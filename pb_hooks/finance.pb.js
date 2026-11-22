/// <reference path="../pb_data/types.d.ts" />

// Server-side hooks for the finance tracker. Shared logic lives in finance/lib.js
// (handlers run in isolated runtimes and must require it themselves).

// ---------- Accounts ----------

// The first account can be created from the app's sign-up screen. After that,
// sign-up is closed, and new accounts can only be made by a superuser in the
// admin dashboard (/_/). This keeps a self-hosted instance private.
onRecordCreateRequest((e) => {
  if (!e.hasSuperuserAuth()) {
    const total = e.app.countRecords("users");
    if (total > 0) {
      throw new ForbiddenError("Sign-up is closed. Ask the owner to add you from the admin dashboard.");
    }
  }
  e.next();
}, "users");

// Lets the app ask whether sign-up is still open, to show the right screen.
routerAdd("GET", "/api/finance/setup", (e) => {
  return e.json(200, { signupOpen: e.app.countRecords("users") === 0 });
});

// ---------- Owner ----------

// API clients (n8n) may leave `owner` out when creating a record; it is filled
// in from the auth token. The collection rules already reject any other owner.
onRecordCreateRequest(
  (e) => {
    if (!e.record.get("owner") && e.auth && e.auth.collection().name === "users") {
      e.record.set("owner", e.auth.id);
    }
    e.next();
  },
  "envelopes",
  "budgets",
  "allocations",
  "transactions",
  "debts",
  "debt_payments",
  "assets",
);

// ---------- Debt payments keep the debt's balance current ----------

onRecordCreate((e) => {
  e.next();
  const lib = require(`${__hooks}/finance/lib.js`);
  lib.adjustDebtBalance(e.app, e.record.get("debt"), -e.record.getFloat("amount"));
}, "debt_payments");

onRecordUpdate((e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  const before = e.record.original();
  const oldDebt = before.get("debt");
  const oldAmount = before.getFloat("amount");
  e.next();
  lib.adjustDebtBalance(e.app, oldDebt, oldAmount);
  lib.adjustDebtBalance(e.app, e.record.get("debt"), -e.record.getFloat("amount"));
}, "debt_payments");

onRecordDelete((e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  const debt = e.record.get("debt");
  const amount = e.record.getFloat("amount");
  e.next();
  lib.adjustDebtBalance(e.app, debt, amount);
}, "debt_payments");

// ---------- Sync endpoint for n8n ----------

// POST /api/sync/{collection}  { "records": [ { "external_id": "...", ... } ] }
// Creates or updates the signed-in user's records, matched on external_id.
routerAdd(
  "POST",
  "/api/sync/{collection}",
  (e) => {
    const lib = require(`${__hooks}/finance/lib.js`);
    const collection = e.request.pathValue("collection");
    const body = e.requestInfo().body || {};
    const result = lib.upsert(e.app, collection, e.auth.id, body.records);
    return e.json(200, result);
  },
  $apis.requireAuth("users"),
);
