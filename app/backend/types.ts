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
  /** "annual" envelopes save toward a yearly goal and always keep their leftovers. */
  period: "" | "monthly" | "annual";
  /** Yearly target for annual envelopes. */
  goal: number;
  /** Cash in the envelope at the end of opening_date (set by an import). Balances count from here. */
  opening_balance: number;
  opening_date: string;
  /** Everything spent from this envelope counts toward this tax category, unless a transaction or its vendor says otherwise. */
  tax_category: TaxCategory | "";
  external_id: string;
}

export interface Budget extends BaseRecord {
  month: string; // YYYY-MM
  planned_income: number;
  notes: string;
  /** Came from an import: its allocations are transfers, not a plan to copy forward. */
  imported: boolean;
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
  /** Bank or card account, as text. */
  account: string;
  /** The checking, savings or cash account it happened in (an asset). */
  account_asset: string;
  /** The credit card it was charged to (a debt). */
  account_debt: string;
  /** Who the money went to. Set by matching the payee (statement value), or picked by hand. */
  vendor: string;
  /** The vendor was picked by hand: matching never changes it. */
  vendor_locked: boolean;
  /** Overrides the vendor's and envelope's tax category; "none" means not deductible. */
  tax_category: TaxCategory | "none" | "";
  /** The deductible part when it isn't the whole amount. 0 means the whole amount. */
  tax_amount: number;
  /** Paid or reimbursed by an HSA, FSA or insurance: listed, but not deductible. */
  tax_paid_by: TaxPaidBy | "";
  /** IRA contributions made January to April can count for the year before. 0 means the date's year. */
  tax_year: number;
  /** Whose IRA. */
  tax_person: string;
  /** The charity's written acknowledgment is in hand (needed for gifts of $250 or more). */
  tax_acknowledged: boolean;
  external_id: string;
}

// ---------- Vendors and taxes ----------

export const TAX_CATEGORIES = ["charity", "medical", "child_care", "ira"] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const TAX_PAID_BY = ["hsa", "health_fsa", "insurance"] as const;
export type TaxPaidBy = (typeof TAX_PAID_BY)[number];

export const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "annual"] as const;
export type Cadence = (typeof CADENCES)[number];

export interface Vendor extends BaseRecord {
  name: string;
  emoji: string;
  color: Color | "";
  /** Statement values that belong to this vendor, e.g. "PAYPAL *STMARYSCHURCH". */
  matches: string[] | null;
  default_envelope: string;
  recurring: Cadence | "";
  expected_amount: number;
  expected_day: number;
  tax_category: TaxCategory | "";
  legal_name: string;
  address: string;
  tin: string;
  notes: string;
  archived: boolean;
  external_id: string;
}

export const TAX_DOCUMENT_KINDS = ["receipt", "acknowledgment", "year_end_statement", "other"] as const;
export type TaxDocumentKind = (typeof TAX_DOCUMENT_KINDS)[number];

export interface TaxDocument extends BaseRecord {
  file: string;
  tax_year: number;
  kind: TaxDocumentKind | "";
  label: string;
  transaction: string;
  vendor: string;
}

export interface TaxYear extends BaseRecord {
  year: number;
  agi: number;
  other_itemized: number;
  confirmed: boolean;
  standard_deduction: number;
  charity_floor_pct: number;
  charity_cash_cap_pct: number;
  nonitemizer_charity_cap: number;
  medical_floor_pct: number;
  care_cap_one: number;
  care_cap_two: number;
  qualifying_children: number;
  ira_limit: number;
  ira_catch_up: number;
  ira_phaseout_start: number;
  ira_phaseout_end: number;
  notes: string;
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
  /** The account the payment came from, e.g. Checking paying a card. */
  from_asset: string;
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
  // Paid after net pay (an insurance offset, a stipend): it lands in the bank too.
  "reimbursement",
] as const;
export type PaystubCategory = (typeof PAYSTUB_CATEGORIES)[number];

export interface Paystub extends BaseRecord {
  earner: string;
  pay_date: string;
  period_start: string;
  period_end: string;
  gross: number;
  net: number;
  /** What lands in the bank: net pay plus reimbursements (the stub's check amount). 0 = same as net. */
  deposit: number;
  /** Year-to-date gross and net pay printed on the stub (0 = not printed). */
  ytd_gross: number;
  ytd_net: number;
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
  /** For contributions (HSA, 401(k)): the account it goes into. */
  asset: string;
  /** Paid by the employer on top of gross pay (not taken out of it). */
  employer_paid: boolean;
  sort: number;
}

// ---------- SimpleFIN Bridge ----------

/** A SimpleFIN setup token the household claimed. Its access URL never leaves the server. */
export interface SimplefinConnection {
  id: string;
  owner: string;
  /** The banks in it, e.g. "Sunshine Bank, Fidelity". */
  label: string;
  /** The UTC hour of the morning pull. */
  sync_hour_utc: number;
  last_sync: string;
  last_attempt: string;
  /** What went wrong on the last pull, or the Bridge's warnings. */
  last_error: string;
  created: string;
  updated: string;
}

export interface SimplefinAccount {
  id: string;
  owner: string;
  connection: string;
  sfin_id: string;
  org: string;
  name: string;
  currency: string;
  /** As the bank reports it: what's owed on a card or loan is negative. */
  balance: number;
  available_balance: number;
  balance_date: string;
  /** "" until someone chooses. spending = budget transactions and balance; balance = balance only. */
  use: "" | "spending" | "balance" | "ignore";
  asset: string;
  debt: string;
  /** Transactions before this day are left out. */
  sync_from: string;
  last_pulled: string;
  created: string;
  updated: string;
}
