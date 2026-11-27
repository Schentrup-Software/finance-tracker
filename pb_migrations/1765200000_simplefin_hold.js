/// <reference path="../pb_data/types.d.ts" />

// Onboarding: a connection made in onboarding's first step holds its transactions. Pulls only
// refresh balances until the household finishes setup (after importing its history, or skipping
// that), so the import and SimpleFIN never bring in the same days. POST /api/simplefin/finish
// clears `hold` and runs the first transaction pull.

migrate(
  (app) => {
    const c = app.findCollectionByNameOrId("simplefin_connections");
    c.fields.add(new BoolField({ name: "hold" }));
    app.save(c);
  },
  (app) => {
    const c = app.findCollectionByNameOrId("simplefin_connections");
    c.fields.removeByName("hold");
    app.save(c);
  },
);
