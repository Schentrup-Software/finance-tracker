/// <reference path="../pb_data/types.d.ts" />

// Paychecks: who earns in the household, their paystubs, and every line taken out
// of a paycheck before it reaches the bank (taxes, healthcare, retirement, 401(k)
// loan repayments). Also adds the 401(k) loan debt type, and links income
// transactions to the earner so a deposit can be matched to a paystub.

const OWNER_ONLY = "@request.auth.id != \"\" && owner = @request.auth.id";
const CREATE_OWN =
  "@request.auth.id != \"\" && (@request.body.owner:isset = false || @request.body.owner = @request.auth.id)";
const UPDATE_OWN =
  OWNER_ONLY + " && (@request.body.owner:isset = false || @request.body.owner = @request.auth.id)";

/** `field` in the request body, if sent and not empty, must point at one of my records. */
function mine(field) {
  return `(@request.body.${field}:isset = false || @request.body.${field} = "" || @request.body.${field}.owner = @request.auth.id)`;
}

function rules(...relationFields) {
  const extra = relationFields.map(mine).join(" && ");
  return {
    listRule: OWNER_ONLY,
    viewRule: OWNER_ONLY,
    createRule: CREATE_OWN + (extra ? " && " + extra : ""),
    updateRule: UPDATE_OWN + (extra ? " && " + extra : ""),
    deleteRule: OWNER_ONLY,
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

// Where each paystub line goes. Grouped in the app as taxes, healthcare,
// retirement, loans and other.
const LINE_CATEGORIES = [
  "federal_tax", "state_tax", "local_tax", "social_security", "medicare",
  "medical", "dental", "vision", "hsa", "fsa", "life", "disability",
  "401k", "roth_401k", "retirement_other",
  "401k_loan", "loan_other",
  "other_pre_tax", "other_post_tax",
];

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const debts = app.findCollectionByNameOrId("debts");
    const transactions = app.findCollectionByNameOrId("transactions");

    // ---------- 401(k) loans are a debt type ----------
    const debtType = debts.fields.getByName("type");
    if (debtType.values.indexOf("401k_loan") === -1) {
      debtType.values = debtType.values.concat(["401k_loan"]);
    }
    app.save(debts);

    // ---------- Earners: each paycheck in the household ----------
    const earners = new Collection({
      type: "base",
      name: "earners",
      ...rules(),
      fields: [
        owner(users.id),
        { name: "name", type: "text", required: true, max: 80 },
        { name: "employer", type: "text", max: 120 },
        { name: "color", type: "select", maxSelect: 1, values: ["coral", "peach", "butter", "mint", "aqua", "sky", "lilac", "pink"] },
        { name: "pay_frequency", type: "select", maxSelect: 1, values: ["weekly", "biweekly", "semimonthly", "monthly"] },
        { name: "archived", type: "bool" },
        { name: "external_id", type: "text", max: 200 },
        ...timestamps(),
      ],
      indexes: ["CREATE UNIQUE INDEX idx_earners_external ON earners (owner, external_id) WHERE external_id != ''"],
    });
    app.save(earners);

    // ---------- Income deposits know whose paycheck they are ----------
    transactions.fields.add(new RelationField({
      name: "earner", collectionId: earners.id, maxSelect: 1, cascadeDelete: false,
    }));
    // Set by the server: "matched" when a paystub explains the deposit,
    // "needs_paystub" when it doesn't and the app should ask for one.
    transactions.fields.add(new SelectField({
      name: "paystub_status", maxSelect: 1, values: ["matched", "needs_paystub"],
    }));
    transactions.createRule += " && " + mine("earner");
    transactions.updateRule += " && " + mine("earner");
    app.save(transactions);

    // ---------- Paystubs ----------
    const paystubs = new Collection({
      type: "base",
      name: "paystubs",
      ...rules("earner", "transaction"),
      fields: [
        owner(users.id),
        { name: "earner", type: "relation", collectionId: earners.id, maxSelect: 1, cascadeDelete: true, required: true },
        { name: "pay_date", type: "date", required: true },
        { name: "period_start", type: "date" },
        { name: "period_end", type: "date" },
        { name: "gross", type: "number", min: 0 },
        { name: "net", type: "number", min: 0 },
        // The paystub itself. Protected: only downloadable with a file token.
        {
          name: "file", type: "file", maxSelect: 1, maxSize: 15 * 1024 * 1024, protected: true,
          mimeTypes: ["application/pdf", "image/png", "image/jpeg", "image/heic", "image/webp"],
        },
        // upload: read from a paystub; manual: typed in; repeat: copied from the
        // last paystub because the deposit matched it to the cent.
        { name: "source", type: "select", maxSelect: 1, values: ["upload", "manual", "repeat"] },
        // The bank deposit this paystub explains, if any.
        { name: "transaction", type: "relation", collectionId: transactions.id, maxSelect: 1, cascadeDelete: false },
        { name: "notes", type: "text", max: 2000 },
        { name: "external_id", type: "text", max: 200 },
        ...timestamps(),
      ],
      indexes: [
        "CREATE INDEX idx_paystubs_earner_date ON paystubs (owner, earner, pay_date)",
        "CREATE UNIQUE INDEX idx_paystubs_external ON paystubs (owner, external_id) WHERE external_id != ''",
      ],
    });
    app.save(paystubs);

    const lines = new Collection({
      type: "base",
      name: "paystub_lines",
      ...rules("paystub", "debt"),
      fields: [
        owner(users.id),
        { name: "paystub", type: "relation", collectionId: paystubs.id, maxSelect: 1, cascadeDelete: true, required: true },
        { name: "category", type: "select", maxSelect: 1, required: true, values: LINE_CATEGORIES },
        // As printed on the stub, e.g. "Fed Withholdng" or "401K Loan 1".
        { name: "label", type: "text", max: 120 },
        { name: "amount", type: "number", min: 0 },
        // For loan repayments: the debt this line pays down.
        { name: "debt", type: "relation", collectionId: debts.id, maxSelect: 1, cascadeDelete: false },
        { name: "sort", type: "number" },
        ...timestamps(),
      ],
      indexes: ["CREATE INDEX idx_paystub_lines_paystub ON paystub_lines (paystub)"],
    });
    app.save(lines);
  },
  (app) => {
    for (const name of ["paystub_lines", "paystubs", "earners"]) {
      try { app.delete(app.findCollectionByNameOrId(name)); } catch (_) {}
    }
    try {
      const transactions = app.findCollectionByNameOrId("transactions");
      transactions.createRule = transactions.createRule.replace(" && " + mine("earner"), "");
      transactions.updateRule = transactions.updateRule.replace(" && " + mine("earner"), "");
      transactions.fields.removeByName("earner");
      transactions.fields.removeByName("paystub_status");
      app.save(transactions);
    } catch (_) {}
  },
);
