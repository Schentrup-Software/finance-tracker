import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { envelopeExternalId, parseAmount, parseCsv, parseDate, planImport } from "~/lib/importer";

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

  it("skips card payments, account transfers and balance adjustments", () => {
    expect(plan.skipped).toEqual({ accountMoves: 2, adjustments: 1, empty: 1 });
    expect(tx("CARD AUTOPAY")).toHaveLength(0);
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
