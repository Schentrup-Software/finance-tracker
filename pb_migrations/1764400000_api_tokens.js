/// <reference path="../pb_data/types.d.ts" />

// API tokens: long-lived keys for n8n and other scripts, made on the app's API tokens page.
//
// A token acts as the household member who made it, so it can do anything they can do in
// the app. It never expires; it stops working when someone revokes it (or the member who
// made it is removed). Only a SHA-256 hash of the token is stored, plus its first few
// characters so people can tell tokens apart.
//
// All rules are superuser-only: tokens are listed, made and revoked through /api/tokens
// (pb_hooks/finance.pb.js), which refuses requests that are themselves signed with a token,
// so a leaked token can't mint more of them.

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const tokens = new Collection({
      type: "base",
      name: "api_tokens",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "owner", type: "relation", collectionId: users.id, maxSelect: 1, cascadeDelete: true, required: true },
        // The member the token acts as.
        { name: "user", type: "relation", collectionId: users.id, maxSelect: 1, cascadeDelete: true, required: true },
        { name: "name", type: "text", required: true, max: 100 },
        { name: "token_hash", type: "text", required: true, hidden: true, max: 64 },
        { name: "prefix", type: "text", max: 20 },
        { name: "last_used", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens (token_hash)",
        "CREATE INDEX idx_api_tokens_owner ON api_tokens (owner)",
      ],
    });
    app.save(tokens);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("api_tokens"));
  },
);
