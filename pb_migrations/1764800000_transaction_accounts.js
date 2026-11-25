/// <reference path="../pb_data/types.d.ts" />

// Accounts for transactions. A bank account (checking, savings, cash) is an asset
// and a credit card is a debt, so the account a transaction happened in links to
// one of those instead of a separate accounts collection:
//
// transactions.account_asset  the checking, savings or cash account (an asset)
// transactions.account_debt   the credit card (a debt)
// transactions.account        stays: the account's name as text, as the import or bank wrote it
// debt_payments.from_asset    the account a payment came from, e.g. Checking paying the Visa
//
// The history import detects the accounts from the spreadsheet and fills these.

const HH = "@request.auth.household";

/** A relation in the request body must be empty or point at one of the household's records. */
function own(field) {
  return "(@request.body." + field + ':isset = false || @request.body.' + field + ' = "" || @request.body.' + field + ".owner = " + HH + ")";
}

migrate(
  (app) => {
    const assets = app.findCollectionByNameOrId("assets");
    const debts = app.findCollectionByNameOrId("debts");

    const transactions = app.findCollectionByNameOrId("transactions");
    transactions.fields.add(new RelationField({ name: "account_asset", collectionId: assets.id, maxSelect: 1, cascadeDelete: false }));
    transactions.fields.add(new RelationField({ name: "account_debt", collectionId: debts.id, maxSelect: 1, cascadeDelete: false }));
    transactions.createRule += " && " + own("account_asset") + " && " + own("account_debt");
    transactions.updateRule += " && " + own("account_asset") + " && " + own("account_debt");
    transactions.indexes = transactions.indexes.concat([
      "CREATE INDEX idx_transactions_account_asset ON transactions (account_asset)",
      "CREATE INDEX idx_transactions_account_debt ON transactions (account_debt)",
    ]);
    app.save(transactions);

    const payments = app.findCollectionByNameOrId("debt_payments");
    payments.fields.add(new RelationField({ name: "from_asset", collectionId: assets.id, maxSelect: 1, cascadeDelete: false }));
    payments.createRule += " && " + own("from_asset");
    payments.updateRule += " && " + own("from_asset");
    app.save(payments);
  },
  (app) => {
    const payments = app.findCollectionByNameOrId("debt_payments");
    payments.createRule = payments.createRule.replace(" && " + own("from_asset"), "");
    payments.updateRule = payments.updateRule.replace(" && " + own("from_asset"), "");
    payments.fields.removeByName("from_asset");
    app.save(payments);

    const transactions = app.findCollectionByNameOrId("transactions");
    const both = " && " + own("account_asset") + " && " + own("account_debt");
    transactions.createRule = transactions.createRule.replace(both, "");
    transactions.updateRule = transactions.updateRule.replace(both, "");
    transactions.indexes = transactions.indexes.filter((i) => i.indexOf("idx_transactions_account_") === -1);
    transactions.fields.removeByName("account_asset");
    transactions.fields.removeByName("account_debt");
    app.save(transactions);
  },
);
