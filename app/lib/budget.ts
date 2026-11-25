import type { Allocation, Envelope, EnvelopeGroup, Transaction } from "~/backend/types";
import { round2 } from "./money";

export const GROUP_LABELS: Record<EnvelopeGroup, string> = {
  giving: "Giving",
  saving: "Saving",
  housing: "Housing",
  utilities: "Utilities",
  food: "Food",
  transportation: "Transportation",
  insurance: "Insurance",
  health: "Health",
  personal: "Personal",
  lifestyle: "Lifestyle",
  debt: "Debt",
  other: "Other",
};

/** Suggested starter envelopes, following the categories in a Ramsey budget. */
export const STARTER_ENVELOPES: { name: string; group: EnvelopeGroup; emoji: string; color: Envelope["color"] }[] = [
  { name: "Giving", group: "giving", emoji: "🎁", color: "pink" },
  { name: "Emergency Fund", group: "saving", emoji: "🛟", color: "aqua" },
  { name: "Rent / Mortgage", group: "housing", emoji: "🏠", color: "sky" },
  { name: "Utilities", group: "utilities", emoji: "💡", color: "butter" },
  { name: "Groceries", group: "food", emoji: "🥕", color: "mint" },
  { name: "Restaurants", group: "food", emoji: "🍕", color: "peach" },
  { name: "Gas", group: "transportation", emoji: "⛽", color: "coral" },
  { name: "Fun Money", group: "lifestyle", emoji: "🎈", color: "lilac" },
];

export const isAnnual = (e: Pick<Envelope, "period">) => e.period === "annual";

export interface EnvelopeSummary {
  envelope: Envelope;
  /** Assigned to this envelope for the month (envelope transfers can make it negative). */
  planned: number;
  /** Left over from earlier months (rollover and annual envelopes). */
  carried: number;
  /** Money that went straight into the envelope this month (refunds, reimbursements). */
  added: number;
  spent: number;
  /** Cash still in the envelope. Negative means overspent. */
  left: number;
  /** 0..1 share of the envelope's cash still left; for annual envelopes, of the yearly goal. */
  fullness: number;
  /** Annual envelopes: spent so far this year. */
  yearSpent: number;
  /**
   * The month is before the envelope's opening balance (an import), when fills
   * aren't known: only its spending is shown, not a balance.
   */
  historyOnly: boolean;
  transactions: Transaction[];
}

export interface BudgetSummary {
  plannedIncome: number;
  receivedIncome: number;
  assigned: number;
  /** Zero-based budgeting: income minus everything assigned. Goal is $0. */
  leftToBudget: number;
  spent: number;
  envelopes: EnvelopeSummary[];
  unassignedSpending: Transaction[];
}

export function summarize(
  envelopes: Envelope[],
  allocations: Allocation[],
  transactions: Transaction[],
  carried: Record<string, number>,
  plannedIncome: number,
  month = "",
  yearSpent: Record<string, number> = {},
): BudgetSummary {
  const planned = new Map<string, number>();
  for (const a of allocations) planned.set(a.envelope, (planned.get(a.envelope) ?? 0) + a.amount);

  const byEnvelope = new Map<string, Transaction[]>();
  const unassignedSpending: Transaction[] = [];
  let receivedIncome = 0;
  for (const t of transactions) {
    if (t.envelope) {
      const arr = byEnvelope.get(t.envelope) ?? [];
      arr.push(t);
      byEnvelope.set(t.envelope, arr);
    } else if (t.kind === "income") {
      receivedIncome += t.amount;
    } else {
      unassignedSpending.push(t);
    }
  }

  const visible = envelopes.filter((e) => !e.archived || planned.has(e.id) || byEnvelope.has(e.id));
  const summaries = visible.map<EnvelopeSummary>((envelope) => {
    const p = round2(planned.get(envelope.id) ?? 0);
    const keeps = envelope.rollover || isAnnual(envelope);
    const historyOnly = !!month && !!envelope.opening_date && month < envelope.opening_date.slice(0, 7);
    const c = keeps && !historyOnly ? round2(carried[envelope.id] ?? 0) : 0;
    const txs = byEnvelope.get(envelope.id) ?? [];
    const spent = round2(txs.reduce((s, t) => s + (t.kind === "expense" ? t.amount : 0), 0));
    const added = round2(txs.reduce((s, t) => s + (t.kind === "income" ? t.amount : 0), 0));
    const left = round2(p + c + added - spent);
    const target = isAnnual(envelope) ? envelope.goal || p + c + added : p + c + added;
    const fullness = target > 0 ? Math.max(0, Math.min(1, left / target)) : left > 0 ? 1 : 0;
    return {
      envelope, planned: p, carried: c, added, spent, left, fullness, historyOnly,
      yearSpent: round2(yearSpent[envelope.id] ?? 0), transactions: txs,
    };
  });

  const assigned = round2(summaries.reduce((s, e) => s + e.planned, 0));
  const spent = round2(
    summaries.reduce((s, e) => s + e.spent, 0) + unassignedSpending.reduce((s, t) => s + t.amount, 0),
  );

  return {
    plannedIncome,
    receivedIncome: round2(receivedIncome),
    assigned,
    leftToBudget: round2(plannedIncome - assigned),
    spent,
    envelopes: summaries,
    unassignedSpending,
  };
}

/** What to put in each month to reach an annual goal by December, given what is already saved. */
export function monthlyToGoal(goal: number, saved: number, month: string): number {
  const monthsLeft = 12 - Number(month.slice(5, 7)) + 1;
  return round2(Math.max(0, goal - saved) / Math.max(1, monthsLeft));
}

/**
 * Share of the month still to come (0..1), the "where you should be" tick on an
 * envelope's bar: cash left above it means you're spending slower than the month
 * is passing. Past months are 0 and future months 1.
 */
export function monthLeftShare(month: string, today: Date = new Date()): number {
  const [y, m] = month.split("-").map(Number);
  const ty = today.getFullYear(), tm = today.getMonth() + 1;
  if (y < ty || (y === ty && m < tm)) return 0;
  if (y > ty || m > tm) return 1;
  const days = new Date(y, m, 0).getDate();
  return (days - today.getDate()) / days;
}
