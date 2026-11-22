/// <reference path="../pb_data/types.d.ts" />

// Initial schema for the finance tracker.
//
// Every data collection has an `owner` relation to `users`, and every API rule
// limits access to the signed-in owner. The n8n sync signs in as the same user
// (see docs/api.md), so the API and the app see exactly the same data.
//
// Collections that n8n is likely to sync also have an `external_id` text field,
// unique per owner, so a sync can be re-run without creating duplicates.

const OWNER_ONLY = "@request.auth.id != \"\" && owner = @request.auth.id";
// On create the owner may be left out (pb_hooks fill it in from the token), or
// set to yourself. It can never be set to somebody else.
const CREATE_OWN =
  "@request.auth.id != \"\" && (@request.body.owner:isset = false || @request.body.owner = @request.auth.id)";
const UPDATE_OWN =
  OWNER_ONLY + " && (@request.body.owner:isset = false || @request.body.owner = @request.auth.id)";

function rules(extraCreate, extraUpdate) {
  return {
    listRule: OWNER_ONLY,
    viewRule: OWNER_ONLY,
    createRule: CREATE_OWN + (extraCreate ? " && " + extraCreate : ""),
    updateRule: UPDATE_OWN + (extraUpdate ? " && " + extraUpdate : ""),
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
  return {
    name: "owner",
    type: "relation",
    collectionId: usersId,
    maxSelect: 1,
    cascadeDelete: true,
    required: true,
  };
}

const ENVELOPE_COLORS = ["coral", "peach", "butter", "mint", "aqua", "sky", "lilac", "pink"];

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    // ---------- Budget: Dave Ramsey cash envelopes ----------

    const envelopes = new Collection({
      type: "base",
      name: "envelopes",
      ...rules(),
      fields: [
        owner(users.id),
        { name: "name", type: "text", required: true, max: 80 },
        {
          name: "group",
          type: "select",
          maxSelect: 1,
          values: [
            "giving", "saving", "housing", "utilities", "food", "transportation",
            "insurance", "health", "personal", "lifestyle", "debt", "other",
          ],
        },
        { name: "color", type: "select", maxSelect: 1, values: ENVELOPE_COLORS },
        { name: "emoji", type: "text", max: 16 },
        // The amount planned for a month when no month-specific amount is set.
        { name: "default_amount", type: "number", min: 0 },
        // Sinking funds: what's left at the end of a month carries into the next.
        { name: "rollover", type: "bool" },
        { name: "sort", type: "number" },
        { name: "archived", type: "bool" },
        { name: "external_id", type: "text", max: 200 },
        ...timestamps(),
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_envelopes_external ON envelopes (owner, external_id) WHERE external_id != ''",
      ],
    });
    app.save(envelopes);

    const budgets = new Collection({
      type: "base",
      name: "budgets",
      ...rules(),
      fields: [
        owner(users.id),
        // "YYYY-MM"
        { name: "month", type: "text", required: true, pattern: "^\\d{4}-(0[1-9]|1[0-2])$" },
        // Planned take-home pay for the month. Zero-based: every dollar gets an envelope.
        { name: "planned_income", type: "number", min: 0 },
        { name: "notes", type: "text", max: 2000 },
        ...timestamps(),
      ],
      indexes: ["CREATE UNIQUE INDEX idx_budgets_owner_month ON budgets (owner, month)"],
    });
    app.save(budgets);

    const allocations = new Collection({
      type: "base",
      name: "allocations",
      ...rules(
        "budget.owner = @request.auth.id && envelope.owner = @request.auth.id",
        "(@request.body.budget:isset = false || @request.body.budget.owner = @request.auth.id) && " +
          "(@request.body.envelope:isset = false || @request.body.envelope.owner = @request.auth.id)",
      ),
      fields: [
        owner(users.id),
        { name: "budget", type: "relation", collectionId: budgets.id, maxSelect: 1, cascadeDelete: true, required: true },
        { name: "envelope", type: "relation", collectionId: envelopes.id, maxSelect: 1, cascadeDelete: true, required: true },
        { name: "amount", type: "number", min: 0 },
        ...timestamps(),
      ],
      indexes: ["CREATE UNIQUE INDEX idx_allocations_budget_envelope ON allocations (budget, envelope)"],
    });
    app.save(allocations);

    const transactions = new Collection({
      type: "base",
      name: "transactions",
      ...rules(
        "(@request.body.envelope:isset = false || @request.body.envelope = \"\" || @request.body.envelope.owner = @request.auth.id)",
        "(@request.body.envelope:isset = false || @request.body.envelope = \"\" || @request.body.envelope.owner = @request.auth.id)",
      ),
      fields: [
        owner(users.id),
        // "expense" spends cash out of an envelope; "income" is money coming in.
        { name: "kind", type: "select", maxSelect: 1, required: true, values: ["expense", "income"] },
        { name: "envelope", type: "relation", collectionId: envelopes.id, maxSelect: 1, cascadeDelete: false },
        { name: "date", type: "date", required: true },
        // Always positive; `kind` says which way it goes.
        { name: "amount", type: "number", required: true, min: 0 },
        { name: "payee", type: "text", max: 200 },
        { name: "note", type: "text", max: 2000 },
        { name: "external_id", type: "text", max: 200 },
        ...timestamps(),
      ],
      indexes: [
        "CREATE INDEX idx_transactions_owner_date ON transactions (owner, date)",
        "CREATE UNIQUE INDEX idx_transactions_external ON transactions (owner, external_id) WHERE external_id != ''",
      ],
    });
    app.save(transactions);

    // ---------- Debts ----------

    const debts = new Collection({
      type: "base",
      name: "debts",
      ...rules(),
      fields: [
        owner(users.id),
        { name: "name", type: "text", required: true, max: 120 },
        {
          name: "type",
          type: "select",
          maxSelect: 1,
          values: ["credit_card", "auto", "student", "medical", "personal", "mortgage", "heloc", "other"],
        },
        { name: "lender", type: "text", max: 120 },
        { name: "balance", type: "number", min: 0 },
        { name: "original_balance", type: "number", min: 0 },
        // APR as a percent, e.g. 6.5 for 6.5%.
        { name: "interest_rate", type: "number", min: 0 },
        { name: "minimum_payment", type: "number", min: 0 },
        // Day of the month the payment is due (1-31).
        { name: "due_day", type: "number", min: 0, max: 31, onlyInt: true },
        { name: "notes", type: "text", max: 2000 },
        { name: "external_id", type: "text", max: 200 },
        ...timestamps(),
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_debts_external ON debts (owner, external_id) WHERE external_id != ''",
      ],
    });
    app.save(debts);

    const debtPayments = new Collection({
      type: "base",
      name: "debt_payments",
      ...rules(
        "debt.owner = @request.auth.id",
        "(@request.body.debt:isset = false || @request.body.debt.owner = @request.auth.id)",
      ),
      fields: [
        owner(users.id),
        { name: "debt", type: "relation", collectionId: debts.id, maxSelect: 1, cascadeDelete: true, required: true },
        { name: "date", type: "date", required: true },
        { name: "amount", type: "number", required: true, min: 0 },
        { name: "note", type: "text", max: 2000 },
        { name: "external_id", type: "text", max: 200 },
        ...timestamps(),
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_debt_payments_external ON debt_payments (owner, external_id) WHERE external_id != ''",
      ],
    });
    app.save(debtPayments);

    // ---------- Assets ----------

    const assets = new Collection({
      type: "base",
      name: "assets",
      // Every debt linked to an asset must belong to the same person.
      ...rules(
        "(@request.body.debts:isset = false || @request.body.debts:length = 0 || @request.body.debts.owner = @request.auth.id)",
        "(@request.body.debts:isset = false || @request.body.debts:length = 0 || @request.body.debts.owner = @request.auth.id)",
      ),
      fields: [
        owner(users.id),
        { name: "name", type: "text", required: true, max: 120 },
        {
          name: "type",
          type: "select",
          maxSelect: 1,
          values: [
            "real_estate", "vehicle", "collectible", "checking", "savings", "brokerage",
            "401k", "ira", "roth_ira", "hsa", "529", "crypto", "cash", "other",
          ],
        },
        { name: "institution", type: "text", max: 120 },
        { name: "value", type: "number", min: 0 },
        // When the value was last checked.
        { name: "as_of", type: "date" },
        // Debts secured by or tied to this asset (a mortgage on a house, a car loan).
        { name: "debts", type: "relation", collectionId: debts.id, maxSelect: 50, cascadeDelete: false },
        { name: "notes", type: "text", max: 2000 },
        { name: "external_id", type: "text", max: 200 },
        ...timestamps(),
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_assets_external ON assets (owner, external_id) WHERE external_id != ''",
      ],
    });
    app.save(assets);
  },
  (app) => {
    for (const name of ["assets", "debt_payments", "debts", "transactions", "allocations", "budgets", "envelopes"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (_) {}
    }
  },
);
