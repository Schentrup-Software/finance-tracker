import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accountExternalId, envelopeExternalId, guessAccountType, parseAmount, parseCsv, parseDate, planImport } from "~/lib/importer";

const CSV = readFileSync(fileURLToPath(new URL("../fixtures/history.csv", import.meta.url)), "utf8");

describe("reading a history spreadsheet", () => {
  it("parses quoted cells, commas in amounts and US dates", () => {
    const rows = parseCsv('a,b\r\n"1,000.00","say ""hi"""\n');
    expect(rows).toEqual([["a", "b"], ["1,000.00", 'say "hi"']]);
    expect(parseAmount("1,000.00")).toBe(1000);
    expect(parseAmount("($12.50)")).toBe(-12.5);
    expect(parseDate("11/22/2026")).toBe("2026-11-22");
    expect(parseDate("2026-01-05")).toBe("2026-01-05");
    expect(parseDate("Nov 5")).toBe("");
  });

  const plan = planImport(parseCsv(CSV));
  const tx = (payee: string) => plan.transactions.filter((t) => t.payee === payee);

  it("reads spending, money back into an envelope, and income", () => {
    expect(tx("Delta Air Lines")).toMatchObject([{ kind: "expense", envelope: "Vacation", amount: 45, account: "Visa" }]);
    expect(tx("Venmo")).toMatchObject([{ kind: "income", envelope: "Joey", amount: 23.94 }]);
    expect(tx("Paycheck")).toMatchObject([{ kind: "income", envelope: "", amount: 2410.11 }]);
    expect(tx("Check")).toMatchObject([{ note: "Check #105", envelope: "Donations" }]);
  });

  it("splits a transaction across envelopes", () => {
    expect(tx("Walmart").map((t) => [t.envelope, t.amount])).toEqual([["Groceries", 40], ["Joey", 20]]);
  });

  it("keeps identical rows apart, with ids that are the same on every import", () => {
    const shops = tx("Publix").filter((t) => t.date === "2026-10-15");
    expect(shops).toHaveLength(2);
    expect(shops[0].external_id).not.toBe(shops[1].external_id);
    expect(planImport(parseCsv(CSV)).transactions.map((t) => t.external_id))
      .toEqual(plan.transactions.map((t) => t.external_id));
  });

  it("turns envelope transfers and fills into that month's allocations", () => {
    const nov = plan.months.find((m) => m.month === "2026-11")!;
    expect(nov.moved).toEqual({ Christmas: 1000, Extra: -1000 });
    expect(nov.income).toBe(2410.11);
    expect(plan.months.find((m) => m.month === "2026-10")!.moved).toEqual({ Extra: -25 });
    expect(plan.months.find((m) => m.month === "2026-09")!.moved).toEqual({ House: 200 });
  });

  it("pairs card payments into transfers, and skips balance adjustments", () => {
    expect(plan.skipped).toEqual({ accountMoves: 0, adjustments: 1, empty: 1 });
    expect(tx("CARD AUTOPAY")).toHaveLength(0);
    expect(plan.transfers).toMatchObject([{ date: "2026-11-13", from: "Checking", to: "Visa", amount: 500, payee: "CARD AUTOPAY" }]);
  });

  it("finds each account and what kind it is", () => {
    expect(plan.accounts.map((a) => [a.name, a.type])).toEqual([["Visa", "credit_card"], ["Checking", "checking"]]);
    expect(accountExternalId("Joint Checking")).toBe("import-acct-joint-checking");
  });

  it("lists every envelope, most recently used first", () => {
    expect(plan.envelopes.map((e) => e.name)).toEqual(
      ["Extra", "Christmas", "Groceries", "Vacation", "Joey", "Donations", "House"]);
    expect(plan.firstDate).toBe("2026-09-01");
    expect(plan.lastDate).toBe("2026-11-22");
    expect(envelopeExternalId("Long Term Payments")).toBe("import-env-long-term-payments");
  });

  it("explains a file without the needed columns", () => {
    expect(() => planImport([["Foo", "Bar"], ["1", "2"]])).toThrow(/Date and Amount/);
  });
});

describe("detecting accounts from transfers", () => {
  // Account names that say nothing about their kind: the money has to tell.
  const csv = [
    "Date,Envelope,Standard,Name,Notes,Amount,Status,Details",
    "11/01/2026,,Joint,Paycheck,,\"3,000.00\",,[Available]|3000.00",
    "11/15/2026,,Joint,Paycheck,,\"3,000.00\",,[Available]|3000.00",
    "11/03/2026,Groceries,Disney,Publix,,-80.00,,",
    "11/04/2026,Gas,Disney,Shell,,-40.00,,",
    "11/05/2026,Bills,Joint,Electric,,-150.00,,",
    // Card payment: the card side posts a day later.
    "11/20/2026,,Joint,PAYMENT THANK YOU,,-120.00,,",
    "11/21/2026,,Disney,PAYMENT THANK YOU,,120.00,,",
    // Moving money to savings and back.
    "11/02/2026,,Joint,TRANSFER TO 0848,,-500.00,,",
    "11/02/2026,,Rainy Day,TRANSFER FROM JOINT,,500.00,,",
    "11/17/2026,,Rainy Day,TRANSFER TO JOINT,,-200.00,,",
    "11/17/2026,,Joint,TRANSFER FROM 0848,,200.00,,",
    // Only one side of this one is in the file.
    "11/25/2026,,Joint,Zelle,,-60.00,,",
  ].join("\n");
  const plan = planImport(parseCsv(csv));
  const kind = (name: string) => plan.accounts.find((a) => a.name === name);

  it("reads the account from a column named Standard", () => {
    expect(plan.transactions.find((t) => t.payee === "Publix")?.account).toBe("Disney");
  });

  it("pairs both sides of each transfer, a few days apart at most", () => {
    expect(plan.transfers.map((t) => [t.date, t.from, t.to, t.amount])).toEqual([
      ["2026-11-02", "Joint", "Rainy Day", 500],
      ["2026-11-17", "Rainy Day", "Joint", 200],
      ["2026-11-20", "Joint", "Disney", 120],
    ]);
    expect(plan.skipped.accountMoves).toBe(1);
  });

  it("tells cards, checking and savings apart", () => {
    expect(kind("Disney")).toMatchObject({ type: "credit_card", reason: "Paid off by 1 transfer from Joint" });
    expect(kind("Joint")).toMatchObject({ type: "checking", reason: "2 deposits to the budget land here" });
    expect(kind("Rainy Day")).toMatchObject({ type: "savings", reason: "Mostly transfers with Joint" });
  });

  it("trusts a name that says what it is", () => {
    const stats = { spending: 0, deposits: 0, paidBy: [], paidTo: [], transfersIn: 3, transfersOut: 0 };
    expect(guessAccountType({ ...stats, name: "Chase Visa" }).type).toBe("credit_card");
    expect(guessAccountType({ ...stats, name: "Online Savings" }).type).toBe("savings");
    expect(guessAccountType({ ...stats, name: "Cash" }).type).toBe("cash");
    // Only ever receiving money, with no spending, is saving.
    expect(guessAccountType({ ...stats, name: "Kids", paidBy: ["Joint"] }).type).toBe("savings");
    // Spending with no paychecks or transfers looks like a card whose payments weren't recorded.
    expect(guessAccountType({ ...stats, name: "Target", transfersIn: 0, spending: 4 }).type).toBe("credit_card");
  });
});
