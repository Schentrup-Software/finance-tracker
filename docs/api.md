# API reference (for n8n and other sync jobs)

The app is PocketBase, so everything you can do in the UI you can do over its REST API.
All examples use `https://finance.example.com` as the base URL; swap in yours (or
`http://localhost:8090` for local development).

Everything is in plain dollars (`123.45`). Dates are `YYYY-MM-DD` or PocketBase's
`YYYY-MM-DD HH:MM:SS.sssZ`; the app stores days at noon UTC (`2026-11-21 12:00:00.000Z`)
so they show on the same day in every time zone.

## 1. Authenticate

Every data endpoint needs a user token in the `Authorization` header. Data belongs to a
**household**: each record's `owner` is the head of the household, and every member of
the household sees and changes the same records. n8n can sign in as any member of your
household (a member just for n8n works well).

### Option A: sign in with a password (simple)

```http
POST /api/collections/users/auth-with-password
Content-Type: application/json

{ "identity": "you@example.com", "password": "..." }
```

Response: `{ "token": "eyJ...", "record": { "id": "...", ... } }`. Tokens last 7 days by
default, so sign in at the start of each workflow run. In n8n: an **HTTP Request** node
for this call, then pass `{{$json.token}}` as the `Authorization` header in later nodes.

### Option B: a long-lived token (no password stored in n8n)

A superuser can mint a token for a user that lasts as long as you choose. Sign in as a
superuser (the admin dashboard account), then:

```http
POST /api/collections/users/impersonate/{userId}
Authorization: <superuser token>
Content-Type: application/json

{ "duration": 31536000 }
```

The response's `token` is good for one year (`duration` is in seconds). Store it as an
n8n credential (Header Auth, name `Authorization`). Find `{userId}` in the admin dashboard
under **users**. To revoke it early, change the user's password.

## 2. Sync endpoint (recommended for n8n)

```http
POST /api/sync/{collection}
Authorization: <token>
Content-Type: application/json

{ "records": [ { "external_id": "...", ...fields } ] }
```

- `{collection}` is one of `earners`, `envelopes`, `vendors`, `transactions`, `debts`, `debt_payments`, `assets`.
- Every record needs an `external_id`: your stable id from the source (bank transaction
  id, account number, a slug you choose). A record with an `external_id` you've sent before
  is **updated**; a new one is **created**. Re-running a workflow never makes duplicates.
- Only the fields you send are changed on update.
- Relations can point at other records by their external id with a `_external_id` suffix:
  `envelope_external_id`, `earner_external_id` and `vendor_external_id` on transactions,
  `default_envelope_external_id` on vendors, `debt_external_id` on debt payments,
  `debts_external_id` (an array) on assets. You can also send the PocketBase `id` directly
  (`envelope`, `vendor`, `debt`, `debts`).
- Send bank transactions with the bank's description as `payee`: the server matches it to a
  vendor (see [Vendors](#vendors)). Naming a vendor yourself (`vendor` or `vendor_external_id`)
  sets `vendor_locked`, so matching leaves it alone.
- Up to 500 records per request. The batch is one transaction: if any record is invalid,
  nothing is saved and you get a `400` with the record's index and the reason.
- `owner`, `id`, `created` and `updated` are ignored if sent.

Response:

```json
{ "created": 3, "updated": 1, "records": [ { "id": "...", "external_id": "...", ... } ] }
```

### Examples

Update account balances (assets) every night:

```json
POST /api/sync/assets
{ "records": [
  { "external_id": "fidelity-401k", "name": "Fidelity 401(k)", "type": "401k", "institution": "Fidelity",
    "value": 96512.33, "as_of": "2026-11-22" },
  { "external_id": "hsa", "name": "HSA", "type": "hsa", "value": 7400 }
] }
```

Update a debt's balance:

```json
POST /api/sync/debts
{ "records": [ { "external_id": "chase-visa", "name": "Chase Visa", "type": "credit_card", "balance": 1432.18 } ] }
```

Import spending from the bank into envelopes:

```json
POST /api/sync/transactions
{ "records": [
  { "external_id": "bank-tx-88213", "kind": "expense", "envelope_external_id": "groceries",
    "date": "2026-11-21", "amount": 120.45, "payee": "Publix" },
  { "external_id": "bank-tx-88214", "kind": "income", "date": "2026-11-21", "amount": 2500, "payee": "Paycheck" }
] }
```

Record a paycheck deposit (see [Paychecks](#paychecks) for what happens next):

```json
POST /api/sync/transactions
{ "records": [
  { "external_id": "bank-tx-90001", "kind": "income", "earner_external_id": "joey",
    "date": "2026-12-05", "amount": 2313.10, "payee": "Acme Widgets payroll" }
] }
```

For `envelope_external_id` to work, give your envelopes external ids first (once), either by
editing them over the API (`PATCH /api/collections/envelopes/records/{id}` with
`{"external_id": "groceries"}`) or by creating them through `POST /api/sync/envelopes`.

Note on `debt_payments`: creating a payment **lowers the debt's balance** by its amount
(editing or deleting one adjusts it back). If your sync already sets `balance` on the debt
from the lender, don't also sync payments, or they'll be subtracted twice.

## Paychecks

Each paycheck in the household is an **earner** (`earners`). Each paystub (`paystubs`) has
the gross and net pay and one `paystub_lines` row for everything taken out before the
money reaches the bank: taxes, healthcare, retirement, 401(k) loan repayments and so on.

When an income transaction with an `earner` is created (in the app or through n8n), the
server compares its `amount` with that earner's most recent paystub's `net`:

- **Within one cent:** pay, taxes and deductions are assumed unchanged. The server copies
  the last paystub and its lines (`source: "repeat"`), dated on the deposit, and sets the
  transaction's `paystub_status` to `matched`.
- **Different, or no paystub yet:** `paystub_status` becomes `needs_paystub`, and the app
  shows a prompt to upload that paycheck's paystub. When a paystub is saved for that
  earner with the same net pay within a week of the deposit, it is tied to the deposit and
  the status becomes `matched`.

Changing a deposit's amount, date or earner runs the check again. Deleting a deposit
deletes its copied paystub.

Loan lines (`401k_loan`, `loan_other`) with a `debt` set create a matching `debt_payments`
row (external id `paystub-line:<line id>`), so the loan's balance goes down every paycheck.
Editing or deleting the line or paystub updates or removes that payment.

Contribution lines (`hsa`, `401k`, `roth_401k`, `retirement_other`) with an `asset` set add
their amount to that asset's `value` (and move `as_of` to the pay date), so an HSA or 401(k)
grows with every paycheck. Editing or deleting the line, its paystub or a deposit's copied
paystub takes the amount back out. If n8n also syncs that account's balance from the bank,
leave `asset` empty on those lines so the money isn't counted twice.

To have n8n remind you, poll for deposits waiting on a paystub:

```http
GET /api/collections/transactions/records?filter=paystub_status="needs_paystub"&expand=earner
```

Uploading a paystub with its file is a `multipart/form-data` create on `paystubs`
(field `file`); then create its lines on `paystub_lines`. Files are protected: get a file
token from `POST /api/files/token` and add `?token=...` to the file URL.

### Reading paystubs

The app reads paystub PDFs in the browser. If it can't make sense of one (or the file is
an image) and an OpenClaw agent is configured on the server, it asks the agent instead.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/paystubs/reader` | `{ "agent": true }` when an OpenClaw agent is configured |
| `POST` | `/api/paystubs/read` | Body `{ "filename", "media_type", "data": "<base64>" }`. Returns `{ pay_date, period_start, period_end, gross, net, lines: [{ label, category, amount }] }`. Saves nothing. |

The server calls the agent's OpenResponses endpoint (`POST {OPENCLAW_URL}/v1/responses`)
with the file as an `input_file` part. Set these on the container:

| Variable | |
| --- | --- |
| `OPENCLAW_URL` | Gateway URL, e.g. `http://192.168.1.20:18789` |
| `OPENCLAW_TOKEN` | Optional gateway token or password, sent as `Authorization: Bearer …`. Leave it unset when OpenClaw is behind a trusted proxy that handles auth |
| `OPENCLAW_AGENT` | Optional agent id; the default agent otherwise |

On the OpenClaw side, turn on the endpoint with `gateway.http.endpoints.responses.enabled: true`.
Its default file limit is 5 MB (`gateway.http.endpoints.responses.files.maxBytes`), and
`application/pdf` is allowed by default. Keep the gateway on your private network: its
token grants full operator access.

## Envelope balances and importing history

`GET /api/finance/balances?month=YYYY-MM` returns, for each envelope, the cash carried into
that month and what it has spent so far that year:

```json
{ "carried": { "<envelope id>": 3210 }, "year_spent": { "<envelope id>": 1471.92 } }
```

Only rollover and annual envelopes carry cash. An envelope with an `opening_date` counts
from its `opening_balance`: activity before that date is left out of its balance.

The app's **Import history** screen reads a CSV export (like Goodbudget's) in the browser,
then saves it with three calls you can also use from n8n:

1. `POST /api/sync/envelopes` for the envelopes (external ids `import-env-<name>`).
2. `POST /api/import/budgets` for each month's income and envelope transfers:

   ```json
   { "months": [ { "month": "2026-11", "planned_income": 6442.63,
       "allocations": [ { "envelope_external_id": "import-env-christmas", "amount": 1000 } ] } ] }
   ```

   A month that doesn't exist yet is created with `imported: true`. Each allocation listed
   replaces that envelope's amount for the month. At most 240 months per call.
3. `POST /api/sync/transactions` for the transactions. Each row's external id is a hash of
   its contents, so importing the same file again updates instead of duplicating.

## Vendors

Every transaction can belong to a **vendor**: who the money went to. A transaction's `payee` is
its *statement value* (what the bank, an import or a person wrote). Each vendor lists the
statement values that belong to it in `matches`.

- When a transaction is created, or its `payee` changes, the server links it to the vendor
  whose pattern it starts with (case and extra spaces don't matter, the longest pattern wins,
  and a pattern must end at a word boundary: `AMAZON` matches `AMAZON.COM*2K4` but not
  `AMAZONIA`). Spending with no envelope goes into the vendor's `default_envelope`.
- A transaction with `vendor_locked: true` keeps the vendor it has.
- Patterns are usually the statement text with trailing words that contain digits removed,
  so `PAYPAL *STMARYSCHURCH 402-555-0100` and next month's `… 402-555-0177` both read
  `PAYPAL *STMARYSCHURCH`.

| Method | Path | Body | |
| --- | --- | --- | --- |
| `POST` | `/api/vendors/{id}/backfill` | | Links the household's transactions with no vendor (and not locked) that fit this vendor. `{ "matched": 3 }` |
| `POST` | `/api/vendors/{id}/merge` | `{ "into": "<vendor id>" }` | Moves the vendor's transactions, documents and patterns into another vendor, then deletes it. `{ "moved": 12 }` |
| `GET` | `/api/vendors/unmatched` | | Statement values with no vendor yet, grouped by pattern, most frequent first: `{ "items": [ { "pattern", "count", "total", "last_date", "example" } ] }`. Paychecks and income to the budget are left out |

Adding a pattern to a vendor (a `PATCH` of `matches`) doesn't change earlier transactions;
call `backfill` afterwards.

## Taxes

The app tracks deductible spending that comes out of the budget: donations, out-of-pocket
medical, child care and traditional IRA contributions. A transaction's tax category is its own
`tax_category` if set (`none` means not deductible), else its vendor's, else its envelope's.
Receipts and charities' year-end statements are `tax_documents`; each year's AGI and IRS
figures are a `tax_years` record. The year-end summary is worked out in the app
(`app/lib/tax.ts`), not by the API.

## 3. Standard PocketBase endpoints

Each collection also has the usual PocketBase CRUD API:

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/collections/{collection}/records` | List. `?filter=`, `?sort=`, `?page=`, `?perPage=` (max 1000), `?expand=` |
| `GET` | `/api/collections/{collection}/records/{id}` | One record |
| `POST` | `/api/collections/{collection}/records` | Create (`owner` may be left out) |
| `PATCH` | `/api/collections/{collection}/records/{id}` | Update the fields you send |
| `DELETE` | `/api/collections/{collection}/records/{id}` | Delete |

Filter examples:

- `transactions?filter=date >= "2026-11-01" && date < "2026-12-01"&sort=-date`
- `debts?filter=type = "401k_loan" && balance > 0` (loans repaid from a paycheck)
- `assets?expand=debts` (each asset with the debts linked to it)
- `allocations?filter=budget.month = "2026-11"&expand=envelope`

Full reference: <https://pocketbase.io/docs/api-records/>.

Other endpoints:

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/health` | Health check, no auth |
| `GET` | `/api/finance/setup` | `{ "signupOpen": bool }`; sign-up closes after the first account |

## 4. Collections

Every collection also has `id`, `owner` (the household: its head's user id), `created`
and `updated`.

### `users` — people who sign in

| Field | Type | |
| --- | --- | --- |
| `email`, `name` | text | Members of a household can see each other |
| `household` | relation → users | The head of the user's household; the head points at themself. Read-only through the API |

Household members are managed by the head:

| Method | Path | Body | |
| --- | --- | --- | --- |
| `POST` | `/api/household/members` | `{ "email", "name", "password" }` | Adds a person to the head's household |
| `POST` | `/api/household/members/{id}/password` | `{ "password" }` | Sets a member's password |
| `DELETE` | `/api/household/members/{id}` | | Removes a member's sign-in. The household's data stays |

Anyone else gets `403` (not the head) or `404` (not in your household).

### `envelopes` — the cash envelopes

| Field | Type | |
| --- | --- | --- |
| `name` | text, required | |
| `group` | `giving` `saving` `housing` `utilities` `food` `transportation` `insurance` `health` `personal` `lifestyle` `debt` `other` | Ramsey category |
| `color` | `coral` `peach` `butter` `mint` `aqua` `sky` `lilac` `pink` | |
| `emoji` | text | |
| `default_amount` | number | Used when a new month starts with no earlier budget |
| `rollover` | bool | Sinking fund: unspent cash carries into next month |
| `sort` | number | |
| `archived` | bool | Hidden from new months |
| `period` | `monthly` (or empty) or `annual` | Annual envelopes save toward a yearly goal and always keep leftover cash |
| `goal` | number ≥ 0 | Yearly goal for annual envelopes |
| `opening_balance` | number | Cash in the envelope at the end of `opening_date`. Set by an import |
| `opening_date` | date | Balances count from here; earlier months show spending only |
| `tax_category` | `charity` `medical` `child_care` `ira` or empty | Spending from this envelope counts toward it at tax time |
| `external_id` | text | Unique per household |

### `budgets` — one per month

| Field | Type | |
| --- | --- | --- |
| `month` | text `YYYY-MM`, required | Unique per household |
| `planned_income` | number | Expected take-home pay |
| `notes` | text | |
| `imported` | bool | Created by an import. A new month copies envelope amounts from the last month that wasn't imported |

### `allocations` — how much goes in each envelope for a month

| Field | Type | |
| --- | --- | --- |
| `budget` | relation → budgets, required | |
| `envelope` | relation → envelopes, required | Unique per budget |
| `amount` | number | Can be negative when envelope transfers moved money out that month |

Left to budget = `planned_income` − sum of the month's allocations (aim for $0).
Envelope cash left = allocation (+ carried, for rollover envelopes) − the month's expenses.

### `transactions` — money out of an envelope, or money in

| Field | Type | |
| --- | --- | --- |
| `kind` | `expense` or `income`, required | |
| `envelope` | relation → envelopes | Expense: the envelope it came from. Income: money put straight into that envelope (a refund or payback). Income with no envelope goes to the month's budget |
| `earner` | relation → earners | Income only: whose paycheck this deposit is |
| `paystub_status` | `matched`, `needs_paystub` or empty | Set by the server; see [Paychecks](#paychecks) |
| `date` | date, required | |
| `amount` | number ≥ 0, required | Always positive; `kind` says which way |
| `payee` | text | |
| `note` | text | |
| `account` | text | Bank or card account, e.g. `Visa` |
| `vendor` | relation → vendors | Set by matching `payee`, or by hand |
| `vendor_locked` | bool | The vendor was picked by hand; matching leaves it alone |
| `tax_category` | `charity` `medical` `child_care` `ira` `none` or empty | Overrides the vendor's and envelope's category. Empty: use theirs |
| `tax_amount` | number ≥ 0 | The deductible part, when it isn't all of it. `0` means the whole amount |
| `tax_paid_by` | `hsa` `health_fsa` `insurance` or empty | Medical paid or paid back by one of these doesn't count |
| `tax_year` | number | IRA contributions until the April deadline can count for the year before. `0` means the date's year |
| `tax_person` | text | Whose IRA |
| `tax_acknowledged` | bool | The charity's written acknowledgment is in hand (needed for a single gift of $250 or more) |
| `external_id` | text | Unique per household |

### `vendors` — who the money goes to

| Field | Type | |
| --- | --- | --- |
| `name` | text, required | |
| `emoji` | text | |
| `color` | same values as envelopes | |
| `matches` | JSON array of text | Statement values that belong to this vendor, e.g. `["PAYPAL *STMARYSCHURCH"]` |
| `default_envelope` | relation → envelopes | New spending with no envelope goes here |
| `recurring` | `weekly` `biweekly` `monthly` `quarterly` `annual` or empty | |
| `expected_amount` | number ≥ 0 | Usual amount of a recurring payment |
| `expected_day` | number 0–31 | Usual day of the month |
| `tax_category` | `charity` `medical` `child_care` `ira` or empty | Every payment to this vendor counts toward it |
| `legal_name`, `address` | text | For tax forms (Form 2441 needs a child care provider's) |
| `tin` | text | EIN or SSN |
| `notes` | text | |
| `archived` | bool | Still matched, left out of lists |
| `external_id` | text | Unique per household |

### `tax_documents` — receipts and acknowledgments

| Field | Type | |
| --- | --- | --- |
| `file` | file (PDF or image, 15 MB, protected), required | Upload as `multipart/form-data` |
| `tax_year` | number, required | |
| `kind` | `receipt` `acknowledgment` `year_end_statement` `other` | A `receipt` or `acknowledgment` on a gift, or the charity's `year_end_statement` for the year, counts as the acknowledgment |
| `label` | text | |
| `transaction` | relation → transactions | The payment it's for |
| `vendor` | relation → vendors | For a year-end statement: covers every gift to the vendor that year |

### `tax_years` — AGI and the IRS figures for a year

One per household per `year`. Percentages are in percent (`7.5`).

| Field | Type | |
| --- | --- | --- |
| `year` | number, required | |
| `agi` | number | Adjusted gross income; the floors are a share of it |
| `other_itemized` | number | Mortgage interest, state taxes and the like, reconciled by hand |
| `confirmed` | bool | The figures were checked against the IRS |
| `standard_deduction` | number | |
| `charity_floor_pct`, `charity_cash_cap_pct` | number | Only giving above the floor counts; cash gifts are capped at this share of AGI |
| `nonitemizer_charity_cap` | number | Cash gifts deductible without itemizing |
| `medical_floor_pct` | number | Only medical above this share of AGI counts |
| `care_cap_one`, `care_cap_two`, `qualifying_children` | number | Form 2441 expense caps |
| `ira_limit`, `ira_catch_up` | number | Per person |
| `ira_phaseout_start`, `ira_phaseout_end` | number | AGI range where a spouse covered at work loses the deduction |
| `notes` | text | |

### `debts`

| Field | Type | |
| --- | --- | --- |
| `name` | text, required | |
| `type` | `credit_card` `auto` `student` `medical` `personal` `mortgage` `heloc` `401k_loan` `other` | |
| `lender` | text | |
| `balance` | number | Current balance |
| `original_balance` | number | For the "paid off" progress bar |
| `interest_rate` | number | APR in percent (`6.5`) |
| `minimum_payment` | number | Monthly payment; the payoff date is worked out from it and the APR |
| `due_day` | number 1–31 | |
| `notes` | text | |
| `external_id` | text | Unique per household |

### `debt_payments`

| Field | Type | |
| --- | --- | --- |
| `debt` | relation → debts, required | |
| `date` | date, required | |
| `amount` | number ≥ 0, required | Lowers the debt's balance |
| `note` | text | |
| `external_id` | text | Unique per household |

### `assets`

| Field | Type | |
| --- | --- | --- |
| `name` | text, required | |
| `type` | `real_estate` `vehicle` `collectible` `checking` `savings` `brokerage` `401k` `ira` `roth_ira` `hsa` `529` `crypto` `cash` `other` | |
| `institution` | text | |
| `value` | number | |
| `as_of` | date | When the value was last checked |
| `debts` | relation → debts (many) | Debts tied to this asset; equity = value − their balances |
| `notes` | text | |
| `external_id` | text | Unique per household |

### `earners` — each paycheck in the household

| Field | Type | |
| --- | --- | --- |
| `name` | text, required | |
| `employer` | text | |
| `color` | same values as envelopes | |
| `pay_frequency` | `weekly` `biweekly` `semimonthly` `monthly` | |
| `archived` | bool | |
| `external_id` | text | Unique per household |

### `paystubs`

| Field | Type | |
| --- | --- | --- |
| `earner` | relation → earners, required | |
| `pay_date` | date, required | |
| `period_start`, `period_end` | date | |
| `gross` | number | |
| `net` | number | Take-home pay |
| `file` | file (PDF or image, 15 MB, protected) | |
| `source` | `upload` `manual` `repeat` | `repeat` = copied by the server |
| `transaction` | relation → transactions | The deposit it explains |
| `notes` | text | |
| `external_id` | text | Unique per household |

### `paystub_lines`

| Field | Type | |
| --- | --- | --- |
| `paystub` | relation → paystubs, required | |
| `category` | required: `federal_tax` `state_tax` `local_tax` `social_security` `medicare` `medical` `dental` `vision` `hsa` `fsa` `life` `disability` `401k` `roth_401k` `retirement_other` `401k_loan` `loan_other` `other_pre_tax` `other_post_tax` | |
| `label` | text | As printed on the stub |
| `amount` | number ≥ 0 | |
| `debt` | relation → debts | For loan lines: the debt it pays down |
| `asset` | relation → assets | For HSA and retirement lines: the account it goes into |
| `sort` | number | |

## 5. Errors

PocketBase errors look like `{ "status": 400, "message": "...", "data": { "field": { "message": "..." } } }`.

- `400`: invalid data, or a relation to a record that isn't yours.
- `401`: missing or expired token. Sign in again.
- `403`: not allowed (for example, sign-up after the first account).
- `404`: not found, or not yours.
