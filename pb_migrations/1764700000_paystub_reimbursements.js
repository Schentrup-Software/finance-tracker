/// <reference path="../pb_data/types.d.ts" />

// Reimbursements on a paystub (an insurance offset, a travel stipend) are paid
// after net pay, so what lands in the bank is net pay plus reimbursements: the
// stub's "Check Amount". Each one is a paystub line with category
// "reimbursement", and paystubs.deposit holds that check amount so a deposit can
// be matched to it. An empty or zero deposit means the check amount is the net.

migrate(
  (app) => {
    const lines = app.findCollectionByNameOrId("paystub_lines");
    const category = lines.fields.getByName("category");
    if (category.values.indexOf("reimbursement") === -1) category.values = category.values.concat(["reimbursement"]);
    app.save(lines);

    const paystubs = app.findCollectionByNameOrId("paystubs");
    paystubs.fields.add(new NumberField({ name: "deposit", min: 0 }));
    app.save(paystubs);
  },
  (app) => {
    const paystubs = app.findCollectionByNameOrId("paystubs");
    paystubs.fields.removeByName("deposit");
    app.save(paystubs);

    const lines = app.findCollectionByNameOrId("paystub_lines");
    const category = lines.fields.getByName("category");
    category.values = category.values.filter((v) => v !== "reimbursement");
    app.save(lines);
  },
);
