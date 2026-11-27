/// <reference path="../pb_data/types.d.ts" />

// SimpleFIN is the first step for every household: until it has connected SimpleFIN or someone
// chose to skip it, the app opens the Bank accounts page first. `simplefin_skipped` on the head
// of the household's user record says when someone skipped (set by POST /api/simplefin/skip).

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new DateField({ name: "simplefin_skipped" }));
    // Members can't set it on themselves through the API; only the skip route sets it, on the head.
    users.updateRule = "id = @request.auth.id && @request.body.household:isset = false && @request.body.simplefin_skipped:isset = false";
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("simplefin_skipped");
    users.updateRule = "id = @request.auth.id && @request.body.household:isset = false";
    app.save(users);
  },
);
