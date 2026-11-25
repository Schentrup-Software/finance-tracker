/// <reference path="../pb_data/types.d.ts" />

// Employer contributions on a paystub: health insurance the employer pays for,
// a 401(k) match, an HSA seed. They aren't taken out of gross pay, so they are
// kept as paystub lines marked `employer_paid` and left out of the
// "gross minus deductions equals net" check. A retirement or HSA one can feed an
// asset like an employee contribution does.

migrate(
  (app) => {
    const lines = app.findCollectionByNameOrId("paystub_lines");
    lines.fields.add(new BoolField({ name: "employer_paid" }));
    app.save(lines);
  },
  (app) => {
    const lines = app.findCollectionByNameOrId("paystub_lines");
    lines.fields.removeByName("employer_paid");
    app.save(lines);
  },
);
