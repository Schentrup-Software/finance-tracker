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

### Option A: an API token (recommended for n8n)

In the app, the key button at the top right opens **API tokens**. **New token**, give it a
name (`n8n`), and copy the token it shows. It starts with `ft_` and is shown only once: the
app stores just a SHA-256 hash of it.

```http
GET /api/collections/envelopes/records
Authorization: ft_...
```

(`Authorization: Bearer ft_...` works too.) In n8n, store it as a **Header Auth**
credential with the name `Authorization`.

- A token acts as the household member who made it, so it can do anything they can do with
  the household's data: the collection endpoints, `/api/sync/...`, `/api/paystubs/...`,
  realtime and the rest of this page.
- Tokens **never expire**, and changing a password doesn't affect them. Revoke one on the
  API tokens page and it stops working at once
  (`401`). Removing the member who made it revokes their tokens too.
- A token can't make anything that would outlive it: it can't list, make or revoke tokens,
  add, remove or set the password of household members (even the head's token), start an
  email change, or be swapped for a regular sign-in (`auth-refresh`). Those answer `403`,
  so revoking a leaked token really ends it. Revoking also closes any realtime connection
  the token subscribed.
- A revoked or mistyped token gets `401` on every endpoint, even ones that are otherwise
  open, so a broken credential fails loudly instead of quietly seeing no data.

Token management (needs a signed-in session, not a token):

| Method | Path | Body | |
| --- | --- | --- | --- |
| `GET` | `/api/tokens` | | `{ "items": [ { "id", "name", "prefix", "created", "last_used", "user": { "id", "name", "email" } } ] }`, the household's tokens, newest first |
| `POST` | `/api/tokens` | `{ "name" }` | Makes a token acting as you. The response has the same fields plus `token`, the only time it's returned |
| `DELETE` | `/api/tokens/{id}` | | Revokes a token in your household |

`last_used` is updated at most every five minutes.

### Option B: sign in with a password

```http
POST /api/collections/users/auth-with-password
Content-Type: application/json

{ "identity": "you@example.com", "password": "..." }
```

Response: `{ "token": "eyJ...", "record": { "id": "...", ... } }`. Tokens last 7 days by
default, so sign in at the start of each workflow run. Sign-ins (for members and
superusers) are limited to 10 a minute from one address; more get `429`. Behind a reverse
proxy that can mean 10 a minute for everyone, which is one more reason to use an API token. In n8n: an **HTTP Request** node
for this call, then pass `{{$json.token}}` as the `Authorization` header in later nodes.

### Option C: a superuser impersonation token

A superuser can also mint a PocketBase token for a user that lasts as long as you choose.
Sign in as a superuser (the admin dashboard account), then:

```http
POST /api/collections/users/impersonate/{userId}
Authorization: <superuser token>
Content-Type: application/json

{ "duration": 31536000 }
```

`duration` is in seconds. To revoke it early, change the user's password. Option A is
easier and can be revoked one token at a time.

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
  `envelope_external_id`, `earner_external_id`, `vendor_external_id`, `account_asset_external_id`
  and `account_debt_external_id` on transactions, `default_envelope_external_id` on vendors,
  `debt_external_id` and `from_asset_external_id` on debt payments,
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

Reimbursements paid after net pay (an insurance offset, a stipend) are `paystub_lines` with
category `reimbursement`. They land in the bank with the take-home pay, so a paystub's
`deposit` is the stub's check amount: `net` plus its reimbursements. When `deposit` is 0
or not set, the deposit is `net`.

When an income transaction with an `earner` is created (in the app or through n8n), the
server compares its `amount` with that earner's most recent paystub's `deposit` (or `net`):

- **Within one cent, above or below:** pay, taxes and deductions are assumed unchanged. The server copies
  the last paystub and its lines (`source: "repeat"`), dated on the deposit (any one-cent
  difference goes into `net`), and sets the
  transaction's `paystub_status` to `matched`.
- **Different, or no paystub yet:** `paystub_status` becomes `needs_paystub`, and the app
  shows a prompt to upload that paycheck's paystub. When a paystub is saved for that
  earner with the same `deposit` (or net pay) within a week of the deposit, it is tied to the deposit and
  the status becomes `matched`. The nearest such deposit wins, and it can also be income with
  no `earner` and no `envelope` (imported), which then gets the earner, or a deposit that
  only has a copied paystub, which the real one replaces. A copied paystub that has a
  `file` (its own PDF, saved by a bulk upload) counts as that paycheck's paystub, so its
  deposit is left alone unless the new paystub names it in `transaction`.

- **Backfill:** `POST /api/paystubs/{id}/backfill` copies a paystub to every deposit from
  the same earner that is still `needs_paystub` and within one cent (above or below) of its
  `deposit` (or `net`). That includes deposits before the pay date, and later ones that
  landed before the paystub was saved, unless another uploaded or typed-in paystub is
  dated between them. Income with no `earner` and no `envelope` (imported from the
  bank or Goodbudget) counts too: when it matches, it gets this paystub's earner.
  It returns `{ "filled": <count> }`. The app calls it after saving a paystub's lines; call
  it from n8n after creating a paystub and its lines. Loan and contribution lines on those
  copies only pay down a debt or raise an asset that was already in the app on the
  deposit's date, since a balance typed in later already includes them.

When a deposit doesn't match the paystub before it, it is also checked against the
earner's next uploaded or typed-in paystub, so marking an old deposit as someone's
paycheck fills it in from the paystub that came after it.

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

Employer contributions (insurance the employer pays for, a 401(k) match or contribution,
an HSA contribution) are `paystub_lines` with `employer_paid: true`. They are paid on top
of gross pay, not taken out of it, so they are left out of "gross minus deductions equals
net". Their category says what they are (an employer 401(k) contribution is `401k`, the
traditional kind, even when it goes into the account that holds Roth contributions), and a
retirement or HSA one with an `asset` set raises that asset's value like any other
contribution line. Copied paystubs (`source: "repeat"`) copy them too.

To have n8n remind you, poll for deposits waiting on a paystub:

```http
GET /api/collections/transactions/records?filter=paystub_status="needs_paystub"&expand=earner
```

Uploading a paystub with its file is a `multipart/form-data` create on `paystubs`
(field `file`); then create its lines on `paystub_lines`. Files are protected: get a file
token from `POST /api/files/token` and add `?token=...` to the file URL.

### Bulk upload (a zip of paystub PDFs, or one PDF with a paystub per page)

The app's **Many paystubs** button takes a zip of paystub PDFs, or one PDF with a paystub
on each page (split into one PDF per page). It reads each one in the browser, then sends
them all at once. The server saves all of them or none.

```http
POST /api/paystubs/bulk
Content-Type: multipart/form-data

earner=<earner id>
stubs=[{ "name": "2026-11-13.pdf", "earner": "<earner id>", "file": 0, "pay_date": "2026-11-13",
         "period_start": "2026-10-27", "period_end": "2026-11-09",
         "gross": 4791.67, "net": 2925.35, "deposit": 3188.52,
         "ytd_gross": 105416.74, "ytd_net": 64357.70,
         "lines": [{ "category": "federal_tax", "label": "Federal Income Tax", "amount": 542.23,
                     "debt": "", "asset": "", "employer_paid": false }] }, ...]
files=<PDF>   (one part per stub; `file` is its position, from 0)
```

A stub's `earner` (optional) is whose paystub it is; the app fills it in from the name
printed on the stub. Stubs without one go to the request's `earner`. In pay-date order,
each stub:

- **Already in the app:** the earner has a paystub paid within 4 days of `pay_date` with
  the same check amount (within a cent). That's usually one the server copied onto a
  matching deposit (`source: "repeat"`). Its amounts are kept; the PDF is saved in its
  `file` (if it has none yet) and `ytd_gross`/`ytd_net` are filled in. If the paystub found
  is a copy with a *different* check amount, the upload fails: the copy was wrong.
- **New:** saved like an uploaded paystub (`source: "upload"`): it is tied to its deposit,
  backfills matching paychecks (see above), and its loan and contribution lines move
  their debts and assets.

Then, when the stub prints year-to-date gross or net pay, that figure is checked against
the paystubs in the app: the last earlier paystub this year with the figure printed, plus
every paystub since (copies included), up to and including this one. With no earlier
figure, it counts from January 1st, but only if the app has this earner's paystubs from
the first pay period of the year; otherwise it's not checked. Each copied paystub may be
a cent off. If a figure has drifted, the request fails with `400` and a message naming
the stub and both amounts, and **everything** the upload did (paystubs, PDFs, deposit
links, backfilled copies, loan payments, asset changes) is rolled back.

Returns `{ "results": [ { index, name, pay_date, action, source, filled, paystub, ytd } ] }`,
in the order sent. `action` is `added`, `attached` (PDF saved with the paystub already
there) or `already` (that paystub already had a PDF). `ytd.gross` / `ytd.net` are
`{ checked, printed, expected, off, ok }` when the stub printed them.

### Reading paystubs

The app reads paystub PDFs in the browser. If it can't make sense of one (or the file is
an image) and an OpenClaw agent is configured on the server, it asks the agent instead.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/paystubs/reader` | `{ "agent": true }` when an OpenClaw agent is configured |
| `POST` | `/api/paystubs/read` | Body `{ "filename", "media_type", "data": "<base64>" }`. Returns `{ pay_date, period_start, period_end, gross, net, lines: [{ label, category, amount }], ytd_gross, ytd_net }`. Saves nothing. |

The server calls the agent's OpenResponses endpoint (`POST {OPENCLAW_URL}/v1/responses`)
with the file as an `input_file` part. Set these on the container:

| Variable | |
| --- | --- |
| `OPENCLAW_URL` | Gateway URL, e.g. `http://192.168.1.20:18789` |
| `OPENCLAW_TOKEN` | Optional gateway token or password, sent as `Authorization: Bearer …`. Leave it unset when OpenClaw is behind a trusted proxy that handles auth |
| `OPENCLAW_AGENT` | Optional agent id; the default agent otherwise |
| `OPENCLAW_USERNAME` / `OPENCLAW_PASSWORD` | Optional HTTP basic login, for a proxy in front of OpenClaw that asks for one. `https://user:pass@host` in `OPENCLAW_URL` works too. Sent as `Authorization: Basic …`, so it takes the place of `OPENCLAW_TOKEN` if both are set. Never logged |

When the agent can't be reached or answers with an error, the call returns `400` with a
short message, and the PocketBase request log entry's `details` hold the URL, agent, status,
response headers and the first 2,000 characters of the response body (secrets redacted).

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
then saves it with calls you can also use from n8n:

0. The accounts. Each value in the file's Account column (or a column named `Standard`) is
   an account. Moves between accounts (rows with no envelope) are paired into transfers, and
   the transfers tell the kind: a card is spent on and paid off by transfers from another
   account, checking is where paychecks land and what pays the cards, savings mostly moves
   money back and forth. The person confirms each kind. Checking, savings and cash accounts
   are `POST /api/sync/assets` and credit cards `POST /api/sync/debts`, with external ids
   `import-acct-<name>` (an asset or debt already in the app with the same name keeps its
   own external id, or gets that one).
1. `POST /api/sync/envelopes` for the envelopes (external ids `import-env-<name>`).
2. `POST /api/import/budgets` for each month's income and envelope transfers:

   ```json
   { "months": [ { "month": "2026-11", "planned_income": 6442.63,
       "allocations": [ { "envelope_external_id": "import-env-christmas", "amount": 1000 } ] } ] }
   ```

   A month that doesn't exist yet is created with `imported: true`. Each allocation listed
   replaces that envelope's amount for the month. At most 240 months per call.
3. `POST /api/sync/transactions` for the transactions. Each row's external id is a hash of
   its contents, so importing the same file again updates instead of duplicating. Each one
   links to its account with `account_asset_external_id` or `account_debt_external_id`.
4. `POST /api/sync/debt_payments` for each transfer into a card (`from_asset_external_id` is
   the account that paid), then `POST /api/sync/debts` again to set each card's balance as of
   the file's last day, since the payments lowered it.

## SimpleFIN Bridge (bank balances and transactions)

The **Bank accounts** page (the bank button at the top) is also the first onboarding step: until a
household has connected SimpleFIN or someone chose **Skip** (`users.simplefin_skipped` on the head
of the household), the app opens it before anything else, so a history import can match its
accounts to SimpleFIN's. It connects
[SimpleFIN Bridge](https://beta-bridge.simplefin.org/). Each account SimpleFIN reports
can bring its transactions into the budget, keep just its balance current, or be left out.
n8n doesn't need to do anything for this; these endpoints are what the app uses.

| Method | Path | Body | |
| --- | --- | --- | --- |
| `GET` | `/api/simplefin` | | `{ "minute", "connected", "skipped", "holding", "imported" }`: the minute past the hour this server checks for pulls that are due, whether the household has a connection, when someone chose to skip SimpleFIN (`""` if nobody has), whether a connection is still held for the end of onboarding, and whether any history was brought in other than by SimpleFIN |
| `POST` | `/api/simplefin/skip` | | The household will enter accounts by hand: onboarding stops asking. Same answer as `GET` |
| `POST` | `/api/simplefin/finish` | `{ "from"? }` | The end of onboarding: held connections start bringing in transactions, with a first pull now. `from` (`YYYY-MM-DD`) moves spending accounts that would start later back to that day, only when no history was imported. `→ { "transactions", "payments", "errors" }` |
| `POST` | `/api/simplefin/connect` | `{ "setup_token", "sync_hour_utc", "hold"? }` | Claims the setup token (each works once), saves the connection and pulls its account list. `→ { "id", "pulled", "error" }`; `error` is set if that first pull failed |
| `POST` | `/api/simplefin/{id}/sync` | | Pulls now. `→ { "accounts", "transactions", "payments", "warnings" }` |
| `DELETE` | `/api/simplefin/{id}` | | Forgets the connection and its account list. Transactions, payments, assets and debts it made stay |

Onboarding: step 1 connects SimpleFIN with `hold: true` and saves what each account is for, with
transactions starting today. A held connection's pulls refresh balances only. Step 2 is the history
import: when it finishes it calls `/api/simplefin/finish`, so SimpleFIN picks up the day after the
spreadsheet ends and nothing comes in twice. Skipping the import finishes setup too, and offers to
start from the 1st of the month instead of today.

How a pull works:

- The server pulls each connection **once every morning** at `sync_hour_utc` (6 AM where the
  person was when they connected) and the instance's own minute. The minute is picked at random
  the first time the server starts and kept in `pb_data/simplefin_minute`, so instances spread
  out over the hour and away from the top of it (`SIMPLEFIN_MINUTE` overrides it). A server
  that was off in the morning catches up within the hour once a day has gone by.
- It asks for transactions since the last pull less five days (banks post late), or the first
  time since the account's `sync_from` day; never more than 89 days back (the Bridge's limit).
  Pending transactions are left out until they post.
- Accounts with `use: "spending"`: money out is an `expense`, money in is `income`, with
  `external_id` `sfin-<account id>-<transaction id>`, so overlapping pulls never duplicate.
  Transactions on or after `sync_from` only. They link to the account with `account_asset` or
  `account_debt`, get a vendor (and its envelope) from the payee, and a deposit whose payee
  names an earner's employer is that earner's paycheck.
- Money into a card that reads like a payment ("PAYMENT THANK YOU", "AUTOPAY") is a
  `debt_payment`. The withdrawal that paid it (the same amount within five days on another
  spending account) is the other side of it, not spending: it's left out, and the payment's
  `from_asset` and `from_external_id` point at it, even when the two sides arrive on different days.
- Accounts with `use: "spending"` or `"balance"` set their asset's `value` and `as_of`, or their
  debt's `balance` (what the bank shows as owed, which SimpleFIN reports as negative), after
  the transactions, so the bank's figure wins.
- Problems (a bank that needs signing in again, the Bridge's rate-limit warnings) are saved on
  the connection's `last_error` and shown on the Bank accounts page.

The history import (above) can match each imported account to a SimpleFIN account: its balance
fills in, and the SimpleFIN account takes over from the day after the file's last day
(`sync_from`), so nothing is brought in twice.

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
| `simplefin_skipped` | date | On the head: when someone chose to skip connecting SimpleFIN during onboarding. Set by `POST /api/simplefin/skip`; read-only through the API |

Household members are managed by the head:

| Method | Path | Body | |
| --- | --- | --- | --- |
| `POST` | `/api/household/members` | `{ "email", "name", "password" }` | Adds a person to the head's household |
| `POST` | `/api/household/members/{id}/password` | `{ "password" }` | Sets a member's password |
| `DELETE` | `/api/household/members/{id}` | | Removes a member's sign-in. The household's data stays |

Anyone else gets `403` (not the head, or an API token) or `404` (not in your household).

### `api_tokens` — API tokens

Superuser-only through the collection API (and `token_hash` is hidden); use `/api/tokens`
(see [Authenticate](#1-authenticate)).

| Field | Type | |
| --- | --- | --- |
| `user` | relation → users | The member the token acts as. Removing them deletes their tokens |
| `name` | text | What uses it, like `n8n` |
| `token_hash` | text | SHA-256 of the token (hex). The token itself isn't stored |
| `prefix` | text | The token's first 7 characters, to tell tokens apart |
| `last_used` | date | When it last signed a request (updated at most every five minutes) |

### `envelopes` — the cash envelopes

| Field | Type | |
| --- | --- | --- |
| `name` | text, required | |
| `group` | `giving` `saving` `housing` `utilities` `food` `transportation` `insurance` `health` `personal` `lifestyle` `debt` `other` | Ramsey category |
| `color` | `coral` `peach` `butter` `mint` `aqua` `sky` `lilac` `pink` | |
| `emoji` | text | |
| `default_amount` | number | Used when a new month starts with no earlier budget |
| `rollover` | bool | Sinking fund: unspent cash carries into next month |
| `sort` | number | Place in the envelope list, lowest first. The app renumbers envelopes 0, 1, 2… when someone drags them into a new order |
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
| `account` | text | Bank or card account's name, e.g. `Visa` |
| `account_asset` | relation → assets | The checking, savings or cash account it happened in |
| `account_debt` | relation → debts | The credit card it was charged to |
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
| `from_asset` | relation → assets | The account it was paid from, e.g. checking |
| `date` | date, required | |
| `amount` | number ≥ 0, required | Lowers the debt's balance |
| `note` | text | |
| `external_id` | text | Unique per household |
| `from_external_id` | text | For a card payment pulled from SimpleFIN, the withdrawal that paid it (`sfin-...`) |

### `assets`

| Field | Type | |
| --- | --- | --- |
| `name` | text, required | |
| `type` | `real_estate` `vehicle` `collectible` `checking` `savings` `brokerage` `401k` `ira` `roth_ira` `hsa` `529` `crypto` `cash` `other` | |
| `institution` | text | |
| `value` | number | Can be negative (an overdrawn account) |
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
| `deposit` | number | What lands in the bank: `net` plus reimbursements (the check amount). 0 = same as `net` |
| `ytd_gross`, `ytd_net` | number | Year-to-date gross and net pay printed on the stub. 0 = not printed. Used by the bulk upload's check |
| `file` | file (PDF or image, 15 MB, protected) | |
| `source` | `upload` `manual` `repeat` | `repeat` = copied by the server |
| `transaction` | relation → transactions | The deposit it explains |
| `notes` | text | |
| `external_id` | text | Unique per household |

### `paystub_lines`

| Field | Type | |
| --- | --- | --- |
| `paystub` | relation → paystubs, required | |
| `category` | required: `federal_tax` `state_tax` `local_tax` `social_security` `medicare` `medical` `dental` `vision` `hsa` `fsa` `life` `disability` `401k` `roth_401k` `retirement_other` `401k_loan` `loan_other` `other_pre_tax` `other_post_tax` `reimbursement` | |
| `label` | text | As printed on the stub |
| `amount` | number ≥ 0 | |
| `debt` | relation → debts | For loan lines: the debt it pays down |
| `asset` | relation → assets | For HSA and retirement lines: the account it goes into |
| `employer_paid` | bool | Paid by the employer on top of gross pay, not a deduction |
| `sort` | number | |

### `simplefin_connections` — SimpleFIN setup tokens the household claimed

Read-only through the collection API; made, pulled and removed with `/api/simplefin`.

| Field | Type | |
| --- | --- | --- |
| `label` | text | The banks in it |
| `sync_hour_utc` | number 0–23 | The hour (UTC) of the morning pull |
| `last_sync` | date | Last pull that worked |
| `last_attempt` | date | Last pull tried |
| `last_error` | text | What went wrong last time, or the Bridge's warnings |
| `hold` | bool | Made during onboarding: balances only until setup is finished |

The access URL (with its login) is stored in a hidden field and never sent to the browser or the API.

### `simplefin_accounts` — accounts SimpleFIN reports

The server adds them and keeps `name`, `org`, `currency`, `balance`, `available_balance`,
`balance_date` and `last_pulled` current; only `use`, `asset`, `debt` and `sync_from` can be changed.

| Field | Type | |
| --- | --- | --- |
| `connection` | relation → simplefin_connections | |
| `sfin_id` | text | SimpleFIN's account id |
| `org`, `name`, `currency` | text | As the bank names them |
| `balance` | number | As the bank reports it: owed is negative |
| `use` | `spending` `balance` `ignore`, or empty until chosen | |
| `asset` / `debt` | relation → assets / debts | What it fills (one or the other) |
| `sync_from` | date | Transactions before this day are left out |
| `last_pulled` | date | Day of the last pull with its transactions |

## 5. Errors

PocketBase errors look like `{ "status": 400, "message": "...", "data": { "field": { "message": "..." } } }`.

- `400`: invalid data, or a relation to a record that isn't yours.
- `401`: missing or expired sign-in, or a revoked API token.
- `403`: not allowed (for example, sign-up after the first account).
- `404`: not found, or not yours.
