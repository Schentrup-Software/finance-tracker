/// <reference path="../pb_data/types.d.ts" />

// Limits sign-in attempts (password logins for members and superusers) to 10 a minute
// from one address, so a password can't be guessed by trying thousands of them.
// PocketBase ships with rate limiting off. Only sign-ins are limited: imports, syncs and
// API tokens are left alone. This machine itself (local tests) isn't limited.
//
// Behind a reverse proxy every request may come from the proxy's address, so the limit
// is then shared by the whole household; 10 a minute is still plenty for people.

const RULE = { label: "*:auth", audience: "", duration: 60, maxRequests: 10 };

migrate(
  (app) => {
    const settings = app.settings();
    const limits = settings.rateLimits;
    // Someone who already turned rate limiting on in the dashboard keeps their rules.
    if (limits.enabled) return;
    limits.enabled = true;
    limits.rules = [RULE];
    limits.excludedIPs = ["127.0.0.1", "::1"];
    app.save(settings);
  },
  (app) => {
    const settings = app.settings();
    const limits = settings.rateLimits;
    if (limits.rules.length === 1 && limits.rules[0].label === RULE.label && limits.rules[0].maxRequests === RULE.maxRequests) {
      limits.enabled = false;
      app.save(settings);
    }
  },
);
