/// <reference path="../pb_data/types.d.ts" />

// Annual envelopes and history import.
//
// envelopes.period        "monthly" (default) or "annual"
// envelopes.goal          yearly target for annual envelopes
// envelopes.opening_balance / opening_date
//                         cash in the envelope at the end of opening_date. Set by an
//                         import, where older fills are unknown: balances count from here.
// allocations.amount      may be negative: an envelope transfer moves money out
// budgets.imported        the month came from an import, so its allocations are
//                         transfers, not a plan to copy into the next month
// transactions.account    the bank or card account, as text

migrate(
  (app) => {
    const envelopes = app.findCollectionByNameOrId("envelopes");
    envelopes.fields.add(new SelectField({ name: "period", maxSelect: 1, values: ["monthly", "annual"] }));
    envelopes.fields.add(new NumberField({ name: "goal", min: 0 }));
    envelopes.fields.add(new NumberField({ name: "opening_balance" }));
    envelopes.fields.add(new DateField({ name: "opening_date" }));
    app.save(envelopes);

    const allocations = app.findCollectionByNameOrId("allocations");
    allocations.fields.getByName("amount").min = null;
    app.save(allocations);

    const budgets = app.findCollectionByNameOrId("budgets");
    budgets.fields.add(new BoolField({ name: "imported" }));
    app.save(budgets);

    const transactions = app.findCollectionByNameOrId("transactions");
    transactions.fields.add(new TextField({ name: "account", max: 120 }));
    app.save(transactions);
  },
  (app) => {
    const envelopes = app.findCollectionByNameOrId("envelopes");
    for (const f of ["period", "goal", "opening_balance", "opening_date"]) envelopes.fields.removeByName(f);
    app.save(envelopes);

    const allocations = app.findCollectionByNameOrId("allocations");
    allocations.fields.getByName("amount").min = 0;
    app.save(allocations);

    const budgets = app.findCollectionByNameOrId("budgets");
    budgets.fields.removeByName("imported");
    app.save(budgets);

    const transactions = app.findCollectionByNameOrId("transactions");
    transactions.fields.removeByName("account");
    app.save(transactions);
  },
);
