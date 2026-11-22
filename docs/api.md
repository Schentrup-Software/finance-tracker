# API reference (for n8n and other sync jobs)

The app is PocketBase, so everything you can do in the UI you can do over its REST API.
All examples use `https://finance.example.com` as the base URL; swap in yours (or
`http://localhost:8090` for local development).

Everything is in plain dollars (`123.45`). Dates are `YYYY-MM-DD` or PocketBase's
`YYYY-MM-DD HH:MM:SS.sssZ`; the app stores days at noon UTC (`2026-11-21 12:00:00.000Z`)
so they show on the same day in every time zone.

## 1. Authenticate

Every data endpoint needs a user token in the `Authorization` header. Each record
belongs to one user (`owner`), and the API only ever shows or changes that user's
records, so n8n must sign in **as the same user you use in the app**.

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

- `{collection}` is one of `envelopes`, `transactions`, `debts`, `debt_payments`, `assets`.
- Every record needs an `external_id`: your stable id from the source (bank transaction
  id, account number, a slug you choose). A record with an `external_id` you've sent before
  is **updated**; a new one is **created**. Re-running a workflow never makes duplicates.
- Only the fields you send are changed on update.
- Relations can point at other records by their external id with a `_external_id` suffix:
  `envelope_external_id` on transactions, `debt_external_id` on debt payments,
  `debts_external_id` (an array) on assets. You can also send the PocketBase `id` directly
  (`envelope`, `debt`, `debts`).
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

For `envelope_external_id` to work, give your envelopes external ids first (once), either by
editing them over the API (`PATCH /api/collections/envelopes/records/{id}` with
`{"external_id": "groceries"}`) or by creating them through `POST /api/sync/envelopes`.

Note on `debt_payments`: creating a payment **lowers the debt's balance** by its amount
(editing or deleting one adjusts it back). If your sync already sets `balance` on the debt
from the lender, don't also sync payments, or they'll be subtracted twice.

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
- `debts?filter=type != "mortgage" && balance > 0&sort=balance` (snowball order)
- `assets?expand=debts` (each asset with the debts linked to it)
- `allocations?filter=budget.month = "2026-11"&expand=envelope`

Full reference: <https://pocketbase.io/docs/api-records/>.

Other endpoints:

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/health` | Health check, no auth |
| `GET` | `/api/finance/setup` | `{ "signupOpen": bool }`; sign-up closes after the first account |

## 4. Collections

Every collection also has `id`, `owner` (user id), `created` and `updated`.

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
| `external_id` | text | Unique per user |

### `budgets` — one per month

| Field | Type | |
| --- | --- | --- |
| `month` | text `YYYY-MM`, required | Unique per user |
| `planned_income` | number | Expected take-home pay |
| `notes` | text | |

### `allocations` — how much goes in each envelope for a month

| Field | Type | |
| --- | --- | --- |
| `budget` | relation → budgets, required | |
| `envelope` | relation → envelopes, required | Unique per budget |
| `amount` | number | |

Left to budget = `planned_income` − sum of the month's allocations (aim for $0).
Envelope cash left = allocation (+ carried, for rollover envelopes) − the month's expenses.

### `transactions` — money out of an envelope, or money in

| Field | Type | |
| --- | --- | --- |
| `kind` | `expense` or `income`, required | |
| `envelope` | relation → envelopes | Expenses only |
| `date` | date, required | |
| `amount` | number ≥ 0, required | Always positive; `kind` says which way |
| `payee` | text | |
| `note` | text | |
| `external_id` | text | Unique per user |

### `debts`

| Field | Type | |
| --- | --- | --- |
| `name` | text, required | |
| `type` | `credit_card` `auto` `student` `medical` `personal` `mortgage` `heloc` `other` | `mortgage` is kept out of the snowball |
| `lender` | text | |
| `balance` | number | Current balance |
| `original_balance` | number | For the "paid off" progress bar |
| `interest_rate` | number | APR in percent (`6.5`) |
| `minimum_payment` | number | |
| `due_day` | number 1–31 | |
| `notes` | text | |
| `external_id` | text | Unique per user |

### `debt_payments`

| Field | Type | |
| --- | --- | --- |
| `debt` | relation → debts, required | |
| `date` | date, required | |
| `amount` | number ≥ 0, required | Lowers the debt's balance |
| `note` | text | |
| `external_id` | text | Unique per user |

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
| `external_id` | text | Unique per user |

## 5. Errors

PocketBase errors look like `{ "status": 400, "message": "...", "data": { "field": { "message": "..." } } }`.

- `400`: invalid data, or a relation to a record that isn't yours.
- `401`: missing or expired token. Sign in again.
- `403`: not allowed (for example, sign-up after the first account).
- `404`: not found, or not yours.
