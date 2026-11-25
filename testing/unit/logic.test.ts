import { describe, expect, it } from "vitest";
import type { Allocation, Envelope, Transaction } from "~/backend/types";
import { monthlyToGoal, summarize } from "~/lib/budget";
import { interestLeft, paidShare, payoffMonths } from "~/lib/debts";
import { equity, netWorth, groupFor } from "~/lib/assets";
import { nextMonth, monthRange } from "~/lib/dates";
import { parseMoney } from "~/lib/money";

const base = { owner: "u", created: "", updated: "" };
const env = (id: string, extra: Partial<Envelope> = {}): Envelope => ({
  ...base, id, name: id, group: "", color: "", emoji: "", default_amount: 0, rollover: false, sort: 0,
  archived: false, external_id: "", period: "", goal: 0, opening_balance: 0, opening_date: "", tax_category: "", ...extra,
});
const alloc = (envelope: string, amount: number): Allocation => ({ ...base, id: envelope + "a", budget: "b", envelope, amount });
const tx = (envelope: string, amount: number, kind: Transaction["kind"] = "expense"): Transaction => ({
  ...base, id: Math.random().toString(), kind, envelope, amount, date: "2026-11-05", payee: "", note: "", account: "", external_id: "",
  earner: "", paystub_status: "", vendor: "", vendor_locked: false, tax_category: "", tax_amount: 0, tax_paid_by: "",
  tax_year: 0, tax_person: "", tax_acknowledged: false,
});

describe("annual envelopes and imports", () => {
  it("measures an annual envelope against its yearly goal and keeps what's left", () => {
    const s = summarize([env("xmas", { period: "annual", goal: 3600 })], [alloc("xmas", 300)], [tx("xmas", 100)],
      { xmas: 1200 }, 0, "2026-11", { xmas: 900 });
    const x = s.envelopes[0];
    expect(x.left).toBe(1400);
    expect(x.fullness).toBeCloseTo(1400 / 3600);
    expect(x.yearSpent).toBe(900);
  });

  it("money put straight into an envelope adds to it and isn't counted as income", () => {
    const s = summarize([env("joey")], [alloc("joey", 100)], [tx("joey", 30), tx("joey", 50, "income"), tx("", 2000, "income")], {}, 0);
    expect(s.envelopes[0].added).toBe(50);
    expect(s.envelopes[0].left).toBe(120);
    expect(s.receivedIncome).toBe(2000);
  });

  it("months before an imported opening balance show spending only", () => {
    const e = env("g", { rollover: true, opening_balance: 164.22, opening_date: "2026-11-22 23:59:59.999Z" });
    expect(summarize([e], [], [tx("g", 40)], { g: -30000 }, 0, "2026-10").envelopes[0].historyOnly).toBe(true);
    const nov = summarize([e], [], [], { g: 164.22 }, 0, "2026-11").envelopes[0];
    expect(nov.historyOnly).toBe(false);
    expect(nov.left).toBe(164.22);
  });

  it("spreads what's left of a goal over the rest of the year", () => {
    expect(monthlyToGoal(3600, 600, "2026-01")).toBe(250);
    expect(monthlyToGoal(3600, 3000, "2026-11")).toBe(300);
    expect(monthlyToGoal(3600, 4000, "2026-11")).toBe(0);
  });
});

describe("cash envelope budget", () => {
  it("computes left to budget, spending and envelope cash", () => {
    const s = summarize(
      [env("food"), env("gas")],
      [alloc("food", 600), alloc("gas", 200)],
      [tx("food", 150), tx("food", 50.5), tx("gas", 250), tx("", 4000, "income")],
      {},
      5000,
    );
    expect(s.assigned).toBe(800);
    expect(s.leftToBudget).toBe(4200);
    expect(s.receivedIncome).toBe(4000);
    expect(s.spent).toBe(450.5);
    const food = s.envelopes.find((e) => e.envelope.id === "food")!;
    expect(food.left).toBe(399.5);
    const gas = s.envelopes.find((e) => e.envelope.id === "gas")!;
    expect(gas.left).toBe(-50);
    expect(gas.fullness).toBe(0);
  });

  it("only rollover envelopes carry cash in", () => {
    const s = summarize([env("xmas", { rollover: true }), env("food")], [alloc("xmas", 100), alloc("food", 100)], [], { xmas: 300, food: 999 }, 200);
    expect(s.envelopes[0].left).toBe(400);
    expect(s.envelopes[1].left).toBe(100);
  });

  it("hides archived envelopes with no activity", () => {
    const s = summarize([env("old", { archived: true })], [], [], {}, 0);
    expect(s.envelopes).toHaveLength(0);
  });
});

describe("loan payoff", () => {
  it("no interest: balance / payment, rounded up", () => {
    expect(payoffMonths(1000, 0, 100)).toBe(10);
    expect(payoffMonths(1001, 0, 100)).toBe(11);
  });
  it("matches a standard amortization", () => {
    // $20,000 at 6% with $386.66/mo is a 60-month loan.
    expect(payoffMonths(20000, 6, 386.66)).toBe(60);
    expect(interestLeft(20000, 6, 386.66)).toBeCloseTo(3199.6, 0);
  });
  it("never, when the payment doesn't cover interest or is missing", () => {
    expect(payoffMonths(10000, 30, 10)).toBeNull();
    expect(payoffMonths(10000, 5, 0)).toBeNull();
  });
  it("paid off is zero months", () => {
    expect(payoffMonths(0, 5, 100)).toBe(0);
  });
  it("tracks share paid", () => {
    expect(paidShare({ balance: 250, original_balance: 1000 })).toBe(0.75);
    expect(paidShare({ balance: 0, original_balance: 0 })).toBe(1);
  });
});

describe("assets", () => {
  it("equity subtracts linked debts", () => {
    const debts = new Map([["m", { balance: 200000 }], ["h", { balance: 15000 }]]);
    expect(equity({ value: 350000, debts: ["m", "h"] }, debts)).toBe(135000);
  });
  it("net worth", () => {
    expect(netWorth([{ value: 100 }, { value: 50 }], [{ balance: 30 }])).toEqual({ totalAssets: 150, totalDebts: 30, netWorth: 120 });
  });
  it("groups retirement accounts", () => {
    expect(groupFor("hsa").key).toBe("retirement");
    expect(groupFor("collectible").key).toBe("stuff");
  });
});

describe("helpers", () => {
  it("months", () => {
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(nextMonth("2026-01", -1)).toBe("2025-12");
    expect(monthRange("2026-11").end).toBe("2026-12-01 00:00:00.000Z");
  });
  it("money parsing", () => {
    expect(parseMoney("$1,234.567")).toBe(1234.57);
    expect(parseMoney("")).toBe(0);
  });
});
