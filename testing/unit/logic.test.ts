import { describe, expect, it } from "vitest";
import type { Allocation, Envelope, Transaction } from "~/backend/types";
import { summarize } from "~/lib/budget";
import { simulateSnowball, snowballOrder, paidShare } from "~/lib/debts";
import { equity, netWorth, groupFor } from "~/lib/assets";
import { nextMonth, monthRange } from "~/lib/dates";
import { parseMoney } from "~/lib/money";

const base = { owner: "u", created: "", updated: "" };
const env = (id: string, extra: Partial<Envelope> = {}): Envelope => ({
  ...base, id, name: id, group: "", color: "", emoji: "", default_amount: 0, rollover: false, sort: 0,
  archived: false, external_id: "", ...extra,
});
const alloc = (envelope: string, amount: number): Allocation => ({ ...base, id: envelope + "a", budget: "b", envelope, amount });
const tx = (envelope: string, amount: number, kind: Transaction["kind"] = "expense"): Transaction => ({
  ...base, id: Math.random().toString(), kind, envelope, amount, date: "2026-11-05", payee: "", note: "", external_id: "",
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

describe("debt snowball", () => {
  const debts = [
    { id: "big", name: "Car", balance: 9000, interest_rate: 5, minimum_payment: 300 },
    { id: "small", name: "Visa", balance: 800, interest_rate: 24, minimum_payment: 40 },
    { id: "mid", name: "Student", balance: 4000, interest_rate: 6, minimum_payment: 100 },
  ];

  it("orders by smallest balance, ignoring interest", () => {
    expect(snowballOrder(debts).map((d) => d.id)).toEqual(["small", "mid", "big"]);
  });

  it("pays the smallest off first and finishes", () => {
    const r = simulateSnowball(debts, 500);
    expect(r.months).not.toBeNull();
    expect(r.payoffMonth.small).toBeLessThan(r.payoffMonth.mid);
    expect(r.payoffMonth.mid).toBeLessThanOrEqual(r.payoffMonth.big);
    expect(r.totalInterest).toBeGreaterThan(0);
  });

  it("extra money makes it faster", () => {
    expect(simulateSnowball(debts, 1000).months!).toBeLessThan(simulateSnowball(debts, 0).months!);
  });

  it("reports never when minimums don't cover interest", () => {
    expect(simulateSnowball([{ id: "x", name: "x", balance: 10000, interest_rate: 30, minimum_payment: 10 }], 0).months).toBeNull();
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
