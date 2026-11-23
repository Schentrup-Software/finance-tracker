# Plan: vendors, and tracking tax-deductible spending from the budget

Status: plan only, nothing built yet. Target: tax year 2027 (filed in early 2028), itemizing, married filing jointly.

## Goal

1. Know **who the money goes to.** Every transaction is linked to a vendor, matched from the text the bank
   statement shows. That gives recurring-payment tracking and a "where the money goes" report on its own.
2. Tag the **deductible cash** that flows through the budget as it is spent, keep the proof next to it, and produce
   a year-end summary that applies the IRS floors and limits. A vendor carries its tax category, so tagging a
   charity once tags every gift to it, including recurring gifts paid from the Bills envelope.

**In scope:** cash donations (including recurring gifts), out-of-pocket medical and dental, child care, and
traditional IRA contributions paid from the budget.

**Out of scope:**
- mortgage interest, property and state taxes, and other loan interest. These are reconciled at year end from the
  1098s and W-2s. The year-end report has one "other itemized deductions" box where that total can be typed in,
  only so the report can compare the itemized total to the standard deduction.
- anything that isn't cash out of the budget: donated items and mileage (charity or medical).
- 529 contributions (no state income tax, so no deduction).
- HSA contributions (made through payroll, already pre-tax) and a dependent care FSA (the household doesn't have one).

## Vendors

### Statement text
A transaction's `payee` today holds whatever the source called it: the bank's description when n8n syncs it
(`"PAYPAL *STMARYSCHURCH 402-555-0100"`), the Name column from a Goodbudget import, or what was typed. That text is
kept as is; it's the **statement value** vendors match on. The tidy name comes from the vendor.

### New collection: `vendors`
- `name` (the tidy name, "St. Mary's Church"), `emoji`, `color`, `notes`, `archived`, `external_id`
- `matches` (JSON list of strings): statement values that belong to this vendor. Each is matched case-insensitively
  as "starts with" after collapsing spaces and dropping trailing reference numbers and dates, so
  `PAYPAL *STMARYSCHURCH` catches every month's charge even though the reference number changes.
- `default_envelope` (relation, optional): suggested envelope for new transactions from this vendor.
- `recurring` (select, optional): `weekly`, `biweekly`, `monthly`, `quarterly`, `annual`, plus `expected_amount`
  and `expected_day`. Set by hand, or suggested by the app (see below).
- Tax details (only shown when `tax_category` is set): `tax_category` (`charity`, `medical`, `child_care`, `ira`),
  `legal_name`, `address`, `tin` (EIN or SSN; shown masked except to edit). Form 2441 needs a child care
  provider's name, address and TIN; a charity's EIN is useful for the preparer.

### Transactions: new fields
- `vendor` (relation, optional): set automatically by matching, or picked by hand.
- `vendor_locked` (bool): set when someone picks the vendor by hand, so matching never changes it.

### How matching works
- **On save, server side.** A hook in `pb_hooks/finance/lib.js` runs on every new transaction, and on a changed
  one whose `payee` changed and isn't `vendor_locked`. It finds the vendor whose `matches` fit the statement value
  (longest match wins, so `AMAZON MKTPL` beats `AMAZON`). Because it runs in the hook, typed entries, n8n syncs and
  Goodbudget imports are all matched the same way. Like paycheck matching, it writes with a direct SQL update so it
  doesn't re-enter hooks. The match function lives in `app/lib/vendors.ts` (pure, unit tested) and the hook
  mirrors it; shared test cases keep the two in step.
- **Teaching it a new vendor.** An unmatched transaction shows its raw statement value with a "Who is this?"
  button. Picking an existing vendor or creating a new one adds that statement value (trimmed to its stable
  start, which can be edited) to the vendor's `matches`, then offers "Also match the N other transactions with
  this text". Back-filling only touches rows with no vendor.
- **Unmatched list.** The Vendors view lists statement values with no vendor yet, most frequent first, so the
  backlog from an import can be cleared in one sitting.
- **Merging.** Two vendors can be merged; their `matches` and transactions combine.

### Recurring payments
- The app suggests `recurring` for a vendor with three or more payments at a steady interval and similar amounts
  ("St. Mary's Church: about $200 on the 1st of each month. Mark as recurring?").
- A recurring vendor shows its next expected date and amount, and is flagged when a payment is **missed**
  (more than a week late) or **changed** (amount differs by more than 10%), which also catches a gift that was
  stopped or raised.
- Recurring vendors list their monthly total, which feeds budget planning: the Bills envelope can be checked
  against the sum of the recurring vendors that are paid from it.

### "Where the money goes" report
A Vendors view (on the Budget tab, next to Paychecks) with a period picker:
- spending by vendor for the month, year or a custom range, largest first, with each vendor's envelopes,
- each vendor's history and its trend against the same period last year,
- the recurring list (vendor, cadence, expected amount, next date, status),
- the unmatched statement values.

## The tax rules the app applies

Figures marked *configurable* live in a per-year settings record (see `tax_years` below), because the 2027 figures
aren't published yet. The app fills in the known 2026 values and copies them forward with an "unconfirmed" flag
until someone checks them against the IRS.

### Donations (Schedule A, lines 11 to 14)
- From 2026 on, only giving above **0.5% of AGI** counts (*configurable*). The report shows the floor, total
  giving and the deductible part.
- Cash gifts to public charities are capped at **60% of AGI** (*configurable*); unlikely to matter but cheap to check.
- **Any single gift of $250 or more** needs a written acknowledgment from the charity, received before filing. The
  app flags those gifts until a receipt is attached or "acknowledgment received" is ticked. A charity's year-end
  statement, attached to its vendor, clears the flag on every gift to that charity in that year.
- If the year ends up not worth itemizing, from 2026 non-itemizers can deduct up to **$2,000** (married filing
  jointly) of cash gifts (*configurable*). The report shows this so the comparison is fair both ways.

### Medical and dental (Schedule A, lines 1 to 4)
- Only the part above **7.5% of AGI** counts (*configurable*).
- Only money paid out of pocket counts. These are **excluded**:
  - anything paid from, or later reimbursed by, the **HSA** or a **health FSA**,
  - anything reimbursed by **insurance** (a refund from the same vendor lowers the total),
  - **pre-tax premiums** taken from paychecks (the `medical`, `dental` and `vision` paystub lines are pre-tax, so
    they are never counted).
- After-tax premiums paid from the budget (for example a dental plan paid directly) do count.

### Child care (Form 2441, a credit, not an itemized deduction)
Child care isn't a Schedule A deduction, but it comes out of the budget and needs the same record keeping, so it
belongs here. The report keeps it in its own section.
- Each provider needs **name, address and TIN** on Form 2441, stored on the vendor.
- Qualifying expenses are capped at **$3,000 for one child and $6,000 for two or more** (*configurable*).
- The credit rate depends on AGI; the report shows qualifying expenses and leaves the rate to tax software.

### Traditional IRA contributions (Schedule 1, above the line)
- Only **traditional** IRA contributions are tracked; Roth contributions aren't deductible.
- A contribution made from January 1 to the filing deadline (about April 15) can count for **either year**, so these
  transactions carry a tax year that defaults to the date's year and can be set to the prior year.
- Each spouse has their own limit (**$7,500** for 2026, plus a catch-up at 50 or older; *configurable*). The report
  shows each person's total against the limit.
- Because there's a 401(k) at work, the deduction phases out above an income range (*configurable*; the range
  differs for the spouse covered by the plan and one who isn't). The report flags when AGI is in or above that
  range and leaves the exact deductible amount to tax software.

## Tax data changes

### Where a transaction's tax category comes from
In order: the transaction's own `tax_category` (including `none`), else its **vendor's**, else its **envelope's**.
- Tagging the vendor is the main way: every gift to St. Mary's is `charity` wherever it's paid from, including the
  Bills envelope.
- Tagging an envelope (Medical as `medical`) covers spending with no vendor yet, or vendors that aren't tagged.
- `none` on a transaction excludes one row, such as a fundraiser dinner bought from a charity.

### Envelopes
`envelopes.tax_category` (select, optional).

### Transactions
- `tax_category` (select, optional): the categories plus `none`.
- `tax_amount` (number, optional): the deductible part when it isn't the whole amount, such as a pharmacy run that
  was half prescriptions. Empty means the full amount.
- `tax_paid_by` (select, optional): `hsa`, `health_fsa`, `insurance`. Set when the expense was, or will be,
  reimbursed. These rows are listed in the report but excluded from the totals.
- `tax_year` (number, optional): only shown for IRA contributions dated January to April; empty means the date's year.
- `tax_person` (text, optional): whose IRA.
- `tax_acknowledged` (bool): the written acknowledgment for a $250+ gift is in hand.

### New collection: `tax_documents`
Receipts and proof, stored as protected files like paystub PDFs.
- `file` (protected, PDF or image, 15 MB), `tax_year`, `kind` (`receipt`, `acknowledgment`, `year_end_statement`,
  `other`), `label`
- Optional relations: `transaction`, `vendor`. A year-end statement links to the vendor and covers all of that
  vendor's gifts in the year; a single receipt links to its transaction.

### New collection: `tax_years` (settings)
One record per household per year: `year`, `agi` (typed in), `other_itemized` (the year-end reconciled total),
`confirmed` (bool), and the configurable figures: `standard_deduction`, `charity_floor_pct` (0.5),
`charity_cash_cap_pct` (60), `nonitemizer_charity_cap` (2,000), `medical_floor_pct` (7.5), `care_cap_one` (3,000),
`care_cap_two` (6,000), `qualifying_children`, `ira_limit` (7,500), `ira_catch_up`, `ira_phaseout_start`,
`ira_phaseout_end`.

Defaults ship in `app/lib/tax.ts` as a table by year (2026 known values). A new year copies the latest known year
with `confirmed = false`, and the report shows a "check these figures" banner until someone ticks it.

### AGI estimate from paychecks
Gross pay minus pre-tax lines (401(k), HSA, FSA, pre-tax premiums) from the year's paystubs gives an estimate shown
next to the AGI box ("estimate from paychecks: $X, use it?"). It's only a starting point, since AGI also includes
interest, dividends and anything off-paycheck, and is lowered by IRA deductions. No paystub schema change is needed.

## Where it shows up

- **Transaction form:** a vendor picker (pre-filled by matching); when the row is tagged, a small "Tax" section
  with deductible amount, "paid or reimbursed by" and "attach receipt". It stays collapsed and pre-filled, so a
  normal entry is no slower than today.
- **Vendor form:** name, matches, default envelope, recurring, and the tax details.
- **Envelope form:** a "Tax category" picker next to Monthly/Annual.
- **Activity list:** the vendor's name and emoji in place of the raw statement text (raw text on hover), a tax
  badge on tagged rows, a warning dot on $250+ gifts with no acknowledgment.
- **Vendors view** (above).
- **Taxes view on the Budget tab**, with a year picker and these parts:
  1. *To do:* gifts missing acknowledgments, tagged vendors missing a TIN, IRA contributions over the limit,
     unmatched transactions in tagged envelopes, unconfirmed figures, AGI not entered.
  2. *Donations:* by charity (recurring gifts grouped), the 0.5% floor and the deductible total.
  3. *Medical:* by provider, excluded rows greyed with the reason, the 7.5% floor and the deductible total.
  4. *Child care:* by provider with name, address and TIN, the cap and the qualifying expenses for Form 2441.
  5. *IRA:* contributions per person and tax year against the limit, with the phase-out flag.
  6. *Itemize or not:* donations + medical + other itemized versus the standard deduction (plus the non-itemizer
     cash gift deduction), with the difference.
- **Exports:** a CSV of every tagged row and a ZIP of the year's documents, for tax software or a preparer.

## Code layout (following the repo rules)

- `app/lib/vendors.ts`: pure and unit tested. Statement normalisation, `matchVendor(payee, vendors)`, the stable
  prefix suggested when teaching a vendor, recurring detection, next expected date, missed/changed flags, and
  spending by vendor.
- `app/lib/tax.ts`: pure and unit tested. Year defaults, `effectiveCategory(tx, vendor, envelope)`,
  `deductibleAmount(tx)`, the floors and caps, the IRA limit and phase-out flag, the to-do checks, the AGI estimate,
  and the itemize-or-not comparison.
- `pb_hooks/finance/lib.js`: `matchVendor(app, tx)` called from the transaction create and update hooks, and
  `POST /api/vendors/{id}/backfill` and `POST /api/vendors/{id}/merge` routes that use `lib.householdOf(e.auth)`.
  Add `vendors` to `SYNCABLE`, and let a transaction sync set `vendor` by the vendor's `external_id` (a synced
  vendor counts as picked by hand). `tax_documents` is upload-only, like paystubs.
- `app/backend/api.ts` and `types.ts`: the new collections and fields.
- `app/components/Vendors.tsx` and `app/components/Taxes.tsx`, plus small additions to the transaction and
  envelope forms in `app/routes/budget.tsx`.
- `docs/api.md`: vendors, matching on sync, and the new transaction fields (n8n depends on it).
- `testing/api-smoke.sh`: rule checks for the new collections (including that a transaction can't point at another
  household's vendor), and that a synced transaction with a known statement value comes back with its vendor.
  `testing/e2e.spec.ts`: teach a vendor from an unmatched row and see the back-fill; tag the vendor as a charity and
  see next month's Bills payment tagged; attach a year-end statement and see the $250 warnings clear; check the
  report totals.

## Build order

Each step is its own PR, usable on its own.
1. **Vendors:** the `vendors` collection, transaction fields, the matching hook, teaching and back-fill, the
   unmatched list, vendor names in the activity list.
2. **Where the money goes:** the Vendors view, spending by vendor, recurring detection and flags.
3. **Tax tagging:** tax fields on vendors, envelopes and transactions, the form changes, badges.
4. **Receipts:** `tax_documents`, attach from a transaction or a vendor, the acknowledgment warnings.
5. **Year-end report:** `tax_years`, `app/lib/tax.ts`, the Taxes view, AGI estimate, exports.

Steps 1, 3 and 4 should be in place before January so 2027 is captured as it happens. Back-fill means late
matching still works, so step 2 can land any time. The report (step 5) is only needed by early 2028, by which time
the 2027 figures will be published.

## Decisions from Joey (2026-11-23)

1. No dependent care FSA; HSA contributions are made through payroll. Both left out.
2. Track traditional IRA contributions paid from the budget. 529s dropped: no state income tax.
3. Cash only: no donated items, no mileage.
4. A charity's year-end statement clears the acknowledgment warning on all of that year's gifts to it.
5. Recurring donations come from the Bills envelope. Vendors are matched from statement values, which handles
   recurring payments and also gives a "where the money goes" report. Vendors replace the earlier payee rules.

*Tax figures come from IRS publications and coverage of the 2025 tax law (P.L. 119-21) as of November 2026. They
are inputs to check, not tax advice.*
