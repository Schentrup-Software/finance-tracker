# Finance Tracker

Budgets, debts and assets in one place. A small self-hosted web app with three tabs:

- **Budget**: Dave Ramsey style cash envelopes. Each month you write down your expected
  take-home pay and give every dollar a job until "left to budget" is $0. Spending comes
  out of an envelope, and each envelope shows how much cash is left. Rollover envelopes
  work as sinking funds and keep their leftover cash from month to month.
  **Paychecks** sit on the same page: each earner in the household, their paystubs, and
  what comes out before the money reaches the bank (taxes, healthcare, retirement, 401(k)
  loans). A deposit within one cent of the last paycheck reuses its deductions; anything
  else asks for the new paystub, which the app reads from the PDF (with an optional
  OpenClaw agent as backup). HSA and 401(k) contributions can feed the matching account on
  the Assets page, and a "so far this year" view totals federal tax, healthcare and every
  other deduction, per earner.
  **Annual envelopes** (Christmas, donations) save toward a yearly goal and sit in their own
  section under the monthly ones. **Import history** reads a CSV export such as Goodbudget's:
  spending, refunds, split transactions, income and envelope transfers.
  **Vendors** show who the money goes to. Each transaction is matched to a vendor from the
  text on the bank statement (teach it once with "Who is this?"), which gives spending by
  vendor and recurring payments, flagged when one is missed or changes.
  **Taxes** track deductible spending from the budget for itemizing: donations, out-of-pocket
  medical, child care and traditional IRA contributions. Tag a vendor or an envelope once,
  attach receipts or a charity's year-end statement, and the year-end view applies the AGI
  floors and limits and compares itemizing with the standard deduction.
- **Debts**: every loan and card with its balance, APR, monthly payment, payment history
  and its own payoff date. 401(k) loans paid from a paycheck go down automatically with
  each paystub, and the mortgage is listed separately.
- **Assets**: net worth, and everything you own: real estate, vehicles, collectibles,
  checking and savings, brokerage, 401(k), IRA, Roth IRA, HSA, 529, crypto. Link a
  mortgage or car loan to an asset to see your equity in it.

Data is entered by hand in the app, and everything is also available over the API, so an
n8n workflow can sync balances and transactions. See **[docs/api.md](docs/api.md)**.

## Stack

Same as [shear-madness](https://github.com/Schentrup-Software/shear-madness): React 19,
React Router 7 (SPA mode), TypeScript, Tailwind 3, Vite, and PocketBase 0.40 as the
backend. Styling follows [toddler-games](https://github.com/Schentrup-Software/toddler-games).

## Run it

The Docker image holds everything: PocketBase serves the API, the admin dashboard and the
built app on port 8080. Every push to `main` publishes
`ghcr.io/schentrup-software/finance-tracker:latest`.

- **TrueNAS:** follow **[docs/truenas.md](docs/truenas.md)** and paste
  [deploy/truenas.yaml](deploy/truenas.yaml) into **Apps → Discover Apps → Custom App →
  Install via YAML**.
- **Any Docker host:** `docker compose up --build -d`, then open `http://localhost:30680`.
  Data is kept in `./pb_data`; back that folder up.

On first visit the app offers **Create account**; that becomes your login and makes you
head of the household, and sign-up then closes. The head adds the rest of the household
on the **Household** page (people button, top right); everyone shares the same data.
For the PocketBase admin dashboard (`/_/`), create a superuser with
`su-exec 568:568 /pb/pocketbase superuser upsert <email> <password> --dir=/pb/pb_data` inside the
container. The schema in `pb_migrations/` is applied automatically on start.

## Develop

```bash
npm install
npm run pb      # local PocketBase on :8090 (downloads it the first time)
npm run dev     # app on http://localhost:5173
```

Local admin dashboard: `http://localhost:8090/_/` (`admin@local.test` / `admin12345678`).
`RESET=1 npm run pb` wipes local data.

Tests:

```bash
npm run typecheck
npm test                 # budget, loan payoff, net worth and paystub reading
npm run test:api         # API rules, payments and sync, against the local PocketBase
RESET=1 npm run pb && npm run test:e2e   # browser walkthrough (needs a fresh database)
```

## Layout

```
app/
  routes/        budget.tsx, debts.tsx, assets.tsx, login.tsx, app-layout.tsx (tabs)
  backend/       api.ts (all PocketBase calls), types.ts, pocketbaseClient.ts
  lib/           budget, loan payoff, asset and paystub-reading logic (unit tested)
  components/    shared UI (ui.tsx), envelope art, logo
pb_migrations/   collections, fields and API rules
pb_hooks/        sign-up lock, households, owner fill-in, debt balances, paycheck matching, /api/sync, paystub reader fallback
docs/api.md      API reference for n8n
docs/truenas.md  TrueNAS install guide (deploy/truenas.yaml)
```
