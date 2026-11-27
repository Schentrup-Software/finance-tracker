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
  [/mortgage|home loan|\bmtg\b/i, "mortgage"],
  [/heloc|home equity/i, "heloc"],
  [/\bauto\b|car loan|vehicle/i, "auto"],
  [/student/i, "student"],
  [/\bloan\b|line of credit/i, "personal"],
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

/** A first guess at what an account is, from its name and the sign of its balance. */
export function guessKind(name: string, balance: number): string {
  const byName = HINTS.find(([re]) => re.test(name))?.[1];
  if (byName) return byName;
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
    const score = common / want.length + (guessKind(a.name, a.balance) === importKind ? 0.25 : 0);
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
