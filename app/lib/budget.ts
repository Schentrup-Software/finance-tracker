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

export interface EnvelopeSummary {
  envelope: Envelope;
  /** Assigned to this envelope for the month. */
  planned: number;
  /** Left over from earlier months (rollover envelopes only). */
  carried: number;
  spent: number;
  /** Cash still in the envelope. Negative means overspent. */
  left: number;
  /** 0..1 share of the envelope's cash still left. */
  fullness: number;
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
): BudgetSummary {
  const planned = new Map<string, number>();
  for (const a of allocations) planned.set(a.envelope, (planned.get(a.envelope) ?? 0) + a.amount);

  const byEnvelope = new Map<string, Transaction[]>();
  const unassignedSpending: Transaction[] = [];
  let receivedIncome = 0;
  for (const t of transactions) {
    if (t.kind === "income") {
      receivedIncome += t.amount;
    } else if (t.envelope) {
      const arr = byEnvelope.get(t.envelope) ?? [];
      arr.push(t);
      byEnvelope.set(t.envelope, arr);
    } else {
      unassignedSpending.push(t);
    }
  }

  const visible = envelopes.filter((e) => !e.archived || planned.has(e.id) || byEnvelope.has(e.id));
  const summaries = visible.map<EnvelopeSummary>((envelope) => {
    const p = planned.get(envelope.id) ?? 0;
    const c = envelope.rollover ? round2(carried[envelope.id] ?? 0) : 0;
    const txs = byEnvelope.get(envelope.id) ?? [];
    const spent = round2(txs.reduce((s, t) => s + t.amount, 0));
    const total = p + c;
    const left = round2(total - spent);
    const fullness = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
    return { envelope, planned: p, carried: c, spent, left, fullness, transactions: txs };
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
