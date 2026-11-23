# Plan: tracking tax-deductible spending from the budget

Status: plan only, nothing built yet. Target: tax year 2027 (filed in early 2028), itemizing, married filing jointly.

## Goal

Tag the deductible money that already flows through the budget (donations, medical, child care) as it is spent,
keep the proof next to it, and produce a year-end summary that applies the IRS floors and limits.

**In scope:** donations (cash and items), out-of-pocket medical and dental, child care, and the mileage driven for
charity and medical care.

**Out of scope:** mortgage interest, property and state taxes, and other loan interest. Joey reconciles those at
year end from the 1098s and W-2s. The year-end report has one "other itemized deductions" box where that total can
be typed in, only so the report can compare the itemized total to the standard deduction.

## The rules the app applies

Figures marked *configurable* live in a per-year settings record (see "Tax year settings"), because the 2027 figures
aren't published yet. The app fills in the known 2026 values and copies them forward with an "unconfirmed" flag
until someone checks them against the IRS.

### Donations (Schedule A, lines 11 to 14)
- From 2026 on, only giving above **0.5% of AGI** counts (*configurable*). The report shows the floor, total
  giving and the deductible part.
- Cash gifts to public charities are capped at **60% of AGI** (*configurable*); unlikely to matter but cheap to check.
- **Any single gift of $250 or more** needs a written acknowledgment from the charity, received before filing. The
  app flags those gifts until a receipt is attached or "acknowledgment received" is ticked. A year-end statement
  from a church or charity can cover many gifts at once.
- **Gifts of items:** the deduction is fair market value. Above **$500** total for the year they go on
  **Form 8283 Section A**, which needs a description, date acquired, how acquired and cost. A single item or
  group of similar items above **$5,000** needs a qualified appraisal (Section B).
- **Charity mileage** is **14 cents a mile** (set by law, not inflation-adjusted, but still *configurable*).
- If the year ends up not worth itemizing, from 2026 non-itemizers can deduct up to **$2,000** (married filing
  jointly) of cash gifts (*configurable*). The report shows this so the comparison is fair both ways.

### Medical and dental (Schedule A, lines 1 to 4)
- Only the part above **7.5% of AGI** counts (*configurable*).
- Only money paid out of pocket counts. These are **excluded**:
  - anything paid from, or later reimbursed by, the **HSA** or a **health FSA**,
  - anything reimbursed by **insurance** (a refund into the Medical envelope lowers the total),
  - **pre-tax premiums** taken from paychecks (the `medical`, `dental` and `vision` paystub lines are pre-tax, so
    they are never counted).
- After-tax premiums paid from the budget (for example a dental plan paid directly) do count.
- Medical mileage counts at the IRS medical rate (*configurable*; 21 cents for 2025).

### Child care (Form 2441, a credit, not an itemized deduction)
Child care isn't a Schedule A deduction, but it comes out of the budget and needs the same record keeping, so it
belongs here. The report keeps it in its own section.
- Each provider needs **name, address and TIN** (EIN or SSN) on Form 2441. The app stores these once per provider.
- Qualifying expenses are capped at **$3,000 for one child and $6,000 for two or more** (*configurable*).
- The **dependent care FSA** (limit **$7,500** from 2026, *configurable*) is subtracted from that cap. Care paid
  through the FSA must not be counted again. The app totals the dependent care FSA from paystub lines (see
  "Paycheck changes") and shows: care paid from the budget, minus the FSA, against the cap.
- The credit rate depends on AGI; the report shows qualifying expenses and leaves the rate to tax software.

## Data changes

One new migration file in `pb_migrations/` (for example `1764300000_tax_tracking.js`). Every new collection has
`owner` and the usual `owner = @request.auth.household` rules, and relation fields check the related record's
owner on create and update. Fields are mirrored in `app/backend/types.ts` and documented in `docs/api.md`.

### Envelopes: a default tax category
`envelopes.tax_category` (select, optional): `charity`, `medical`, `child_care`.

Tagging the Donations envelope `charity` means every gift spent from it is tagged automatically, with no extra
step per transaction. This also covers history imported from Goodbudget, since imported rows land in envelopes.

### Transactions: per-row overrides
- `tax_category` (select, optional): same values plus `none`. Empty means "use the envelope's". `none` excludes a
  row from a tagged envelope (a birthday gift paid from Donations, for instance).
- `tax_amount` (number, optional): the deductible part when it isn't the whole amount, such as a pharmacy run that
  was half prescriptions, or a charity dinner where the meal's value isn't deductible. Empty means the full amount.
- `tax_paid_by` (select, optional): `hsa`, `health_fsa`, `dependent_care_fsa`, `insurance`. Set when the expense
  was, or will be, reimbursed. These rows are listed in the report but excluded from the totals.
- `tax_payee` (relation to `tax_payees`, optional): the charity, provider or doctor.
- `tax_acknowledged` (bool): the written acknowledgment for a $250+ gift is in hand.

Tax year is the transaction date's year. No override field is needed for donations, medical or child care.

### New collection: `tax_payees`
Charities and providers, entered once and picked on each transaction.
- `kind` (select): `charity`, `care_provider`, `medical_provider`
- `name`, `address`, `tin` (EIN or SSN; shown masked except to edit), `notes`, `external_id`
- `default_category` so picking a payee on an untagged transaction suggests the category.

### New collection: `tax_entries` (deductions that don't move money through the budget)
Items given away and miles driven aren't budget spending, so they don't go in `transactions` and never affect an
envelope balance.
- `kind` (select): `noncash_gift`, `mileage`
- `date`, `tax_payee`, `description`
- For gifts: `value` (fair market value), `cost`, `date_acquired`, `how_acquired`, `condition`,
  `tax_acknowledged`
- For mileage: `category` (`charity` or `medical`), `miles`, `purpose`. The dollar value is computed from the
  year's rate, not stored, so a corrected rate fixes every row.
- `external_id` (so n8n can sync, for example, a mileage log from a phone shortcut)

### New collection: `tax_documents`
Receipts and proof, stored as protected files like paystub PDFs.
- `file` (protected, PDF or image, 15 MB), `tax_year`, `kind` (`receipt`, `acknowledgment`, `year_end_statement`,
  `appraisal`, `other`), `label`
- Optional relations: `transaction`, `tax_entry`, `tax_payee`. A year-end statement links to the payee and covers
  all of that payee's gifts in the year; a single receipt links to its transaction.
- Attaching an `acknowledgment` or `year_end_statement` counts as "acknowledgment received" for the gifts it covers.

### New collection: `tax_years` (settings)
One record per household per year: `year`, `agi` (typed in), `other_itemized` (the year-end reconciled total),
`confirmed` (bool), and the configurable figures: `standard_deduction`, `charity_floor_pct` (0.5),
`charity_cash_cap_pct` (60), `nonitemizer_charity_cap` (2,000), `medical_floor_pct` (7.5),
`charity_mileage_rate` (0.14), `medical_mileage_rate`, `care_cap_one` (3,000), `care_cap_two` (6,000),
`dcfsa_limit` (7,500), `qualifying_children` (number).

Defaults ship in `app/lib/tax.ts` as a table by year (2026 known values). A new year copies the latest known year
with `confirmed = false`, and the report shows a "check these figures" banner until someone ticks it.

### Paycheck changes
- New paystub category `dependent_care_fsa` (label "Dependent care FSA") in its own select value, and the reader in
  `app/lib/paystub.ts` maps "Dep Care", "DCAP", "DCFSA" and "Dependent Care" lines to it. The current `fsa`
  category keeps meaning a health FSA. Existing `fsa` lines stay as they are; anyone with a dependent care FSA
  re-tags them once.
- **AGI estimate:** gross pay minus pre-tax lines (401(k), HSA, FSAs, pre-tax premiums) from the year's paystubs
  gives an estimate shown next to the AGI box ("estimate from paychecks: $X, use it?"). It's only a starting
  point, since AGI also includes interest, dividends and anything off-paycheck. The real number gets typed in
  once the return is drafted.

## Where it shows up

- **Envelope form:** a "Tax category" picker (none, Donations, Medical, Child care) next to Monthly/Annual.
- **Transaction form:** when the envelope (or the chosen category) is tagged, a small "Tax" section opens with the
  payee picker, deductible amount, "paid or reimbursed by" and "attach receipt". It stays collapsed and
  pre-filled, so a normal entry is no slower than today.
- **Activity list:** a small badge on tagged rows, and a warning dot on $250+ gifts with no acknowledgment.
- **New "Taxes" view on the Budget tab** (next to Paychecks), with a year picker and five parts:
  1. *To do:* gifts missing acknowledgments, providers missing a TIN, items over $500 missing Form 8283 details,
     items over $5,000 missing an appraisal, unconfirmed figures, AGI not entered.
  2. *Donations:* list by charity, cash and items separately, mileage, the 0.5% floor and the deductible total.
  3. *Medical:* list by provider, excluded rows shown greyed with the reason, mileage, the 7.5% floor and the
     deductible total.
  4. *Child care:* by provider with name, address and TIN, the dependent care FSA total, the cap and the
     qualifying expenses for Form 2441.
  5. *Itemize or not:* donations + medical + other itemized versus the standard deduction (plus the non-itemizer
     cash gift deduction), with the difference.
- **Exports:** a CSV of every tagged row and a ZIP of the year's documents, to hand to tax software or a preparer.
- **Mileage and items given away:** "Log miles" and "Log items" buttons on the Taxes view, since these don't
  belong to an envelope.

## Code layout (following the repo rules)

- `app/lib/tax.ts`: pure and unit tested. Year defaults, `effectiveCategory(tx, envelope)`,
  `deductibleAmount(tx)`, the floors, caps and mileage math, the Form 2441 cap with the FSA offset, the to-do
  checks, the AGI estimate from paystub lines, and the itemize-or-not comparison. Tests in `testing/unit/`.
- `app/backend/api.ts` and `types.ts`: the new collections and fields.
- `app/components/Taxes.tsx` (view), plus small additions to the envelope and transaction forms in
  `app/routes/budget.tsx`.
- `pb_hooks/finance/lib.js`: add `tax_payees`, `tax_entries` to `SYNCABLE`, and let a sync fill `tax_payee` by
  the payee's `external_id`. `tax_documents` is upload-only, like paystubs.
- `testing/api-smoke.sh`: rule checks for the new collections, including that a transaction can't point at another
  household's payee. `testing/e2e.spec.ts`: tag the Donations envelope, add a $300 gift, see the warning, attach a
  receipt, see it clear, check the report totals.

## Build order

Each step is its own PR, usable on its own.
1. **Tagging:** migration fields on envelopes and transactions, `tax_payees`, the form changes, badges.
   Start tagging 2027 spending from January 1.
2. **Receipts:** `tax_documents`, attach from a transaction or a payee, the acknowledgment warnings.
3. **Items and mileage:** `tax_entries` and the two log forms.
4. **Year-end report:** `tax_years`, `app/lib/tax.ts`, the Taxes view, exports.
5. **Paychecks:** `dependent_care_fsa` category and the AGI estimate.

Steps 1 and 2 are the ones that need to be in place before January, since they capture records as the year
happens. The report (step 4) is only needed by early 2028, by which time the 2027 figures will be published.

## Open questions for Joey

1. Is there a dependent care FSA through either employer? If not, step 5's FSA part can be skipped.
2. Are any other budget-paid items worth tagging, such as direct HSA or IRA contributions, or 529 contributions
   (a state deduction in some states)? They'd be extra category values; the plan leaves them out for now.
3. Should "items given away" (clothes to Goodwill and so on) be tracked at all, or only cash giving?
4. Should a church's year-end statement be enough to clear every gift's warning, or should each $250+ gift still
   get its own receipt?

*Tax figures come from IRS publications and coverage of the 2025 tax law (P.L. 119-21) as of November 2026. They
are inputs to check, not tax advice.*
