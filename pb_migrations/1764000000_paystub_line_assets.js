/// <reference path="../pb_data/types.d.ts" />

// A paystub line can feed an asset: an HSA deduction goes into the HSA, a 401(k)
// deduction into the 401(k). Each such line raises that asset's value (pb_hooks).

const MINE = '(@request.body.asset:isset = false || @request.body.asset = "" || @request.body.asset.owner = @request.auth.id)';

migrate(
  (app) => {
    const lines = app.findCollectionByNameOrId("paystub_lines");
    const assets = app.findCollectionByNameOrId("assets");
    lines.fields.add(new RelationField({ name: "asset", collectionId: assets.id, maxSelect: 1, cascadeDelete: false }));
    lines.createRule += " && " + MINE;
    lines.updateRule += " && " + MINE;
    app.save(lines);
  },
  (app) => {
    const lines = app.findCollectionByNameOrId("paystub_lines");
    lines.createRule = lines.createRule.replace(" && " + MINE, "");
    lines.updateRule = lines.updateRule.replace(" && " + MINE, "");
    lines.fields.removeByName("asset");
    app.save(lines);
  },
);
