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
    // A copy that has its own paystub's PDF (saved by a bulk upload) is that
    // paycheck's paystub, so its deposit isn't up for grabs.
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
      paystubsForTransaction(app, t.id).every((p) => p.get("source") === "repeat" && !p.getString("file")),
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

// ---------- Bulk paystub upload (a zip of PDFs, read in the browser) ----------

const LINE_CATEGORIES = [
  "federal_tax", "state_tax", "local_tax", "social_security", "medicare", "medical", "dental", "vision", "hsa", "fsa",
  "life", "disability", "401k", "roth_401k", "retirement_other", "401k_loan", "loan_other", "other_pre_tax",
  "other_post_tax", "reimbursement",
];

/** Days in one pay period, for deciding whether the app has an earner's paystubs from the start of a year. */
const PERIOD_DAYS = { weekly: 7, biweekly: 14, semimonthly: 16, monthly: 31 };

function money2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function dayOf(value) {
  return String(value || "").slice(0, 10);
}

function pbDay(day) {
  return day + " 12:00:00.000Z";
}

/** "Nov 13, 2026" */
function niceDay(day) {
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, mo, d] = dayOf(day).split("-");
  return m[Number(mo) - 1] + " " + Number(d) + ", " + y;
}

function dollars(n) {
  return "$" + money2(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Checks one stub sent by the app and returns it cleaned up. */
function cleanStub(app, ownerId, raw, index, fileCount) {
  const name = String((raw && raw.name) || "paystub " + (index + 1)).slice(0, 200);
  const fail = (why) => badRequest("The paystub " + name + ": " + why);
  if (!raw || typeof raw !== "object") throw fail("not a paystub.");
  const payDate = dayOf(raw.pay_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) throw fail("no pay date.");
  const file = Number(raw.file);
  if (!(file >= 0 && file < fileCount)) throw fail("its PDF wasn't sent.");
  const net = money2(raw.net);
  const gross = money2(raw.gross);
  if (net <= 0 || gross <= 0) throw fail("no gross or net pay.");
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).map((l) => {
    const category = String((l && l.category) || "");
    if (LINE_CATEGORIES.indexOf(category) === -1) throw fail("unknown category '" + category + "'.");
    const line = {
      category: category,
      label: String(l.label || "").slice(0, 200),
      amount: money2(l.amount),
      employer_paid: !!l.employer_paid,
      debt: l.employer_paid ? "" : String(l.debt || ""),
      asset: String(l.asset || ""),
    };
    if (line.debt) assertOwned(app, "debts", line.debt, ownerId);
    if (line.asset) assertOwned(app, "assets", line.asset, ownerId);
    return line;
  }).filter((l) => l.amount > 0);
  const reimbursed = lines.filter((l) => l.category === "reimbursement").reduce((s, l) => s + l.amount, 0);
  return {
    index: index,
    name: name,
    file: file,
    pay_date: payDate,
    period_start: dayOf(raw.period_start),
    period_end: dayOf(raw.period_end),
    gross: gross,
    net: net,
    deposit: money2(raw.deposit) || money2(net + reimbursed),
    lines: lines,
    ytd_gross: money2(raw.ytd_gross),
    ytd_net: money2(raw.ytd_net),
  };
}

/**
 * The earner's paystub already in the app for this paycheck: paid within a few
 * days of the stub's pay date. `same` is whether it has the same check amount to
 * the cent; a copied paystub that doesn't means the copy was wrong.
 */
function existingPaystubFor(app, ownerId, earnerId, stub) {
  const d = new Date(stub.pay_date + "T12:00:00Z").getTime();
  const from = new Date(d - 4 * 864e5).toISOString().replace("T", " ");
  const to = new Date(d + 4 * 864e5).toISOString().replace("T", " ");
  const rows = app.findRecordsByFilter(
    "paystubs",
    "owner = {:owner} && earner = {:earner} && pay_date >= {:from} && pay_date <= {:to}",
    "pay_date,created",
    0,
    0,
    { owner: ownerId, earner: earnerId, from: from, to: to },
  );
  const dist = (p) => Math.abs(daysBetween(p.getString("pay_date"), stub.pay_date));
  const same = rows.filter((p) => sameMoney(depositOf(p), stub.deposit)).sort((a, b) => dist(a) - dist(b));
  if (same.length) return { paystub: same[0], same: true };
  const copy = rows.filter((p) => p.get("source") === "repeat").sort((a, b) => dist(a) - dist(b))[0];
  return copy ? { paystub: copy, same: false } : null;
}

/**
 * Compares a stub's printed year-to-date gross or net pay (`field`) with the
 * paystubs in the app. It counts from the last earlier paystub this year that
 * had the figure printed (its figure plus every paycheck since), else from
 * January 1st when the app has this earner's paystubs from the first pay period
 * on. Each copied paystub in between may be a cent off (rounding), so the
 * tolerance grows a cent with each one. Returns null when there's nothing to
 * compare with.
 */
function ytdCheck(app, ownerId, earner, record, field, printed) {
  if (!printed) return null;
  const payDate = record.getString("pay_date");
  const year = dayOf(payDate).slice(0, 4);
  const yearStart = year + "-01-01 00:00:00.000Z";
  const ytdField = "ytd_" + field;
  const params = { owner: ownerId, earner: earner.id, start: yearStart, end: payDate, self: record.id };
  const anchors = app.findRecordsByFilter(
    "paystubs",
    "owner = {:owner} && earner = {:earner} && id != {:self} && pay_date >= {:start} && pay_date < {:end} && " + ytdField + " > 0",
    "-pay_date,-created",
    1,
    0,
    params,
  );
  const anchor = anchors[0] || null;
  const since = app.findRecordsByFilter(
    "paystubs",
    "owner = {:owner} && earner = {:earner} && pay_date >= {:start} && pay_date <= {:end}" + (anchor ? " && pay_date > {:after}" : ""),
    "pay_date",
    0,
    0,
    Object.assign({ after: anchor ? anchor.getString("pay_date") : "" }, params),
  );
  if (!anchor) {
    // Without an earlier figure, the sum only means something if the app has this
    // earner's paystubs from the start of the year.
    const first = since[0];
    const limit = new Date(Date.parse(year + "-01-01T12:00:00Z") + ((PERIOD_DAYS[earner.get("pay_frequency")] || 14) + 3) * 864e5);
    if (!first || dayOf(first.getString("pay_date")) > limit.toISOString().slice(0, 10)) return { checked: false, printed: printed };
  }
  let total = anchor ? anchor.getFloat(ytdField) : 0;
  let copies = 0;
  for (const p of since) {
    total += p.getFloat(field);
    if (p.get("source") === "repeat") copies++;
  }
  const expected = money2(total);
  const off = money2(printed - expected);
  return {
    checked: true,
    printed: printed,
    expected: expected,
    off: off,
    ok: Math.abs(off) <= 0.01 * (1 + copies) + 0.001,
    from: anchor ? dayOf(anchor.getString("pay_date")) : "",
    count: since.length,
  };
}

/**
 * Saves a batch of paystubs read from a zip of PDFs, all or nothing. In pay-date
 * order, each stub:
 *   - already in the app (a paystub for that paycheck with the same check amount,
 *     copied or not): its PDF is saved with that paystub, nothing else changes;
 *   - otherwise: saved like an uploaded paystub (it links to its deposit and
 *     backfills matching earlier ones, and its loan and contribution lines move
 *     their debts and assets).
 * A stub that prints year-to-date gross or net pay is then checked against the
 * paystubs in the app (see ytdCheck). If they've drifted apart, or anything else
 * fails, the whole batch is rolled back: nothing it added or changed is kept.
 */
function bulkUploadPaystubs(app, ownerId, earnerId, rawStubs, files) {
  if (!Array.isArray(rawStubs) || rawStubs.length === 0) throw badRequest("Send at least one paystub in `stubs`.");
  if (rawStubs.length > 200) throw badRequest("Send at most 200 paystubs at a time.");
  // Each stub can name its own earner (read from the name on it); `earnerId` is for the rest.
  const earners = {};
  const earnerOf = (id) => {
    if (!earners[id]) {
      let rec;
      try { rec = app.findRecordById("earners", id); } catch (_) { rec = null; }
      if (!rec || rec.get("owner") !== ownerId) throw badRequest("Pick whose paystubs these are.");
      earners[id] = rec;
    }
    return earners[id];
  };
  const stubs = rawStubs.map((r, i) => {
    const stub = cleanStub(app, ownerId, r, i, files.length);
    stub.earner = earnerOf(String((r && r.earner) || earnerId || "")).id;
    return stub;
  });
  const order = stubs.slice().sort((a, b) => (a.pay_date < b.pay_date ? -1 : a.pay_date > b.pay_date ? 1 : a.index - b.index));
  const results = [];

  app.runInTransaction((txApp) => {
    const collection = txApp.findCollectionByNameOrId("paystubs");
    const lineCollection = txApp.findCollectionByNameOrId("paystub_lines");
    for (const stub of order) {
      const result = { index: stub.index, name: stub.name, pay_date: stub.pay_date, action: "added", filled: 0, ytd: {} };
      const earner = earners[stub.earner];
      result.earner = earner.id;
      const found = existingPaystubFor(txApp, ownerId, earner.id, stub);
      let record;
      if (found && !found.same) {
        throw badRequest(
          "The paystub " + stub.name + " doesn't match the paycheck on " + niceDay(found.paystub.getString("pay_date")) + ", which was filled in from an earlier paystub with " +
          dollars(depositOf(found.paystub)) + ", but this paystub's check amount is " + dollars(stub.deposit) +
          ". Open that paycheck and upload this paystub on its own to fix it. Nothing from this upload was saved.",
        );
      } else if (found) {
        // Already in the app (often a paystub copied onto a matching deposit): keep its
        // amounts and just save the PDF with it.
        record = found.paystub;
        result.action = record.getString("file") ? "already" : "attached";
        result.source = record.get("source");
        if (!record.getString("file")) record.set("file", files[stub.file]);
        if (stub.ytd_gross && !record.getFloat("ytd_gross")) record.set("ytd_gross", stub.ytd_gross);
        if (stub.ytd_net && !record.getFloat("ytd_net")) record.set("ytd_net", stub.ytd_net);
        txApp.save(record);
      } else {
        record = new Record(collection);
        record.set("owner", ownerId);
        record.set("earner", earner.id);
        record.set("pay_date", pbDay(stub.pay_date));
        if (stub.period_start) record.set("period_start", pbDay(stub.period_start));
        if (stub.period_end) record.set("period_end", pbDay(stub.period_end));
        record.set("gross", stub.gross);
        record.set("net", stub.net);
        record.set("deposit", stub.deposit);
        record.set("ytd_gross", stub.ytd_gross);
        record.set("ytd_net", stub.ytd_net);
        record.set("source", "upload");
        record.set("file", files[stub.file]);
        txApp.save(record);
        stub.lines.forEach((l, i) => {
          const line = new Record(lineCollection);
          line.set("owner", ownerId);
          line.set("paystub", record.id);
          line.set("category", l.category);
          line.set("label", l.label);
          line.set("amount", l.amount);
          line.set("debt", l.debt);
          line.set("asset", l.asset);
          line.set("employer_paid", l.employer_paid);
          line.set("sort", i);
          txApp.save(line);
        });
        result.filled = backfillPaystub(txApp, ownerId, record.id);
        record = txApp.findRecordById("paystubs", record.id);
      }
      result.paystub = record.id;

      for (const field of ["gross", "net"]) {
        const check = ytdCheck(txApp, ownerId, earner, record, field, stub["ytd_" + field]);
        if (!check) continue;
        result.ytd[field] = check;
        if (check.checked && !check.ok) {
          throw badRequest(
            "The paystub " + stub.name + " (paid " + niceDay(stub.pay_date) + ") shows " + dollars(check.printed) + " " + field +
            " pay so far this year, but the paystubs in the app add up to " + dollars(check.expected) + " (" +
            dollars(Math.abs(check.off)) + (check.off > 0 ? " short" : " over") + "). Nothing from this upload was saved.",
          );
        }
      }
      results.push(result);
    }
  });

  results.sort((a, b) => a.index - b.index);
  return { results: results };
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
  '"reimbursements":[{"label":"as printed","amount":0}],"check_amount":0,"ytd_gross":0,"ytd_net":0,"employee_name":""}',
  "Use this pay period's amounts, not year-to-date. Amounts are positive numbers in dollars.",
  "employee_name is the employee's name as printed.",
  "ytd_gross and ytd_net are the year-to-date gross and net pay printed on the stub (null if it doesn't show them).",
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
  closeTokenRealtime(app, t.id);
}

/** Closes the realtime connections a token subscribed (tagged in onRealtimeSubscribeRequest). */
function closeTokenRealtime(app, tokenId) {
  const clients = app.subscriptionsBroker().clients();
  for (const id of Object.keys(clients)) {
    const c = clients[id];
    if (c && c.get("apiTokenId") === tokenId) c.discard();
  }
}

// ---------- SimpleFIN Bridge ----------
//
// The pure parts (token decoding, what a pull adds, when it's due) are in finance/simplefin.js.

function sfin() {
  return require(`${__hooks}/finance/simplefin.js`);
}

/** A "YYYY-MM-DD" day as PocketBase stores days (noon UTC, so it's the same day everywhere). */
function pbDay(day) {
  return day ? String(day).slice(0, 10) + " 12:00:00.000Z" : "";
}

function pbNow() {
  return new Date().toISOString().replace("T", " ");
}

/**
 * The minute past each hour this instance checks for due pulls. Picked at random the
 * first time and kept in pb_data, so instances spread out over the hour (and away
 * from the top of it). SIMPLEFIN_MINUTE overrides it.
 */
function simplefinMinute(app) {
  const s = sfin();
  const fromEnv = s.parseMinute($os.getenv("SIMPLEFIN_MINUTE"));
  if (fromEnv !== null) return fromEnv;
  const path = app.dataDir() + "/simplefin_minute";
  try {
    const saved = s.parseMinute(toString($os.readFile(path)));
    if (saved !== null) return saved;
  } catch (_) {}
  const minute = s.pickMinute();
  try {
    $os.writeFile(path, String(minute), 0o644);
  } catch (err) {
    console.log("Couldn't save the SimpleFIN minute to " + path + ": " + err);
  }
  return minute;
}

function sfinFailure(message, details) {
  return new BadRequestError(message, details ? JSON.stringify(details, null, 2) : undefined);
}

/** Trades a setup token for an access URL. Each token works once. */
function claimSimplefin(setupToken) {
  const s = sfin();
  let claimUrl;
  try {
    claimUrl = s.claimUrlFromToken(setupToken);
  } catch (err) {
    throw new BadRequestError(String(err.message || err));
  }
  // A pasted access URL (it already has a login in it) needs no claiming.
  if (s.splitAccessUrl(claimUrl).username) {
    try { return s.checkAccessUrl(claimUrl); } catch (err) { throw new BadRequestError(String(err.message || err)); }
  }
  let res;
  try {
    res = $http.send({ url: claimUrl, method: "POST", headers: { "Content-Length": "0" }, body: "", timeout: 30 });
  } catch (err) {
    throw sfinFailure("Couldn't reach SimpleFIN to claim the setup token.", { url: safeUrl(claimUrl), cause: String(err) });
  }
  const text = (() => { try { return toString(res.body); } catch (_) { return ""; } })();
  if (res.statusCode === 403) {
    throw new BadRequestError(
      "SimpleFIN says this setup token was already used or doesn't exist. Make a new one on the Bridge. " +
      "If you didn't use it yourself, someone else may have: disconnect it on the Bridge.",
    );
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw sfinFailure("SimpleFIN answered the claim with HTTP " + res.statusCode + ".", { url: safeUrl(claimUrl), body: truncate(text, 500) });
  }
  try {
    return s.checkAccessUrl(text);
  } catch (err) {
    throw sfinFailure(String(err.message || err), { url: safeUrl(claimUrl) });
  }
}

/** GET <access URL>/accounts. Returns the parsed answer, or throws with a message for the person. */
function fetchSimplefin(accessUrl, query) {
  const s = sfin();
  const parts = s.splitAccessUrl(accessUrl);
  const url = parts.base + "/accounts?" + query;
  let res;
  try {
    res = $http.send({
      url: url,
      method: "GET",
      headers: { Authorization: "Basic " + s.encodeBase64(parts.username + ":" + parts.password), Accept: "application/json" },
      timeout: 90,
    });
  } catch (err) {
    throw new Error("Couldn't reach SimpleFIN (" + safeUrl(parts.base) + "): " + err);
  }
  if (res.statusCode === 403 || res.statusCode === 401) {
    throw new Error("SimpleFIN refused this connection. It may have been disconnected on the Bridge. Connect again with a new setup token.");
  }
  if (res.statusCode === 402) throw new Error("SimpleFIN says the Bridge subscription needs paying.");
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error("SimpleFIN answered with HTTP " + res.statusCode + ".");
  let body = res.json;
  if (!body) {
    try { body = JSON.parse(toString(res.body)); } catch (_) { body = null; }
  }
  if (!body || !Array.isArray(body.accounts)) throw new Error("SimpleFIN's answer had no accounts in it.");
  return body;
}

function findSimplefinAccount(app, connId, sfinId) {
  try {
    return app.findFirstRecordByFilter("simplefin_accounts", "connection = {:c} && sfin_id = {:s}", { c: connId, s: sfinId });
  } catch (_) {
    return null;
  }
}

function recordExists(app, collection, filter, params) {
  try {
    app.findFirstRecordByFilter(collection, filter, params);
    return true;
  } catch (_) {
    return false;
  }
}

/** Filter params for "within PAIR_DAYS days of this day, this amount to the cent". */
function nearParams(owner, day, amount) {
  const s = sfin();
  const at = s.epochOfDay(day);
  return {
    o: owner,
    lo: s.dayOf(at - s.PAIR_DAYS * 86400) + " 00:00:00.000Z",
    hi: s.dayOf(at + s.PAIR_DAYS * 86400) + " 23:59:59.999Z",
    a1: amount - 0.004,
    a2: amount + 0.004,
  };
}

/**
 * Pulls one connection: refreshes its accounts and their balances, and brings in the
 * transactions of accounts used for spending. Saves what went wrong on the connection
 * and rethrows it. Returns { accounts, transactions, payments, warnings }.
 */
function pullSimplefin(app, conn) {
  const s = sfin();
  const owner = conn.get("owner");
  const now = Date.now();
  conn.set("last_attempt", pbNow());
  try {
    const inUse = app.findRecordsByFilter(
      "simplefin_accounts", "connection = {:c} && (use = 'spending' || use = 'balance')", "", 0, 0, { c: conn.id },
    );
    const spending = inUse.filter((a) => a.getString("use") === "spending" && (a.get("asset") || a.get("debt")));
    const nowSec = Math.floor(now / 1000);
    let query = "version=2";
    if (spending.length > 0) {
      query += "&start-date=" + s.windowStart(nowSec, spending.map((a) => ({
        last_pulled: a.getString("last_pulled"), sync_from: a.getString("sync_from"),
      })));
    } else {
      query += "&balances-only=1";
    }
    const body = fetchSimplefin(conn.getString("access_url"), query);
    const warnings = s.answerErrors(body);
    const found = s.readAccounts(body);
    const result = { accounts: found.length, transactions: 0, payments: 0, warnings: warnings };

    app.runInTransaction((txApp) => {
      const accountsCol = txApp.findCollectionByNameOrId("simplefin_accounts");
      const records = {};
      const orgs = [];
      for (const a of found) {
        let rec = findSimplefinAccount(txApp, conn.id, a.id);
        if (!rec) {
          rec = new Record(accountsCol);
          rec.set("owner", owner);
          rec.set("connection", conn.id);
          rec.set("sfin_id", a.id);
        }
        rec.set("name", a.name);
        rec.set("org", a.org);
        rec.set("currency", a.currency);
        rec.set("balance", a.balance);
        rec.set("available_balance", a.available_balance === null ? a.balance : a.available_balance);
        rec.set("balance_date", pbDay(a.balance_date));
        txApp.save(rec);
        records[a.id] = rec;
        if (a.org && orgs.indexOf(a.org) === -1) orgs.push(a.org);
      }
      if (orgs.length) conn.set("label", orgs.join(", ").slice(0, 300));

      // Transactions, for accounts used for spending.
      const debtTypes = {};
      const linked = found.filter((a) => records[a.id]).map((a) => {
        const rec = records[a.id];
        const debt = rec.get("asset") ? "" : rec.get("debt");
        if (debt && !debtTypes[debt]) {
          try { debtTypes[debt] = txApp.findRecordById("debts", debt).getString("type"); } catch (_) { debtTypes[debt] = ""; }
        }
        return {
          id: a.id, name: rec.getString("name"), use: rec.getString("use"),
          asset: rec.get("asset"), debt: debt, debt_type: debtTypes[debt] || "",
          sync_from: rec.getString("sync_from").slice(0, 10), transactions: a.transactions,
        };
      });
      const known = (ext) =>
        recordExists(txApp, "transactions", "owner = {:o} && external_id = {:e}", { o: owner, e: ext }) ||
        recordExists(txApp, "debt_payments", "owner = {:o} && (external_id = {:e} || from_external_id = {:e})", { o: owner, e: ext });
      const plan = s.planPull(linked, known);

      // A card payment whose withdrawal came in on an earlier day: that withdrawal isn't spending after all.
      for (const p of plan.payments) {
        if (p.from_external_id) continue;
        let old = null;
        try {
          old = txApp.findFirstRecordByFilter("transactions",
            "owner = {:o} && kind = 'expense' && account_asset != '' && envelope = '' && external_id ~ 'sfin-%' && " +
            "amount >= {:a1} && amount <= {:a2} && date >= {:lo} && date <= {:hi}", nearParams(owner, p.date, p.amount));
        } catch (_) {}
        if (old) {
          p.from_asset = old.get("account_asset");
          p.from_external_id = old.getString("external_id");
          txApp.delete(old);
        }
      }
      // A withdrawal that paid a card payment brought in on an earlier day.
      const keep = [];
      for (const t of plan.transactions) {
        if (t.kind === "expense" && t.account_asset) {
          let pay = null;
          try {
            pay = txApp.findFirstRecordByFilter("debt_payments",
              "owner = {:o} && from_external_id = '' && external_id ~ 'sfin-%' && " +
              "amount >= {:a1} && amount <= {:a2} && date >= {:lo} && date <= {:hi}", nearParams(owner, t.date, t.amount));
          } catch (_) {}
          if (pay) {
            pay.set("from_asset", t.account_asset);
            pay.set("from_external_id", t.external_id);
            txApp.save(pay);
            continue;
          }
        }
        keep.push(t);
      }

      const earners = txApp.findRecordsByFilter("earners", "owner = {:o} && archived = false && employer != ''", "", 0, 0, { o: owner });
      const txCol = txApp.findCollectionByNameOrId("transactions");
      for (const t of keep) {
        const rec = new Record(txCol);
        rec.set("owner", owner);
        for (const k of ["external_id", "kind", "amount", "payee", "note", "account", "account_asset", "account_debt"]) rec.set(k, t[k]);
        rec.set("date", pbDay(t.date));
        if (t.kind === "income" && t.account_asset) {
          const earner = earners.find((e) => s.fromEmployer(t.payee, e.getString("employer")));
          if (earner) rec.set("earner", earner.id);
        }
        txApp.save(rec);
        result.transactions++;
      }
      const payCol = txApp.findCollectionByNameOrId("debt_payments");
      for (const p of plan.payments) {
        const rec = new Record(payCol);
        rec.set("owner", owner);
        for (const k of ["external_id", "debt", "amount", "note", "from_asset", "from_external_id"]) rec.set(k, p[k]);
        rec.set("date", pbDay(p.date));
        txApp.save(rec);
        result.payments++;
      }

      // Balances last: payments above move a debt's balance, and the bank's figure wins.
      for (const a of found) {
        const rec = records[a.id];
        const use = rec.getString("use");
        if (use !== "spending" && use !== "balance") continue;
        if (rec.get("asset")) {
          try {
            const asset = txApp.findRecordById("assets", rec.get("asset"));
            asset.set("value", a.balance);
            if (a.balance_date) asset.set("as_of", pbDay(a.balance_date));
            txApp.save(asset);
          } catch (_) {}
        } else if (rec.get("debt")) {
          try {
            const debt = txApp.findRecordById("debts", rec.get("debt"));
            debt.set("balance", s.debtBalance(a.balance, debt.getString("type")));
            txApp.save(debt);
          } catch (_) {}
        }
        if (use === "spending" && spending.some((x) => x.id === rec.id)) {
          rec.set("last_pulled", pbDay(s.dayOf(nowSec)));
          txApp.save(rec);
        }
      }
    });

    conn.set("last_sync", pbNow());
    conn.set("last_error", warnings.join("\n").slice(0, 4000));
    app.save(conn);
    return result;
  } catch (err) {
    const message = String((err && err.message) || err);
    conn.set("last_error", message.slice(0, 4000));
    try { app.save(conn); } catch (_) {}
    throw err;
  }
}

function findConnection(app, ownerId, id) {
  let c = null;
  try { c = app.findRecordById("simplefin_connections", id); } catch (_) {}
  if (!c || c.get("owner") !== ownerId) throw new NotFoundError("That SimpleFIN connection isn't in your household.");
  return c;
}

/** Claims a setup token, saves the connection and pulls its accounts. */
function connectSimplefin(app, ownerId, setupToken, syncHourUtc) {
  const accessUrl = claimSimplefin(setupToken);
  const hour = Number(syncHourUtc);
  const conn = new Record(app.findCollectionByNameOrId("simplefin_connections"));
  conn.set("owner", ownerId);
  conn.set("access_url", accessUrl);
  conn.set("label", "SimpleFIN");
  // 6 AM US Eastern unless the app says where the person is.
  conn.set("sync_hour_utc", Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 11);
  app.save(conn);
  let pulled = null;
  let error = "";
  try {
    pulled = pullSimplefin(app, conn);
  } catch (err) {
    error = String((err && err.message) || err);
  }
  return { id: conn.id, pulled: pulled, error: error };
}

function syncSimplefinNow(app, ownerId, id) {
  const conn = findConnection(app, ownerId, id);
  try {
    return pullSimplefin(app, conn);
  } catch (err) {
    throw new BadRequestError(String((err && err.message) || err));
  }
}

function disconnectSimplefin(app, ownerId, id) {
  app.delete(findConnection(app, ownerId, id));
}

/** Runs every hour at the instance's minute: pulls each connection whose morning it is. */
function runDueSimplefin(app) {
  const s = sfin();
  const now = Date.now();
  const all = app.findRecordsByFilter("simplefin_connections", "", "created", 0, 0);
  for (const conn of all) {
    const last = Date.parse(String(conn.getString("last_attempt") || "").replace(" ", "T"));
    if (!s.isDue(now, Number.isFinite(last) ? last : 0, conn.getInt("sync_hour_utc"))) continue;
    try {
      const r = pullSimplefin(app, conn);
      console.log("SimpleFIN pull for " + conn.id + ": " + r.transactions + " transactions, " + r.payments + " payments");
    } catch (err) {
      console.log("SimpleFIN pull for " + conn.id + " failed: " + ((err && err.message) || err));
    }
  }
}

module.exports = {
  simplefinMinute, connectSimplefin, syncSimplefinNow, disconnectSimplefin, runDueSimplefin,
  applyVendor, backfillVendor, unmatchedStatements, mergeVendors,
  householdOf, requireHead, findMember,
  bearerOf, isApiToken, authWithApiToken, requireSession, listApiTokens, createApiToken, revokeApiToken,
  envelopeBalances, importBudgets,
  agentConfig, readPaystubWithAgent, adjustAssetValue, payDateOf,
  OWNED, SYNCABLE, upsert, adjustDebtBalance,
  setPaystubStatus, reconcilePaycheck, attachPaystub, detachPaystub, backfillPaystub, syncLinePayment, removeLinePayment,
  bulkUploadPaystubs,
};
