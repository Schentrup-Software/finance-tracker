# Plan: tracking tax-deductible spending from the budget

Status: plan only, nothing built yet. Target: tax year 2027 (filed in early 2028), itemizing, married filing jointly.

## Goal

Tag the deductible money that already flows through the budget as it is spent, including recurring gifts paid
from the Bills envelope, keep the proof next to it, and produce a year-end summary that applies the IRS floors and
limits.

**In scope:**
- cash donations (including recurring gifts) and the miles driven for charity,
- out-of-pocket medical and dental, and medical miles,
- child care,
- traditional IRA contributions and 529 contributions paid from the budget.

**Out of scope:**
- mortgage interest, property and state taxes, and other loan interest. These are reconciled at year end from the
  1098s and W-2s. The year-end report has one "other itemized deductions" box where that total can be typed in,
  only so the report can compare the itemized total to the standard deduction.
- donated items (cash giving only).
- HSA contributions: they're made through payroll, so they're already pre-tax and never come out of the budget.
- a dependent care FSA: the household doesn't have one.

## The rules the app applies

Figures marked *configurable* live in a per-year settings record (see `tax_years` below), because the 2027 figures
aren't published yet. The app fills in the known 2026 values and copies them forward with an "unconfirmed" flag
until someone checks them against the IRS.

### Donations (Schedule A, lines 11 to 14)
- From 2026 on, only giving above **0.5% of AGI** counts (*configurable*). The report shows the floor, total
  giving and the deductible part.
- Cash gifts to public charities are capped at **60% of AGI** (*configurable*); unlikely to matter but cheap to check.
- **Any single gift of $250 or more** needs a written acknowledgment from the charity, received before filing. The
  app flags those gifts until a receipt is attached or "acknowledgment received" is ticked. A charity's year-end
  statement clears the flag on every gift to that charity in that year, which covers recurring giving with one
  upload.
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
- Qualifying expenses are capped at **$3,000 for one child and $6,000 for two or more** (*configurable*). With no
  dependent care FSA, nothing is subtracted from the cap. (If one is added later, a paystub category and an offset
  are a small follow-up.)
- The credit rate depends on AGI; the report shows qualifying expenses and leaves the rate to tax software.

### Traditional IRA contributions (Schedule 1, above the line)
- Only **traditional** IRA contributions are tracked; Roth contributions aren't deductible.
- A contribution made from January 1 to the filing deadline (about April 15) can count for **either year**, so these
  transactions carry a tax year that defaults to the date's year and can be set to the prior year.
- Each spouse has their own limit (**$7,500** for 2026, plus a catch-up at 50 or older; *configurable*). The report
  shows each person's total against the limit.
- Because there's a 401(k) at work, the deduction phases out above an income range (*configurable*; the range
  differs for the spouse covered by the plan and one who isn't). The report flags when AGI is in or above that range and leaves the exact deductible amount to
  tax software.

### 529 contributions (state return only)
- There's no federal deduction. Many states allow one, with a cap per return or per beneficiary and their own rules.
- The report totals contributions per beneficiary for the year and compares them to a state cap typed into the
  year's settings (*configurable*, blank means "no cap known"). It doesn't try to encode state rules beyond that.

## Recurring gifts from the Bills envelope

Most giving is recurring and paid from the Bills envelope alongside non-deductible bills, so tagging the envelope
won't work. The app has no recurring-transaction feature today; each month's payment arrives as a new transaction
(typed in, synced by n8n or imported from Goodbudget). So recurring gifts are tagged by **rules** that match the
payee.

### New collection: `tax_rules`
- `payee_match` (text): matched case-insensitively against the transaction's payee, as "equals" or "contains"
  (`match_kind` select).
- `envelope` (relation, optional): only match in this envelope, for example Bills.
- `amount` (number, optional): only match this exact amount, for a payee that gets both gifts and purchases.
- What the rule applies: `tax_category`, `tax_payee`, and for 529s the beneficiary.
- `active` (bool), `external_id`.

### How rules are applied
- **On save, server side.** A hook in `pb_hooks/finance/lib.js` runs on every new or changed transaction that has
  no tax category of its own and fills it from the first matching rule. Because it runs in the hook, manual entry,
  n8n syncs and Goodbudget imports are all tagged the same way. Like the paycheck matching, it writes with a direct
  SQL update so it doesn't re-enter hooks.
- **Made from a transaction.** When tagging one gift in the transaction form, a checkbox "Tag future payments to
  this payee the same way" creates the rule (pre-filled with the payee and envelope). That's the normal way rules
  get made; there's also a small list on the Taxes view to edit or turn one off.
- **Back-filled once.** Saving a new rule offers "Also tag the N matching payments already this year", so a rule
  made in March catches January and February. It only touches rows with no tax category yet.
- **Overrides still win.** A transaction's own `tax_category` (including `none`) is never replaced by a rule. A
  rule-tagged row shows which rule tagged it, so it's easy to spot a wrong match.
- A **paused or stopped** gift needs nothing: the rule simply stops matching. Turning a rule off doesn't untag
  past rows.

### Acknowledgments for recurring gifts
Each monthly gift is usually under $250, so no per-gift receipt is needed, but if any single payment is $250 or more
it needs one. Either way, one year-end statement from the charity, attached to its payee, clears every gift for that
year.

## Data changes

One new migration file in `pb_migrations/` (for example `1764300000_tax_tracking.js`). Every new collection has
`owner` and the usual `owner = @request.auth.household` rules, and relation fields check the related record's
owner on create and update. Fields are mirrored in `app/backend/types.ts` and documented in `docs/api.md`.

Tax categories used throughout: `charity`, `medical`, `child_care`, `ira`, `529`.

### Envelopes: a default tax category
`envelopes.tax_category` (select, optional). Tagging the Donations envelope `charity` or the Medical envelope
`medical` tags everything spent from it, with no extra step per transaction. This also covers history imported
from Goodbudget, since imported rows land in envelopes. Mixed envelopes like Bills stay untagged and rely on rules.

### Transactions: per-row fields
- `tax_category` (select, optional): the categories plus `none`. Empty means "use the rule, then the envelope".
  `none` excludes a row (a birthday gift paid from Donations, for instance).
- `tax_rule` (relation, set by the hook): which rule tagged it.
- `tax_amount` (number, optional): the deductible part when it isn't the whole amount, such as a pharmacy run that
  was half prescriptions, or a charity dinner where the meal's value isn't deductible. Empty means the full amount.
- `tax_paid_by` (select, optional): `hsa`, `health_fsa`, `insurance`. Set when the expense was, or will be,
  reimbursed. These rows are listed in the report but excluded from the totals.
- `tax_payee` (relation to `tax_payees`, optional): the charity, provider, doctor, IRA or 529 plan.
- `tax_year` (number, optional): only shown for IRA contributions dated January to April; empty means the date's year.
- `tax_person` (text, optional): whose IRA, or which child's 529.
- `tax_acknowledged` (bool): the written acknowledgment for a $250+ gift is in hand.

The effective category is: the row's own `tax_category`, else the matching rule's, else the envelope's.

### New collection: `tax_payees`
Charities, providers and accounts, entered once and picked on each transaction or rule.
- `kind` (select): `charity`, `care_provider`, `medical_provider`, `ira`, `529_plan`
- `name`, `address`, `tin` (EIN or SSN; shown masked except to edit), `notes`, `external_id`
- `default_category` so picking a payee on an untagged transaction suggests the category.

### New collection: `mileage`
Miles driven aren't budget spending, so they don't go in `transactions` and never affect an envelope balance.
- `date`, `category` (`charity` or `medical`), `miles`, `purpose`, `tax_payee`, `external_id` (so n8n can sync,
  for example, a log from a phone shortcut)
- The dollar value is computed from the year's rate, not stored, so a corrected rate fixes every row.

### New collection: `tax_documents`
Receipts and proof, stored as protected files like paystub PDFs.
- `file` (protected, PDF or image, 15 MB), `tax_year`, `kind` (`receipt`, `acknowledgment`, `year_end_statement`,
  `other`), `label`
- Optional relations: `transaction`, `tax_payee`. A year-end statement links to the payee and covers all of that
  payee's gifts in the year; a single receipt links to its transaction.
- Attaching an `acknowledgment` or `year_end_statement` counts as "acknowledgment received" for the gifts it covers.

### New collection: `tax_years` (settings)
One record per household per year: `year`, `agi` (typed in), `other_itemized` (the year-end reconciled total),
`confirmed` (bool), and the configurable figures: `standard_deduction`, `charity_floor_pct` (0.5),
`charity_cash_cap_pct` (60), `nonitemizer_charity_cap` (2,000), `medical_floor_pct` (7.5),
`charity_mileage_rate` (0.14), `medical_mileage_rate`, `care_cap_one` (3,000), `care_cap_two` (6,000),
`qualifying_children`, `ira_limit` (7,500), `ira_catch_up`, `ira_phaseout_start`, `ira_phaseout_end`,
`state_529_cap`.

Defaults ship in `app/lib/tax.ts` as a table by year (2026 known values). A new year copies the latest known year
with `confirmed = false`, and the report shows a "check these figures" banner until someone ticks it.

### AGI estimate from paychecks
Gross pay minus pre-tax lines (401(k), HSA, FSA, pre-tax premiums) from the year's paystubs gives an estimate shown
next to the AGI box ("estimate from paychecks: $X, use it?"). It's only a starting point, since AGI also includes
interest, dividends and anything off-paycheck, and is lowered by IRA deductions. The real number gets typed in once
the return is drafted. No paystub schema change is needed.

## Where it shows up

- **Envelope form:** a "Tax category" picker next to Monthly/Annual.
- **Transaction form:** when the row is tagged (by envelope, rule or by hand), a small "Tax" section opens with the
  payee picker, deductible amount, "paid or reimbursed by", "attach receipt", and "tag future payments to this payee
  the same way". It stays collapsed and pre-filled, so a normal entry is no slower than today.
- **Activity list:** a small badge on tagged rows (with a repeat icon when a rule tagged it), and a warning dot on
  $250+ gifts with no acknowledgment.
- **New "Taxes" view on the Budget tab** (next to Paychecks), with a year picker and these parts:
  1. *To do:* gifts missing acknowledgments, providers missing a TIN, IRA contributions over the limit,
     unconfirmed figures, AGI not entered.
  2. *Donations:* list by charity with recurring gifts grouped, mileage, the 0.5% floor and the deductible total.
  3. *Medical:* list by provider, excluded rows shown greyed with the reason, mileage, the 7.5% floor and the
     deductible total.
  4. *Child care:* by provider with name, address and TIN, the cap and the qualifying expenses for Form 2441.
  5. *IRA and 529:* IRA contributions per person and tax year against the limit, with the phase-out flag; 529
     contributions per beneficiary against the state cap.
  6. *Itemize or not:* donations + medical + other itemized versus the standard deduction (plus the non-itemizer
     cash gift deduction), with the difference.
  7. *Rules:* the recurring-gift rules, with how many payments each tagged this year.
- **Exports:** a CSV of every tagged row and a ZIP of the year's documents, to hand to tax software or a preparer.
- **Mileage:** a "Log miles" button on the Taxes view, since miles don't belong to an envelope.

## Code layout (following the repo rules)

- `app/lib/tax.ts`: pure and unit tested. Year defaults, `effectiveCategory(tx, envelope, rules)`,
  `matchRule(tx, rules)`, `deductibleAmount(tx)`, the floors, caps and mileage math, the IRA limit and phase-out
  flag, the 529 cap, the to-do checks, the AGI estimate from paystub lines, and the itemize-or-not comparison.
  Tests in `testing/unit/`.
- `pb_hooks/finance/lib.js`: `applyTaxRule(app, tx)` called from the transaction create and update hooks (the same
  matching as `matchRule`, kept in step by shared test cases), plus a `POST /api/tax/rules/{id}/backfill` route
  that uses `lib.householdOf(e.auth)`. Add `tax_payees`, `tax_rules` and `mileage` to `SYNCABLE`, and let a sync
  fill `tax_payee` by the payee's `external_id`. `tax_documents` is upload-only, like paystubs.
- `app/backend/api.ts` and `types.ts`: the new collections and fields.
- `app/components/Taxes.tsx` (view), plus small additions to the envelope and transaction forms in
  `app/routes/budget.tsx`.
- `testing/api-smoke.sh`: rule checks for the new collections (including that a transaction or rule can't point at
  another household's payee), and that a synced transaction to a ruled payee comes back tagged.
  `testing/e2e.spec.ts`: tag a $300 gift, see the warning, attach a receipt, see it clear; tag a Bills payment with
  "tag future payments", add next month's payment and see it tagged; check the report totals.

## Build order

Each step is its own PR, usable on its own.
1. **Tagging:** migration fields on envelopes and transactions, `tax_payees`, the form changes, badges.
2. **Recurring rules:** `tax_rules`, the hook, "tag future payments", the back-fill.
3. **Receipts:** `tax_documents`, attach from a transaction or a payee, the acknowledgment warnings.
4. **Mileage:** the `mileage` collection and the log form.
5. **Year-end report:** `tax_years`, `app/lib/tax.ts`, the Taxes view, IRA and 529 sections, AGI estimate, exports.

Steps 1 to 3 should be in place before January, since they capture records as the year happens (and recurring
gifts start on January 1). Anything entered before then can still be back-filled by a rule. The report (step 5) is
only needed by early 2028, by which time the 2027 figures will be published.

## Decisions from Joey (2026-11-23)

1. No dependent care FSA; HSA contributions are made through payroll. Both left out.
2. Track IRA and 529 contributions paid from the budget.
3. Track cash giving only, not donated items.
4. A charity's year-end statement clears the acknowledgment warning on all of that year's gifts to it.
5. Recurring donations come from the Bills envelope and must be taggable once and applied to future payments.

*Tax figures come from IRS publications and coverage of the 2025 tax law (P.L. 119-21) as of November 2026. They
are inputs to check, not tax advice.*
