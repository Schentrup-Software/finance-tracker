/// <reference path="../pb_data/types.d.ts" />

// Households. Every user belongs to one: `users.household` points at the head of
// the household (the head points at themself). The first account is a head; the
// head adds the rest from the app's Household page.
//
// Data is shared by the whole household: every record's `owner` is the head, and
// the API rules compare it with `@request.auth.household` instead of the user's id.
//
// Existing users: the first one becomes a head. Any other user who has no data yet
// joins that household; a user who already has data keeps it, as the head of a
// household of their own.

const OWNED = [
  "earners", "paystubs", "paystub_lines", "envelopes", "budgets", "allocations",
  "transactions", "debts", "debt_payments", "assets",
];
const RULES = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];

function swapRules(app, from, to) {
  for (const name of OWNED) {
    const c = app.findCollectionByNameOrId(name);
    for (const r of RULES) {
      const rule = c[r];
      if (rule === null || rule === undefined) continue;
      c[r] = String(rule).split(from).join(to);
    }
    app.save(c);
  }
}

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new RelationField({ name: "household", collectionId: users.id, maxSelect: 1, cascadeDelete: false }));
    users.listRule = 'id = @request.auth.id || (household != "" && household = @request.auth.household)';
    users.viewRule = users.listRule;
    users.updateRule = "id = @request.auth.id && @request.body.household:isset = false";
    users.deleteRule = null;
    app.save(users);

    const all = app.findRecordsByFilter("users", "", "created", 0, 0);
    if (all.length > 0) {
      const head = all[0];
      for (const u of all) {
        let join = u.id !== head.id;
        if (join) {
          for (const name of OWNED) {
            if (app.countRecords(name, $dbx.hashExp({ owner: u.id })) > 0) { join = false; break; }
          }
        }
        // Emails are visible only to the rest of the household (see the list rule).
        app.db().newQuery("UPDATE users SET household = {:h}, emailVisibility = TRUE WHERE id = {:id}")
          .bind({ h: join ? head.id : u.id, id: u.id }).execute();
      }
    }

    swapRules(app, "= @request.auth.id", "= @request.auth.household");
  },
  (app) => {
    swapRules(app, "= @request.auth.household", "= @request.auth.id");
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("household");
    users.listRule = "id = @request.auth.id";
    users.viewRule = "id = @request.auth.id";
    users.updateRule = "id = @request.auth.id";
    users.deleteRule = "id = @request.auth.id";
    app.save(users);
  },
);
