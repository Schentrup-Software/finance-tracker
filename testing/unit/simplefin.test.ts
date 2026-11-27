import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultUse, guessKind, morningHourUtc, suggestMatch } from "~/lib/simplefin";

// The server's half (pb_hooks/finance/simplefin.js) is plain CommonJS for PocketBase.
const source = readFileSync(new URL("../../pb_hooks/finance/simplefin.js", import.meta.url), "utf8");
const mod: { exports: any } = { exports: {} };
new Function("module", "exports", source)(mod, mod.exports);
const sf = mod.exports;

const b64 = (s: string) => Buffer.from(s).toString("base64");
const DAY = 86400;

describe("setup tokens", () => {
  it("decodes a setup token to its claim URL", () => {
    const url = "https://beta-bridge.simplefin.org/simplefin/claim/DEMO-v2-CA9A55BC442F2E84B622";
    expect(sf.claimUrlFromToken(b64(url))).toBe(url);
    expect(sf.claimUrlFromToken(`  ${b64(url)}\n`)).toBe(url);
    expect(sf.claimUrlFromToken(b64(url).replace(/=+$/, ""))).toBe(url);
  });

  it("refuses things that aren't tokens, and plain http to other machines", () => {
    expect(() => sf.claimUrlFromToken("")).toThrow(/Paste/);
    expect(() => sf.claimUrlFromToken("not a token!")).toThrow(/isn't a SimpleFIN setup token/);
    expect(() => sf.claimUrlFromToken(b64("hello there"))).toThrow(/isn't a SimpleFIN setup token/);
    expect(() => sf.claimUrlFromToken(b64("http://bridge.example.com/claim/x"))).toThrow(/https/);
    expect(sf.claimUrlFromToken(b64("http://localhost:8091/claim/x"))).toBe("http://localhost:8091/claim/x");
  });

  it("splits an access URL into its address and login", () => {
    expect(sf.splitAccessUrl("https://user:p%40ss@bridge.example.com/simplefin/")).toEqual({
      base: "https://bridge.example.com/simplefin", username: "user", password: "p@ss",
    });
    expect(sf.checkAccessUrl(" https://u:p@bridge.example.com/simplefin\n")).toBe("https://u:p@bridge.example.com/simplefin");
    expect(() => sf.checkAccessUrl("<html>oops</html>")).toThrow(/access URL/);
    expect(() => sf.checkAccessUrl("http://u:p@evil.example.com/simplefin")).toThrow(/http/);
  });

  it("encodes Basic auth like btoa", () => {
    for (const s of ["demo:s3cret", "a:", "ab:c", "user:pass word"]) expect(sf.encodeBase64(s)).toBe(b64(s));
  });
});

describe("when to pull", () => {
  const at = (iso: string) => Date.parse(iso);

  it("pulls in the connection's morning hour, once", () => {
    expect(sf.isDue(at("2026-11-27T11:48:00Z"), at("2026-11-26T11:48:00Z"), 11)).toBe(true);
    expect(sf.isDue(at("2026-11-27T10:48:00Z"), at("2026-11-26T11:48:00Z"), 11)).toBe(false);
    // Pulled by hand half an hour ago: not again.
    expect(sf.isDue(at("2026-11-27T11:48:00Z"), at("2026-11-27T11:15:00Z"), 11)).toBe(false);
    // Connected yesterday afternoon: still pulls this morning.
    expect(sf.isDue(at("2026-11-27T11:48:00Z"), at("2026-11-26T19:00:00Z"), 11)).toBe(true);
    expect(sf.isDue(at("2026-11-27T11:48:00Z"), 0, 11)).toBe(true);
  });

  it("catches up after a missed morning", () => {
    expect(sf.isDue(at("2026-11-27T15:48:00Z"), at("2026-11-26T11:48:00Z"), 11)).toBe(true);
    expect(sf.isDue(at("2026-11-27T12:48:00Z"), at("2026-11-26T11:48:00Z"), 11)).toBe(false);
  });

  it("picks a minute away from the top and bottom of the hour", () => {
    const seen = new Set<number>();
    for (let r = 0; r < 1; r += 0.001) seen.add(sf.pickMinute(r));
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...seen)).toBeLessThanOrEqual(56);
    for (const m of [0, 1, 2, 3, 27, 28, 29, 30, 31, 32, 33, 57, 58, 59]) expect(seen.has(m)).toBe(false);
    expect(seen.size).toBeGreaterThan(40);
    expect(sf.parseMinute("48\n")).toBe(48);
    expect(sf.parseMinute("")).toBe(null);
    expect(sf.parseMinute("75")).toBe(null);
  });

  it("asks for days since the last pull, less a few for late posts, and never past 89 days", () => {
    const now = Date.parse("2026-11-27T12:00:00Z") / 1000;
    expect(sf.windowStart(now, [{ last_pulled: "2026-11-26 12:00:00.000Z", sync_from: "2026-11-01" }]))
      .toBe(Date.parse("2026-11-21T00:00:00Z") / 1000);
    expect(sf.windowStart(now, [{ last_pulled: "", sync_from: "2026-11-01 12:00:00.000Z" }]))
      .toBe(Date.parse("2026-11-01T00:00:00Z") / 1000);
    expect(sf.windowStart(now, [{ last_pulled: "", sync_from: "2025-01-01" }])).toBe(now - 89 * DAY);
  });
});

describe("reading an answer", () => {
  const body = {
    errlist: [{ code: "con.auth", msg: "Sunshine Bank needs you to sign in again." }],
    errors: ["You're over the daily limit."],
    connections: [{ conn_id: "C1", name: "Sunshine Bank", org_id: "O1", sfin_url: "x" }],
    accounts: [{
      id: "A1", conn_id: "C1", name: "Checking", currency: "USD", balance: "100.235", "balance-date": 1795867200,
      transactions: [
        { id: "T1", posted: 1795694400, amount: "-12.50", description: "PUBLIX #1234", payee: "Publix" },
        { id: "T2", posted: 0, amount: "-3", description: "pending", pending: true },
        { id: "T3", posted: 1795694400, transacted_at: 1795608000, amount: "20", description: "VENMO" },
      ],
    }, { id: "A2", name: "Old", org: { name: "Old Bank" }, balance: "-5", "balance-date": 1795867200 }],
  };

  it("collects errors from errlist and the older errors list", () => {
    expect(sf.answerErrors(body)).toEqual(["Sunshine Bank needs you to sign in again.", "You're over the daily limit."]);
    expect(sf.answerErrors({})).toEqual([]);
  });

  it("flattens accounts and leaves out pending transactions", () => {
    const [a, b] = sf.readAccounts(body);
    expect(a).toMatchObject({ id: "A1", name: "Checking", org: "Sunshine Bank", balance: 100.24, balance_date: "2026-11-28" });
    expect(a.transactions.map((t: any) => [t.id, t.date, t.amount, t.payee])).toEqual([
      ["T1", "2026-11-26", -12.5, "Publix"],
      ["T3", "2026-11-25", 20, "VENMO"], // the day it happened, not the day it posted
    ]);
    expect(b).toMatchObject({ org: "Old Bank", balance: -5, transactions: [] });
  });

  it("turns bank balances into debt balances", () => {
    expect(sf.debtBalance(-612.4, "credit_card")).toBe(612.4);
    expect(sf.debtBalance(15, "credit_card")).toBe(0); // a credit on the card
    expect(sf.debtBalance(245000, "mortgage")).toBe(245000);
  });
});

describe("what a pull adds", () => {
  const checking = {
    id: "CHK", name: "Checking", use: "spending", asset: "asset1", debt: "", sync_from: "2026-11-01",
    transactions: [
      { id: "old", date: "2026-10-30", amount: -9, payee: "Before the import", description: "", memo: "" },
      { id: "pay", date: "2026-11-21", amount: 2104.33, payee: "Acme Corp", description: "ACME CORP PAYROLL", memo: "" },
      { id: "pub", date: "2026-11-23", amount: -87.12, payee: "Publix", description: "PUBLIX #1234", memo: "" },
      { id: "visa", date: "2026-11-24", amount: -400, payee: "Visa Payment", description: "VISA ONLINE PAYMENT", memo: "" },
    ],
  };
  const card = {
    id: "VISA", name: "Visa", use: "spending", asset: "", debt: "debt1", sync_from: "2026-11-01",
    transactions: [
      { id: "shell", date: "2026-11-22", amount: -45.5, payee: "Shell", description: "SHELL OIL", memo: "" },
      { id: "thanks", date: "2026-11-25", amount: 400, payee: "Payment Thank You", description: "PAYMENT THANK YOU", memo: "" },
      { id: "refund", date: "2026-11-26", amount: 12, payee: "Target", description: "TARGET REFUND", memo: "" },
    ],
  };
  const savings = { id: "SAV", name: "Savings", use: "balance", asset: "asset2", debt: "", sync_from: "", transactions: [
    { id: "int", date: "2026-11-24", amount: 31.2, payee: "Interest", description: "", memo: "" },
  ] };

  it("brings in spending and deposits, and pairs a card payment with the withdrawal that paid it", () => {
    const plan = sf.planPull([checking, card, savings], () => false);
    expect(plan.transactions.map((t: any) => [t.external_id, t.kind, t.amount, t.account_asset, t.account_debt])).toEqual([
      ["sfin-CHK-pay", "income", 2104.33, "asset1", ""],
      ["sfin-CHK-pub", "expense", 87.12, "asset1", ""],
      ["sfin-VISA-shell", "expense", 45.5, "", "debt1"],
      ["sfin-VISA-refund", "income", 12, "", "debt1"],
    ]);
    expect(plan.payments).toEqual([{
      external_id: "sfin-VISA-thanks", debt: "debt1", date: "2026-11-25", amount: 400, note: "Payment Thank You",
      from_asset: "asset1", from_external_id: "sfin-CHK-visa",
    }]);
  });

  it("skips what's already saved, so overlapping pulls don't duplicate", () => {
    const known = new Set(["sfin-CHK-pay", "sfin-CHK-pub", "sfin-VISA-shell", "sfin-VISA-thanks", "sfin-CHK-visa"]);
    const plan = sf.planPull([checking, card], (ext: string) => known.has(ext));
    expect(plan.transactions.map((t: any) => t.external_id)).toEqual(["sfin-VISA-refund"]);
    expect(plan.payments).toEqual([]);
  });

  it("leaves a payment unpaired when no withdrawal is close enough", () => {
    const late = { ...checking, transactions: [{ ...checking.transactions[3], date: "2026-11-10" }] };
    const plan = sf.planPull([late, card], () => false);
    expect(plan.payments[0].from_external_id).toBe("");
    expect(plan.transactions.some((t: any) => t.external_id === "sfin-CHK-visa")).toBe(true);
  });

  it("knows paychecks from an employer by name", () => {
    expect(sf.fromEmployer("ACME CORP PAYROLL", "Acme Corp")).toBe(true);
    expect(sf.fromEmployer("ACME PAYROLL PPD", "Acme, Inc.")).toBe(true);
    expect(sf.fromEmployer("ACMEX PAYROLL", "Acme")).toBe(false);
    expect(sf.fromEmployer("Payroll", "")).toBe(false);
  });
});

describe("choosing accounts in the app", () => {
  it("guesses what an account is", () => {
    expect(guessKind("Everyday Checking", 10)).toBe("checking");
    expect(guessKind("Sapphire Preferred", -10)).toBe("credit_card");
    expect(guessKind("Home Mortgage", -200000)).toBe("mortgage");
    expect(guessKind("Roth IRA", 5000)).toBe("roth_ira");
    expect(guessKind("Guideline 401(k)", 5000)).toBe("401k");
    expect(guessKind("High Yield Savings", 10)).toBe("savings");
    expect(guessKind("Account ...1234", -50)).toBe("credit_card");
  });

  it("treats mortgages and other loans as balance only, not budget transactions", () => {
    const loans: [string, number, string, string][] = [
      ["Home Mortgage", -245000, "Sunshine Bank", "mortgage"],
      ["Mortgage ...4471", -180000, "Chase", "mortgage"],
      ["Escrow and principal", -150000, "", "mortgage"],
      ["Loan ...0042", -12000, "Navy Federal", "personal"],
      ["Account ...9921", -210000, "Mr. Cooper", "mortgage"],
      ["Account ...1100", -14000, "Rocket Mortgage", "mortgage"],
      ["Direct Loans", -23000, "Nelnet", "personal"], // "loans" in the name says loan; still balance only
      ["Account ...5012", -23000, "Aidvantage", "student"],
      ["Account ...7300", -18000, "Toyota Financial Services", "auto"],
      ["Vehicle ...7300", -18000, "Bank", "auto"],
      ["HELOC", -40000, "Bank", "heloc"],
      ["Account ...3333", -320000, "Some Bank", "mortgage"], // owes too much to be a card
      ["Account ...4444", -30000, "Some Bank", "personal"],
    ];
    for (const [name, balance, org, kind] of loans) {
      expect(guessKind(name, balance, org), name).toBe(kind);
      expect(defaultUse(guessKind(name, balance, org)), name).toBe("balance");
    }
    // Cards and checking still bring in transactions, even at a lender's bank.
    expect(guessKind("Freedom Unlimited", -1200, "Chase")).toBe("credit_card");
    expect(guessKind("Account ...8888", -900, "Some Bank")).toBe("credit_card");
    expect(guessKind("Account ...8888", 900, "Toyota Financial Services")).toBe("checking");
    expect(defaultUse(guessKind("Account ...8888", -900, "Some Bank"))).toBe("spending");
    expect(defaultUse("checking")).toBe("spending");
    expect(defaultUse("credit_card")).toBe("spending");
    expect(defaultUse("mortgage")).toBe("balance");
  });

  it("matches an imported account to a SimpleFIN account by name", () => {
    const accts = [
      { id: "1", name: "Everyday Checking", org: "Sunshine Bank", balance: 10 },
      { id: "2", name: "Sunshine Visa", org: "Sunshine Bank", balance: -10 },
      { id: "3", name: "Discover it Card", org: "Discover", balance: -5 },
      { id: "4", name: "Discover it Card", org: "Discover", balance: -6 },
    ];
    expect(suggestMatch("Checking", "checking", accts)?.id).toBe("1");
    expect(suggestMatch("Visa", "credit_card", accts)?.id).toBe("2");
    expect(suggestMatch("Brie Discover", "credit_card", accts)).toBe(null); // two fit equally
    expect(suggestMatch("Disney", "checking", accts)).toBe(null);
  });

  it("works out the UTC hour of 6 AM local", () => {
    const hour = morningHourUtc(6, new Date(2026, 10, 27));
    expect(hour).toBe(new Date(2026, 10, 27, 6).getUTCHours());
  });
});
