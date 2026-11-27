// Browser-side helpers for SimpleFIN accounts: guessing what an account is, matching
// an imported account to one, and when the morning pull happens. The server's side
// (claiming tokens, pulling, pairing card payments) is pb_hooks/finance/simplefin.js.

import type { AssetType, DebtType } from "~/backend/types";

export type AccountUse = "spending" | "balance" | "ignore";

/** What a bank account becomes in the app: an asset or a debt of some type. */
export interface AccountKindOption {
  value: string;
  label: string;
  side: "asset" | "debt";
  type: AssetType | DebtType;
}

export const ACCOUNT_KIND_OPTIONS: AccountKindOption[] = [
  { value: "checking", label: "Checking", side: "asset", type: "checking" },
  { value: "savings", label: "Savings", side: "asset", type: "savings" },
  { value: "credit_card", label: "Credit card", side: "debt", type: "credit_card" },
  { value: "cash", label: "Cash", side: "asset", type: "cash" },
  { value: "mortgage", label: "Mortgage", side: "debt", type: "mortgage" },
  { value: "heloc", label: "Home equity line", side: "debt", type: "heloc" },
  { value: "auto", label: "Car loan", side: "debt", type: "auto" },
  { value: "student", label: "Student loan", side: "debt", type: "student" },
  { value: "personal", label: "Other loan", side: "debt", type: "personal" },
  { value: "brokerage", label: "Brokerage", side: "asset", type: "brokerage" },
  { value: "401k", label: "401(k)", side: "asset", type: "401k" },
  { value: "ira", label: "IRA", side: "asset", type: "ira" },
  { value: "roth_ira", label: "Roth IRA", side: "asset", type: "roth_ira" },
  { value: "hsa", label: "HSA", side: "asset", type: "hsa" },
  { value: "529", label: "529", side: "asset", type: "529" },
  { value: "other_asset", label: "Other asset", side: "asset", type: "other" },
];

export const kindOption = (value: string) => ACCOUNT_KIND_OPTIONS.find((k) => k.value === value) ?? ACCOUNT_KIND_OPTIONS[0];

const HINTS: [RegExp, string][] = [
  [/mortgage|home loan|\bmtg\b|\bescrow\b/i, "mortgage"],
  [/heloc|home equity/i, "heloc"],
  [/\bauto\b|car loan|vehicle|\blease\b/i, "auto"],
  [/student/i, "student"],
  [/\bloans?\b|line of credit|\bloc\b|installment|personal credit/i, "personal"],
  [/credit|card|visa|master\s*card|\bamex\b|american express|discover|sapphire|freedom|quicksilver|venture/i, "credit_card"],
  [/roth\s*ira/i, "roth_ira"],
  [/401\s*\(?k\)?|403\s*\(?b\)?|retirement|\btsp\b/i, "401k"],
  [/\bira\b/i, "ira"],
  [/\bhsa\b|health savings/i, "hsa"],
  [/\b529\b|college/i, "529"],
  [/brokerage|invest|individual|stock|trading|\bjoint\b/i, "brokerage"],
  [/saving|money market|\bmma\b|reserve|emergency|\bhysa\b|\bcd\b|certificate/i, "savings"],
  [/checking|\bchk\b|debit|spend/i, "checking"],
  [/cash|wallet/i, "cash"],
];

// Lenders whose accounts are loans, when the account's own name doesn't say (e.g. "Account ...1234").
const LENDERS: [RegExp, string][] = [
  [/mortgage|home ?loans?|mr\.? ?cooper|rocket|pennymac|loancare|newrez|shellpoint|nationstar|cenlar|dovenmuehle|roundpoint|lakeview|guild|flagstar|freedom mortgage|united wholesale/i, "mortgage"],
  [/nelnet|navient|mohela|aidvantage|great lakes|edfinancial|sallie ?mae|fedloan|earnest|sofi lending|student/i, "student"],
  [/auto|motor|financial services|toyota|honda|ford credit|gm financial|santander consumer|westlake|carvana|exeter|tesla|car ?max/i, "auto"],
  [/lending ?club|prosper|upstart|best ?egg|lightstream|avant|marcus|oportun|\bloans?\b|lending/i, "personal"],
];

// Cards rarely owe this much; a bigger balance owed is a loan (and a very big one, a mortgage).
const LOAN_OWED = 25000;
const MORTGAGE_OWED = 100000;

/**
 * A first guess at what an account is. In order: what its name says ("Home Mortgage", "Visa",
 * "Savings"); then its bank, when that is a mortgage, student loan or car lender; then how much
 * it owes, so a large balance owed with an unhelpful name is a loan, not a card.
 */
export function guessKind(name: string, balance: number, org = ""): string {
  const byName = HINTS.find(([re]) => re.test(name))?.[1];
  if (byName) return byName;
  if (balance <= 0) {
    const byLender = LENDERS.find(([re]) => re.test(org))?.[1];
    if (byLender) return byLender;
    if (-balance >= MORTGAGE_OWED) return "mortgage";
    if (-balance >= LOAN_OWED) return "personal";
  }
  return balance < 0 ? "credit_card" : "checking";
}

/** Checking accounts and cards are where everyday spending happens; the rest just have a balance. */
export function defaultUse(kind: string): AccountUse {
  return kind === "checking" || kind === "credit_card" || kind === "cash" ? "spending" : "balance";
}

const words = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !["the", "of", "and", "account"].includes(w));

/**
 * The SimpleFIN account an imported account (by its name and kind) most likely is,
 * or null when none fits well enough. Name words in common count most; the same kind breaks ties.
 */
export function suggestMatch<T extends { id: string; name: string; org: string; balance: number }>(
  importName: string, importKind: string, accounts: T[],
): T | null {
  const want = words(importName);
  if (want.length === 0) return null;
  let best: T | null = null;
  let bestScore = 0;
  let tied = false;
  for (const a of accounts) {
    const have = new Set(words(`${a.name} ${a.org}`));
    const common = want.filter((w) => have.has(w)).length;
    if (common === 0) continue;
    const score = common / want.length + (guessKind(a.name, a.balance, a.org) === importKind ? 0.25 : 0);
    if (score > bestScore) { best = a; bestScore = score; tied = false; }
    else if (score === bestScore) tied = true;
  }
  return tied || bestScore < 0.5 ? null : best;
}

/** The UTC hour that is `localHour` (6 AM) where the browser is, on `date`. */
export function morningHourUtc(localHour = 6, date = new Date()): number {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), localHour, 0, 0);
  return d.getUTCHours();
}

/** "6:48 AM": when a pull at this UTC hour and minute happens on the viewer's clock. */
export function pullTimeLabel(hourUtc: number, minute: number, date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hourUtc, minute));
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The kinds of account a history import knows. */
export type ImportAccountKind = "checking" | "savings" | "cash" | "credit_card";
const IMPORT_KINDS: string[] = ["checking", "savings", "cash", "credit_card"];

/**
 * What a history-import account becomes once it is matched to SimpleFIN account `s`. If `s` already
 * fills an asset or debt (the bank step links every account it saves), the import uses that one
 * instead of making a second copy, and a debt makes it a card. Otherwise its kind is what the bank
 * account looks like, when that is one the import knows. `kind` null keeps the import's own guess.
 */
export function adoptSimplefin<A extends { id: string; type: string }, D extends { id: string }>(
  s: { name: string; org: string; balance: number; asset: string; debt: string },
  assets: A[], debts: D[],
): { kind: ImportAccountKind | null; asset: A | null; debt: D | null } {
  const debt = s.debt ? debts.find((d) => d.id === s.debt) ?? null : null;
  if (debt) return { kind: "credit_card", asset: null, debt };
  const asset = s.asset ? assets.find((a) => a.id === s.asset) ?? null : null;
  if (asset) return { kind: IMPORT_KINDS.includes(asset.type) ? (asset.type as ImportAccountKind) : "checking", asset, debt: null };
  const guess = guessKind(s.name, s.balance, s.org);
  return { kind: IMPORT_KINDS.includes(guess) ? (guess as ImportAccountKind) : null, asset: null, debt: null };
}
