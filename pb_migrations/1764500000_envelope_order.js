/// <reference path="../pb_data/types.d.ts" />

// Envelopes can be put in any order in the app (drag to reorder), so the list is now
// ordered by `sort` alone. Until now it was ordered by group first, then `sort`, then
// name. This renumbers each household's envelopes 0, 1, 2… in that old order, so
// nobody's list moves around when the new ordering takes over. No schema change.

const GROUPS = [
  "giving", "saving", "housing", "utilities", "food", "transportation",
  "insurance", "health", "personal", "lifestyle", "debt", "other",
];

migrate(
  (app) => {
    const rank = (g) => {
      const i = GROUPS.indexOf(g);
      return i < 0 ? 99 : i;
    };
    const byOwner = {};
    for (const r of app.findAllRecords("envelopes")) {
      const o = r.getString("owner");
      (byOwner[o] = byOwner[o] || []).push(r);
    }
    for (const o in byOwner) {
      byOwner[o]
        .sort((a, b) =>
          rank(a.getString("group")) - rank(b.getString("group")) ||
          a.getFloat("sort") - b.getFloat("sort") ||
          a.getString("name").localeCompare(b.getString("name")))
        .forEach((r, i) => {
          if (r.getFloat("sort") === i) return;
          r.set("sort", i);
          app.unsafeWithoutHooks().saveNoValidate(r);
        });
    }
  },
  () => {},
);
