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
];

// Collections the /api/sync/{collection} upsert endpoint accepts. Each record
// in a sync is matched on (owner, external_id).
const SYNCABLE = ["earners", "envelopes", "transactions", "debts", "debt_payments", "assets"];

// Relation fields a sync may fill by the other record's external_id, e.g.
// `envelope_external_id: "groceries"` on a transaction.
const RELATIONS = {
  transactions: { envelope: "envelopes", earner: "earners" },
  debt_payments: { debt: "debts" },
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

// A deposit "matches" the earner's last paystub when the take-home pay is
// within one cent of it. Then taxes and deductions are assumed unchanged.
const MATCH_TOLERANCE = 0.01;

function sameMoney(a, b) {
  return Math.abs(a - b) <= MATCH_TOLERANCE + 1e-9;
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
  if (prev && sameMoney(prev.getFloat("net"), tx.getFloat("amount"))) {
    return { status: "matched", template: prev };
  }
  return { status: "needs_paystub", template: null };
}

/** Copies a paystub and its lines for a new deposit (same pay, same deductions). */
function repeatPaystub(app, template, tx) {
  const collection = app.findCollectionByNameOrId("paystubs");
  const copy = new Record(collection);
  copy.set("owner", tx.get("owner"));
  copy.set("earner", template.get("earner"));
  copy.set("pay_date", tx.getString("date"));
  copy.set("gross", template.getFloat("gross"));
  copy.set("net", tx.getFloat("amount"));
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
    l.set("debt", line.get("debt"));
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
  if (result.template) repeatPaystub(app, result.template, tx);
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
    const waiting = app.findRecordsByFilter(
      "transactions",
      "owner = {:owner} && earner = {:earner} && kind = 'income' && paystub_status = 'needs_paystub' && date >= {:from} && date <= {:to}",
      "date",
      0,
      0,
      { owner: paystub.get("owner"), earner: paystub.get("earner"), from: from, to: to },
    );
    const hit = waiting.find((t) => sameMoney(t.getFloat("amount"), paystub.getFloat("net")));
    if (!hit) return;
    txId = hit.id;
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

/** When a paystub linked to a deposit goes away, the deposit needs one again. */
function detachPaystub(app, txId) {
  if (!txId) return;
  let tx;
  try { tx = app.findRecordById("transactions", txId); } catch (_) { return; }
  if (paystubsForTransaction(app, txId).length === 0 && tx.get("earner") && tx.get("kind") === "income") {
    setPaystubStatus(app, tx, "needs_paystub");
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
//   OPENCLAW_TOKEN  the gateway token or password     (required)
//   OPENCLAW_AGENT  agent id to use (optional; default agent otherwise)

const PAYSTUB_PROMPT = [
  "Read this paystub and reply with ONLY a JSON object, no other text, in this shape:",
  '{"pay_date":"YYYY-MM-DD","period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD","employer":"","gross":0,"net":0,',
  '"lines":[{"label":"as printed","category":"one of the categories","amount":0}]}',
  "Use this pay period's amounts, not year-to-date. Amounts are positive numbers in dollars.",
  "lines are every deduction and tax taken from gross pay. Do not include earnings lines, employer contributions, or net pay.",
  "Categories: federal_tax, state_tax, local_tax, social_security, medicare, medical, dental, vision, hsa, fsa, life,",
  "disability, 401k, roth_401k, retirement_other, 401k_loan, loan_other, other_pre_tax, other_post_tax.",
  "Use null for anything you can't find.",
].join(" ");

function agentConfig() {
  const url = ($os.getenv("OPENCLAW_URL") || "").replace(/\/+$/, "");
  const token = $os.getenv("OPENCLAW_TOKEN") || "";
  return url && token ? { url: url, token: token, agent: $os.getenv("OPENCLAW_AGENT") || "" } : null;
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

function readPaystubWithAgent(base64, filename, mediaType) {
  const cfg = agentConfig();
  if (!cfg) throw new BadRequestError("No OpenClaw agent is set up for reading paystubs.");
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + cfg.token };
  if (cfg.agent) headers["x-openclaw-agent-id"] = cfg.agent;

  const res = $http.send({
    url: cfg.url + "/v1/responses",
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
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new BadRequestError("The OpenClaw agent answered with HTTP " + res.statusCode + ".");
  }
  let body = res.json;
  if (!body) {
    try { body = JSON.parse(toString(res.body)); } catch (_) { body = null; }
  }
  try {
    return parseAgentJson(responseText(body));
  } catch (_) {
    throw new BadRequestError("The OpenClaw agent's reply wasn't a paystub.");
  }
}

module.exports = {
  agentConfig, readPaystubWithAgent,
  OWNED, SYNCABLE, upsert, adjustDebtBalance,
  setPaystubStatus, reconcilePaycheck, attachPaystub, detachPaystub, syncLinePayment, removeLinePayment,
};
