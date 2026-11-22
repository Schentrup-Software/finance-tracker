# Finance Tracker — Claude Code guide

Budget (Dave Ramsey cash envelopes, plus paychecks and paystub deductions), Debts (per-loan payoff dates,
no snowball) and Assets (net worth), one tab each.
Same stack as Schentrup-Software/shear-madness; look and feel from Schentrup-Software/toddler-games.

## Commands

```bash
npm run pb         # local PocketBase on :8090 with this repo's migrations + hooks (RESET=1 wipes data)
npm run dev        # app on :5173, talks to the local PocketBase
npm run typecheck
npm test           # unit tests for app/lib
npm run test:api   # API rule/sync checks against the local PocketBase
npm run test:e2e   # Playwright walkthrough; needs RESET=1 npm run pb first
```

## Rules of the road

- All PocketBase calls go through `app/backend/api.ts`. Field names in `app/backend/types.ts`
  must match `pb_migrations/`.
- Schema changes are new files in `pb_migrations/` (never edit an applied migration), and
  `docs/api.md` must be updated with them: n8n depends on it.
- Data belongs to a household: every data collection has `owner` (the household head's user id)
  and rules `owner = @request.auth.household`. Relations must also check the related record's
  owner in create/update rules. Server routes use `lib.householdOf(e.auth)`, never `e.auth.id`.
- Business math (budget totals, loan payoff, equity, paystub reading, history import) lives in `app/lib/` and is unit tested.
- Hook handlers run in isolated runtimes: `require(\`${__hooks}/finance/lib.js\`)` inside each handler.
- Styling: Tailwind plus the component classes in `app/app.css` (`.chunk`, `.btn`, `.tray`,
  `.c-<hue>` sets `--c`/`--cd`). Pastel palette only; colours come from those tokens.
- `npm install` needs `legacy-peer-deps` (set in `.npmrc`).
- Paycheck matching (one-cent rule), copied paystubs and loan-line payments are server-side in
  `pb_hooks/finance/lib.js`; status updates there use a direct SQL update to avoid re-entering hooks.
- The paystub reader is `app/lib/paystub.ts` (pure, unit tested) fed by `app/lib/pdfText.ts`.
  Sample PDF: `testing/fixtures/paystub.pdf` (regenerate with `node testing/fixtures/make-paystub.cjs`).
