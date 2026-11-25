// ALL PocketBase calls go through this file. Components never call pb directly.

import pb, { POCKETBASE_URL } from "./pocketbaseClient";
import type {
  Allocation, Asset, BaseRecord, Budget, Debt, DebtPayment, Draft, Earner, Envelope, Paystub, PaystubLine, TaxDocument,
  TaxYear, Transaction, Vendor,
} from "./types";
import { monthRange } from "~/lib/dates";

// ---------- Auth ----------

export function isSignedIn(): boolean {
  return pb.authStore.isValid;
}

export function currentUserEmail(): string {
  return (pb.authStore.record?.email as string | undefined) ?? "";
}

/** The household the signed-in user belongs to. Its id is the head's user id, and owns all the data. */
function householdId(): string {
  const r = pb.authStore.record;
  return (r?.household as string | undefined) || r?.id || "";
}

/** Whether the signed-in user is the head of their household (who manages its members). */
export function isHouseholdHead(): boolean {
  const r = pb.authStore.record;
  return !!r && householdId() === r.id;
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
  | "debts" | "debt_payments" | "assets"
  | "earners" | "paystubs" | "paystub_lines"
  | "vendors" | "tax_documents" | "tax_years";

function list<T>(name: Name, options: { filter?: string; sort?: string } = {}) {
  return pb.collection(name).getFullList<T>({ batch: 500, ...options });
}

function create<T extends BaseRecord>(name: Name, data: Draft<T>) {
  return pb.collection(name).create<T>({ ...data, owner: householdId() });
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
  /** Per envelope: money carried in from earlier months (rollover and annual envelopes). */
  carried: Record<string, number>;
  /** Per envelope: spent so far this calendar year, through the end of the month. */
  yearSpent: Record<string, number>;
}

export async function loadMonth(month: string): Promise<MonthData> {
  const { start, end } = monthRange(month);
  const [envelopes, budgets, transactions, balances] = await Promise.all([
    list<Envelope>("envelopes", { sort: "sort,created" }),
    list<Budget>("budgets", { filter: pb.filter("month = {:m}", { m: month }) }),
    list<Transaction>("transactions", {
      filter: pb.filter("date >= {:s} && date < {:e}", { s: start, e: end }),
      sort: "-date,-created",
    }),
    pb.send<{ carried: Record<string, number>; year_spent: Record<string, number> }>(
      `/api/finance/balances?month=${month}`, { method: "GET" }),
  ]);
  const budget = budgets[0] ?? null;
  const allocations = budget
    ? await list<Allocation>("allocations", { filter: pb.filter("budget = {:b}", { b: budget.id }) })
    : [];
  return { budget, envelopes, allocations, transactions, carried: balances.carried, yearSpent: balances.year_spent };
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
  // An imported month's allocations are transfers, not a plan: start from the usual amounts.
  const fromLast = new Map<string, number>(last?.imported ? [] : lastAlloc.map((a) => [a.envelope, Math.max(0, a.amount)]));
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

// ---------- Household ----------

export interface Member {
  id: string;
  email: string;
  name: string;
  isHead: boolean;
  isMe: boolean;
}

/** Everyone in the signed-in user's household, head first. */
export async function listHousehold(): Promise<Member[]> {
  const me = pb.authStore.record?.id;
  const head = householdId();
  const users = await pb.collection("users").getFullList<{ id: string; email?: string; name?: string }>({ sort: "created" });
  return users
    .map((u) => ({ id: u.id, email: u.email ?? "", name: u.name ?? "", isHead: u.id === head, isMe: u.id === me }))
    .sort((a, b) => Number(b.isHead) - Number(a.isHead));
}

export function addMember(member: { email: string; name: string; password: string }) {
  return pb.send<{ id: string }>("/api/household/members", { method: "POST", body: member });
}

export function setMemberPassword(id: string, password: string) {
  return pb.send(`/api/household/members/${id}/password`, { method: "POST", body: { password } });
}

export function removeMember(id: string) {
  return pb.send(`/api/household/members/${id}`, { method: "DELETE" });
}

/** Changes the signed-in user's own name. */
export async function updateMyName(name: string) {
  const id = pb.authStore.record?.id;
  if (id) await pb.collection("users").update(id, { name });
}

// ---------- API tokens ----------

export interface ApiToken {
  id: string;
  name: string;
  /** The token's first few characters, to tell tokens apart. */
  prefix: string;
  created: string;
  last_used: string;
  /** The household member the token acts as. */
  user: { id: string; name: string; email: string } | null;
}

/** The address API clients (n8n) send requests to. */
export function apiBaseUrl(): string {
  return POCKETBASE_URL.replace(/\/+$/, "");
}

export async function listApiTokens(): Promise<ApiToken[]> {
  return (await pb.send<{ items: ApiToken[] }>("/api/tokens", { method: "GET" })).items;
}

/** Makes a token that acts as the signed-in user. The returned `token` is shown once and never again. */
export function createApiToken(name: string) {
  return pb.send<ApiToken & { token: string }>("/api/tokens", { method: "POST", body: { name } });
}

export function revokeApiToken(id: string) {
  return pb.send(`/api/tokens/${id}`, { method: "DELETE" });
}

// ---------- Import ----------

/** Upserts records by external_id through the sync endpoint, in batches of 500. */
export async function syncRecords(collection: "envelopes" | "transactions", records: object[], onProgress?: (done: number) => void) {
  let done = 0;
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    await pb.send(`/api/sync/${collection}`, { method: "POST", body: { records: batch } });
    done += batch.length;
    onProgress?.(done);
  }
}

export interface ImportMonth {
  month: string;
  planned_income: number;
  allocations: { envelope_external_id: string; amount: number }[];
}

export function importBudgets(months: ImportMonth[]) {
  return pb.send<{ budgets_created: number; allocations: number }>("/api/import/budgets", { method: "POST", body: { months } });
}

export const listEnvelopes = () => list<Envelope>("envelopes", { sort: "sort,created" });

export const createTransaction = (d: Draft<Transaction>) => create<Transaction>("transactions", d);
export const updateTransaction = (id: string, d: Draft<Transaction>) => update<Transaction>("transactions", id, d);
export const deleteTransaction = (id: string) => remove("transactions", id);

/** All transactions from `from` (inclusive) to `to` (exclusive), both YYYY-MM-DD. */
export const listTransactionsBetween = (from: string, to: string) =>
  list<Transaction>("transactions", {
    filter: pb.filter("date >= {:s} && date < {:e}", { s: `${from} 00:00:00.000Z`, e: `${to} 00:00:00.000Z` }),
    sort: "-date,-created",
  });

// ---------- Vendors ----------

export const listVendors = () => list<Vendor>("vendors", { sort: "name" });
export const createVendor = (d: Draft<Vendor>) => create<Vendor>("vendors", d);
export const updateVendor = (id: string, d: Draft<Vendor>) => update<Vendor>("vendors", id, d);
export const deleteVendor = (id: string) => remove("vendors", id);

export const listVendorTransactions = (vendorId: string) =>
  list<Transaction>("transactions", { filter: pb.filter("vendor = {:v}", { v: vendorId }), sort: "-date,-created" });

/** Links earlier transactions with no vendor that fit the vendor's statement values. */
export function backfillVendor(id: string) {
  return pb.send<{ matched: number }>(`/api/vendors/${id}/backfill`, { method: "POST" });
}

/** Moves a vendor's transactions, documents and statement values into another vendor, then deletes it. */
export function mergeVendor(id: string, into: string) {
  return pb.send<{ moved: number }>(`/api/vendors/${id}/merge`, { method: "POST", body: { into } });
}

export interface UnmatchedStatement {
  pattern: string;
  count: number;
  total: number;
  last_date: string;
  example: string;
}

/** Statement values with no vendor yet, most frequent first. */
export async function listUnmatched(): Promise<UnmatchedStatement[]> {
  return (await pb.send<{ items: UnmatchedStatement[] }>("/api/vendors/unmatched", { method: "GET" })).items;
}

// ---------- Taxes ----------

export async function getTaxYear(year: number): Promise<TaxYear | null> {
  const rows = await list<TaxYear>("tax_years", { filter: pb.filter("year = {:y}", { y: year }) });
  return rows[0] ?? null;
}

export function saveTaxYear(existing: TaxYear | null | undefined, data: Draft<TaxYear>) {
  return existing ? update<TaxYear>("tax_years", existing.id, data) : create<TaxYear>("tax_years", data);
}

export const listTaxDocuments = (year: number) =>
  list<TaxDocument>("tax_documents", { filter: pb.filter("tax_year = {:y}", { y: year }), sort: "created" });

export const listTransactionDocuments = (txId: string) =>
  list<TaxDocument>("tax_documents", { filter: pb.filter("transaction = {:t}", { t: txId }), sort: "created" });

export async function uploadTaxDocument(file: File, data: Draft<TaxDocument>): Promise<TaxDocument> {
  const form = new FormData();
  for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) form.append(k, String(v));
  form.append("file", file);
  form.append("owner", householdId());
  return pb.collection("tax_documents").create<TaxDocument>(form);
}

export const deleteTaxDocument = (id: string) => remove("tax_documents", id);

/** A short-lived link to a tax document (files are protected). */
export async function taxDocumentUrl(d: TaxDocument, download = false): Promise<string> {
  const token = await pb.files.getToken();
  return pb.files.getURL(d, d.file, { token, ...(download ? { download: true } : {}) });
}

/** The calendar year's paystubs and lines, for the AGI estimate. */
export async function loadYearPaystubs(year: number) {
  const ys = `${year}-01-01 00:00:00.000Z`, ye = `${year + 1}-01-01 00:00:00.000Z`;
  const [paystubs, lines] = await Promise.all([
    list<Paystub>("paystubs", { filter: pb.filter("pay_date >= {:s} && pay_date < {:e}", { s: ys, e: ye }) }),
    list<PaystubLine>("paystub_lines", { filter: pb.filter("paystub.pay_date >= {:s} && paystub.pay_date < {:e}", { s: ys, e: ye }) }),
  ]);
  return { paystubs, lines };
}

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

// ---------- Paychecks ----------

export const listEarners = () => list<Earner>("earners", { sort: "created" });
export const createEarner = (d: Draft<Earner>) => create<Earner>("earners", d);
export const updateEarner = (id: string, d: Draft<Earner>) => update<Earner>("earners", id, d);
export const deleteEarner = (id: string) => remove("earners", id);

export interface PaycheckData {
  earners: Earner[];
  /** Paystubs paid in the month, newest first. */
  paystubs: Paystub[];
  lines: PaystubLine[];
  /** Deposits (any month) still waiting for a paystub. */
  waiting: Transaction[];
  /** The whole calendar year the month is in, for year-to-date totals. */
  year: { paystubs: Paystub[]; lines: PaystubLine[] };
}

/** Paycheck deposits (any month) still waiting for a paystub. */
export function listWaitingDeposits(): Promise<Transaction[]> {
  return list<Transaction>("transactions", { filter: "paystub_status = 'needs_paystub'", sort: "-date" });
}

export async function loadPaychecks(month: string): Promise<PaycheckData> {
  const { start, end } = monthRange(month);
  const y = Number(month.slice(0, 4));
  const ys = `${y}-01-01 00:00:00.000Z`, ye = `${y + 1}-01-01 00:00:00.000Z`;
  const [earners, paystubs, lines, waiting, yearPaystubs, yearLines] = await Promise.all([
    listEarners(),
    list<Paystub>("paystubs", { filter: pb.filter("pay_date >= {:s} && pay_date < {:e}", { s: start, e: end }), sort: "-pay_date" }),
    list<PaystubLine>("paystub_lines", {
      filter: pb.filter("paystub.pay_date >= {:s} && paystub.pay_date < {:e}", { s: start, e: end }), sort: "sort,created",
    }),
    listWaitingDeposits(),
    list<Paystub>("paystubs", { filter: pb.filter("pay_date >= {:s} && pay_date < {:e}", { s: ys, e: ye }) }),
    list<PaystubLine>("paystub_lines", { filter: pb.filter("paystub.pay_date >= {:s} && paystub.pay_date < {:e}", { s: ys, e: ye }) }),
  ]);
  return { earners, paystubs, lines, waiting, year: { paystubs: yearPaystubs, lines: yearLines } };
}

export const listPaystubLines = (paystubId: string) =>
  list<PaystubLine>("paystub_lines", { filter: pb.filter("paystub = {:p}", { p: paystubId }), sort: "sort,created" });

/** The most recent paystub for an earner, to prefill a new one. */
export async function latestPaystub(earnerId: string): Promise<{ paystub: Paystub; lines: PaystubLine[] } | null> {
  const rows = await pb.collection("paystubs").getList<Paystub>(1, 1, {
    filter: pb.filter("earner = {:e}", { e: earnerId }), sort: "-pay_date,-created",
  });
  const paystub = rows.items[0];
  return paystub ? { paystub, lines: await listPaystubLines(paystub.id) } : null;
}

export type LineDraft = {
  id?: string; category: PaystubLine["category"]; label: string; amount: number; debt: string; asset: string;
  employer_paid?: boolean;
};

/**
 * Saves a paystub and replaces its lines. The server then ties it to a waiting
 * deposit, and turns loan lines into payments on their debts.
 */
export async function savePaystub(
  existing: Paystub | null,
  data: Draft<Paystub>,
  lines: LineDraft[],
  file?: File | null,
): Promise<Paystub> {
  const form = new FormData();
  for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) form.append(k, String(v));
  if (file) form.append("file", file);
  if (!existing) form.append("owner", householdId());
  const paystub = existing
    ? await pb.collection("paystubs").update<Paystub>(existing.id, form)
    : await pb.collection("paystubs").create<Paystub>(form);

  const before = existing ? await listPaystubLines(existing.id) : [];
  const keep = new Set(lines.filter((l) => l.id).map((l) => l.id));
  await Promise.all(before.filter((l) => !keep.has(l.id)).map((l) => remove("paystub_lines", l.id)));
  await Promise.all(lines.map((l, i) => {
    const d = { paystub: paystub.id, category: l.category, label: l.label, amount: l.amount, debt: l.employer_paid ? "" : l.debt, asset: l.asset,
      employer_paid: !!l.employer_paid, sort: i };
    return l.id ? update<PaystubLine>("paystub_lines", l.id, d) : create<PaystubLine>("paystub_lines", d);
  }));
  // Earlier paychecks still waiting for a paystub, with the same check amount, get a copy of this one.
  if (paystub.source !== "repeat") await backfillPaystub(paystub.id);
  return paystub;
}

/** Copies a paystub to earlier matching deposits that are waiting for one. Returns how many it filled in. */
export async function backfillPaystub(id: string): Promise<number> {
  return (await pb.send<{ filled: number }>(`/api/paystubs/${id}/backfill`, { method: "POST" })).filled;
}

export const deletePaystub = (id: string) => remove("paystubs", id);

/** A short-lived link to a paystub's file (files are protected). */
export async function paystubFileUrl(p: Paystub): Promise<string> {
  const token = await pb.files.getToken();
  return pb.files.getURL(p, p.file, { token });
}

/** Whether the server has an OpenClaw agent to fall back on for reading paystubs. */
export async function agentReaderAvailable(): Promise<boolean> {
  try {
    return (await pb.send<{ agent: boolean }>("/api/paystubs/reader", { method: "GET" })).agent;
  } catch {
    return false;
  }
}

export function readPaystubWithAgent(filename: string, mediaType: string, data: string) {
  return pb.send<unknown>("/api/paystubs/read", {
    method: "POST",
    body: { filename, media_type: mediaType, data },
    requestKey: null,
  });
}

/** Debts that some paystub pays down (401(k) loans and the like). */
export async function listPayrollDebtIds(): Promise<Set<string>> {
  const rows = await list<PaystubLine>("paystub_lines", { filter: "debt != ''" });
  return new Set(rows.map((r) => r.debt));
}

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
