import { describe, expect, it } from "vitest";
import { datesIn, depositAmount, fromAgent, isContributionCategory, linkAccounts, readPaystub, whoseStub, readingLooksGood, segments, totalsByCategory, totalsByGroup, unexplained } from "~/lib/paystub";
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
    expect(r.employer).toEqual([{ label: "Employer 401K Match", category: "401k", amount: 105 }]);
  });

  it("reads an Employer Contributions section apart from the deductions", () => {
    // Laid out like a Gusto-style stub: deductions, then what the employer paid.
    const r = readPaystub([
      ["Pay Date", "11/13/2026"],
      ["Gross Pay", "$4,791.67"],
      ["Taxes"],
      ["Federal Income Tax", "$542.23", "$9,000.00"],
      ["Social Security", "$256.50", "$5,000.00"],
      ["Medicare", "$59.99", "$1,200.00"],
      ["Deductions"],
      ["Description", "Type", "Current", "Year To Date"],
      ["Employee Medical Insurance", "Medical Insurance", "$30.91", "$600.00"],
      ["Dependents Medical Insurance", "Medical Insurance", "$296.37", "$6,000.00"],
      ["Dependents Dental Insurance", "Dental Insurance", "$23.30", "$480.00"],
      ["Dependents Vision Insurance", "Vision Insurance", "$4.08", "$85.36"],
      ["Guideline Roth 401(k)", "Roth 401(k)", "$239.58", "$5,000.00"],
      ["Health Savings Account", "HSA", "$300.00", "$6,000.00"],
      ["Guideline 401(k) Loan", "401(k) Loan", "$113.36", "$2,300.00"],
      ["Zeroing out Health Insurance Offset", "Deduction", "$0.00", "$263.17"],
      ["Employer Contributions"],
      ["Description", "Type", "Current", "Year To Date"],
      ["Employee Medical Insurance", "Medical Insurance", "$236.34", "$4,955.06"],
      ["Employee Dental Insurance", "Dental Insurance", "$22.74", "$475.69"],
      ["Employee Vision Insurance", "Vision Insurance", "$4.08", "$85.36"],
      ["Guideline Traditional 401(k)", "401(k)", "$191.67", "$4,271.25"],
      ["Summary"],
      ["Description", "Current", "Year To Date"],
      ["Gross Earnings", "$4,791.67", "$106,779.72"],
      ["Pre-Tax Deductions/Contributions", "$654.66", "$13,696.52"],
      ["Taxes", "$858.72", "$19,534.62"],
      ["Post-Tax Deductions/Contributions", "$352.94", "$8,096.00"],
      ["Net Pay", "$2,925.35", "$65,452.58"],
      ["Total Reimbursements", "$263.17", "$7,451.57"],
      ["Gusto Health Insurance Offset", "$263.17", "$5,789.74"],
      ["Dev trip", "$0.00", "$100.00"],
      ["Uber for travel", "$0.00", "$49.93"],
      ["Work Life Reimbursement", "$0.00", "$1,000.00"],
      ["Check Amount", "$3,188.52", "$72,904.15"],
    ]);
    expect(r.lines.map((l) => [l.category, l.amount])).toEqual([
      ["federal_tax", 542.23], ["social_security", 256.5], ["medicare", 59.99],
      ["medical", 30.91], ["medical", 296.37], ["dental", 23.3], ["vision", 4.08],
      ["roth_401k", 239.58], ["hsa", 300], ["401k_loan", 113.36],
    ]);
    // A traditional 401(k) contribution from the employer stays traditional.
    expect(r.employer.map((l) => [l.category, l.amount])).toEqual([
      ["medical", 236.34], ["dental", 22.74], ["vision", 4.08], ["401k", 191.67],
    ]);
    // Paid after net pay: net + reimbursements is the check amount that hits the bank.
    expect(r.net).toBe(2925.35);
    expect(r.check).toBe(3188.52);
    expect(r.reimbursements).toEqual([{ label: "Gusto Health Insurance Offset", category: "reimbursement", amount: 263.17 }]);
    expect(depositAmount(r.net!, r.reimbursements)).toBe(3188.52);
    expect(unexplained(r.gross!, r.net!, r.lines)).toBe(0);
    expect(readingLooksGood(r)).toBe(true);
  });

  it("counts the gap between net pay and the check amount as a reimbursement", () => {
    const r = readPaystub([["Gross Pay", "1,000.00"], ["Federal Tax", "100.00"], ["Net Pay", "900.00"], ["Check Amount", "950.00"]]);
    expect(r.reimbursements).toEqual([{ label: "Reimbursements", category: "reimbursement", amount: 50 }]);
    expect(readingLooksGood(r)).toBe(true);
  });

  it("leaves employer-paid taxes out", () => {
    const r = readPaystub([["Gross Pay", "1,000.00"], ["Employer Contributions"], ["ER Medicare", "14.50"], ["ER HSA", "50.00"], ["Net Pay", "1,000.00"]]);
    expect(r.employer).toEqual([{ label: "ER HSA", category: "hsa", amount: 50 }]);
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
    expect(r.employer).toEqual([]);
  });

  it("reads reimbursements and the check amount from an agent reply", () => {
    const r = fromAgent({ gross: 4791.67, net: 2925.35, check_amount: 3188.52, lines: [], reimbursements: [
      { label: "Gusto Health Insurance Offset", amount: 263.17 }, { label: "Dev trip", amount: 0 },
    ] });
    expect(r.check).toBe(3188.52);
    expect(r.reimbursements).toEqual([{ label: "Gusto Health Insurance Offset", category: "reimbursement", amount: 263.17 }]);
    expect(fromAgent({ net: 100, check_amount: 120, lines: [] }).reimbursements).toEqual([
      { label: "Reimbursements", category: "reimbursement", amount: 20 },
    ]);
  });

  it("reads employer contributions from an agent reply", () => {
    const r = fromAgent({ gross: 100, net: 90, lines: [], employer: [
      { label: "ER 401k", category: "401k", amount: 191.67 }, { label: "ER FICA", category: "medicare", amount: 9 },
      { label: "ER Life", category: "401k_loan", amount: 3 },
    ] });
    expect(r.employer).toEqual([
      { label: "ER 401k", category: "401k", amount: 191.67 },
      { label: "ER Life", category: "other_pre_tax", amount: 3 },
    ]);
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

describe("year-to-date pay printed on the stub", () => {
  it("reads it from the column after this period's amount", () => {
    const r = readPaystub([
      ...ADP_LIKE,
      ["Summary", "this period", "year to date"],
      ["Net Pay", "2,313.10", "50,888.20"],
    ]);
    expect(r.ytd).toEqual({ gross: 77000, net: 50888.2 });
    expect(r.gross).toBe(3500);
    expect(r.net).toBe(2313.1);
  });

  it("reads rows labelled YTD", () => {
    const r = readPaystub([["Gross Pay", "3,500.00"], ["YTD Gross", "77,000.00"], ["Net Pay", "2,500.00"], ["YTD Net Pay", "55,000.00"]]);
    expect(r.gross).toBe(3500);
    expect(r.net).toBe(2500);
    expect(r.ytd).toEqual({ gross: 77000, net: 55000 });
  });

  it("reads a summary at the top laid out in columns", () => {
    const r = readPaystub([
      ["", "Gross Pay", "Taxes", "Deductions", "Net Pay"],
      ["Current", "$4,791.67", "$1,100.00", "$766.32", "$2,925.35"],
      ["YTD", "$105,416.74", "$24,200.00", "$16,859.04", "$64,357.70"],
      ["Pay Date", "11/13/2026"],
    ]);
    expect(r.ytd).toEqual({ gross: 105416.74, net: 64357.7 });
  });

  it("is null when the stub has no year-to-date totals", () => {
    expect(readPaystub([["Gross Pay", "3,500.00"], ["Net Pay", "2,500.00"]]).ytd).toBeNull();
  });

  it("comes through from the OpenClaw agent", () => {
    expect(fromAgent({ gross: 1, net: 1, ytd_gross: 77000, ytd_net: "50888.20" }).ytd).toEqual({ gross: 77000, net: 50888.2 });
    expect(fromAgent({ gross: 1, net: 1 }).ytd).toBeNull();
  });
});

describe("linking lines to loans and accounts", () => {
  const debts = [{ id: "loan", type: "401k_loan", balance: 5000 }];
  const assets = [{ id: "k401", type: "401k" }, { id: "hsa", type: "hsa" }];
  const line = (category: any, extra = {}) => ({ category, label: "", amount: 1, debt: "", asset: "", ...extra });

  it("uses the only loan or account of the right kind, and the employee's account for the employer's", () => {
    const linked = linkAccounts([line("401k_loan"), line("401k"), line("401k", { employer_paid: true }), line("medical")], [], debts as any, assets as any);
    expect(linked.map((l) => l.debt || l.asset)).toEqual(["loan", "k401", "k401", ""]);
  });

  it("prefers what the last paystub used", () => {
    const linked = linkAccounts([line("hsa", { label: "HSA" })], [line("hsa", { label: "HSA", asset: "other-hsa" })], debts as any, assets as any);
    expect(linked[0].asset).toBe("other-hsa");
  });
});

describe("whose paystub", () => {
  const earners = [{ id: "j", name: "Joey" }, { id: "k", name: "Katie" }];

  it("reads the employee's name and matches the earner by first name", () => {
    const r = readPaystub([["Employee", "Joey Example"], ["Pay Date:", "11/21/2026"], ["Gross Pay", "3,500.00"]]);
    expect(r.employee).toBe("Joey Example");
    expect(whoseStub(r, earners)).toBe("j");
    expect(readPaystub([["Employee Name: Katie Example"]]).employee).toBe("Katie Example");
  });

  it("finds an unlabelled name anywhere on the stub", () => {
    const r = readPaystub([["Acme Widgets Inc"], ["KATIE EXAMPLE"], ["123 Main St"], ["Gross Pay", "3,500.00"]]);
    expect(r.employee).toBeNull();
    expect(whoseStub(r, earners)).toBe("k");
  });

  it("can't tell when no earner's name is on it, or more than one is", () => {
    expect(whoseStub({ employee: null, text: "Acme Widgets" }, earners)).toBeNull();
    expect(whoseStub({ employee: null, text: "Joey and Katie" }, earners)).toBeNull();
    // The labelled employee name settles it.
    expect(whoseStub({ employee: "Katie Example", text: "Joey and Katie" }, earners)).toBe("k");
  });

  it("uses a full name when two earners share a first name", () => {
    const twins = [{ id: "a", name: "Sam Lee" }, { id: "b", name: "Sam Park" }];
    expect(whoseStub({ employee: "Sam Park", text: "" }, twins)).toBe("b");
  });

  it("comes through from the OpenClaw agent", () => {
    expect(fromAgent({ employee_name: " Joey Example " }).employee).toBe("Joey Example");
  });
});
