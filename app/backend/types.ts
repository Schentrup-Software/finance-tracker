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
  /** For income: whose paycheck this deposit is. */
  earner: string;
  /** Set by the server for paycheck deposits. */
  paystub_status: "" | "matched" | "needs_paystub";
  date: string;
  amount: number;
  payee: string;
  note: string;
  external_id: string;
}

export const DEBT_TYPES = [
  "credit_card", "auto", "student", "medical", "personal", "mortgage", "heloc", "401k_loan", "other",
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

// ---------- Paychecks ----------

export const PAY_FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly"] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export interface Earner extends BaseRecord {
  name: string;
  employer: string;
  color: Color | "";
  pay_frequency: PayFrequency | "";
  archived: boolean;
  external_id: string;
}

export const PAYSTUB_CATEGORIES = [
  "federal_tax", "state_tax", "local_tax", "social_security", "medicare",
  "medical", "dental", "vision", "hsa", "fsa", "life", "disability",
  "401k", "roth_401k", "retirement_other",
  "401k_loan", "loan_other",
  "other_pre_tax", "other_post_tax",
] as const;
export type PaystubCategory = (typeof PAYSTUB_CATEGORIES)[number];

export interface Paystub extends BaseRecord {
  earner: string;
  pay_date: string;
  period_start: string;
  period_end: string;
  gross: number;
  net: number;
  file: string;
  source: "upload" | "manual" | "repeat" | "";
  transaction: string;
  notes: string;
  external_id: string;
}

export interface PaystubLine extends BaseRecord {
  paystub: string;
  category: PaystubCategory;
  label: string;
  amount: number;
  debt: string;
  sort: number;
}
