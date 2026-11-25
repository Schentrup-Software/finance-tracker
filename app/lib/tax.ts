// Tax-deductible spending from the budget: which transactions count, and the
// year-end summary with the IRS floors and limits applied.
//
// Mortgage interest, state taxes and loan interest are out of scope: they are
// reconciled by hand at year end and typed in as one "other itemized" total.

import type {
  Envelope, Paystub, PaystubCategory, PaystubLine, TaxCategory, TaxDocument, TaxPaidBy, TaxYear, Transaction, Vendor,
} from "~/backend/types";
import { round2 } from "./money";

export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
  charity: "Donations",
  medical: "Medical and dental",
  child_care: "Child care",
  ira: "Traditional IRA",
};

export const TAX_CATEGORY_EMOJI: Record<TaxCategory, string> = {
  charity: "🎁", medical: "🩺", child_care: "🧸", ira: "🌱",
};

export const PAID_BY_LABELS: Record<TaxPaidBy, string> = {
  hsa: "HSA", health_fsa: "Health FSA", insurance: "Insurance",
};

/** A single gift of this much or more needs the charity's written acknowledgment. */
export const ACK_THRESHOLD = 250;

// ---------- Yearly figures ----------

export type TaxFigures = Pick<TaxYear,
  | "standard_deduction" | "charity_floor_pct" | "charity_cash_cap_pct" | "nonitemizer_charity_cap" | "medical_floor_pct"
  | "care_cap_one" | "care_cap_two" | "ira_limit" | "ira_catch_up" | "ira_phaseout_start" | "ira_phaseout_end">;

/**
 * Published figures, married filing jointly. A year that isn't here copies the
 * latest one and is marked unconfirmed until someone checks it against the IRS.
 */
export const PUBLISHED_FIGURES: Record<number, TaxFigures> = {
  2026: {
    standard_deduction: 32200,
    charity_floor_pct: 0.5,
    charity_cash_cap_pct: 60,
    nonitemizer_charity_cap: 2000,
    medical_floor_pct: 7.5,
    care_cap_one: 3000,
    care_cap_two: 6000,
    ira_limit: 7500,
    ira_catch_up: 1100,
    // For a spouse covered by a retirement plan at work.
    ira_phaseout_start: 129000,
    ira_phaseout_end: 149000,
  },
};

export type TaxSettings = TaxFigures & Pick<TaxYear, "year" | "agi" | "other_itemized" | "confirmed" | "qualifying_children"> & {
  /** The saved record, when there is one. */
  id?: string;
};

/** The settings for a year: what was saved, or the published (or latest known) figures. */
export function settingsFor(year: number, saved?: TaxYear | null): TaxSettings {
  if (saved) return { ...saved };
  const known = Object.keys(PUBLISHED_FIGURES).map(Number).sort((a, b) => a - b);
  const from = PUBLISHED_FIGURES[year] ? year : known.filter((y) => y <= year).pop() ?? known[0];
  return {
    year, agi: 0, other_itemized: 0, qualifying_children: 0,
    confirmed: from === year,
    ...PUBLISHED_FIGURES[from],
  };
}

// ---------- Which transactions count ----------

/** The transaction's own category, else its vendor's, else its envelope's. "none" means it doesn't count. */
export function effectiveCategory(
  tx: Pick<Transaction, "tax_category">,
  vendor?: Pick<Vendor, "tax_category"> | null,
  envelope?: Pick<Envelope, "tax_category"> | null,
): TaxCategory | null {
  if (tx.tax_category === "none") return null;
  return tx.tax_category || vendor?.tax_category || envelope?.tax_category || null;
}

/** Where the category came from, for showing it in the app. */
export function categorySource(
  tx: Pick<Transaction, "tax_category">,
  vendor?: Pick<Vendor, "tax_category"> | null,
  envelope?: Pick<Envelope, "tax_category"> | null,
): "transaction" | "vendor" | "envelope" | null {
  if (tx.tax_category) return "transaction";
  if (vendor?.tax_category) return "vendor";
  if (envelope?.tax_category) return "envelope";
  return null;
}

/** The tax year a transaction counts for. */
export function taxYearOf(tx: Pick<Transaction, "tax_year" | "date">): number {
  return tx.tax_year || Number(tx.date.slice(0, 4));
}

/** The deductible part: the set part, or the whole amount. Money back (a refund) counts against the total. */
export function deductibleAmount(tx: Pick<Transaction, "amount" | "tax_amount" | "kind">): number {
  const v = tx.tax_amount > 0 ? Math.min(tx.tax_amount, tx.amount) : tx.amount;
  return round2(tx.kind === "income" ? -v : v);
}

export interface TaxRow {
  tx: Transaction;
  category: TaxCategory;
  /** Deductible amount; negative for money back. 0 when excluded. */
  amount: number;
  /** Paid or reimbursed by an HSA, FSA or insurance, so it doesn't count. */
  excluded: TaxPaidBy | "";
  vendor: Vendor | null;
  /** A gift of $250 or more with no acknowledgment yet. */
  needsAck: boolean;
}

/** Whether a document clears the acknowledgment for a gift. */
function acknowledged(tx: Transaction, year: number, docs: TaxDocument[]): boolean {
  if (tx.tax_acknowledged) return true;
  return docs.some((d) =>
    (d.transaction === tx.id && (d.kind === "receipt" || d.kind === "acknowledgment")) ||
    (!!tx.vendor && d.vendor === tx.vendor && d.kind === "year_end_statement" && d.tax_year === year));
}

/** The year's tagged transactions, oldest first. */
export function taxRows(
  txs: Transaction[],
  vendors: Map<string, Vendor>,
  envelopes: Map<string, Envelope>,
  docs: TaxDocument[],
  year: number,
): TaxRow[] {
  const rows: TaxRow[] = [];
  for (const tx of txs) {
    if (taxYearOf(tx) !== year || tx.earner) continue;
    const vendor = vendors.get(tx.vendor) ?? null;
    const category = effectiveCategory(tx, vendor, envelopes.get(tx.envelope));
    if (!category) continue;
    // Medical paid by an HSA, FSA or insurance doesn't count.
    const excluded = category === "medical" ? tx.tax_paid_by : "";
    const amount = excluded ? 0 : deductibleAmount(tx);
    rows.push({
      tx, category, amount, excluded, vendor,
      needsAck: category === "charity" && tx.kind === "expense" && amount >= ACK_THRESHOLD && !acknowledged(tx, year, docs),
    });
  }
  return rows.sort((a, b) => a.tx.date.localeCompare(b.tx.date));
}

// ---------- The year-end summary ----------

export interface ByWhom {
  key: string;
  vendor: Vendor | null;
  total: number;
  count: number;
}

function byVendor(rows: TaxRow[]): ByWhom[] {
  const m = new Map<string, ByWhom>();
  for (const r of rows) {
    const key = r.vendor?.id ?? "";
    const g = m.get(key) ?? { key, vendor: r.vendor, total: 0, count: 0 };
    g.total = round2(g.total + r.amount);
    g.count++;
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

const pct = (agi: number, p: number) => round2((agi * p) / 100);
const sum = (rows: TaxRow[]) => round2(rows.reduce((s, r) => s + r.amount, 0));

export interface TaxReport {
  settings: TaxSettings;
  charity: {
    rows: TaxRow[]; byVendor: ByWhom[]; total: number; floor: number; cap: number; deductible: number;
    /** What a non-itemizer could deduct instead (cash gifts, up to the cap). */
    nonitemizer: number;
  };
  medical: { rows: TaxRow[]; byVendor: ByWhom[]; total: number; excluded: number; floor: number; deductible: number };
  childCare: { rows: TaxRow[]; byVendor: ByWhom[]; total: number; cap: number; qualifying: number };
  ira: {
    rows: TaxRow[];
    people: { person: string; total: number; over: boolean }[];
    total: number;
    limit: number;
    /** Where AGI sits against the deduction's phase-out range for a spouse covered at work. */
    phaseout: "below" | "in" | "above" | "unknown";
  };
  itemized: number;
  standard: number;
  /** Itemizing minus taking the standard deduction (positive: itemizing saves more). */
  difference: number;
  todo: { key: string; text: string; count?: number }[];
}

export function yearReport(rows: TaxRow[], settings: TaxSettings): TaxReport {
  const s = settings;
  const agi = s.agi;
  const of = (c: TaxCategory) => rows.filter((r) => r.category === c);

  const giving = of("charity");
  const givingTotal = sum(giving);
  const floor = pct(agi, s.charity_floor_pct);
  const cap = agi > 0 ? pct(agi, s.charity_cash_cap_pct) : Infinity;
  const charityDeductible = round2(Math.max(0, Math.min(givingTotal - floor, cap)));

  const medicalRows = of("medical");
  const medicalTotal = sum(medicalRows);
  const medicalFloor = pct(agi, s.medical_floor_pct);
  const excludedTotal = round2(medicalRows.filter((r) => r.excluded).reduce((t, r) => t + r.tx.amount, 0));

  const care = of("child_care");
  const careTotal = sum(care);
  const careCap = s.qualifying_children >= 2 ? s.care_cap_two : s.qualifying_children === 1 ? s.care_cap_one : 0;

  const iraRows = of("ira");
  const people = new Map<string, number>();
  for (const r of iraRows) people.set(r.tx.tax_person.trim(), round2((people.get(r.tx.tax_person.trim()) ?? 0) + r.amount));
  const phaseout = !agi ? "unknown" : agi <= s.ira_phaseout_start ? "below" : agi < s.ira_phaseout_end ? "in" : "above";

  const charity = {
    rows: giving, byVendor: byVendor(giving), total: givingTotal, floor, cap: Number.isFinite(cap) ? cap : 0,
    deductible: charityDeductible,
    nonitemizer: round2(Math.max(0, Math.min(givingTotal, s.nonitemizer_charity_cap))),
  };
  const medical = {
    rows: medicalRows, byVendor: byVendor(medicalRows.filter((r) => !r.excluded)), total: medicalTotal,
    excluded: excludedTotal, floor: medicalFloor, deductible: round2(Math.max(0, medicalTotal - medicalFloor)),
  };
  const itemized = round2(charity.deductible + medical.deductible + s.other_itemized);
  const standard = round2(s.standard_deduction + charity.nonitemizer);

  const todo: TaxReport["todo"] = [];
  if (!agi) todo.push({ key: "agi", text: "Enter the year's AGI so the floors can be applied." });
  if (!s.confirmed) todo.push({ key: "figures", text: `Check the ${s.year} figures against the IRS. They were copied from an earlier year.` });
  const unacked = giving.filter((r) => r.needsAck);
  if (unacked.length) {
    todo.push({ key: "ack", count: unacked.length, text: `${unacked.length} gift(s) of $${ACK_THRESHOLD} or more need the charity's written acknowledgment.` });
  }
  const careVendors = new Set(care.map((r) => r.vendor));
  if (care.some((r) => !r.vendor)) todo.push({ key: "care-vendor", text: "Some child care has no provider. Form 2441 needs each provider's name, address and TIN." });
  const noTin = [...careVendors].filter((v): v is Vendor => !!v && (!v.tin || !v.address));
  if (noTin.length) {
    todo.push({ key: "tin", count: noTin.length, text: `${noTin.map((v) => v.name).join(", ")}: add the address and TIN for Form 2441.` });
  }
  if (careTotal > 0 && !s.qualifying_children) todo.push({ key: "children", text: "Enter how many children the child care was for." });
  const over = [...people].filter(([, t]) => t > s.ira_limit);
  if (over.length) {
    todo.push({ key: "ira", text: `IRA contributions over the ${moneyText(s.ira_limit)} limit for ${over.map(([p]) => p || "someone").join(", ")} (the limit is ${moneyText(s.ira_limit + s.ira_catch_up)} at 50 or older).` });
  }
  if (iraRows.some((r) => !r.tx.tax_person.trim())) todo.push({ key: "ira-person", text: "Some IRA contributions don't say whose IRA they went to." });

  return {
    settings: s,
    charity,
    medical,
    childCare: { rows: care, byVendor: byVendor(care), total: careTotal, cap: careCap, qualifying: round2(Math.max(0, Math.min(careTotal, careCap))) },
    ira: {
      rows: iraRows,
      people: [...people].map(([person, total]) => ({ person, total, over: total > s.ira_limit })).sort((a, b) => a.person.localeCompare(b.person)),
      total: sum(iraRows), limit: s.ira_limit, phaseout,
    },
    itemized,
    standard,
    difference: round2(itemized - standard),
    todo,
  };
}

function moneyText(n: number) {
  return "$" + n.toLocaleString("en-US");
}

// ---------- AGI estimate from paychecks ----------

/** Paystub lines taken out before income tax. */
export const PRE_TAX: PaystubCategory[] = ["401k", "hsa", "fsa", "medical", "dental", "vision", "retirement_other", "other_pre_tax"];

/**
 * A starting point for AGI: gross pay minus pre-tax deductions, from the year's
 * paystubs. AGI also includes interest and other income, and is lowered by IRA
 * deductions, so the real number gets typed in once the return is drafted.
 */
export function agiEstimate(paystubs: Pick<Paystub, "id" | "gross">[], lines: Pick<PaystubLine, "paystub" | "category" | "amount">[]): number {
  const ids = new Set(paystubs.map((p) => p.id));
  const gross = paystubs.reduce((s, p) => s + p.gross, 0);
  const pre = lines.filter((l) => ids.has(l.paystub) && PRE_TAX.includes(l.category)).reduce((s, l) => s + l.amount, 0);
  return round2(Math.max(0, gross - pre));
}

// ---------- Export ----------

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Every tagged row as CSV, for tax software or a preparer. */
export function rowsToCsv(rows: TaxRow[], envelopes: Map<string, Envelope>): string {
  const head = ["Date", "Category", "Vendor", "Legal name", "TIN", "Statement", "Envelope", "Amount", "Deductible",
    "Paid by", "Acknowledged", "Tax year", "Person", "Note"];
  const lines = rows.map((r) => [
    r.tx.date.slice(0, 10), TAX_CATEGORY_LABELS[r.category], r.vendor?.name ?? "", r.vendor?.legal_name ?? "", r.vendor?.tin ?? "",
    r.tx.payee, envelopes.get(r.tx.envelope)?.name ?? "", (r.tx.kind === "income" ? -r.tx.amount : r.tx.amount).toFixed(2),
    r.amount.toFixed(2), r.excluded ? PAID_BY_LABELS[r.excluded] : "", r.category === "charity" ? (r.needsAck ? "no" : "yes") : "",
    taxYearOf(r.tx), r.tx.tax_person, r.tx.note,
  ].map(csvCell).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}

/** Masks a TIN for display: "12-3456789" -> "•••••6789". */
export function maskTin(tin: string): string {
  const digits = tin.replace(/\D/g, "");
  return digits.length <= 4 ? tin : "•".repeat(digits.length - 4) + digits.slice(-4);
}
