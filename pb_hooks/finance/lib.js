// Shared server-side logic for the finance tracker hooks.
//
// PocketBase runs every hook handler in its own isolated runtime, so handlers
// can't close over variables in finance.pb.js. They `require()` this file instead.

// Collections that belong to a user and are open to the API.
const OWNED = [
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
];

// Collections the /api/sync/{collection} upsert endpoint accepts. Each record
// in a sync is matched on (owner, external_id).
const SYNCABLE = ["earners", "envelopes", "vendors", "transactions", "debts", "debt_payments", "assets"];

// Relation fields a sync may fill by the other record's external_id, e.g.
// `envelope_external_id: "groceries"` on a transaction.
const RELATIONS = {
  transactions: { envelope: "envelopes", earner: "earners", vendor: "vendors", account_asset: "assets", account_debt: "debts" },
  vendors: { default_envelope: "envelopes" },
  debt_payments: { debt: "debts", from_asset: "assets" },
  assets: { debts: "debts" },
};

// Fields a sync can never set directly.
const PROTECTED = ["id", "owner", "created", "updated", "collectionId", "collectionName", "expand"];

function badRequest(message) {
  return new BadRequestError(message);
}

/** Finds one of the owner's records by external_id, or null. */
function findByExternalId(app, collection, ownerId, externalId) {
  try {
    return app.findFirstRecordByFilter(
      collection,
      "owner = {:owner} && external_id = {:ext}",
      { owner: ownerId, ext: externalId },
    );
  } catch (_) {
    return null;
  }
}

/** Checks that a record id exists in a collection and belongs to the owner. */
function assertOwned(app, collection, id, ownerId) {
  let rec;
  try {
    rec = app.findRecordById(collection, id);
  } catch (_) {
    throw badRequest(collection + " record '" + id + "' was not found.");
  }
  if (rec.get("owner") !== ownerId) {
    throw badRequest(collection + " record '" + id + "' was not found.");
  }
}

/** Turns one relation input (`<field>_external_id`) into record ids. */
function resolveExternalRelation(app, target, ownerId, value) {
  const list = Array.isArray(value) ? value : [value];
  const ids = [];
  for (const ext of list) {
    if (ext === null || ext === undefined || ext === "") continue;
    const rec = findByExternalId(app, target, ownerId, String(ext));
    if (!rec) throw badRequest(target + " with external_id '" + ext + "' was not found.");
    ids.push(rec.id);
  }
  return Array.isArray(value) ? ids : ids[0] || "";
}

/**
 * Creates or updates records in `collectionName` for `ownerId`, matching on
 * external_id. Runs in one transaction: one bad record rolls the batch back.
 */
function upsert(app, collectionName, ownerId, items) {
  if (SYNCABLE.indexOf(collectionName) === -1) {
    throw badRequest("Sync is not available for '" + collectionName + "'. Use one of: " + SYNCABLE.join(", ") + ".");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest("Send { \"records\": [ ... ] } with at least one record.");
  }
  if (items.length > 500) {
    throw badRequest("Send at most 500 records per request.");
  }

  const result = { created: 0, updated: 0, records: [] };
  const relations = RELATIONS[collectionName] || {};

  app.runInTransaction((txApp) => {
    const collection = txApp.findCollectionByNameOrId(collectionName);

    items.forEach((item, index) => {
      if (!item || typeof item !== "object") throw badRequest("Record " + index + " is not an object.");
      const ext = item.external_id;
      if (ext === undefined || ext === null || String(ext).trim() === "") {
        throw badRequest("Record " + index + " needs an external_id.");
      }

      let record = findByExternalId(txApp, collectionName, ownerId, String(ext));
      const isNew = !record;
      if (isNew) {
        record = new Record(collection);
        record.set("owner", ownerId);
      }

      for (const key of Object.keys(item)) {
        if (PROTECTED.indexOf(key) !== -1) continue;

        const relMatch = key.match(/^(.+)_external_id$/);
        if (relMatch && relations[relMatch[1]]) {
          const field = relMatch[1];
          record.set(field, resolveExternalRelation(txApp, relations[field], ownerId, item[key]));
          continue;
        }

        if (!collection.fields.getByName(key)) {
          throw badRequest("Record " + index + ": unknown field '" + key + "' for " + collectionName + ".");
        }

        if (relations[key]) {
          const target = relations[key];
          const ids = Array.isArray(item[key]) ? item[key] : [item[key]];
          for (const id of ids) if (id) assertOwned(txApp, target, id, ownerId);
        }

        record.set(key, item[key]);
      }

      // A vendor named by the sync is the vendor: matching won't change it.
      if (collectionName === "transactions" && (item.vendor || item.vendor_external_id) && item.vendor_locked === undefined) {
        record.set("vendor_locked", true);
      }

      try {
        txApp.save(record);
      } catch (err) {
        throw badRequest("Record " + index + " (external_id '" + ext + "'): " + err);
      }

      if (isNew) result.created++;
      else result.updated++;
      result.records.push(record);
    });
  });

  return result;
}

/** Adds `delta` to a debt's balance, never going below zero. */
function adjustDebtBalance(app, debtId, delta) {
  if (!debtId || !delta) return;
  let debt;
  try {
    debt = app.findRecordById("debts", debtId);
  } catch (_) {
    return; // the debt was deleted; nothing to adjust
  }
  const next = Math.max(0, Math.round((debt.getFloat("balance") + delta) * 100) / 100);
  debt.set("balance", next);
  app.save(debt);
}

// ---------- Paychecks ----------

// A deposit "matches" the earner's last paystub when it is within one cent of
// the paystub's check amount, above or below (paychecks drift by a cent from
// rounding). Then taxes and deductions are assumed unchanged. Compared in whole
// cents so floating point can't push a one-cent difference over the line.
const MATCH_TOLERANCE_CENTS = 1;

function sameMoney(a, b) {
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= MATCH_TOLERANCE_CENTS;
}

/** The earner's first uploaded or typed-in paystub after `date`. */
function nextRealPaystub(app, ownerId, earnerId, date) {
  const rows = app.findRecordsByFilter(
    "paystubs",
    "owner = {:owner} && earner = {:earner} && source != 'repeat' && pay_date > {:date}",
    "pay_date,created",
    1,
    0,
    { owner: ownerId, earner: earnerId, date: date },
  );
  return rows.length ? rows[0] : null;
}

/** The earner's most recent paystub on or before `date`, ignoring any tied to `excludeTx`. */
function previousPaystub(app, ownerId, earnerId, date, excludeTx) {
  const rows = app.findRecordsByFilter(
    "paystubs",
    "owner = {:owner} && earner = {:earner} && pay_date <= {:date}" + (excludeTx ? " && transaction != {:tx}" : ""),
    "-pay_date,-created",
    1,
    0,
    { owner: ownerId, earner: earnerId, date: date, tx: excludeTx || "" },
  );
  return rows.length ? rows[0] : null;
}

/**
 * Sets a deposit's paystub_status without running record hooks again (a normal
 * save would re-enter the transactions hooks and match the deposit twice).
 */
function setPaystubStatus(app, tx, status) {
  if ((tx.get("paystub_status") || "") === status) return;
  app.db()
    .newQuery("UPDATE transactions SET paystub_status = {:s} WHERE id = {:id}")
    .bind({ s: status, id: tx.id })
    .execute();
  tx.set("paystub_status", status);
}

/** What a paystub puts in the bank: its check amount (net plus reimbursements), else its net pay. */
function depositOf(paystub) {
  return paystub.getFloat("deposit") || paystub.getFloat("net");
}

function paystubsForTransaction(app, txId) {
  return app.findRecordsByFilter("paystubs", "transaction = {:tx}", "", 0, 0, { tx: txId });
}

/**
 * Decides what an income deposit from an earner needs. Returns the paystub to
 * copy when it matches the last one to the cent, or null when the app should
 * ask for this paycheck's paystub.
 */
function matchPaycheck(app, tx) {
  if (tx.get("kind") !== "income" || !tx.get("earner")) return { status: "", template: null };
  const prev = previousPaystub(app, tx.get("owner"), tx.get("earner"), tx.getString("date"), tx.id);
  if (prev && sameMoney(depositOf(prev), tx.getFloat("amount"))) {
    return { status: "matched", template: prev, backfill: false };
  }
  // An older deposit (imported, or marked as a paycheck later) can match the next
  // uploaded paystub instead, the same way saving that paystub backfills it.
  const next = nextRealPaystub(app, tx.get("owner"), tx.get("earner"), tx.getString("date"));
  if (next && sameMoney(depositOf(next), tx.getFloat("amount"))) {
    return { status: "matched", template: next, backfill: true };
  }
  return { status: "needs_paystub", template: null };
}

/** True when a debt or asset was added after `date`, so its balance already counts what happened before. */
function addedAfter(app, collection, id, date) {
  try {
    return app.findRecordById(collection, id).getString("created") > date;
  } catch (_) {
    return true;
  }
}

/**
 * Copies a paystub and its lines for a deposit (same pay, same deductions).
 * For an earlier deposit (`backfill`), loan and contribution lines only touch a
 * debt or asset that was already in the app on that date: a balance typed in
 * later already includes those payments.
 */
function repeatPaystub(app, template, tx, backfill) {
  const collection = app.findCollectionByNameOrId("paystubs");
  const copy = new Record(collection);
  copy.set("owner", tx.get("owner"));
  copy.set("earner", template.get("earner"));
  copy.set("pay_date", tx.getString("date"));
  copy.set("gross", template.getFloat("gross"));
  // The deposit can be a cent off the last one; that cent is in the take-home pay.
  const cents = tx.getFloat("amount") - depositOf(template);
  copy.set("net", Math.round((template.getFloat("net") + cents) * 100) / 100);
  if (template.getFloat("deposit")) copy.set("deposit", tx.getFloat("amount"));
  copy.set("source", "repeat");
  copy.set("transaction", tx.id);
  copy.set("notes", "Same as the paystub from " + template.getString("pay_date").slice(0, 10));
  app.save(copy);

  const lineCollection = app.findCollectionByNameOrId("paystub_lines");
  const lines = app.findRecordsByFilter("paystub_lines", "paystub = {:p}", "sort,created", 0, 0, { p: template.id });
  for (const line of lines) {
    const l = new Record(lineCollection);
    l.set("owner", tx.get("owner"));
    l.set("paystub", copy.id);
    l.set("category", line.get("category"));
    l.set("label", line.get("label"));
    l.set("amount", line.getFloat("amount"));
    let debt = line.get("debt");
    let asset = line.get("asset");
    if (backfill && debt && addedAfter(app, "debts", debt, tx.getString("date"))) debt = "";
    if (backfill && asset && addedAfter(app, "assets", asset, tx.getString("date"))) asset = "";
    l.set("debt", debt);
    l.set("asset", asset);
    l.set("employer_paid", line.getBool("employer_paid"));
    l.set("sort", line.getFloat("sort"));
    app.save(l);
  }
  return copy;
}

/**
 * After a deposit is created or its amount/earner changes: drop any copied
 * paystub, then match again.
 */
function reconcilePaycheck(app, tx) {
  const linked = paystubsForTransaction(app, tx.id);
  // A paystub read from an upload or typed in explains the deposit for good.
  if (linked.some((p) => p.get("source") !== "repeat")) {
    setPaystubStatus(app, tx, "matched");
    return;
  }
  for (const p of linked) app.delete(p);

  const result = matchPaycheck(app, tx);
  if (result.template) repeatPaystub(app, result.template, tx, result.backfill);
  setPaystubStatus(app, tx, result.status);
}

/**
 * A paystub was uploaded or typed in. If it names its deposit, that deposit is
 * matched. If not, it is tied to a waiting deposit from the same earner with the
 * same take-home pay, paid within a week of the pay date.
 */
function attachPaystub(app, paystub) {
  if (paystub.get("source") === "repeat") return;
  let txId = paystub.get("transaction");
  if (!txId) {
    const date = paystub.getString("pay_date").slice(0, 10);
    const d = new Date(date + "T12:00:00Z");
    const from = new Date(d.getTime() - 7 * 864e5).toISOString().replace("T", " ");
    const to = new Date(d.getTime() + 7 * 864e5).toISOString().replace("T", " ");
    // This earner's deposits (waiting, or filled with a copy of another paystub),
    // or income with no earner and no envelope (imported), nearest the pay date first.
    const candidates = app.findRecordsByFilter(
      "transactions",
      "owner = {:owner} && kind = 'income' && date >= {:from} && date <= {:to} && " +
        "(earner = {:earner} || (earner = '' && envelope = ''))",
      "date",
      0,
      0,
      { owner: paystub.get("owner"), earner: paystub.get("earner"), from: from, to: to },
    ).filter((t) =>
      sameMoney(t.getFloat("amount"), depositOf(paystub)) &&
      paystubsForTransaction(app, t.id).every((p) => p.get("source") === "repeat"),
    );
    const at = d.getTime();
    const dist = (t) => Math.abs(new Date(t.getString("date").replace(" ", "T")).getTime() - at);
    candidates.sort((a, b) => dist(a) - dist(b));
    const hit = candidates[0];
    if (!hit) return;
    txId = hit.id;
    if (!hit.get("earner")) {
      app.db().newQuery("UPDATE transactions SET earner = {:e} WHERE id = {:id}")
        .bind({ e: paystub.get("earner"), id: hit.id }).execute();
    }
    paystub.set("transaction", txId);
    app.saveNoValidate(paystub);
  }
  let tx;
  try { tx = app.findRecordById("transactions", txId); } catch (_) { return; }
  // Replace a copied paystub with the real one.
  for (const p of paystubsForTransaction(app, txId)) {
    if (p.id !== paystub.id && p.get("source") === "repeat") app.delete(p);
  }
  setPaystubStatus(app, tx, "matched");
}

/**
 * Fills in paychecks from a paystub: every deposit within a cent (either way) of
 * this one's check amount that is either waiting for this earner's paystub, or
 * income with no earner and no envelope (imported from the bank or Goodbudget),
 * gets a copy of it; the latter also gets this earner. That covers deposits before the pay date and ones
 * after it that landed before the paystub was saved, unless another uploaded or
 * typed-in paystub sits between them. Run after the paystub's lines are saved.
 * Returns how many deposits were filled in.
 */
function backfillPaystub(app, ownerId, paystubId) {
  let paystub;
  try { paystub = app.findRecordById("paystubs", paystubId); } catch (_) { paystub = null; }
  if (!paystub || paystub.get("owner") !== ownerId) throw new NotFoundError("Paystub not found.");
  if (paystub.get("source") === "repeat") return 0;
  // The paystub's own deposit gets the paystub itself, not a copy of it.
  if (!paystub.get("transaction")) {
    attachPaystub(app, paystub);
    paystub = app.findRecordById("paystubs", paystubId);
  }
  // Deposits waiting for this earner's paystub, plus income with no earner yet
  // (imported from the bank or another app) that isn't money back into an envelope.
  const waiting = app.findRecordsByFilter(
    "transactions",
    "owner = {:owner} && kind = 'income' && id != {:self} && " +
      "((earner = {:earner} && paystub_status = 'needs_paystub') || (earner = '' && envelope = ''))",
    "date",
    0,
    0,
    { owner: ownerId, earner: paystub.get("earner"), self: paystub.get("transaction") || "" },
  );
  const payDate = paystub.getString("pay_date");
  let filled = 0;
  for (const tx of waiting) {
    if (!sameMoney(tx.getFloat("amount"), depositOf(paystub))) continue;
    if (paystubsForTransaction(app, tx.id).length > 0) continue;
    const date = tx.getString("date");
    if (date > payDate && newerRealPaystub(app, paystub, date)) continue;
    // A matching deposit within a few days of the pay date is this same paycheck
    // recorded twice (typed in and imported), not another one: leave it alone.
    if (Math.abs(daysBetween(date, payDate)) < 4) continue;
    if (!tx.get("earner")) {
      // Same check amount to the cent: it's this earner's paycheck. Set directly so
      // the transactions hooks don't run the match again.
      app.db().newQuery("UPDATE transactions SET earner = {:e} WHERE id = {:id}")
        .bind({ e: paystub.get("earner"), id: tx.id }).execute();
      tx.set("earner", paystub.get("earner"));
    }
    repeatPaystub(app, paystub, tx, date < payDate);
    setPaystubStatus(app, tx, "matched");
    filled++;
  }
  return filled;
}

/** Days from `a` to `b` (PocketBase date strings). */
function daysBetween(a, b) {
  return (new Date(b.slice(0, 10) + "T12:00:00Z").getTime() - new Date(a.slice(0, 10) + "T12:00:00Z").getTime()) / 864e5;
}

/** True when the earner has an uploaded or typed-in paystub after `paystub` and on or before `date`. */
function newerRealPaystub(app, paystub, date) {
  return app.findRecordsByFilter(
    "paystubs",
    "owner = {:owner} && earner = {:earner} && source != 'repeat' && id != {:id} && pay_date > {:from} && pay_date <= {:to}",
    "",
    1,
    0,
    { owner: paystub.get("owner"), earner: paystub.get("earner"), id: paystub.id, from: paystub.getString("pay_date"), to: date },
  ).length > 0;
}

/** When a paystub linked to a deposit goes away, the deposit needs one again. */
function detachPaystub(app, txId) {
  if (!txId) return;
  let tx;
  try { tx = app.findRecordById("transactions", txId); } catch (_) { return; }
  if (paystubsForTransaction(app, txId).length === 0 && tx.get("earner") && tx.get("kind") === "income") {
    setPaystubStatus(app, tx, "needs_paystub");
  }
}

// ---------- Contributions taken out of a paycheck into an asset ----------

/** Adds `delta` to an asset's value (an HSA or 401(k) contribution), never below zero. */
function adjustAssetValue(app, assetId, delta, date) {
  if (!assetId || !delta) return;
  let asset;
  try {
    asset = app.findRecordById("assets", assetId);
  } catch (_) {
    return; // the asset was deleted
  }
  asset.set("value", Math.max(0, Math.round((asset.getFloat("value") + delta) * 100) / 100));
  if (delta > 0 && date && date > asset.getString("as_of")) asset.set("as_of", date);
  app.save(asset);
}

function payDateOf(app, line) {
  try {
    return app.findRecordById("paystubs", line.get("paystub")).getString("pay_date");
  } catch (_) {
    return "";
  }
}

// ---------- Loan repayments taken out of a paycheck ----------

function linePaymentId(lineId) {
  return "paystub-line:" + lineId;
}

function removeLinePayment(app, ownerId, lineId) {
  const p = findByExternalId(app, "debt_payments", ownerId, linePaymentId(lineId));
  if (p) app.delete(p); // the debt_payments hook puts the balance back
}

/** Keeps one debt payment per loan line, so the loan's balance follows the paystubs. */
function syncLinePayment(app, line) {
  const ownerId = line.get("owner");
  removeLinePayment(app, ownerId, line.id);
  const debtId = line.get("debt");
  const amount = line.getFloat("amount");
  if (!debtId || amount <= 0) return;
  let paystub;
  try { paystub = app.findRecordById("paystubs", line.get("paystub")); } catch (_) { return; }
  const payment = new Record(app.findCollectionByNameOrId("debt_payments"));
  payment.set("owner", ownerId);
  payment.set("debt", debtId);
  payment.set("date", paystub.getString("pay_date"));
  payment.set("amount", amount);
  payment.set("note", "From paycheck" + (line.getString("label") ? " (" + line.getString("label") + ")" : ""));
  payment.set("external_id", linePaymentId(line.id));
  app.save(payment);
}

// ---------- Paystub reading fallback: an OpenClaw agent ----------
//
// The app reads paystub PDFs in the browser first. When that can't make sense
// of a layout, it can ask an OpenClaw gateway's /v1/responses endpoint, if one
// is configured with these environment variables:
//
//   OPENCLAW_URL    e.g. http://192.168.1.20:18789   (required)
//   OPENCLAW_TOKEN  the gateway token or password     (optional: leave it unset when
//                   OpenClaw sits behind a trusted proxy that handles auth)
//   OPENCLAW_AGENT  agent id to use (optional; default agent otherwise)
//   OPENCLAW_USERNAME / OPENCLAW_PASSWORD
//                   HTTP basic login for a proxy in front of OpenClaw (optional).
//                   A user:password@ in OPENCLAW_URL works too. Basic auth uses the
//                   Authorization header, so it replaces OPENCLAW_TOKEN if both are set.

const PAYSTUB_PROMPT = [
  "Read this paystub and reply with ONLY a JSON object, no other text, in this shape:",
  '{"pay_date":"YYYY-MM-DD","period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD","employer_name":"","gross":0,"net":0,',
  '"lines":[{"label":"as printed","category":"one of the categories","amount":0}],',
  '"employer":[{"label":"as printed","category":"one of the categories","amount":0}],',
  '"reimbursements":[{"label":"as printed","amount":0}],"check_amount":0}',
  "Use this pay period's amounts, not year-to-date. Amounts are positive numbers in dollars.",
  "lines are every deduction and tax taken from gross pay. Do not include earnings lines or net pay in lines.",
  "employer is what the employer paid on top of gross pay (employer contributions such as employer-paid medical, dental or vision insurance, a 401(k)",
  "match or contribution, or an HSA contribution). Use [] if there are none. Employer contributions never go in lines,",
  "and employer-paid taxes go in neither list. An employer 401(k) contribution is category 401k (traditional),",
  "even when the employee's own contributions are Roth.",
  "reimbursements are amounts paid on top of net pay (insurance offsets, stipends, expense reimbursements) with a",
  "non-zero amount this period; check_amount is what was deposited (net pay plus reimbursements).",
  "Categories: federal_tax, state_tax, local_tax, social_security, medicare, medical, dental, vision, hsa, fsa, life,",
  "disability, 401k, roth_401k, retirement_other, 401k_loan, loan_other, other_pre_tax, other_post_tax.",
  "Use null for anything you can't find.",
].join(" ");

function agentConfig() {
  let url = ($os.getenv("OPENCLAW_URL") || "").trim().replace(/\/+$/, "");
  if (!url) return null;
  let username = $os.getenv("OPENCLAW_USERNAME") || "";
  let password = $os.getenv("OPENCLAW_PASSWORD") || "";
  // Credentials written into the URL (https://user:pass@host) become the basic login.
  const m = url.match(/^(\w+:\/\/)([^@\/]*)@(.*)$/);
  if (m) {
    url = m[1] + m[3];
    if (!username && !password) {
      const i = m[2].indexOf(":");
      username = decodeURIComponent(i === -1 ? m[2] : m[2].slice(0, i));
      password = i === -1 ? "" : decodeURIComponent(m[2].slice(i + 1));
    }
  }
  return {
    url: url,
    token: $os.getenv("OPENCLAW_TOKEN") || "",
    agent: $os.getenv("OPENCLAW_AGENT") || "",
    username: username,
    password: password,
  };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of a string's UTF-8 bytes (the hook runtime has no btoa). */
function base64Utf8(text) {
  const bytes = [];
  const utf8 = unescape(encodeURIComponent(text));
  for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

/** Pulls the first JSON object out of a model reply. */
function parseAgentJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON in reply");
  return JSON.parse(text.slice(start, end + 1));
}

function responseText(body) {
  if (!body) return "";
  if (typeof body.output_text === "string") return body.output_text;
  const parts = [];
  for (const item of body.output || []) {
    for (const c of item.content || []) {
      if (typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n");
}

// Response headers that can carry secrets; their values are left out of logs.
const SECRET_HEADERS = ["set-cookie", "authorization", "proxy-authorization", "cookie", "x-api-key"];
const LOG_BODY_LIMIT = 2000;

/** The URL with any user:password@ taken out, so it is safe to log. */
function safeUrl(url) {
  return String(url).replace(/^(\w+:\/\/)[^@\/]*@/, "$1");
}

/** A response's headers as { name: "value" }, with secret ones redacted. */
function safeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  for (const name in headers) {
    const v = headers[name];
    const value = Array.isArray(v) ? v.join(", ") : String(v);
    out[name] = SECRET_HEADERS.indexOf(String(name).toLowerCase()) === -1 ? value : "(redacted)";
  }
  return out;
}

function truncate(text, limit) {
  text = text || "";
  return text.length > limit ? text.slice(0, limit) + "… (" + text.length + " chars)" : text;
}

/**
 * What went wrong talking to the agent, for the PocketBase logs. It is passed as
 * the error's data, which PocketBase shows as `details` on the request log entry.
 * It is a JSON string, not an object: PocketBase would echo an object's keys back
 * to the browser as validation errors. The token is never included.
 */
function agentDetails(cfg, requestUrl, extra) {
  const details = {
    url: safeUrl(requestUrl),
    agent: cfg.agent || "(default agent: OPENCLAW_AGENT is empty)",
    model: cfg.agent ? "openclaw/" + cfg.agent : "openclaw",
    auth_sent: cfg.username ? "basic (user " + cfg.username + ")" : cfg.token ? "bearer token" : "none",
  };
  for (const k in extra) details[k] = extra[k];
  return JSON.stringify(details, null, 2);
}

/** A short hint for the person reading the error, based on the status. */
function agentHint(status, cfg) {
  if (status === 401 || status === 403) {
    if (cfg.username) return " The proxy or gateway refused the OPENCLAW_USERNAME / OPENCLAW_PASSWORD login.";
    if (cfg.token) return " The gateway or a proxy in front of it refused OPENCLAW_TOKEN.";
    return " No login is set. If a proxy in front of OpenClaw asks for one, set OPENCLAW_USERNAME and OPENCLAW_PASSWORD.";
  }
  if (status === 404) return " Check that the OpenResponses endpoint is turned on in OpenClaw.";
  return "";
}

function readPaystubWithAgent(base64, filename, mediaType) {
  const cfg = agentConfig();
  if (!cfg) throw new BadRequestError("No OpenClaw agent is set up for reading paystubs.");
  const headers = { "Content-Type": "application/json" };
  if (cfg.username || cfg.password) {
    headers.Authorization = "Basic " + base64Utf8(cfg.username + ":" + cfg.password);
  } else if (cfg.token) {
    headers.Authorization = "Bearer " + cfg.token;
  }
  if (cfg.agent) headers["x-openclaw-agent-id"] = cfg.agent;
  const requestUrl = cfg.url + "/v1/responses";

  let res;
  try {
    res = $http.send({
      url: requestUrl,
      method: "POST",
      headers: headers,
      timeout: 120,
      body: JSON.stringify({
        model: cfg.agent ? "openclaw/" + cfg.agent : "openclaw",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_file",
                source: { type: "base64", media_type: mediaType || "application/pdf", data: base64, filename: filename || "paystub.pdf" },
              },
              { type: "input_text", text: PAYSTUB_PROMPT },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    throw new BadRequestError(
      "Couldn't reach the OpenClaw agent at " + safeUrl(cfg.url) + ".",
      agentDetails(cfg, requestUrl, { cause: String(err) }),
    );
  }

  let raw = "";
  try { raw = toString(res.body); } catch (_) { raw = ""; }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new BadRequestError(
      "The OpenClaw agent answered with HTTP " + res.statusCode + "." + agentHint(res.statusCode, cfg),
      agentDetails(cfg, requestUrl, {
        status: res.statusCode,
        response_headers: safeHeaders(res.headers),
        response_body: truncate(raw, LOG_BODY_LIMIT),
      }),
    );
  }
  let body = res.json;
  if (!body) {
    try { body = JSON.parse(raw); } catch (_) { body = null; }
  }
  try {
    return parseAgentJson(responseText(body));
  } catch (_) {
    throw new BadRequestError(
      "The OpenClaw agent's reply wasn't a paystub.",
      agentDetails(cfg, requestUrl, { status: res.statusCode, response_body: truncate(raw, LOG_BODY_LIMIT) }),
    );
  }
}

// ---------- Envelope balances ----------

function monthStart(month) {
  return month + "-01 00:00:00.000Z";
}

/**
 * Cash carried into `month` (YYYY-MM) for each of the owner's envelopes that
 * keeps its leftovers (rollover, or annual), plus what each envelope spent so
 * far in that calendar year (through the end of the month).
 *
 * An envelope with an opening balance counts from that point: earlier fills
 * are unknown after an import, so older activity is left out of its balance.
 */
function envelopeBalances(app, ownerId, month) {
  const start = monthStart(month);
  const yearStart = month.slice(0, 4) + "-01-01 00:00:00.000Z";
  const next = Number(month.slice(5, 7)) === 12
    ? (Number(month.slice(0, 4)) + 1) + "-01"
    : month.slice(0, 4) + "-" + String(Number(month.slice(5, 7)) + 1).padStart(2, "0");
  const end = monthStart(next);

  const envs = arrayOf(new DynamicModel({ id: "", rollover: false, period: "", opening_balance: -0, opening_date: "" }));
  app.db().newQuery(
    "SELECT id, rollover, period, opening_balance, opening_date FROM envelopes WHERE owner = {:o}",
  ).bind({ o: ownerId }).all(envs);

  const allocs = arrayOf(new DynamicModel({ envelope: "", month: "", total: -0 }));
  app.db().newQuery(
    "SELECT a.envelope AS envelope, b.month AS month, SUM(a.amount) AS total FROM allocations a " +
    "JOIN budgets b ON b.id = a.budget WHERE b.owner = {:o} GROUP BY a.envelope, b.month",
  ).bind({ o: ownerId }).all(allocs);

  // Money in (+) and out (-) of each envelope, per day.
  const moves = arrayOf(new DynamicModel({ envelope: "", date: "", total: -0, spent: -0 }));
  app.db().newQuery(
    "SELECT envelope, date, SUM(CASE WHEN kind = 'income' THEN amount ELSE -amount END) AS total, " +
    "SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END) AS spent " +
    "FROM transactions WHERE owner = {:o} AND envelope != '' GROUP BY envelope, date",
  ).bind({ o: ownerId }).all(moves);

  const byEnvAlloc = {};
  for (const a of allocs) (byEnvAlloc[a.envelope] = byEnvAlloc[a.envelope] || []).push(a);
  const byEnvMove = {};
  for (const m of moves) (byEnvMove[m.envelope] = byEnvMove[m.envelope] || []).push(m);

  const carried = {};
  const yearSpent = {};
  for (const env of envs) {
    const a = byEnvAlloc[env.id] || [];
    const m = byEnvMove[env.id] || [];
    let spent = 0;
    for (const x of m) if (x.date >= yearStart && x.date < end) spent += x.spent;
    yearSpent[env.id] = Math.round(spent * 100) / 100;

    if (!env.rollover && env.period !== "annual") continue;
    let total = 0;
    const o = env.opening_date;
    if (!o) {
      for (const x of a) if (x.month < month) total += x.total;
      for (const x of m) if (x.date < start) total += x.total;
    } else if (o < start) {
      // Opening balance, plus everything after it and before this month.
      total = env.opening_balance;
      for (const x of a) if (monthStart(x.month) > o && x.month < month) total += x.total;
      for (const x of m) if (x.date > o && x.date < start) total += x.total;
    } else {
      // The opening is inside (or after) this month: back out what this month
      // added before it, so the month ends at the opening balance plus what came after.
      total = env.opening_balance;
      for (const x of a) if (x.month >= month && monthStart(x.month) <= o) total -= x.total;
      for (const x of m) if (x.date >= start && x.date <= o) total -= x.total;
    }
    carried[env.id] = Math.round(total * 100) / 100;
  }
  return { carried: carried, year_spent: yearSpent };
}

// ---------- Importing budget months ----------

/**
 * Creates or updates months of the owner's budget from an import:
 *   [{ month: "2026-11", planned_income: 5000, allocations: [{ envelope_external_id, amount }] }]
 * New months are marked imported. Each listed allocation replaces that envelope's
 * amount for the month (envelope transfers can make it negative).
 */
function importBudgets(app, ownerId, months) {
  if (!Array.isArray(months) || months.length === 0) throw badRequest("Send { \"months\": [ ... ] }.");
  if (months.length > 240) throw badRequest("Send at most 240 months per request.");
  const result = { budgets_created: 0, allocations: 0 };

  app.runInTransaction((tx) => {
    const budgets = tx.findCollectionByNameOrId("budgets");
    const allocations = tx.findCollectionByNameOrId("allocations");
    months.forEach((item, index) => {
      const month = item && String(item.month || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("Month " + index + " needs a month like 2026-11.");
      let budget = null;
      try {
        budget = tx.findFirstRecordByFilter("budgets", "owner = {:o} && month = {:m}", { o: ownerId, m: month });
      } catch (_) {}
      if (!budget) {
        budget = new Record(budgets);
        budget.set("owner", ownerId);
        budget.set("month", month);
        budget.set("imported", true);
        budget.set("planned_income", Math.max(0, Number(item.planned_income) || 0));
        tx.save(budget);
        result.budgets_created++;
      } else if (!budget.getFloat("planned_income") && item.planned_income > 0) {
        budget.set("planned_income", Number(item.planned_income));
        tx.save(budget);
      }

      for (const a of item.allocations || []) {
        const env = findByExternalId(tx, "envelopes", ownerId, String(a.envelope_external_id || ""));
        if (!env) throw badRequest("envelopes with external_id '" + a.envelope_external_id + "' was not found.");
        let rec = null;
        try {
          rec = tx.findFirstRecordByFilter("allocations", "budget = {:b} && envelope = {:e}", { b: budget.id, e: env.id });
        } catch (_) {}
        if (!rec) {
          rec = new Record(allocations);
          rec.set("owner", ownerId);
          rec.set("budget", budget.id);
          rec.set("envelope", env.id);
        }
        rec.set("amount", Math.round((Number(a.amount) || 0) * 100) / 100);
        tx.save(rec);
        result.allocations++;
      }
    });
  });
  return result;
}

// ---------- Vendors ----------
//
// A transaction's `payee` is its statement value: what the bank (through n8n), an
// import or a person wrote. Each vendor lists the statement values that belong to
// it (`matches`); match.js decides which vendor a statement value is.

function matcher() {
  return require(`${__hooks}/finance/match.js`);
}

function jsonList(record, field) {
  try {
    const v = JSON.parse(record.getString(field) || "null");
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function loadVendors(app, ownerId) {
  const rows = app.findRecordsByFilter("vendors", "owner = {:o}", "", 0, 0, { o: ownerId });
  return rows.map((r) => ({ id: r.id, matches: jsonList(r, "matches"), default_envelope: r.get("default_envelope") }));
}

/**
 * Links a transaction that is about to be saved to its vendor, unless someone
 * picked the vendor by hand (vendor_locked). Spending with no envelope goes into
 * the vendor's usual envelope. Runs before the save, so no hooks run twice.
 */
function applyVendor(app, record, isNew) {
  if (record.getBool("vendor_locked")) return;
  const payee = record.getString("payee");
  const vendor = payee ? matcher().matchVendor(payee, loadVendors(app, record.get("owner"))) : null;
  record.set("vendor", vendor ? vendor.id : "");
  if (isNew && vendor && vendor.default_envelope && record.get("kind") === "expense" && !record.get("envelope") && !record.get("earner")) {
    record.set("envelope", vendor.default_envelope);
  }
}

/** A vendor of the household, or a 404. */
function findVendor(app, ownerId, id) {
  let v = null;
  try { v = app.findRecordById("vendors", id); } catch (_) {}
  if (!v || v.get("owner") !== ownerId) throw new NotFoundError("That vendor wasn't found.");
  return v;
}

/**
 * Links the household's transactions that have no vendor yet (and weren't set by
 * hand) to this vendor where its patterns fit. Returns how many were linked.
 */
function backfillVendor(app, ownerId, vendorId) {
  const vendor = findVendor(app, ownerId, vendorId);
  const one = [{ id: vendor.id, matches: jsonList(vendor, "matches") }];
  const rows = arrayOf(new DynamicModel({ id: "", payee: "" }));
  app.db().newQuery(
    "SELECT id, payee FROM transactions WHERE owner = {:o} AND vendor = '' AND vendor_locked = FALSE AND payee != ''",
  ).bind({ o: ownerId }).all(rows);
  let matched = 0;
  const m = matcher();
  for (const r of rows) {
    if (!m.matchVendor(r.payee, one)) continue;
    app.db().newQuery("UPDATE transactions SET vendor = {:v} WHERE id = {:id}").bind({ v: vendor.id, id: r.id }).execute();
    matched++;
  }
  return matched;
}

/**
 * Statement values with no vendor yet, grouped by their stable start, most
 * frequent first. Spending and money back into an envelope count; income to the
 * budget (paychecks, fills) is left out.
 */
function unmatchedStatements(app, ownerId) {
  const rows = arrayOf(new DynamicModel({ payee: "", n: 0, total: -0, last: "" }));
  app.db().newQuery(
    "SELECT payee, COUNT(*) AS n, SUM(CASE WHEN kind = 'income' THEN -amount ELSE amount END) AS total, MAX(date) AS last " +
    "FROM transactions WHERE owner = {:o} AND vendor = '' AND payee != '' AND earner = '' AND (kind = 'expense' OR envelope != '') GROUP BY payee",
  ).bind({ o: ownerId }).all(rows);
  const groups = {};
  const m = matcher();
  for (const r of rows) {
    const key = m.normalizeStatement(r.payee);
    const g = groups[key] || (groups[key] = { pattern: key, count: 0, total: 0, last_date: "", example: r.payee });
    g.count += r.n;
    g.total = Math.round((g.total + r.total) * 100) / 100;
    if (r.last > g.last_date) { g.last_date = r.last; g.example = r.payee; }
  }
  return Object.keys(groups).map((k) => groups[k])
    .sort((a, b) => b.count - a.count || b.total - a.total || (a.pattern < b.pattern ? -1 : 1));
}

/** Moves one vendor's transactions, documents and patterns into another, then deletes it. */
function mergeVendors(app, ownerId, fromId, intoId) {
  if (fromId === intoId) throw badRequest("Pick a different vendor to merge into.");
  let moved = 0;
  app.runInTransaction((tx) => {
    const from = findVendor(tx, ownerId, fromId);
    const into = findVendor(tx, ownerId, intoId);
    const patterns = jsonList(into, "matches");
    for (const p of jsonList(from, "matches")) if (patterns.indexOf(p) === -1) patterns.push(p);
    into.set("matches", patterns);
    for (const f of ["default_envelope", "recurring", "tax_category", "legal_name", "address", "tin", "emoji", "color"]) {
      if (!into.get(f) && from.get(f)) into.set(f, from.get(f));
    }
    if (!into.getFloat("expected_amount") && from.getFloat("expected_amount")) into.set("expected_amount", from.getFloat("expected_amount"));
    if (!into.getInt("expected_day") && from.getInt("expected_day")) into.set("expected_day", from.getInt("expected_day"));
    tx.save(into);
    moved = tx.countRecords("transactions", $dbx.hashExp({ vendor: fromId }));
    tx.db().newQuery("UPDATE transactions SET vendor = {:to} WHERE vendor = {:from} AND owner = {:o}")
      .bind({ to: intoId, from: fromId, o: ownerId }).execute();
    tx.db().newQuery("UPDATE tax_documents SET vendor = {:to} WHERE vendor = {:from} AND owner = {:o}")
      .bind({ to: intoId, from: fromId, o: ownerId }).execute();
    tx.delete(from);
  });
  return moved;
}

// ---------- Households ----------

/** The id that owns the signed-in user's data: the head of their household. */
function householdOf(auth) {
  return (auth && (auth.get("household") || auth.id)) || "";
}

/** Only the head of a household manages its members. Returns the head's id. */
function requireHead(auth) {
  if (!auth || householdOf(auth) !== auth.id) {
    throw new ForbiddenError("Only the head of the household can do that.");
  }
  return auth.id;
}

/** A member of the head's household (never the head), or a 404. */
function findMember(app, headId, id) {
  let user = null;
  try {
    user = app.findRecordById("users", id);
  } catch (_) {}
  if (!user || user.id === headId || user.get("household") !== headId) {
    throw new NotFoundError("That person isn't in your household.");
  }
  return user;
}

// ---------- API tokens ----------

const TOKEN_PREFIX = "ft_";

/** The raw value of the Authorization header (with or without "Bearer "). */
function bearerOf(e) {
  const header = String(e.request.header.get("Authorization") || "").trim();
  return header.replace(/^Bearer\s+/i, "").trim();
}

/** Whether a value looks like one of our API tokens (rather than a PocketBase JWT). */
function isApiToken(value) {
  return typeof value === "string" && value.indexOf(TOKEN_PREFIX) === 0;
}

/**
 * Signs the request in as the member an API token belongs to. Marks the request so routes
 * can tell it came from a token. Throws a 401 for a token that doesn't exist (revoked).
 */
function authWithApiToken(e, raw) {
  let token = null;
  try {
    token = e.app.findFirstRecordByData("api_tokens", "token_hash", $security.sha256(raw));
  } catch (_) {}
  let user = null;
  if (token) {
    try {
      user = e.app.findRecordById("users", token.get("user"));
    } catch (_) {}
  }
  if (!token || !user) {
    throw new UnauthorizedError("This API token isn't valid. It may have been revoked.");
  }
  e.auth = user;
  e.set("apiTokenId", token.id);

  // Note when it was last used, at most every few minutes (a direct update: no hooks, no `updated` bump).
  const last = Date.parse(String(token.getString("last_used") || "").replace(" ", "T"));
  const now = Date.now();
  if (!last || now - last > 5 * 60 * 1000) {
    e.app.db().newQuery("UPDATE api_tokens SET last_used = {:t} WHERE id = {:id}")
      .bind({ t: new Date(now).toISOString().replace("T", " "), id: token.id }).execute();
  }
}

/** API tokens are managed only from a signed-in session, never with a token (so a leaked one can't make more). */
function requireSession(e, message) {
  if (e.get("apiTokenId")) {
    throw new ForbiddenError(message || "API tokens can't manage API tokens. Sign in to the app to do that.");
  }
}

function tokenJSON(app, t) {
  let by = null;
  try {
    const u = app.findRecordById("users", t.get("user"));
    by = { id: u.id, name: u.getString("name"), email: u.email() };
  } catch (_) {}
  return {
    id: t.id,
    name: t.getString("name"),
    prefix: t.getString("prefix"),
    last_used: t.getString("last_used"),
    created: t.getString("created"),
    user: by,
  };
}

function listApiTokens(app, ownerId) {
  return app.findRecordsByFilter("api_tokens", "owner = {:o}", "-created", 0, 0, { o: ownerId }).map((t) => tokenJSON(app, t));
}

/** Makes a token for `auth`. The plain token is returned once and never stored. */
function createApiToken(app, auth, name) {
  name = String(name || "").trim();
  if (!name) throw new BadRequestError("Give the token a name, like \"n8n\".");
  if (name.length > 100) throw new BadRequestError("Keep the name under 100 characters.");
  const raw = TOKEN_PREFIX + $security.randomString(40);
  const t = new Record(app.findCollectionByNameOrId("api_tokens"));
  t.set("owner", householdOf(auth));
  t.set("user", auth.id);
  t.set("name", name);
  t.set("token_hash", $security.sha256(raw));
  t.set("prefix", raw.slice(0, 7));
  app.save(t);
  return Object.assign(tokenJSON(app, t), { token: raw });
}

function revokeApiToken(app, ownerId, id) {
  let t = null;
  try {
    t = app.findRecordById("api_tokens", id);
  } catch (_) {}
  if (!t || t.get("owner") !== ownerId) throw new NotFoundError("That token isn't in your household.");
  app.delete(t);
}

module.exports = {
  applyVendor, backfillVendor, unmatchedStatements, mergeVendors,
  householdOf, requireHead, findMember,
  bearerOf, isApiToken, authWithApiToken, requireSession, listApiTokens, createApiToken, revokeApiToken,
  envelopeBalances, importBudgets,
  agentConfig, readPaystubWithAgent, adjustAssetValue, payDateOf,
  OWNED, SYNCABLE, upsert, adjustDebtBalance,
  setPaystubStatus, reconcilePaycheck, attachPaystub, detachPaystub, backfillPaystub, syncLinePayment, removeLinePayment,
};
