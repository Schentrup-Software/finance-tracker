// Paystub categories, and a best-effort reader that turns the text of a
// paystub PDF into gross pay, net pay, pay date and deduction lines. Every
// reading is shown to the person to check before it's saved.

import type { Color, PaystubCategory } from "~/backend/types";
import { round2 } from "./money";

export const CATEGORY_LABELS: Record<PaystubCategory, string> = {
  federal_tax: "Federal income tax",
  state_tax: "State tax",
  local_tax: "Local tax",
  social_security: "Social Security",
  medicare: "Medicare",
  medical: "Medical",
  dental: "Dental",
  vision: "Vision",
  hsa: "HSA",
  fsa: "FSA",
  life: "Life insurance",
  disability: "Disability",
  "401k": "401(k)",
  roth_401k: "Roth 401(k)",
  retirement_other: "Other retirement",
  "401k_loan": "401(k) loan",
  loan_other: "Other loan",
  other_pre_tax: "Other (pre-tax)",
  other_post_tax: "Other (after tax)",
  reimbursement: "Reimbursement",
};

export interface CategoryGroup {
  key: string;
  label: string;
  emoji: string;
  color: Color;
  categories: PaystubCategory[];
}

export const CATEGORY_GROUPS: CategoryGroup[] = [
  { key: "taxes", label: "Taxes", emoji: "🏛️", color: "coral",
    categories: ["federal_tax", "state_tax", "local_tax", "social_security", "medicare"] },
  { key: "health", label: "Healthcare", emoji: "🩺", color: "pink",
    categories: ["medical", "dental", "vision", "life", "disability"] },
  { key: "health_savings", label: "HSA and FSA", emoji: "🩹", color: "aqua", categories: ["hsa", "fsa"] },
  { key: "retirement", label: "Retirement savings", emoji: "🌳", color: "mint",
    categories: ["401k", "roth_401k", "retirement_other"] },
  { key: "loans", label: "Loan repayments", emoji: "⛓️", color: "peach", categories: ["401k_loan", "loan_other"] },
  { key: "other", label: "Other", emoji: "📄", color: "lilac", categories: ["other_pre_tax", "other_post_tax"] },
];

export function groupOf(category: PaystubCategory): CategoryGroup {
  return CATEGORY_GROUPS.find((g) => g.categories.includes(category)) ?? CATEGORY_GROUPS[CATEGORY_GROUPS.length - 1];
}

export function isLoanCategory(c: PaystubCategory) {
  return c === "401k_loan" || c === "loan_other";
}

/** Lines that put money into an account you own (and so can feed an asset). */
export function isContributionCategory(c: PaystubCategory) {
  return c === "hsa" || c === "401k" || c === "roth_401k" || c === "retirement_other";
}

/** The asset types a contribution line most likely goes into. */
export const CONTRIBUTION_ASSET_TYPES: Partial<Record<PaystubCategory, string[]>> = {
  hsa: ["hsa"],
  "401k": ["401k"],
  roth_401k: ["401k", "roth_ira"],
  retirement_other: ["401k", "ira", "roth_ira"],
};

/**
 * What an employer pays on top of the paycheck (health insurance premiums, a
 * 401(k) match, an HSA seed). It isn't taken out of gross pay, so it's kept
 * apart from the deductions; these are the categories it can be.
 */
export const EMPLOYER_CATEGORIES: PaystubCategory[] = [
  "medical", "dental", "vision", "life", "disability", "hsa", "fsa", "401k", "roth_401k", "retirement_other", "other_pre_tax",
];

/** Totals per category, largest first. */
export function totalsByCategory(lines: { category: PaystubCategory; amount: number }[]) {
  const m = new Map<PaystubCategory, number>();
  for (const l of lines) m.set(l.category, round2((m.get(l.category) ?? 0) + l.amount));
  return [...m.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
}

// ---------- Reading paystub text ----------

export interface ReadLine {
  label: string;
  category: PaystubCategory;
  amount: number;
}

export interface PaystubReading {
  pay_date: string | null; // YYYY-MM-DD
  period_start: string | null;
  period_end: string | null;
  gross: number | null;
  net: number | null;
  /** Taken out of gross pay. */
  lines: ReadLine[];
  /** Paid by the employer on top of gross pay (not taken out of it). */
  employer: ReadLine[];
  /** Paid after net pay (category "reimbursement"); they land in the bank with it. */
  reimbursements: ReadLine[];
  /** What was deposited, if the stub says ("Check Amount"): net pay plus reimbursements. */
  check: number | null;
}

/**
 * Words that mark a deduction, checked in order (the first match wins, so the
 * narrow ones come before the broad ones: "401k loan" before "401k",
 * "Medicare" before "Medical", "Fed OASDI" before "Federal").
 */
const RULES: [RegExp, PaystubCategory][] = [
  [/401\s*\(?k\)?[^a-z]*(loan|ln)|(loan|ln)\b.*401|ret(irement)?\.?\s*loan|\bk[\s-]*loan|plan\s*loan/i, "401k_loan"],
  [/\bloan\b/i, "loan_other"],
  [/roth/i, "roth_401k"],
  [/\bhsa\b|health\s*sav/i, "hsa"],
  [/\bfsa\b|flex(ible)?\s*spend|dep(endent)?\.?\s*care/i, "fsa"],
  [/medicare|fica[\s-]*m(ed|ed\.|edicare)?\b|\bmed\s*\/?\s*ee\b|\bee\s*med\b|\bmwt\b|\bmed(icare)?\s*tax\b/i, "medicare"],
  [/social\s*sec|soc\.?\s*sec|oasdi|\bss\s*(\/?\s*ee|tax|w\/?h)\b|\bfica\b/i, "social_security"],
  [/fed(eral)?\.?\s*(income\s*)?(tax|w\/?h|with)|\bfitw?\b|\bfederal\b/i, "federal_tax"],
  [/\blocal\b|\bcity\b|\bcounty\b|school\s*dist|\bmunicipal|\blit\b/i, "local_tax"],
  [/\bstate\b|\bsitw?\b|\bsdi\b|\bpfml?\b|\bsui\b|\b[A-Z]{2}\s+(income\s+)?(tax|w\/?h|withholding)\b/i, "state_tax"],
  [/dental|\bdent\b/i, "dental"],
  [/vision/i, "vision"],
  [/medical|\bhealth\b|\bmed\b|\bhmo\b|\bppo\b|\bhdhp\b|\bepo\b/i, "medical"],
  [/\blife\b|ad\s*&\s*d|\badd\b/i, "life"],
  [/disab|\bstd\b|\bltd\b/i, "disability"],
  [/401\s*\(?k\)?|\b401k\b|\bk\s*plan|savings\s*plan/i, "401k"],
  [/403\s*\(?b\)?|\b457\b|pension|retire|\btsp\b/i, "retirement_other"],
];

/** Lines that look like deductions but aren't money in or out of this paycheck. */
const SKIP = /\bnet\b|\bgross\b|total|taxable|earnings|\bwages?\b|\bhours?\b|\brate\b|\bbalance\b|year\s*to\s*date|\bytd\b\s*$/i;

/** A line paid by the employer ("Employer 401K Match", "ER HSA"), wherever it sits. */
const EMPLOYER_LINE = /employer|\ber\b|match|company\s*(paid|contrib)/i;

/** A heading that starts the employer's section ("Employer Contributions", "Employer Paid Benefits"). */
const EMPLOYER_HEADING = /employer\s*(paid\s*)?(contrib|benefit|paid|match)|company\s*(paid|contrib)|paid\s*by\s*(your\s*)?employer|\ber\s*contrib/i;

/** Starts the reimbursements: a "Reimbursements" heading or the "Total Reimbursements" row. */
const REIMBURSE_HEADING = /reimburse/i;

/** The check amount: net pay plus reimbursements. */
const CHECK_AMOUNT = /check\s*amount|amount\s*(of\s*)?(check|deposit(ed)?)|total\s*deposits?/i;

/** A heading that ends it: the next section of the stub. */
const OTHER_HEADING = /^(statutory\s*|other\s*|pre[\s-]*tax\s*|post[\s-]*tax\s*|after[\s-]*tax\s*|voluntary\s*|employee\s*)?(deductions?|taxes|tax\s*withholdings?|withholdings?|earnings|summary|net\s*pay(\s*distribution)?|pay\s*distribution|direct\s*deposits?|deposits?|time\s*off|pto|leave|accruals?|messages?|memo|notes?)\b/i;

const MONEY = /\(?-?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?|\(?-?\$?\s?\d+\.\d{2}\)?/g;

function moneyIn(text: string): number[] {
  const cleaned = text.replace(/\d+(\.\d+)?\s*%/g, " ");
  return (cleaned.match(MONEY) ?? []).map((m) => {
    const neg = m.includes("(") || m.includes("-");
    const v = parseFloat(m.replace(/[^\d.]/g, ""));
    return neg ? -v : v;
  });
}

function hasLetters(s: string) {
  return /[a-z]{2,}/i.test(s);
}

/**
 * Splits each row of cells into label + numbers segments, so a row that holds
 * two columns ("Federal Tax 400.00 5,200.00   Medical 120.00 1,560.00") reads
 * as two deductions.
 */
export function segments(rows: string[][]): { label: string; amounts: number[]; text: string }[] {
  const out: { label: string; amounts: number[]; text: string }[] = [];
  for (const row of rows) {
    let cur: { label: string; amounts: number[]; text: string } | null = null;
    for (const raw of row) {
      const cell = raw.trim();
      if (!cell) continue;
      const amounts = moneyIn(cell);
      const labelPart = cell.replace(MONEY, " ").replace(/\s+/g, " ").trim();
      if (hasLetters(labelPart) && (!cur || cur.amounts.length > 0)) {
        if (cur) out.push(cur);
        cur = { label: labelPart, amounts: [], text: cell };
      } else if (!cur) {
        cur = { label: labelPart, amounts: [], text: cell };
      } else {
        if (hasLetters(labelPart)) cur.label += " " + labelPart;
        cur.text += " " + cell;
      }
      cur.amounts.push(...amounts);
    }
    if (cur) out.push(cur);
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Every date in a string, in order. Understands 11/21/2026, 2026-11-21 and Nov 21, 2026. */
export function datesIn(text: string): string[] {
  const found: { at: number; iso: string }[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g)) {
    const iso = isoDate(+m[3], +m[1], +m[2]);
    if (iso) found.push({ at: m.index!, iso });
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const iso = isoDate(+m[1], +m[2], +m[3]);
    if (iso) found.push({ at: m.index!, iso });
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    const iso = mi >= 0 ? isoDate(+m[3], mi + 1, +m[2]) : null;
    if (iso) found.push({ at: m.index!, iso });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.iso);
}

/** The first date after a label such as "Pay Date", on the same row or the next one. */
function dateAfter(rowsText: string[], label: RegExp): string | null {
  for (let i = 0; i < rowsText.length; i++) {
    const m = rowsText[i].match(label);
    if (!m) continue;
    const rest = rowsText[i].slice(m.index! + m[0].length);
    const d = datesIn(rest)[0] ?? datesIn(rowsText[i + 1] ?? "")[0];
    if (d) return d;
  }
  return null;
}

function firstAmount(segs: ReturnType<typeof segments>, label: RegExp, exclude?: RegExp): number | null {
  for (const s of segs) {
    if (label.test(s.label) && !(exclude && exclude.test(s.label))) {
      const v = s.amounts.find((a) => a !== 0);
      if (v !== undefined) return Math.abs(v);
    }
  }
  return null;
}

/** Reads a paystub's text (rows of cells, as laid out on the page). */
export function readPaystub(rows: string[][]): PaystubReading {
  const segs = segments(rows);
  const rowsText = rows.map((r) => r.join(" ").replace(/\s+/g, " "));

  const check = firstAmount(segs, CHECK_AMOUNT);
  const gross = firstAmount(segs, /gross\s*(pay|earnings|wages)?|total\s*(earnings|gross)/i, /taxable|ytd only|year/i);
  const net = firstAmount(segs, /net\s*(pay|check|amount|deposit)|take[\s-]*home|\bnet\b/i, /ytd only/i);

  let pay_date = dateAfter(rowsText, /(pay|check|advice|payment|deposit)\s*date|pay\s*day|date\s*paid/i);
  let period_start = dateAfter(rowsText, /period\s*(begin(ning)?|start(ing)?|from)|(pay\s*)?period\s*(:)?/i);
  let period_end = dateAfter(rowsText, /period\s*(end(ing)?|to|thru|through)/i);
  // "Pay Period: 11/01/2026 - 11/14/2026"
  const periodRow = rowsText.find((t) => /period/i.test(t) && datesIn(t).length >= 2);
  if (periodRow) {
    const [a, b] = datesIn(periodRow);
    period_start = period_start && period_start !== b ? period_start : a;
    period_end = b;
  }
  if (period_start && period_end && period_start > period_end) [period_start, period_end] = [period_end, period_start];
  if (!pay_date) pay_date = period_end;

  const lines: ReadLine[] = [];
  const employer: ReadLine[] = [];
  const reimbursements: ReadLine[] = [];
  const seen = new Set<string>();
  // Inside an "Employer Contributions" section, every line is paid by the employer;
  // after "Total Reimbursements", every line is a reimbursement until the check amount.
  let inEmployer = false;
  let inReimbursements = false;
  for (const s of segs) {
    if (s.amounts.length === 0) {
      if (EMPLOYER_HEADING.test(s.label)) inEmployer = true;
      else if (REIMBURSE_HEADING.test(s.label)) [inReimbursements, inEmployer] = [true, false];
      else if (OTHER_HEADING.test(s.label)) inEmployer = inReimbursements = false;
      continue;
    }
    if (CHECK_AMOUNT.test(s.label)) { inReimbursements = false; continue; }
    if (REIMBURSE_HEADING.test(s.label) && /total/i.test(s.label)) { [inReimbursements, inEmployer] = [true, false]; continue; }
    if (inReimbursements || (REIMBURSE_HEADING.test(s.label) && !SKIP.test(s.label))) {
      // This period's amount comes first; a reimbursement that's 0.00 this period wasn't paid.
      const amount = Math.abs(s.amounts[0]);
      const label = s.label.replace(/\s+/g, " ").trim().slice(0, 120);
      if (amount > 0 && !SKIP.test(label)) reimbursements.push({ label, category: "reimbursement", amount: round2(amount) });
      continue;
    }
    if (SKIP.test(s.label)) continue;
    const byEmployer = inEmployer || EMPLOYER_LINE.test(s.label);
    const rule = RULES.find(([re]) => re.test(s.label));
    let category = rule?.[1];
    if (byEmployer) {
      // Employer-paid taxes (their half of Social Security and Medicare) aren't benefits.
      if (category && groupOf(category).key === "taxes") continue;
      if (!category || !EMPLOYER_CATEGORIES.includes(category)) category = "other_pre_tax";
    }
    if (!category) continue;
    // This period's amount comes first. A line that's 0.00 this period (but has a
    // year-to-date total) wasn't taken out of this paycheck.
    const amount = s.amounts[0];
    if (!amount) continue;
    const label = s.label.replace(/\s+/g, " ").trim().slice(0, 120);
    const key = `${byEmployer ? "er" : "ee"}|${label.toLowerCase()}|${Math.abs(amount)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (byEmployer ? employer : lines).push({ label, category, amount: round2(Math.abs(amount)) });
  }

  // No itemized reimbursements, but the check is more than the net: the difference
  // was paid on top of it.
  if (reimbursements.length === 0 && check !== null && net !== null && check - net >= 0.01) {
    reimbursements.push({ label: "Reimbursements", category: "reimbursement", amount: round2(check - net) });
  }

  return { pay_date, period_start, period_end, gross, net, lines, employer, reimbursements, check };
}

/** What lands in the bank: net pay plus reimbursements. */
export function depositAmount(net: number, reimbursements: { amount: number }[]): number {
  return round2(net + reimbursements.reduce((s, l) => s + (l.amount || 0), 0));
}

/** gross − deductions − net. Zero when everything on the stub is accounted for. */
export function unexplained(gross: number, net: number, lines: { amount: number }[]): number {
  return round2(gross - lines.reduce((s, l) => s + (l.amount || 0), 0) - net);
}

/** True when a reading is complete enough to trust as a starting point. */
export function readingLooksGood(r: PaystubReading): boolean {
  if (!r.gross || !r.net || r.lines.length === 0) return false;
  if (r.check !== null && Math.abs(depositAmount(r.net, r.reimbursements) - r.check) > 0.01) return false;
  return Math.abs(unexplained(r.gross, r.net, r.lines)) <= 1;
}

/** Totals by group for a set of paystub lines. */
export function totalsByGroup(lines: { category: PaystubCategory; amount: number }[]) {
  const totals = new Map<string, number>();
  for (const l of lines) {
    const g = groupOf(l.category).key;
    totals.set(g, round2((totals.get(g) ?? 0) + l.amount));
  }
  return CATEGORY_GROUPS.map((g) => ({ group: g, total: totals.get(g.key) ?? 0 }));
}

/** Normalizes the OpenClaw agent's JSON into a reading, keeping only known categories. */
export function fromAgent(json: any): PaystubReading {
  const num = (v: any) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Math.abs(Number(v)));
  const date = (v: any) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const readLines = (list: any, allowed: (c: PaystubCategory) => boolean): ReadLine[] =>
    (Array.isArray(list) ? list : [])
      .map((l: any) => ({
        label: String(l?.label ?? "").slice(0, 120),
        category: (l?.category in CATEGORY_LABELS && allowed(l.category) ? l.category : "other_pre_tax") as PaystubCategory,
        amount: num(l?.amount) ?? 0,
      }))
      .filter((l: ReadLine) => l.amount > 0);
  const reading: PaystubReading = {
    pay_date: date(json?.pay_date), period_start: date(json?.period_start), period_end: date(json?.period_end),
    gross: num(json?.gross), net: num(json?.net), check: num(json?.check_amount),
    lines: readLines(json?.lines, () => true),
    // Employer-paid taxes aren't benefits, so they are dropped.
    employer: readLines(
      (Array.isArray(json?.employer) ? json.employer : json?.employer_contributions ?? [])
        .filter((l: any) => !(l?.category in CATEGORY_LABELS && groupOf(l.category).key === "taxes")),
      (c) => EMPLOYER_CATEGORIES.includes(c),
    ),
    reimbursements: readLines(json?.reimbursements, () => false).map((l) => ({ ...l, category: "reimbursement" as const })),
  };
  const { check, net } = reading;
  if (reading.reimbursements.length === 0 && check !== null && net !== null && check - net >= 0.01) {
    reading.reimbursements.push({ label: "Reimbursements", category: "reimbursement", amount: round2(check - net) });
  }
  return reading;
}
