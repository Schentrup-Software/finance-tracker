// Shared server-side logic for the finance tracker hooks.
//
// PocketBase runs every hook handler in its own isolated runtime, so handlers
// can't close over variables in finance.pb.js. They `require()` this file instead.

// Collections that belong to a user and are open to the API.
const OWNED = [
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
const SYNCABLE = ["envelopes", "transactions", "debts", "debt_payments", "assets"];

// Relation fields a sync may fill by the other record's external_id, e.g.
// `envelope_external_id: "groceries"` on a transaction.
const RELATIONS = {
  transactions: { envelope: "envelopes" },
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

module.exports = { OWNED, SYNCABLE, upsert, adjustDebtBalance };
