// Shapes of the PocketBase records. Field names match pb_migrations exactly,
// which is also what the REST API (and n8n) sends and receives.

export interface BaseRecord {
  id: string;
  owner: string;
  created: string;
  updated: string;
}

export const COLORS = ["coral", "peach", "butter", "mint", "aqua", "sky", "lilac", "pink"] as const;
export type Color = (typeof COLORS)[number];

export const ENVELOPE_GROUPS = [
  "giving", "saving", "housing", "utilities", "food", "transportation",
  "insurance", "health", "personal", "lifestyle", "debt", "other",
] as const;
export type EnvelopeGroup = (typeof ENVELOPE_GROUPS)[number];

export interface Envelope extends BaseRecord {
  name: string;
  group: EnvelopeGroup | "";
  color: Color | "";
  emoji: string;
  default_amount: number;
  rollover: boolean;
  sort: number;
  archived: boolean;
  external_id: string;
}

export interface Budget extends BaseRecord {
  month: string; // YYYY-MM
  planned_income: number;
  notes: string;
}

export interface Allocation extends BaseRecord {
  budget: string;
  envelope: string;
  amount: number;
}

export type TransactionKind = "expense" | "income";

export interface Transaction extends BaseRecord {
  kind: TransactionKind;
  envelope: string;
  date: string;
  amount: number;
  payee: string;
  note: string;
  external_id: string;
}

export const DEBT_TYPES = [
  "credit_card", "auto", "student", "medical", "personal", "mortgage", "heloc", "other",
] as const;
export type DebtType = (typeof DEBT_TYPES)[number];

export interface Debt extends BaseRecord {
  name: string;
  type: DebtType | "";
  lender: string;
  balance: number;
  original_balance: number;
  interest_rate: number;
  minimum_payment: number;
  due_day: number;
  notes: string;
  external_id: string;
}

export interface DebtPayment extends BaseRecord {
  debt: string;
  date: string;
  amount: number;
  note: string;
  external_id: string;
}

export const ASSET_TYPES = [
  "real_estate", "vehicle", "collectible", "checking", "savings", "brokerage",
  "401k", "ira", "roth_ira", "hsa", "529", "crypto", "cash", "other",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export interface Asset extends BaseRecord {
  name: string;
  type: AssetType | "";
  institution: string;
  value: number;
  as_of: string;
  debts: string[];
  notes: string;
  external_id: string;
}

/** Fields a form may send when creating or editing a record. */
export type Draft<T extends BaseRecord> = Partial<Omit<T, keyof BaseRecord>>;
