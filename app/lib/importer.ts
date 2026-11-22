// Reads a transaction history spreadsheet (CSV) into records for the app.
//
// Built around envelope-budget exports like Goodbudget's, with the columns
//   Date, Envelope, Account, Name, Notes, Check #, Amount, Status, Details
// Similar files work too: columns are found by header name (Category, Payee,
// Description, Memo, Split…). Amounts are signed: negative is money spent.
//
// How each row is read:
// - "Envelope Transfer" rows move money between envelopes: they become that
//   month's allocations (the [Available] side is left out).
// - A row with an envelope is spending (negative) or money put straight into the
//   envelope (positive, e.g. a refund or a Venmo payback).
// - A row with no envelope but a Details split ("Groceries|-20.00||Gas|-10.00")
//   becomes one record per part. [Available] parts are income for the month.
//   A split on the "[none]" account is an envelope fill, so its parts are allocations.
// - Rows with neither (moving money between accounts, paying a card) and balance
//   adjustments on [Available] are skipped: they don't change any envelope.

import { round2 } from "./money";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sep = guessSeparator(src);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function guessSeparator(text: string): string {
  const first = text.slice(0, text.indexOf("\n") >>> 0 || text.length);
  return (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? "\t" : ",";
}

const HEADERS: Record<string, string[]> = {
  date: ["date", "transaction date", "posted date"],
  envelope: ["envelope", "category", "budget", "envelope name"],
  account: ["account", "account name"],
  name: ["name", "payee", "description", "merchant"],
  notes: ["notes", "note", "memo"],
  check: ["check #", "check", "check number", "check no"],
  amount: ["amount"],
  details: ["details", "split", "splits"],
};

export type Column = keyof typeof HEADERS;

export function findColumns(header: string[]): Partial<Record<Column, number>> {
  const norm = header.map((h) => h.trim().toLowerCase());
  const out: Partial<Record<Column, number>> = {};
  for (const [key, names] of Object.entries(HEADERS) as [Column, string[]][]) {
    const i = norm.findIndex((h) => names.includes(h));
    if (i >= 0) out[key] = i;
  }
  return out;
}

/** "11/22/2026", "2026-11-22" or "1/5/24" -> "2026-11-22" (or "" if it isn't a date). */
export function parseDate(s: string): string {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  return "";
}

function iso(y: number, mo: number, d: number) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "1,000.00", "-48.00", "($12.50)" -> number, or NaN. */
export function parseAmount(s: string): number {
  let t = s.trim().replace(/[$,\s]/g, "");
  if (/^\(.*\)$/.test(t)) t = "-" + t.slice(1, -1);
  return t === "" ? NaN : Number(t);
}

export interface ImportedTransaction {
  external_id: string;
  kind: "expense" | "income";
  /** Envelope name, or "" for income to the budget / spending with no envelope. */
  envelope: string;
  date: string; // YYYY-MM-DD
  amount: number;
  payee: string;
  note: string;
  account: string;
}

export interface FoundEnvelope {
  name: string;
  /** Last day it had activity (YYYY-MM-DD). */
  lastUsed: string;
  count: number;
}

export interface ImportMonthPlan {
  month: string;
  /** Income that went to the budget (not straight into an envelope). */
  income: number;
  /** Envelope name -> net money moved in by transfers and fills. */
  moved: Record<string, number>;
}

export interface ImportPlan {
  transactions: ImportedTransaction[];
  envelopes: FoundEnvelope[];
  months: ImportMonthPlan[];
  firstDate: string;
  lastDate: string;
  skipped: { accountMoves: number; adjustments: number; empty: number };
  /** Rows that couldn't be read, as "Row 12: …". */
  problems: string[];
}

const AVAILABLE = "[available]";
const isTransfer = (name: string) => /^envelope transfer$/i.test(name.trim());
const cleanEnvelope = (s: string) => s.replace(/^DELETED:\s*/i, "").trim();

/** Short stable hash, so the same row gets the same id when imported again. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function planImport(rows: string[][]): ImportPlan {
  if (rows.length < 2) throw new Error("The file has no rows.");
  const col = findColumns(rows[0]);
  if (col.date === undefined || col.amount === undefined) {
    throw new Error("Couldn't find the Date and Amount columns. The first row should name the columns.");
  }
  const get = (r: string[], c: Column) => (col[c] === undefined ? "" : (r[col[c]!] ?? "").trim());

  const plan: ImportPlan = {
    transactions: [], envelopes: [], months: [], firstDate: "", lastDate: "",
    skipped: { accountMoves: 0, adjustments: 0, empty: 0 }, problems: [],
  };
  const months = new Map<string, ImportMonthPlan>();
  const monthFor = (m: string) => {
    let p = months.get(m);
    if (!p) months.set(m, (p = { month: m, income: 0, moved: {} }));
    return p;
  };
  const envs = new Map<string, FoundEnvelope>();
  const seeEnvelope = (name: string, date: string) => {
    const e = envs.get(name) ?? { name, lastUsed: "", count: 0 };
    e.count++;
    if (date > e.lastUsed) e.lastUsed = date;
    envs.set(name, e);
  };
  const seen = new Map<string, number>();

  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const date = parseDate(get(r, "date"));
    const amount = parseAmount(get(r, "amount"));
    if (!date) return void plan.problems.push(`Row ${line}: "${get(r, "date")}" isn't a date.`);
    if (Number.isNaN(amount)) return void plan.problems.push(`Row ${line}: "${get(r, "amount")}" isn't an amount.`);

    const envelope = cleanEnvelope(get(r, "envelope"));
    const name = get(r, "name");
    const details = get(r, "details");
    const rawAccount = get(r, "account");
    const account = rawAccount === "[none]" ? "" : rawAccount;
    const notes = [get(r, "notes"), get(r, "check") && `Check #${get(r, "check")}`].filter(Boolean).join(" · ");
    const month = date.slice(0, 7);

    if (!plan.firstDate || date < plan.firstDate) plan.firstDate = date;
    if (date > plan.lastDate) plan.lastDate = date;
    monthFor(month);

    const key = [date, envelope, rawAccount, name, amount, notes, details].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const id = `import-${hash(key)}-${n}`;

    const add = (env: string, value: number, part?: number) => {
      if (value === 0) return;
      plan.transactions.push({
        external_id: part === undefined ? id : `${id}-${part}`,
        kind: value < 0 ? "expense" : "income",
        envelope: env, date, amount: round2(Math.abs(value)), payee: name, note: notes, account,
      });
      if (env) seeEnvelope(env, date);
      else if (value > 0) monthFor(month).income = round2(monthFor(month).income + value);
    };
    const move = (env: string, value: number) => {
      const m = monthFor(month);
      m.moved[env] = round2((m.moved[env] ?? 0) + value);
      seeEnvelope(env, date);
    };

    if (envelope.toLowerCase() === AVAILABLE) {
      if (!isTransfer(name)) plan.skipped.adjustments++;
      return;
    }
    if (envelope) {
      if (isTransfer(name)) return move(envelope, amount);
      if (amount === 0) return void plan.skipped.empty++;
      return add(envelope, amount);
    }
    if (details) {
      const fill = rawAccount === "[none]" || isTransfer(name);
      details.split("||").forEach((part, p) => {
        const cut = part.lastIndexOf("|");
        if (cut < 0) return;
        const env = cleanEnvelope(part.slice(0, cut));
        const value = parseAmount(part.slice(cut + 1));
        if (Number.isNaN(value) || value === 0) return;
        if (env.toLowerCase() === AVAILABLE) return fill ? undefined : add("", value, p);
        if (fill) move(env, value);
        else add(env, value, p);
      });
      return;
    }
    if (amount === 0) plan.skipped.empty++;
    else plan.skipped.accountMoves++;
  });

  plan.envelopes = [...envs.values()].sort((a, b) => b.lastUsed.localeCompare(a.lastUsed) || b.count - a.count);
  plan.months = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return plan;
}

/** The external_id an imported envelope gets, from its name. */
export function envelopeExternalId(name: string): string {
  return "import-env-" + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** A first guess at an emoji, colour and category for an imported envelope. */
export function guessEnvelopeStyle(name: string): { emoji: string; group: string } {
  const n = name.toLowerCase();
  const rules: [RegExp, string, string][] = [
    [/grocer|food|publix/, "🥕", "food"],
    [/restaurant|dining|eat/, "🍕", "food"],
    [/gas|fuel|car/, "⛽", "transportation"],
    [/bill|utilit|electric|water|phone|internet/, "🧾", "utilities"],
    [/house|home|rent|mortgage/, "🏠", "housing"],
    [/vacation|travel|trip/, "🏖️", "lifestyle"],
    [/christmas|gift|holiday/, "🎄", "giving"],
    [/donat|tithe|giving|church|charity/, "🎁", "giving"],
    [/animal|pet|dog|cat/, "🐾", "other"],
    [/pamper|beauty|hair|spa/, "💅", "personal"],
    [/golf|fun|hobby|book/, "🎈", "lifestyle"],
    [/kid|boys|girls|child|baby/, "🧸", "personal"],
    [/insur/, "🛡️", "insurance"],
    [/doctor|medical|health/, "🩺", "health"],
    [/save|saving|emergency|extra/, "🛟", "saving"],
    [/loan|debt|payment/, "💳", "debt"],
  ];
  for (const [re, emoji, group] of rules) if (re.test(n)) return { emoji, group };
  return { emoji: "✉️", group: "other" };
}
