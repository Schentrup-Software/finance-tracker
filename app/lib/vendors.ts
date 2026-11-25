// Vendors: who the money goes to, matched from each transaction's statement
// value (its payee), plus recurring payments and spending by vendor.
//
// The matching functions mirror pb_hooks/finance/match.js, which does the same on
// the server; testing/unit/vendors.test.ts runs both on the same cases.

import type { Cadence, Transaction, Vendor } from "~/backend/types";
import { round2 } from "./money";

/** Upper case, one space between words. */
export function cleanStatement(s: string | null | undefined): string {
  return String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * The stable start of a statement value: trailing words with digits in them
 * (reference numbers, phone numbers, dates, store numbers) are dropped.
 *   "PayPal *StMarysChurch 402-555-0100" -> "PAYPAL *STMARYSCHURCH"
 */
export function normalizeStatement(s: string | null | undefined): string {
  const words = cleanStatement(s).split(" ").filter((w) => w !== "");
  while (words.length > 1 && /\d/.test(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/** Whether a statement value starts with the pattern, at a word boundary. */
export function matchesPattern(statement: string, pattern: string): boolean {
  const s = cleanStatement(statement);
  const p = cleanStatement(pattern);
  if (!p || !s.startsWith(p)) return false;
  if (s.length === p.length) return true;
  return !/[A-Z0-9]/.test(s.charAt(p.length)) || !/[A-Z0-9]/.test(p.charAt(p.length - 1));
}

/** The vendor whose longest pattern fits the statement value, or null. */
export function matchVendor<V extends Pick<Vendor, "matches">>(statement: string, vendors: V[]): V | null {
  let best: V | null = null;
  let bestLength = 0;
  for (const v of vendors) {
    for (const raw of v.matches ?? []) {
      const p = cleanStatement(raw);
      if (p.length > bestLength && matchesPattern(statement, p)) {
        best = v;
        bestLength = p.length;
      }
    }
  }
  return best;
}

/** A tidy name to suggest for a new vendor: "PAYPAL *STMARYSCHURCH" -> "Stmaryschurch". */
export function suggestVendorName(statement: string): string {
  const base = normalizeStatement(statement)
    .replace(/^(PAYPAL|SQ|SP|TST|PY|IN|DD|CKE|PP|POS|ACH|DEBIT|CHECKCARD|PURCHASE)\s*\*\s*/i, "")
    .replace(/[*#].*$/, "")
    .trim();
  return base.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) || statement.trim();
}

// ---------- Recurring payments ----------

const DAY = 864e5;

export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Every week", biweekly: "Every two weeks", monthly: "Every month", quarterly: "Every quarter", annual: "Every year",
};

/** Days between payments, and how far off a payment can be and still fit. */
const CADENCE_DAYS: Record<Cadence, [number, number]> = {
  weekly: [7, 2], biweekly: [14, 3], monthly: [30.4, 4], quarterly: [91, 8], annual: [365, 12],
};

const dayOf = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface RecurringGuess {
  cadence: Cadence;
  amount: number;
  day: number;
}

/**
 * Whether a vendor's payments look recurring: three or more payments (the most
 * recent ones), evenly spaced, of about the same amount (within 10%).
 */
export function guessRecurring(payments: Pick<Transaction, "date" | "amount" | "kind">[]): RecurringGuess | null {
  const spent = payments.filter((p) => p.kind === "expense").sort((a, b) => a.date.localeCompare(b.date)).slice(-6);
  if (spent.length < 3) return null;
  const days = spent.map((p) => dayOf(p.date));
  const gaps = days.slice(1).map((d, i) => (d - days[i]) / DAY);
  const gap = median(gaps);
  const cadence = (Object.keys(CADENCE_DAYS) as Cadence[]).find((c) => {
    const [n, slack] = CADENCE_DAYS[c];
    return gaps.every((g) => Math.abs(g - n) <= slack);
  });
  if (!cadence || gap <= 0) return null;
  const amount = round2(median(spent.map((p) => p.amount)));
  if (!spent.every((p) => Math.abs(p.amount - amount) <= amount * 0.1 + 0.005)) return null;
  return { cadence, amount, day: +spent[spent.length - 1].date.slice(8, 10) };
}

/** When the next payment is due after `last` (YYYY-MM-DD). */
export function nextExpected(cadence: Cadence, last: string, day = 0): string {
  const t = dayOf(last);
  if (cadence === "weekly") return isoOf(t + 7 * DAY);
  if (cadence === "biweekly") return isoOf(t + 14 * DAY);
  const months = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const y = +last.slice(0, 4), m = +last.slice(5, 7) - 1 + months;
  const want = day || +last.slice(8, 10);
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return isoOf(Date.UTC(y, m, Math.min(want, lastDay)));
}

export type RecurringStatus = "ok" | "missed" | "changed" | "none";

export interface RecurringState {
  status: RecurringStatus;
  last: string;
  lastAmount: number;
  next: string;
}

/**
 * A recurring vendor's state on `today`: missed when the next payment is more
 * than a week late, changed when the last one differs from the expected amount
 * by more than 10%.
 */
export function recurringState(
  vendor: Pick<Vendor, "recurring" | "expected_amount" | "expected_day">,
  payments: Pick<Transaction, "date" | "amount" | "kind">[],
  today: string,
): RecurringState {
  const spent = payments.filter((p) => p.kind === "expense").sort((a, b) => a.date.localeCompare(b.date));
  const lastTx = spent[spent.length - 1];
  if (!vendor.recurring || !lastTx) return { status: "none", last: lastTx?.date.slice(0, 10) ?? "", lastAmount: lastTx?.amount ?? 0, next: "" };
  const last = lastTx.date.slice(0, 10);
  const next = nextExpected(vendor.recurring, last, vendor.expected_day);
  let status: RecurringStatus = "ok";
  if (dayOf(today) > dayOf(next) + 7 * DAY) status = "missed";
  else if (vendor.expected_amount > 0 && Math.abs(lastTx.amount - vendor.expected_amount) > vendor.expected_amount * 0.1 + 0.005) {
    status = "changed";
  }
  return { status, last, lastAmount: lastTx.amount, next };
}

/** About how much a recurring vendor costs a month. */
export function monthlyCost(cadence: Cadence, amount: number): number {
  const perYear = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, annual: 1 }[cadence];
  return round2((amount * perYear) / 12);
}

// ---------- Where the money goes ----------

export interface VendorSpending {
  /** The vendor's id, or "" for spending with no vendor yet. */
  vendor: string;
  total: number;
  count: number;
  envelopes: string[];
  /** Spending in the comparison period (e.g. the same months last year). */
  before: number;
}

/**
 * Net spending per vendor (refunds from a vendor count against it), largest
 * first. Paycheck deposits and income with no vendor are left out.
 */
export function spendingByVendor(
  txs: Pick<Transaction, "vendor" | "kind" | "amount" | "envelope" | "earner">[],
  previous: Pick<Transaction, "vendor" | "kind" | "amount" | "earner">[] = [],
): VendorSpending[] {
  const rows = new Map<string, VendorSpending>();
  const row = (v: string) => {
    let r = rows.get(v);
    if (!r) rows.set(v, (r = { vendor: v, total: 0, count: 0, envelopes: [], before: 0 }));
    return r;
  };
  const counts = (t: Pick<Transaction, "vendor" | "kind" | "earner">) => !t.earner && (t.kind === "expense" || !!t.vendor);
  for (const t of txs) {
    if (!counts(t)) continue;
    const r = row(t.vendor);
    r.total = round2(r.total + (t.kind === "expense" ? t.amount : -t.amount));
    r.count++;
    if (t.envelope && !r.envelopes.includes(t.envelope)) r.envelopes.push(t.envelope);
  }
  for (const t of previous) {
    if (!counts(t) || !rows.has(t.vendor)) continue;
    const r = rows.get(t.vendor)!;
    r.before = round2(r.before + (t.kind === "expense" ? t.amount : -t.amount));
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}
