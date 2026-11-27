/// <reference path="../pb_data/types.d.ts" />

// SimpleFIN Bridge: bank balances and transactions, pulled every morning.
//
// simplefin_connections  one per setup token a household member claimed. The access URL
//                        (with its login) is hidden: only the server reads it. Made, pulled
//                        and removed through /api/simplefin (pb_hooks/finance.pb.js).
// simplefin_accounts     every account SimpleFIN reports. The server adds them and keeps
//                        their balances current; people choose what each one is for (`use`)
//                        and which asset or debt it fills.
//
// transactions.external_id is "sfin-<account id>-<transaction id>" for pulled ones.
// debt_payments.from_external_id is the withdrawal that paid a card, so it isn't also spending.
//
// Asset values can go below zero now: an overdrawn checking account.

const HH = "@request.auth.household";
const MEMBER = '@request.auth.id != "" && owner = ' + HH;

/** A relation in the request body must be empty or point at one of the household's records. */
function own(field) {
  return "(@request.body." + field + ':isset = false || @request.body.' + field + ' = "" || @request.body.' + field + ".owner = " + HH + ")";
}

/** Fields only the server sets. */
function fixed(fields) {
  return fields.map((f) => "@request.body." + f + ":isset = false").join(" && ");
}

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const assets = app.findCollectionByNameOrId("assets");
    const debts = app.findCollectionByNameOrId("debts");

    const connections = new Collection({
      type: "base",
      name: "simplefin_connections",
      listRule: MEMBER,
      viewRule: MEMBER,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "owner", type: "relation", collectionId: users.id, maxSelect: 1, cascadeDelete: true, required: true },
        // https://user:pass@host/simplefin. Never sent to the browser.
        { name: "access_url", type: "text", required: true, hidden: true, max: 2000 },
        // Bank names, for telling connections apart.
        { name: "label", type: "text", max: 300 },
        // The UTC hour of the morning pull (6 AM where the person was when they connected).
        { name: "sync_hour_utc", type: "number", min: 0, max: 23, onlyInt: true },
        { name: "last_sync", type: "date" },
        { name: "last_attempt", type: "date" },
        // What went wrong on the last pull, or the Bridge's warnings. Empty when all is well.
        { name: "last_error", type: "text", max: 4000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_simplefin_connections_owner ON simplefin_connections (owner)"],
    });
    app.save(connections);

    const accounts = new Collection({
      type: "base",
      name: "simplefin_accounts",
      listRule: MEMBER,
      viewRule: MEMBER,
      createRule: null,
      updateRule: MEMBER + " && " + fixed([
        "owner", "connection", "sfin_id", "org", "name", "currency", "balance", "available_balance", "balance_date", "last_pulled",
      ]) + " && " + own("asset") + " && " + own("debt"),
      deleteRule: null,
      fields: [
        { name: "owner", type: "relation", collectionId: users.id, maxSelect: 1, cascadeDelete: true, required: true },
        { name: "connection", type: "relation", collectionId: connections.id, maxSelect: 1, cascadeDelete: true, required: true },
        { name: "sfin_id", type: "text", required: true, max: 300 },
        { name: "org", type: "text", max: 200 },
        { name: "name", type: "text", max: 200 },
        { name: "currency", type: "text", max: 200 },
        { name: "balance", type: "number" },
        { name: "available_balance", type: "number" },
        { name: "balance_date", type: "date" },
        // "" = not chosen yet, "spending" = budget transactions and balance,
        // "balance" = balance only (savings, mortgage, retirement), "ignore" = leave it out.
        { name: "use", type: "select", maxSelect: 1, values: ["spending", "balance", "ignore"] },
        // The asset (checking, savings…) or debt (card, mortgage…) it fills.
        { name: "asset", type: "relation", collectionId: assets.id, maxSelect: 1, cascadeDelete: false },
        { name: "debt", type: "relation", collectionId: debts.id, maxSelect: 1, cascadeDelete: false },
        // Transactions before this day are left out (they came from an import, or are too old).
        { name: "sync_from", type: "date" },
        // The day of the last pull that included this account's transactions.
        { name: "last_pulled", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_simplefin_accounts_sfin ON simplefin_accounts (connection, sfin_id)",
        "CREATE INDEX idx_simplefin_accounts_owner ON simplefin_accounts (owner)",
      ],
    });
    app.save(accounts);

    const payments = app.findCollectionByNameOrId("debt_payments");
    payments.fields.add(new TextField({ name: "from_external_id", max: 200 }));
    payments.indexes = payments.indexes.concat([
      "CREATE INDEX idx_debt_payments_from_external ON debt_payments (owner, from_external_id)",
    ]);
    app.save(payments);

    assets.fields.getByName("value").min = null;
    app.save(assets);
  },
  (app) => {
    const assets = app.findCollectionByNameOrId("assets");
    assets.fields.getByName("value").min = 0;
    app.save(assets);
    const payments = app.findCollectionByNameOrId("debt_payments");
    payments.indexes = payments.indexes.filter((i) => i.indexOf("idx_debt_payments_from_external") === -1);
    payments.fields.removeByName("from_external_id");
    app.save(payments);
    for (const name of ["simplefin_accounts", "simplefin_connections"]) {
      try { app.delete(app.findCollectionByNameOrId(name)); } catch (_) {}
    }
  },
);
