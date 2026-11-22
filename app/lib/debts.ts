import type { Debt, DebtType } from "~/backend/types";
import { round2 } from "./money";

export const DEBT_LABELS: Record<DebtType, string> = {
  credit_card: "Credit card",
  auto: "Car loan",
  student: "Student loan",
  medical: "Medical",
  personal: "Personal loan",
  mortgage: "Mortgage",
  heloc: "HELOC",
  other: "Other",
};

export const DEBT_EMOJI: Record<DebtType, string> = {
  credit_card: "💳",
  auto: "🚗",
  student: "🎓",
  medical: "🩺",
  personal: "🤝",
  mortgage: "🏡",
  heloc: "🔑",
  other: "📄",
};

/** Baby Step 2 is everything but the house; the mortgage is Baby Step 6. */
export function isMortgage(d: Pick<Debt, "type">): boolean {
  return d.type === "mortgage";
}

/** Debt snowball order: smallest balance first, interest rate ignored. Paid-off debts go last. */
export function snowballOrder<T extends Pick<Debt, "balance" | "name">>(debts: T[]): T[] {
  return [...debts].sort((a, b) => {
    const aDone = a.balance <= 0, bDone = b.balance <= 0;
    if (aDone !== bDone) return aDone ? 1 : -1;
    return a.balance - b.balance || a.name.localeCompare(b.name);
  });
}

export interface SnowballResult {
  /** Months until all debts are paid; null if they never get paid off. */
  months: number | null;
  totalInterest: number;
  /** Month number (1-based) each debt is paid off, by debt id. */
  payoffMonth: Record<string, number>;
}

/**
 * Simulates the debt snowball: pay every minimum, then throw the extra (plus
 * each paid-off debt's minimum) at the smallest balance.
 */
export function simulateSnowball(
  debts: Pick<Debt, "id" | "name" | "balance" | "interest_rate" | "minimum_payment">[],
  extraPerMonth: number,
  maxMonths = 600,
): SnowballResult {
  const live = snowballOrder(debts.filter((d) => d.balance > 0)).map((d) => ({
    id: d.id,
    balance: d.balance,
    rate: (d.interest_rate || 0) / 100 / 12,
    min: d.minimum_payment || 0,
  }));
  const payoffMonth: Record<string, number> = {};
  let totalInterest = 0;
  const budget = live.reduce((s, d) => s + d.min, 0) + Math.max(0, extraPerMonth);
  if (live.length === 0) return { months: 0, totalInterest: 0, payoffMonth };

  for (let month = 1; month <= maxMonths; month++) {
    for (const d of live) {
      if (d.balance <= 0) continue;
      const interest = d.balance * d.rate;
      totalInterest += interest;
      d.balance += interest;
    }
    let pool = budget;
    // Minimums first...
    for (const d of live) {
      if (d.balance <= 0) continue;
      const pay = Math.min(d.min, d.balance, pool);
      d.balance -= pay;
      pool -= pay;
    }
    // ...then everything left goes to the smallest balance, then the next.
    for (const d of live) {
      if (pool <= 0) break;
      if (d.balance <= 0) continue;
      const pay = Math.min(d.balance, pool);
      d.balance -= pay;
      pool -= pay;
    }
    for (const d of live) {
      if (d.balance <= 0.005 && payoffMonth[d.id] === undefined) {
        d.balance = 0;
        payoffMonth[d.id] = month;
      }
    }
    if (live.every((d) => d.balance <= 0)) {
      return { months: month, totalInterest: round2(totalInterest), payoffMonth };
    }
  }
  return { months: null, totalInterest: round2(totalInterest), payoffMonth };
}

/** Share of the original balance already paid, 0..1. */
export function paidShare(d: Pick<Debt, "balance" | "original_balance">): number {
  const start = Math.max(d.original_balance || 0, d.balance);
  if (start <= 0) return d.balance <= 0 ? 1 : 0;
  return Math.max(0, Math.min(1, 1 - d.balance / start));
}

export function addMonthsLabel(months: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth() + months, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
