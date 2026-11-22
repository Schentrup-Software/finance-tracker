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
    l.set("asset", line.get("asset"));
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
  return url ? { url: url, token: token, agent: $os.getenv("OPENCLAW_AGENT") || "" } : null;
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
  const headers = { "Content-Type": "application/json" };
  if (cfg.token) headers.Authorization = "Bearer " + cfg.token;
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

module.exports = {
  householdOf, requireHead, findMember,
  envelopeBalances, importBudgets,
  agentConfig, readPaystubWithAgent, adjustAssetValue, payDateOf,
  OWNED, SYNCABLE, upsert, adjustDebtBalance,
  setPaystubStatus, reconcilePaycheck, attachPaystub, detachPaystub, syncLinePayment, removeLinePayment,
};
