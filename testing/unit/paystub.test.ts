import { describe, expect, it } from "vitest";
import { datesIn, fromAgent, isContributionCategory, readPaystub, readingLooksGood, segments, totalsByCategory, totalsByGroup, unexplained } from "~/lib/paystub";
import { toRows } from "~/lib/pdfText";

// Rows of cells as pdfText produces them, modelled on common payroll layouts.
const ADP_LIKE: string[][] = [
  ["Acme Widgets Inc", "Earnings Statement"],
  ["Period Beginning:", "11/01/2026"],
  ["Period Ending:", "11/14/2026"],
  ["Pay Date:", "11/21/2026"],
  ["Earnings", "rate", "hours", "this period", "year to date"],
  ["Regular", "43.7500", "80.00", "3,500.00", "77,000.00"],
  ["Gross Pay", "$3,500.00", "77,000.00"],
  ["Statutory Deductions", "this period", "year to date"],
  ["Federal Income Tax", "-312.45", "6,873.90"],
  ["Social Security Tax", "-207.70", "4,569.40"],
  ["Medicare Tax", "-48.58", "1,068.76"],
  ["GA State Income Tax", "-155.20", "3,414.40"],
  ["Other Deductions"],
  ["Medical", "-142.31", "3,130.82"],
  ["Dental", "-18.40", "404.80"],
  ["Vision", "-6.12", "134.64"],
  ["401K", "-175.00", "3,850.00"],
  ["401K Loan 1", "-121.14", "2,665.08"],
  ["Net Pay", "$2,313.10"],
  ["Your federal taxable wages this period are $2,988.17"],
  ["Employer 401K Match", "105.00", "2,310.00"],
];

describe("paystub reader", () => {
  it("reads gross, net, dates and every deduction", () => {
    const r = readPaystub(ADP_LIKE);
    expect(r.gross).toBe(3500);
    expect(r.net).toBe(2313.1);
    expect(r.pay_date).toBe("2026-11-21");
    expect(r.period_start).toBe("2026-11-01");
    expect(r.period_end).toBe("2026-11-14");
    expect(r.lines.map((l) => [l.category, l.amount])).toEqual([
      ["federal_tax", 312.45],
      ["social_security", 207.7],
      ["medicare", 48.58],
      ["state_tax", 155.2],
      ["medical", 142.31],
      ["dental", 18.4],
      ["vision", 6.12],
      ["401k", 175],
      ["401k_loan", 121.14],
    ]);
    expect(unexplained(r.gross!, r.net!, r.lines)).toBe(0);
    expect(readingLooksGood(r)).toBe(true);
  });

  it("splits two deduction columns that share a row", () => {
    const r = readPaystub([
      ["Gross Earnings", "4,000.00"],
      ["Fed Withholding", "500.00", "9,000.00", "Med Ins Pre-Tax", "200.00", "3,600.00"],
      ["FICA - Medicare", "58.00", "1,044.00", "Roth 401(k)", "240.00", "4,320.00"],
      ["FICA - Social Security", "248.00", "4,464.00", "HSA EE", "100.00", "1,800.00"],
      ["Check Date 12/05/2026", "Net Pay", "2,654.00"],
    ]);
    expect(r.gross).toBe(4000);
    expect(r.net).toBe(2654);
    expect(r.pay_date).toBe("2026-12-05");
    expect(r.lines.map((l) => l.category).sort()).toEqual(
      ["federal_tax", "hsa", "medical", "medicare", "roth_401k", "social_security"].sort(),
    );
    expect(readingLooksGood(r)).toBe(true);
  });

  it("flags a reading that doesn't add up", () => {
    const r = readPaystub([["Gross Pay", "1,000.00"], ["Federal Tax", "100.00"], ["Net Pay", "700.00"]]);
    expect(unexplained(r.gross!, r.net!, r.lines)).toBe(200);
    expect(readingLooksGood(r)).toBe(false);
  });

  it("understands date formats", () => {
    expect(datesIn("Paid Nov 21, 2026 for 2026-11-01 to 11/14/26")).toEqual(["2026-11-21", "2026-11-01", "2026-11-14"]);
  });

  it("treats a lone label followed by number cells as one segment", () => {
    expect(segments([["Dental", "18.40", "404.80"]])).toEqual([{ label: "Dental", amounts: [18.4, 404.8], text: "Dental 18.40 404.80" }]);
  });

  it("groups totals", () => {
    const t = totalsByGroup([{ category: "federal_tax", amount: 10 }, { category: "medicare", amount: 5 }, { category: "401k_loan", amount: 7 }]);
    expect(t.find((x) => x.group.key === "taxes")!.total).toBe(15);
    expect(t.find((x) => x.group.key === "loans")!.total).toBe(7);
  });

  it("cleans up an agent reply", () => {
    const r = fromAgent({ pay_date: "2026-11-21", gross: "3500", net: 2580.1, lines: [{ label: "X", category: "nonsense", amount: -5 }, { label: "Y", category: "dental", amount: 0 }] });
    expect(r.gross).toBe(3500);
    expect(r.lines).toEqual([{ label: "X", category: "other_pre_tax", amount: 5 }]);
  });
});

describe("pdf text layout", () => {
  it("builds rows and cells from positioned text", () => {
    const rows = toRows([
      { x: 10, y: 700, w: 40, str: "Gross" },
      { x: 52, y: 700, w: 20, str: "Pay" },
      { x: 300, y: 701, w: 50, str: "3,500.00" },
      { x: 10, y: 680, w: 40, str: "Net Pay" },
      { x: 300, y: 680, w: 50, str: "2,313.10" },
    ]);
    expect(rows).toEqual([["Gross Pay", "3,500.00"], ["Net Pay", "2,313.10"]]);
  });
});

describe("year-to-date totals", () => {
  it("adds up each category across paystubs, largest first", () => {
    const t = totalsByCategory([
      { category: "federal_tax", amount: 312.45 },
      { category: "medical", amount: 120.5 },
      { category: "federal_tax", amount: 312.45 },
      { category: "hsa", amount: 100 },
    ]);
    expect(t).toEqual([
      { category: "federal_tax", total: 624.9 },
      { category: "medical", total: 120.5 },
      { category: "hsa", total: 100 },
    ]);
  });

  it("treats HSA and retirement lines as contributions, not costs", () => {
    expect(isContributionCategory("hsa")).toBe(true);
    expect(isContributionCategory("401k")).toBe(true);
    expect(isContributionCategory("medical")).toBe(false);
    expect(isContributionCategory("401k_loan")).toBe(false);
  });
});
