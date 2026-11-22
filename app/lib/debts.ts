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
  "401k_loan": "401(k) loan",
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
  "401k_loan": "🌳",
  other: "📄",
};

export function isMortgage(d: Pick<Debt, "type">): boolean {
  return d.type === "mortgage" || d.type === "heloc";
}

/** 401(k) loans are repaid by payroll deduction, before the paycheck hits the bank. */
export function isPayrollLoan(d: Pick<Debt, "type">): boolean {
  return d.type === "401k_loan";
}

/**
 * Months until one loan is paid off at a fixed monthly payment, with interest
 * compounding monthly. 0 if already paid; null if the payment never covers the
 * interest (or there is no payment).
 */
export function payoffMonths(balance: number, aprPercent: number, monthlyPayment: number, maxMonths = 1200): number | null {
  if (balance <= 0) return 0;
  if (!monthlyPayment || monthlyPayment <= 0) return null;
  const r = (aprPercent || 0) / 100 / 12;
  if (r > 0 && monthlyPayment <= balance * r) return null;
  let b = balance;
  for (let m = 1; m <= maxMonths; m++) {
    b = b * (1 + r) - monthlyPayment;
    if (b <= 0.005) return m;
  }
  return null;
}

/** Interest still to pay on a loan at its monthly payment. */
export function interestLeft(balance: number, aprPercent: number, monthlyPayment: number): number | null {
  const months = payoffMonths(balance, aprPercent, monthlyPayment);
  if (months === null) return null;
  const r = (aprPercent || 0) / 100 / 12;
  let b = balance, interest = 0;
  for (let m = 0; m < months; m++) {
    const i = b * r;
    interest += i;
    b = Math.max(0, b + i - monthlyPayment);
  }
  return round2(interest);
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
