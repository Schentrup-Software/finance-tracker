/// <reference path="../pb_data/types.d.ts" />

// Year-to-date gross and net pay as printed on an uploaded paystub. The bulk
// upload checks each one against the paystubs the app has for that year, and
// later uploads check against the last one that had them. 0 = not on the stub.
migrate(
  (app) => {
    const paystubs = app.findCollectionByNameOrId("paystubs");
    paystubs.fields.add(new NumberField({ name: "ytd_gross", min: 0 }));
    paystubs.fields.add(new NumberField({ name: "ytd_net", min: 0 }));
    app.save(paystubs);
  },
  (app) => {
    const paystubs = app.findCollectionByNameOrId("paystubs");
    paystubs.fields.removeByName("ytd_gross");
    paystubs.fields.removeByName("ytd_net");
    app.save(paystubs);
  },
);
