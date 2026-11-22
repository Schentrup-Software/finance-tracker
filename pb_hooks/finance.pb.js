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
  "earners",
  "paystubs",
  "paystub_lines",
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

// ---------- Paychecks ----------

// An income deposit from an earner: if the take-home pay is within one cent of
// their last paystub, copy that paystub (same taxes and deductions). Otherwise
// mark it "needs_paystub" so the app asks for this paycheck's stub.
onRecordCreate((e) => {
  e.next();
  if (e.record.get("kind") === "income" && e.record.get("earner")) {
    require(`${__hooks}/finance/lib.js`).reconcilePaycheck(e.app, e.record);
  }
}, "transactions");

onRecordUpdate((e) => {
  const before = e.record.original();
  const changed = ["kind", "earner", "amount", "date"].some((f) => String(before.get(f)) !== String(e.record.get(f)));
  e.next();
  if (!changed) return;
  const lib = require(`${__hooks}/finance/lib.js`);
  if (e.record.get("kind") === "income" && e.record.get("earner")) {
    lib.reconcilePaycheck(e.app, e.record);
  } else {
    lib.setPaystubStatus(e.app, e.record, "");
  }
}, "transactions");

// A deleted deposit takes its copied paystub (and the loan payments on it) along.
onRecordDelete((e) => {
  const copies = e.app.findRecordsByFilter("paystubs", "transaction = {:t} && source = 'repeat'", "", 0, 0, { t: e.record.id });
  for (const p of copies) e.app.delete(p);
  e.next();
}, "transactions");

onRecordCreate((e) => {
  e.next();
  require(`${__hooks}/finance/lib.js`).attachPaystub(e.app, e.record);
}, "paystubs");

onRecordUpdate((e) => {
  const before = e.record.original();
  const oldTx = before.get("transaction");
  e.next();
  const lib = require(`${__hooks}/finance/lib.js`);
  if (oldTx && oldTx !== e.record.get("transaction")) lib.detachPaystub(e.app, oldTx);
  if (e.record.get("source") !== "repeat") lib.attachPaystub(e.app, e.record);
  // Loan payments are dated by the paystub.
  if (before.getString("pay_date") !== e.record.getString("pay_date")) {
    const lines = e.app.findRecordsByFilter("paystub_lines", "paystub = {:p} && debt != ''", "", 0, 0, { p: e.record.id });
    for (const l of lines) lib.syncLinePayment(e.app, l);
  }
}, "paystubs");

onRecordDelete((e) => {
  const txId = e.record.get("transaction");
  e.next();
  require(`${__hooks}/finance/lib.js`).detachPaystub(e.app, txId);
}, "paystubs");

// A loan line on a paystub (a 401(k) loan repayment) pays down its debt.
// A contribution line (HSA, 401(k)) with an asset raises that asset's value.
onRecordCreate((e) => {
  e.next();
  const lib = require(`${__hooks}/finance/lib.js`);
  if (e.record.get("debt")) lib.syncLinePayment(e.app, e.record);
  if (e.record.get("asset")) lib.adjustAssetValue(e.app, e.record.get("asset"), e.record.getFloat("amount"), lib.payDateOf(e.app, e.record));
}, "paystub_lines");

onRecordUpdate((e) => {
  const before = e.record.original();
  const oldAsset = before.get("asset");
  const oldAmount = before.getFloat("amount");
  e.next();
  const lib = require(`${__hooks}/finance/lib.js`);
  lib.syncLinePayment(e.app, e.record);
  if (oldAsset !== e.record.get("asset") || oldAmount !== e.record.getFloat("amount")) {
    lib.adjustAssetValue(e.app, oldAsset, -oldAmount, "");
    lib.adjustAssetValue(e.app, e.record.get("asset"), e.record.getFloat("amount"), lib.payDateOf(e.app, e.record));
  }
}, "paystub_lines");

onRecordDelete((e) => {
  const owner = e.record.get("owner");
  const id = e.record.id;
  const asset = e.record.get("asset");
  const amount = e.record.getFloat("amount");
  e.next();
  const lib = require(`${__hooks}/finance/lib.js`);
  lib.removeLinePayment(e.app, owner, id);
  lib.adjustAssetValue(e.app, asset, -amount, "");
}, "paystub_lines");

// ---------- Paystub reader fallback (OpenClaw) ----------

// Whether a fallback reader is configured, so the app can offer it.
routerAdd("GET", "/api/paystubs/reader", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  return e.json(200, { agent: !!lib.agentConfig() });
}, $apis.requireAuth("users"));

// POST { "filename": "stub.pdf", "media_type": "application/pdf", "data": "<base64>" }
// Returns the agent's reading: { pay_date, gross, net, lines: [...] }. Nothing is saved.
routerAdd("POST", "/api/paystubs/read", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  const body = e.requestInfo().body || {};
  if (!body.data) throw new BadRequestError("Send the paystub as base64 in `data`.");
  return e.json(200, lib.readPaystubWithAgent(String(body.data), body.filename, body.media_type));
}, $apis.requireAuth("users"), $apis.bodyLimit(20 << 20));

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

// ---------- Envelope balances and import ----------

// GET /api/finance/balances?month=YYYY-MM -> { carried: {envelopeId: n}, year_spent: {envelopeId: n} }
routerAdd("GET", "/api/finance/balances", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  const month = e.request.url.query().get("month") || "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequestError("Pass ?month=YYYY-MM.");
  return e.json(200, lib.envelopeBalances(e.app, e.auth.id, month));
}, $apis.requireAuth("users"));

// POST /api/import/budgets  { "months": [ { month, planned_income, allocations: [ { envelope_external_id, amount } ] } ] }
routerAdd("POST", "/api/import/budgets", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  const body = e.requestInfo().body || {};
  return e.json(200, lib.importBudgets(e.app, e.auth.id, body.months));
}, $apis.requireAuth("users"), $apis.bodyLimit(5 << 20));
