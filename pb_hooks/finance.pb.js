/// <reference path="../pb_data/types.d.ts" />

// Server-side hooks for the finance tracker. Shared logic lives in finance/lib.js
// (handlers run in isolated runtimes and must require it themselves).

// ---------- Accounts ----------

// The first account can be created from the app's sign-up screen and becomes the
// head of a household. After that, sign-up is closed: the head adds the rest of the
// household from the app (/api/household/members). This keeps an instance private.
onRecordCreateRequest((e) => {
  if (!e.hasSuperuserAuth()) {
    const total = e.app.countRecords("users");
    if (total > 0) {
      throw new ForbiddenError("Sign-up is closed. Ask the head of your household to add you.");
    }
    e.record.set("household", "");
  }
  e.next();
}, "users");

// A user created without a household (the first sign-up, or one a superuser makes
// in the dashboard) heads a new household of their own.
onRecordCreate((e) => {
  e.next();
  if (!e.record.get("household")) {
    e.app.db().newQuery("UPDATE users SET household = {:id}, emailVisibility = TRUE WHERE id = {:id}").bind({ id: e.record.id }).execute();
    e.record.set("household", e.record.id);
  }
}, "users");

// ---------- Household members (the head manages them) ----------

// POST /api/household/members  { "email", "password", "name" }
routerAdd("POST", "/api/household/members", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  const head = lib.requireHead(e.auth);
  const body = e.requestInfo().body || {};
  const user = new Record(e.app.findCollectionByNameOrId("users"));
  user.set("email", String(body.email || "").trim());
  user.set("name", String(body.name || "").trim());
  user.setPassword(String(body.password || ""));
  user.set("verified", true);
  user.set("emailVisibility", true); // visible only inside the household (users list rule)
  user.set("household", head);
  try {
    e.app.save(user);
  } catch (err) {
    throw new BadRequestError("Couldn't add that person: " + err);
  }
  return e.json(200, { id: user.id, email: user.email(), name: user.get("name") });
}, $apis.requireAuth("users"));

// POST /api/household/members/{id}/password  { "password" }
routerAdd("POST", "/api/household/members/{id}/password", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  const head = lib.requireHead(e.auth);
  const user = lib.findMember(e.app, head, e.request.pathValue("id"));
  user.setPassword(String((e.requestInfo().body || {}).password || ""));
  try {
    e.app.save(user);
  } catch (err) {
    throw new BadRequestError("Couldn't set that password: " + err);
  }
  return e.json(200, { ok: true });
}, $apis.requireAuth("users"));

// DELETE /api/household/members/{id}: the member's sign-in goes away; the shared data stays.
routerAdd("DELETE", "/api/household/members/{id}", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  const head = lib.requireHead(e.auth);
  const user = lib.findMember(e.app, head, e.request.pathValue("id"));
  e.app.delete(user);
  return e.json(200, { ok: true });
}, $apis.requireAuth("users"));

// Lets the app ask whether sign-up is still open, to show the right screen.
routerAdd("GET", "/api/finance/setup", (e) => {
  return e.json(200, { signupOpen: e.app.countRecords("users") === 0 });
});

// ---------- API tokens (for n8n and scripts) ----------

// A request with `Authorization: ft_...` is signed in as the member who made that token,
// so it can do anything they can in the app: the collection API, /api/sync and the rest.
// A PocketBase JWT is left to PocketBase.
routerUse((e) => {
  if (!e.auth) {
    const lib = require(`${__hooks}/finance/lib.js`);
    const raw = lib.bearerOf(e);
    if (lib.isApiToken(raw)) lib.authWithApiToken(e, raw);
  }
  return e.next();
});

// A token can't be traded for a regular (refreshable) session, so revoking it really ends it.
onRecordAuthRefreshRequest((e) => {
  require(`${__hooks}/finance/lib.js`).requireSession(e, "An API token can't be swapped for a sign-in. Use the token itself.");
  e.next();
}, "users");

// GET /api/tokens -> { items: [ { id, name, prefix, created, last_used, user: { id, name, email } } ] }
routerAdd("GET", "/api/tokens", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  lib.requireSession(e);
  return e.json(200, { items: lib.listApiTokens(e.app, lib.householdOf(e.auth)) });
}, $apis.requireAuth("users"));

// POST /api/tokens  { "name" } -> the new token, with `token` (shown once, never stored)
routerAdd("POST", "/api/tokens", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  lib.requireSession(e);
  return e.json(200, lib.createApiToken(e.app, e.auth, (e.requestInfo().body || {}).name));
}, $apis.requireAuth("users"));

// DELETE /api/tokens/{id}: revoke; it stops working at once.
routerAdd("DELETE", "/api/tokens/{id}", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  lib.requireSession(e);
  lib.revokeApiToken(e.app, lib.householdOf(e.auth), e.request.pathValue("id"));
  return e.json(200, { ok: true });
}, $apis.requireAuth("users"));

// ---------- Owner ----------

// Records belong to the household: `owner` is the head of the signed-in user's
// household. API clients (n8n) may leave it out; it is filled in from the auth
// token. The collection rules already reject any other owner.
onRecordCreateRequest(
  (e) => {
    if (!e.record.get("owner") && e.auth && e.auth.collection().name === "users") {
      e.record.set("owner", e.auth.get("household") || e.auth.id);
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
  "vendors",
  "tax_documents",
  "tax_years",
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

// ---------- Vendors ----------

// A transaction is linked to the vendor whose statement values fit its payee,
// before it is saved. A vendor picked by hand (vendor_locked) is left alone.
onRecordCreate((e) => {
  require(`${__hooks}/finance/lib.js`).applyVendor(e.app, e.record, true);
  e.next();
}, "transactions");

onRecordUpdate((e) => {
  const before = e.record.original();
  const unlocked = before.getBool("vendor_locked") && !e.record.getBool("vendor_locked");
  if (unlocked || before.getString("payee") !== e.record.getString("payee")) {
    require(`${__hooks}/finance/lib.js`).applyVendor(e.app, e.record, false);
  }
  e.next();
}, "transactions");

// POST /api/vendors/{id}/backfill: link earlier transactions with no vendor that fit this vendor.
routerAdd("POST", "/api/vendors/{id}/backfill", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  return e.json(200, { matched: lib.backfillVendor(e.app, lib.householdOf(e.auth), e.request.pathValue("id")) });
}, $apis.requireAuth("users"));

// POST /api/vendors/{id}/merge  { "into": "<vendor id>" }
routerAdd("POST", "/api/vendors/{id}/merge", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  const into = String((e.requestInfo().body || {}).into || "");
  return e.json(200, { moved: lib.mergeVendors(e.app, lib.householdOf(e.auth), e.request.pathValue("id"), into) });
}, $apis.requireAuth("users"));

// GET /api/vendors/unmatched -> { items: [ { pattern, count, total, last_date, example } ] }
routerAdd("GET", "/api/vendors/unmatched", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  return e.json(200, { items: lib.unmatchedStatements(e.app, lib.householdOf(e.auth)) });
}, $apis.requireAuth("users"));

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

// POST /api/paystubs/{id}/backfill: copy this paystub to earlier deposits from the
// same earner that are waiting for a paystub and match its check amount to the cent.
// The app calls it after saving a paystub's lines. -> { filled: <count> }
routerAdd("POST", "/api/paystubs/{id}/backfill", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  return e.json(200, { filled: lib.backfillPaystub(e.app, lib.householdOf(e.auth), e.request.pathValue("id")) });
}, $apis.requireAuth("users"));

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
    const result = lib.upsert(e.app, collection, lib.householdOf(e.auth), body.records);
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
  return e.json(200, lib.envelopeBalances(e.app, lib.householdOf(e.auth), month));
}, $apis.requireAuth("users"));

// POST /api/import/budgets  { "months": [ { month, planned_income, allocations: [ { envelope_external_id, amount } ] } ] }
routerAdd("POST", "/api/import/budgets", (e) => {
  const lib = require(`${__hooks}/finance/lib.js`);
  const body = e.requestInfo().body || {};
  return e.json(200, lib.importBudgets(e.app, lib.householdOf(e.auth), body.months));
}, $apis.requireAuth("users"), $apis.bodyLimit(5 << 20));
