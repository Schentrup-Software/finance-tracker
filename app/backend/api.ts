// ALL PocketBase calls go through this file. Components never call pb directly.

import pb from "./pocketbaseClient";
import type {
  Allocation, Asset, BaseRecord, Budget, Debt, DebtPayment, Draft, Envelope, Transaction,
} from "./types";
import { monthRange } from "~/lib/dates";

// ---------- Auth ----------

export function isSignedIn(): boolean {
  return pb.authStore.isValid;
}

export function currentUserEmail(): string {
  return (pb.authStore.record?.email as string | undefined) ?? "";
}

export async function signupOpen(): Promise<boolean> {
  try {
    const res = await pb.send<{ signupOpen: boolean }>("/api/finance/setup", { method: "GET" });
    return res.signupOpen;
  } catch {
    return false;
  }
}

export async function signIn(email: string, password: string) {
  await pb.collection("users").authWithPassword(email, password);
}

export async function signUp(email: string, password: string) {
  await pb.collection("users").create({ email, password, passwordConfirm: password });
  await signIn(email, password);
}

export function signOut() {
  pb.authStore.clear();
}

/** Re-checks a stored token with the server; signs out if it is no longer valid. */
export async function refreshAuth(): Promise<boolean> {
  if (!pb.authStore.isValid) return false;
  try {
    await pb.collection("users").authRefresh();
    return true;
  } catch (err: any) {
    if (err?.status === 401 || err?.status === 403 || err?.status === 404) {
      pb.authStore.clear();
      return false;
    }
    return true; // offline or server hiccup: keep the session
  }
}

// ---------- Generic helpers ----------

type Name =
  | "envelopes" | "budgets" | "allocations" | "transactions"
  | "debts" | "debt_payments" | "assets";

function list<T>(name: Name, options: { filter?: string; sort?: string } = {}) {
  return pb.collection(name).getFullList<T>({ batch: 500, ...options });
}

function create<T extends BaseRecord>(name: Name, data: Draft<T>) {
  return pb.collection(name).create<T>({ ...data, owner: pb.authStore.record?.id });
}

function update<T extends BaseRecord>(name: Name, id: string, data: Draft<T>) {
  return pb.collection(name).update<T>(id, data);
}

function remove(name: Name, id: string) {
  return pb.collection(name).delete(id);
}

/** Calls `onChange` whenever any of the collections change (app, other tab or n8n). */
export function subscribeAll(names: Name[], onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 250);
  };
  const unsubs: Promise<() => Promise<void>>[] = names.map((n) =>
    pb.collection(n).subscribe("*", debounced).catch(() => async () => {}),
  );
  return () => {
    clearTimeout(timer);
    unsubs.forEach((p) => p.then((u) => u()).catch(() => {}));
  };
}

/** PocketBase stores dates as "YYYY-MM-DD HH:MM:SS.sssZ". Noon UTC keeps the day stable in any time zone. */
export function toPbDate(day: string): string {
  return day ? `${day} 12:00:00.000Z` : "";
}

export function fromPbDate(value: string): string {
  return value ? value.slice(0, 10) : "";
}

// ---------- Budget ----------

export interface MonthData {
  budget: Budget | null;
  envelopes: Envelope[];
  allocations: Allocation[];
  transactions: Transaction[];
  /** Per envelope: money carried in from earlier months (rollover envelopes only). */
  carried: Record<string, number>;
}

export async function loadMonth(month: string): Promise<MonthData> {
  const { start, end } = monthRange(month);
  const [envelopes, budgets, transactions] = await Promise.all([
    list<Envelope>("envelopes", { sort: "sort,created" }),
    list<Budget>("budgets", { filter: pb.filter("month = {:m}", { m: month }) }),
    list<Transaction>("transactions", {
      filter: pb.filter("date >= {:s} && date < {:e}", { s: start, e: end }),
      sort: "-date,-created",
    }),
  ]);
  const budget = budgets[0] ?? null;
  const allocations = budget
    ? await list<Allocation>("allocations", { filter: pb.filter("budget = {:b}", { b: budget.id }) })
    : [];

  // Rollover (sinking fund) envelopes keep what was left in earlier months.
  const carried: Record<string, number> = {};
  if (envelopes.some((e) => e.rollover)) {
    const [pastAlloc, pastSpent] = await Promise.all([
      list<Allocation>("allocations", {
        filter: pb.filter("envelope.rollover = true && budget.month < {:m}", { m: month }),
      }),
      list<Transaction>("transactions", {
        filter: pb.filter("kind = 'expense' && envelope.rollover = true && date < {:s}", { s: start }),
      }),
    ]);
    for (const a of pastAlloc) carried[a.envelope] = (carried[a.envelope] ?? 0) + a.amount;
    for (const t of pastSpent) carried[t.envelope] = (carried[t.envelope] ?? 0) - t.amount;
  }

  return { budget, envelopes, allocations, transactions, carried };
}

/**
 * Creates the budget for a month. Envelope amounts are copied from the most
 * recent earlier month that has a budget, or from each envelope's default.
 */
export async function startMonth(month: string, plannedIncome?: number): Promise<Budget> {
  const previous = await list<Budget>("budgets", {
    filter: pb.filter("month < {:m}", { m: month }),
    sort: "-month",
  });
  const last = previous[0];
  const lastAlloc = last
    ? await list<Allocation>("allocations", { filter: pb.filter("budget = {:b}", { b: last.id }) })
    : [];
  const envelopes = await list<Envelope>("envelopes", { filter: "archived = false" });

  const budget = await create<Budget>("budgets", {
    month,
    planned_income: plannedIncome ?? last?.planned_income ?? 0,
  });
  const fromLast = new Map(lastAlloc.map((a) => [a.envelope, a.amount]));
  await Promise.all(
    envelopes.map((e) =>
      create<Allocation>("allocations", {
        budget: budget.id,
        envelope: e.id,
        amount: fromLast.get(e.id) ?? e.default_amount ?? 0,
      }),
    ),
  );
  return budget;
}

export function updateBudget(id: string, data: Draft<Budget>) {
  return update<Budget>("budgets", id, data);
}

export async function setAllocation(budgetId: string, envelopeId: string, amount: number) {
  const existing = await list<Allocation>("allocations", {
    filter: pb.filter("budget = {:b} && envelope = {:e}", { b: budgetId, e: envelopeId }),
  });
  if (existing[0]) return update<Allocation>("allocations", existing[0].id, { amount });
  return create<Allocation>("allocations", { budget: budgetId, envelope: envelopeId, amount });
}

export const createEnvelope = (d: Draft<Envelope>) => create<Envelope>("envelopes", d);
export const updateEnvelope = (id: string, d: Draft<Envelope>) => update<Envelope>("envelopes", id, d);
export const deleteEnvelope = (id: string) => remove("envelopes", id);

export const createTransaction = (d: Draft<Transaction>) => create<Transaction>("transactions", d);
export const updateTransaction = (id: string, d: Draft<Transaction>) => update<Transaction>("transactions", id, d);
export const deleteTransaction = (id: string) => remove("transactions", id);


// ---------- Debts ----------

export const listDebts = () => list<Debt>("debts", { sort: "balance" });
export const createDebt = (d: Draft<Debt>) => create<Debt>("debts", d);
export const updateDebt = (id: string, d: Draft<Debt>) => update<Debt>("debts", id, d);
export const deleteDebt = (id: string) => remove("debts", id);

export const listPayments = (debtId: string) =>
  list<DebtPayment>("debt_payments", { filter: pb.filter("debt = {:d}", { d: debtId }), sort: "-date,-created" });
/** Recording a payment lowers the debt's balance (done server-side in pb_hooks). */
export const createPayment = (d: Draft<DebtPayment>) => create<DebtPayment>("debt_payments", d);
export const deletePayment = (id: string) => remove("debt_payments", id);

// ---------- Assets ----------

export const listAssets = () => list<Asset>("assets", { sort: "-value" });
export const createAsset = (d: Draft<Asset>) => create<Asset>("assets", d);
export const updateAsset = (id: string, d: Draft<Asset>) => update<Asset>("assets", id, d);
export const deleteAsset = (id: string) => remove("assets", id);

/** Turns a PocketBase error into one readable sentence. */
export function errorMessage(err: unknown): string {
  const e = err as any;
  const fields = e?.response?.data;
  if (fields && typeof fields === "object") {
    const first = Object.entries(fields)[0] as [string, any] | undefined;
    if (first) return `${first[0].replace(/_/g, " ")}: ${first[1]?.message ?? "is invalid"}`;
  }
  return e?.response?.message || e?.message || "Something went wrong.";
}
