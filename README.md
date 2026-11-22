# Finance Tracker

Budgets, debts and assets in one place. A small self-hosted web app with three tabs:

- **Budget**: Dave Ramsey style cash envelopes. Each month you write down your expected
  take-home pay and give every dollar a job until "left to budget" is $0. Spending comes
  out of an envelope, and each envelope shows how much cash is left. Rollover envelopes
  work as sinking funds and keep their leftover cash from month to month.
- **Debts**: the debt snowball. Debts are listed smallest balance first (the mortgage is
  kept separate), with minimums, APR, payment history and a "debt-free by" date that
  updates as you change the extra you throw at it each month.
- **Assets**: net worth, and everything you own: real estate, vehicles, collectibles,
  checking and savings, brokerage, 401(k), IRA, Roth IRA, HSA, 529, crypto. Link a
  mortgage or car loan to an asset to see your equity in it.

Data is entered by hand in the app, and everything is also available over the API, so an
n8n workflow can sync balances and transactions. See **[docs/api.md](docs/api.md)**.

## Stack

Same as [shear-madness](https://github.com/Schentrup-Software/shear-madness): React 19,
React Router 7 (SPA mode), TypeScript, Tailwind 3, Vite, and PocketBase 0.28 as the
backend. Styling follows [toddler-games](https://github.com/Schentrup-Software/toddler-games).

## Run it

The Docker image holds everything: PocketBase serves the API, the admin dashboard and the
built app on port 8080. Every push to `main` publishes
`ghcr.io/schentrup-software/finance-tracker:latest`.

```yaml
services:
  finance-tracker:
    image: ghcr.io/schentrup-software/finance-tracker:latest
    pull_policy: always
    ports:
      - "8080:8080"
    volumes:
      - ./pb_data:/pb/pb_data   # your data; back this folder up
    restart: unless-stopped
```

First run:

1. Open `http://<host>:8080`. The first visit offers **Create account**; that becomes your
   login. After that, sign-up is closed.
2. Create a superuser for the admin dashboard at `http://<host>:8080/_/` (PocketBase prints
   a one-time setup link in the container log). You need it to add more users or to mint
   a long-lived API token for n8n.

The schema is in `pb_migrations/` and is applied automatically on start.

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
npm test                 # budget, snowball and net-worth logic
npm run test:api         # API rules, payments and sync, against the local PocketBase
RESET=1 npm run pb && npm run test:e2e   # browser walkthrough (needs a fresh database)
```

## Layout

```
app/
  routes/        budget.tsx, debts.tsx, assets.tsx, login.tsx, app-layout.tsx (tabs)
  backend/       api.ts (all PocketBase calls), types.ts, pocketbaseClient.ts
  lib/           budget, debt snowball and asset math (unit tested)
  components/    shared UI (ui.tsx), envelope art, logo
pb_migrations/   collections, fields and API rules
pb_hooks/        sign-up lock, owner fill-in, debt balance updates, /api/sync endpoint
docs/api.md      API reference for n8n
```
