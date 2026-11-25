/// <reference path="../pb_data/types.d.ts" />

// Vendors, and tax-deductible spending.
//
// vendors              who the money goes to. `matches` lists statement values (the
//                      transaction's `payee`, as the bank or an import wrote it) that belong
//                      to the vendor; pb_hooks links new transactions to it. A vendor can
//                      be recurring, and can carry a tax category with the details a tax
//                      form needs (legal name, address, TIN).
// transactions.vendor  set by matching, or picked by hand (then vendor_locked = true)
// transactions.tax_*   per-row tax overrides: category (or "none"), deductible part,
//                      who reimbursed it, IRA tax year and person, acknowledgment received
// envelopes.tax_category  default tax category for everything spent from the envelope
// tax_documents        receipts, acknowledgments and charities' year-end statements
// tax_years            per-year AGI and the IRS figures the year-end report applies

const HH = "@request.auth.household";
const SIGNED_IN = '@request.auth.id != ""';
const MINE = SIGNED_IN + " && owner = " + HH;
const CREATE_OWN = SIGNED_IN + " && (@request.body.owner:isset = false || @request.body.owner = " + HH + ")";
const UPDATE_OWN = MINE + " && (@request.body.owner:isset = false || @request.body.owner = " + HH + ")";

/** A relation in the request body must be empty or point at one of the household's records. */
function own(field) {
  return "(@request.body." + field + ':isset = false || @request.body.' + field + ' = "" || @request.body.' + field + ".owner = " + HH + ")";
}

function rules(relations) {
  const extra = relations.map(own).join(" && ");
  return {
    listRule: MINE,
    viewRule: MINE,
    createRule: CREATE_OWN + (extra ? " && " + extra : ""),
    updateRule: UPDATE_OWN + (extra ? " && " + extra : ""),
    deleteRule: MINE,
  };
}

function timestamps() {
  return [
    { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];
}

function owner(usersId) {
  return { name: "owner", type: "relation", collectionId: usersId, maxSelect: 1, cascadeDelete: true, required: true };
}

const TAX_CATEGORIES = ["charity", "medical", "child_care", "ira"];
const COLORS = ["coral", "peach", "butter", "mint", "aqua", "sky", "lilac", "pink"];

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const envelopes = app.findCollectionByNameOrId("envelopes");
    const transactions = app.findCollectionByNameOrId("transactions");

    const vendors = new Collection({
      type: "base",
      name: "vendors",
      ...rules(["default_envelope"]),
      fields: [
        owner(users.id),
        { name: "name", type: "text", required: true, max: 120 },
        { name: "emoji", type: "text", max: 16 },
        { name: "color", type: "select", maxSelect: 1, values: COLORS },
        // Statement values (normalized) that belong to this vendor, e.g. ["PAYPAL *STMARYSCHURCH"].
        { name: "matches", type: "json", maxSize: 20000 },
        { name: "default_envelope", type: "relation", collectionId: envelopes.id, maxSelect: 1, cascadeDelete: false },
        { name: "recurring", type: "select", maxSelect: 1, values: ["weekly", "biweekly", "monthly", "quarterly", "annual"] },
        { name: "expected_amount", type: "number", min: 0 },
        { name: "expected_day", type: "number", min: 0, max: 31, onlyInt: true },
        { name: "tax_category", type: "select", maxSelect: 1, values: TAX_CATEGORIES },
        { name: "legal_name", type: "text", max: 200 },
        { name: "address", type: "text", max: 500 },
        { name: "tin", type: "text", max: 20 },
        { name: "notes", type: "text", max: 2000 },
        { name: "archived", type: "bool" },
        { name: "external_id", type: "text", max: 200 },
        ...timestamps(),
      ],
      indexes: ["CREATE UNIQUE INDEX idx_vendors_external ON vendors (owner, external_id) WHERE external_id != ''"],
    });
    app.save(vendors);

    envelopes.fields.add(new SelectField({ name: "tax_category", maxSelect: 1, values: TAX_CATEGORIES }));
    app.save(envelopes);

    transactions.fields.add(new RelationField({ name: "vendor", collectionId: vendors.id, maxSelect: 1, cascadeDelete: false }));
    transactions.fields.add(new BoolField({ name: "vendor_locked" }));
    transactions.fields.add(new SelectField({ name: "tax_category", maxSelect: 1, values: TAX_CATEGORIES.concat(["none"]) }));
    transactions.fields.add(new NumberField({ name: "tax_amount", min: 0 }));
    transactions.fields.add(new SelectField({ name: "tax_paid_by", maxSelect: 1, values: ["hsa", "health_fsa", "insurance"] }));
    transactions.fields.add(new NumberField({ name: "tax_year", min: 0, max: 2200, onlyInt: true }));
    transactions.fields.add(new TextField({ name: "tax_person", max: 80 }));
    transactions.fields.add(new BoolField({ name: "tax_acknowledged" }));
    transactions.createRule += " && " + own("vendor");
    transactions.updateRule += " && " + own("vendor");
    transactions.indexes = transactions.indexes.concat(["CREATE INDEX idx_transactions_vendor ON transactions (vendor)"]);
    app.save(transactions);

    const docs = new Collection({
      type: "base",
      name: "tax_documents",
      ...rules(["transaction", "vendor"]),
      fields: [
        owner(users.id),
        {
          name: "file", type: "file", maxSelect: 1, maxSize: 15 * 1024 * 1024, protected: true, required: true,
          mimeTypes: ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"],
        },
        { name: "tax_year", type: "number", required: true, min: 1900, max: 2200, onlyInt: true },
        { name: "kind", type: "select", maxSelect: 1, values: ["receipt", "acknowledgment", "year_end_statement", "other"] },
        { name: "label", type: "text", max: 200 },
        { name: "transaction", type: "relation", collectionId: transactions.id, maxSelect: 1, cascadeDelete: false },
        { name: "vendor", type: "relation", collectionId: vendors.id, maxSelect: 1, cascadeDelete: false },
        ...timestamps(),
      ],
      indexes: ["CREATE INDEX idx_tax_documents_owner_year ON tax_documents (owner, tax_year)"],
    });
    app.save(docs);

    const num = (name, extra) => Object.assign({ name: name, type: "number", min: 0 }, extra || {});
    const years = new Collection({
      type: "base",
      name: "tax_years",
      ...rules([]),
      fields: [
        owner(users.id),
        num("year", { required: true, min: 1900, max: 2200, onlyInt: true }),
        num("agi"),
        // Mortgage interest, state taxes and the like, reconciled by hand at year end.
        num("other_itemized"),
        { name: "confirmed", type: "bool" },
        num("standard_deduction"),
        num("charity_floor_pct"),
        num("charity_cash_cap_pct"),
        num("nonitemizer_charity_cap"),
        num("medical_floor_pct"),
        num("care_cap_one"),
        num("care_cap_two"),
        num("qualifying_children", { onlyInt: true }),
        num("ira_limit"),
        num("ira_catch_up"),
        num("ira_phaseout_start"),
        num("ira_phaseout_end"),
        { name: "notes", type: "text", max: 2000 },
        ...timestamps(),
      ],
      indexes: ["CREATE UNIQUE INDEX idx_tax_years_owner_year ON tax_years (owner, year)"],
    });
    app.save(years);
  },
  (app) => {
    for (const name of ["tax_years", "tax_documents"]) app.delete(app.findCollectionByNameOrId(name));

    const transactions = app.findCollectionByNameOrId("transactions");
    transactions.createRule = transactions.createRule.replace(" && " + own("vendor"), "");
    transactions.updateRule = transactions.updateRule.replace(" && " + own("vendor"), "");
    transactions.indexes = transactions.indexes.filter((i) => i.indexOf("idx_transactions_vendor") === -1);
    for (const f of ["vendor", "vendor_locked", "tax_category", "tax_amount", "tax_paid_by", "tax_year", "tax_person", "tax_acknowledged"]) {
      transactions.fields.removeByName(f);
    }
    app.save(transactions);

    const envelopes = app.findCollectionByNameOrId("envelopes");
    envelopes.fields.removeByName("tax_category");
    app.save(envelopes);

    app.delete(app.findCollectionByNameOrId("vendors"));
  },
);
