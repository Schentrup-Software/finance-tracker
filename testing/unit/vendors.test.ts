import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as client from "~/lib/vendors";

// The server's copy (pb_hooks/finance/match.js) is plain CommonJS for PocketBase.
const serverSource = readFileSync(new URL("../../pb_hooks/finance/match.js", import.meta.url), "utf8");
const serverModule: { exports: any } = { exports: {} };
new Function("module", "exports", serverSource)(serverModule, serverModule.exports);
const server = serverModule.exports as Pick<typeof client, "normalizeStatement" | "matchesPattern" | "matchVendor">;

const NORMALIZE: [string, string][] = [
  ["PayPal *StMarysChurch 402-555-0100", "PAYPAL *STMARYSCHURCH"],
  ["PUBLIX #1234", "PUBLIX"],
  ["  sq *joes   cafe 11/21 ", "SQ *JOES CAFE"],
  ["7-ELEVEN 1234", "7-ELEVEN"],
  ["Publix", "PUBLIX"],
  ["", ""],
];

const VENDORS = [
  { id: "church", matches: ["PAYPAL *STMARYSCHURCH"] },
  { id: "amazon", matches: ["AMAZON"] },
  { id: "amazon-mkt", matches: ["AMAZON MKTPL"] },
  { id: "kids", matches: ["little sprouts"] },
  { id: "none", matches: null },
];

const MATCH: [string, string | null][] = [
  ["PAYPAL *STMARYSCHURCH 402-555-0100", "church"],
  ["Amazon.com*2K4", "amazon"],
  ["AMAZON MKTPL*1A2B3C", "amazon-mkt"], // the longer pattern wins
  ["AMAZONIA TOURS", null], // not at a word boundary
  ["Little Sprouts Daycare", "kids"],
  ["Shell Oil 5555", null],
];

describe("vendor matching (browser and server agree)", () => {
  for (const impl of [["browser", client], ["server", server]] as const) {
    it(`${impl[0]}: normalizes statement values`, () => {
      for (const [input, want] of NORMALIZE) expect(impl[1].normalizeStatement(input)).toBe(want);
    });
    it(`${impl[0]}: picks the vendor with the longest fitting pattern`, () => {
      for (const [statement, want] of MATCH) expect((impl[1].matchVendor(statement, VENDORS as any) as { id: string } | null)?.id ?? null).toBe(want);
    });
  }

  it("suggests a tidy vendor name", () => {
    expect(client.suggestVendorName("PAYPAL *STMARYSCHURCH 402-555-0100")).toBe("Stmaryschurch");
    expect(client.suggestVendorName("PUBLIX #1234")).toBe("Publix");
  });
});

const pay = (date: string, amount = 200, kind: "expense" | "income" = "expense") => ({ date, amount, kind });

describe("recurring payments", () => {
  it("spots a monthly gift", () => {
    expect(client.guessRecurring([pay("2027-01-01"), pay("2027-02-01"), pay("2027-03-01"), pay("2027-04-01")]))
      .toEqual({ cadence: "monthly", amount: 200, day: 1 });
  });

  it("spots biweekly payments", () => {
    expect(client.guessRecurring([pay("2027-01-01", 50), pay("2027-01-15", 52), pay("2027-01-29", 50)])?.cadence).toBe("biweekly");
  });

  it("needs three payments, evenly spaced, of about the same amount", () => {
    expect(client.guessRecurring([pay("2027-01-01"), pay("2027-02-01")])).toBeNull();
    expect(client.guessRecurring([pay("2027-01-01"), pay("2027-01-09"), pay("2027-03-01")])).toBeNull();
    expect(client.guessRecurring([pay("2027-01-01", 20), pay("2027-02-01", 95), pay("2027-03-01", 40)])).toBeNull();
  });

  it("works out the next payment, keeping the day of the month", () => {
    expect(client.nextExpected("monthly", "2027-01-31", 31)).toBe("2027-02-28");
    expect(client.nextExpected("monthly", "2027-02-28", 31)).toBe("2027-03-31");
    expect(client.nextExpected("biweekly", "2027-01-01")).toBe("2027-01-15");
    expect(client.nextExpected("annual", "2027-04-15")).toBe("2028-04-15");
  });

  it("flags a missed or changed payment", () => {
    const v = { recurring: "monthly" as const, expected_amount: 200, expected_day: 1 };
    expect(client.recurringState(v, [pay("2027-01-01"), pay("2027-02-01")], "2027-02-20").status).toBe("ok");
    expect(client.recurringState(v, [pay("2027-01-01"), pay("2027-02-01")], "2027-03-09").status).toBe("missed");
    expect(client.recurringState(v, [pay("2027-01-01"), pay("2027-02-01", 250)], "2027-02-10").status).toBe("changed");
    expect(client.recurringState({ ...v, recurring: "" }, [pay("2027-01-01")], "2027-09-01").status).toBe("none");
  });

  it("puts a monthly cost on any cadence", () => {
    expect(client.monthlyCost("biweekly", 60)).toBe(130);
    expect(client.monthlyCost("annual", 120)).toBe(10);
  });
});

describe("where the money goes", () => {
  const t = (vendor: string, amount: number, kind: "expense" | "income" = "expense", envelope = "e1", earner = "") =>
    ({ vendor, amount, kind, envelope, earner });

  it("totals spending per vendor, refunds count against it, paychecks are left out", () => {
    const rows = client.spendingByVendor(
      [t("publix", 100), t("publix", 50, "expense", "e2"), t("publix", 20, "income"), t("church", 200), t("", 15),
        t("", 2500, "income", "", "joey"), t("", 40, "income", "")],
      [t("publix", 90), t("other", 5)],
    );
    expect(rows).toEqual([
      { vendor: "church", total: 200, count: 1, envelopes: ["e1"], before: 0 },
      { vendor: "publix", total: 130, count: 3, envelopes: ["e1", "e2"], before: 90 },
      { vendor: "", total: 15, count: 1, envelopes: ["e1"], before: 0 },
    ]);
  });
});
