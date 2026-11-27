// SimpleFIN Bridge (https://beta-bridge.simplefin.org): the pure parts.
//
// Plain functions with no PocketBase globals, so the unit tests can load this file
// as it is (testing/unit/simplefin.test.ts). finance/lib.js does the HTTP calls and
// the saving.
//
// How SimpleFIN works:
// - The person makes a setup token on the Bridge. It is a base64'd claim URL.
// - POST to the claim URL (once) answers with an access URL, https://user:pass@host/simplefin.
// - GET <access URL>/accounts?start-date=&end-date= answers with every account the
//   person connected, its balance, and its posted transactions in the window
//   (at most 90 days per request). The Bridge expects about one pull a day.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DAY = 86400;
// The Bridge answers at most 90 days per request.
const MAX_WINDOW_DAYS = 89;
// Each pull reaches back this far before the last one, for transactions that post late.
const OVERLAP_DAYS = 5;
// A card payment and the checking withdrawal that paid it can post this many days apart.
const PAIR_DAYS = 5;

/** Decodes base64 (standard or URL-safe, padding optional) to a string. */
function decodeBase64(text) {
  const s = String(text || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const n = B64.indexOf(s[i]);
    if (n === -1) throw new Error("not base64");
    value = (value << 6) | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(escape(out));
  } catch (_) {
    return out;
  }
}

/** Base64 of an ASCII string (for the Basic auth header). */
function encodeBase64(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < text.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < text.length ? B64[n & 63] : "=";
  }
  return out;
}

/** Plain http is only allowed to this machine (for tests and a local mock). */
function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

/**
 * The claim URL inside a setup token. A pasted claim URL or access URL is taken as is.
 * Throws an Error with a message for the person when it isn't one.
 */
function claimUrlFromToken(token) {
  const raw = String(token || "").trim();
  if (!raw) throw new Error("Paste the setup token from SimpleFIN Bridge.");
  let url = raw;
  if (!/^https?:\/\//i.test(raw)) {
    try {
      url = decodeBase64(raw).trim();
    } catch (_) {
      throw new Error("That isn't a SimpleFIN setup token. Copy the whole token from SimpleFIN Bridge.");
    }
  }
  const m = url.match(/^(https?):\/\/([^\/?#]+)(\/[^\s]*)?$/i);
  if (!m) throw new Error("That isn't a SimpleFIN setup token. Copy the whole token from SimpleFIN Bridge.");
  const host = m[2].replace(/^.*@/, "");
  if (m[1].toLowerCase() !== "https" && !isLocalHost(host)) {
    throw new Error("The setup token points at an http:// address. SimpleFIN only uses https.");
  }
  return url;
}

/** Splits https://user:pass@host/path into the URL without credentials and the login. */
function splitAccessUrl(accessUrl) {
  const m = String(accessUrl || "").trim().match(/^(https?:\/\/)([^@\/]*)@(.+)$/i);
  if (!m) return { base: String(accessUrl || "").trim().replace(/\/+$/, ""), username: "", password: "" };
  const i = m[2].indexOf(":");
  return {
    base: (m[1] + m[3]).replace(/\/+$/, ""),
    username: decodeURIComponent(i === -1 ? m[2] : m[2].slice(0, i)),
    password: i === -1 ? "" : decodeURIComponent(m[2].slice(i + 1)),
  };
}

/** Checks the claim answer is an access URL, and returns it trimmed. */
function checkAccessUrl(text) {
  const url = String(text || "").trim();
  const parts = splitAccessUrl(url);
  const m = parts.base.match(/^(https?):\/\/([^\/?#]+)/i);
  if (!m || !parts.username) throw new Error("SimpleFIN didn't answer with an access URL.");
  if (m[1].toLowerCase() !== "https" && !isLocalHost(m[2])) throw new Error("SimpleFIN answered with an http:// access URL.");
  return url;
}

/** "YYYY-MM-DD" (UTC) of a Unix time in seconds. */
function dayOf(epochSeconds) {
  return new Date(Number(epochSeconds) * 1000).toISOString().slice(0, 10);
}

/** Unix seconds at the start (UTC) of a "YYYY-MM-DD" day. */
function epochOfDay(day) {
  const d = String(day || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
  return Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 1000);
}

/** Whole days between two "YYYY-MM-DD" days. */
function daysApart(a, b) {
  return Math.abs(epochOfDay(a) - epochOfDay(b)) / DAY;
}

/**
 * Where the next pull starts (Unix seconds). Each account in use that pulls
 * transactions asks for days since its last pull (less a few days, for late posts)
 * or, the first time, since its `sync_from` day. Never more than 89 days back.
 * accounts: [{ last_pulled: "YYYY-MM-DD..." | "", sync_from: "YYYY-MM-DD..." | "" }]
 */
function windowStart(nowSeconds, accounts) {
  const floor = nowSeconds - MAX_WINDOW_DAYS * DAY;
  let start = nowSeconds - OVERLAP_DAYS * DAY;
  for (const a of accounts || []) {
    let from;
    if (a.last_pulled) from = epochOfDay(a.last_pulled) - OVERLAP_DAYS * DAY;
    else if (a.sync_from) from = epochOfDay(a.sync_from);
    else from = nowSeconds - 30 * DAY;
    if (from < start) start = from;
  }
  return Math.max(floor, Math.floor(start));
}

/**
 * Whether the morning pull is due. It runs once an hour at the instance's minute:
 * a connection pulls in its morning hour (UTC) unless it was tried in the last two
 * hours, and catches up at any hour once it's gone more than a day and a bit
 * (the server was off that morning).
 */
function isDue(nowMs, lastAttemptMs, syncHourUtc) {
  const hours = lastAttemptMs ? (nowMs - lastAttemptMs) / 3600000 : Infinity;
  if (hours >= 26) return true;
  return new Date(nowMs).getUTCHours() === Number(syncHourUtc) && hours >= 2;
}

/** A minute for the hourly check, kept away from the busy top and bottom of the hour. */
function pickMinute(random) {
  const r = typeof random === "number" ? random : Math.random();
  const choices = [];
  for (let m = 4; m <= 56; m++) if (Math.abs(m - 30) > 3) choices.push(m);
  return choices[Math.min(choices.length - 1, Math.floor(r * choices.length))];
}

/** The minute stored in the instance's file, or null when it's missing or not a minute. */
function parseMinute(text) {
  const n = Number(String(text || "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 59 ? n : null;
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Statement text of a card payment (money into a card that isn't a refund). */
const PAYMENT = /\b(payment|pymt|pmt|autopay|auto[- ]?pay|e-?pay|thank you|online transfer|transfer from)\b/i;

function looksLikeCardPayment(text) {
  return PAYMENT.test(String(text || ""));
}

/** A debt's balance from a SimpleFIN balance: what's owed is negative there. */
function debtBalance(balance, debtType) {
  const b = money(balance);
  if (b < 0) return -b;
  // A card with a credit owes nothing. Some banks report loans as positive amounts owed.
  return debtType === "credit_card" ? 0 : b;
}

/** The external_id a SimpleFIN transaction gets (unique per household with the account id). */
function transactionExternalId(accountId, txId) {
  return "sfin-" + accountId + "-" + txId;
}

/** Errors and warnings in an /accounts answer, as text for the person. Handles v1 `errors` and v2 `errlist`. */
function answerErrors(body) {
  const out = [];
  for (const e of (body && body.errlist) || []) {
    const msg = e && (e.msg || e.message);
    if (msg && out.indexOf(String(msg)) === -1) out.push(String(msg));
  }
  for (const e of (body && body.errors) || []) {
    const msg = typeof e === "string" ? e : e && (e.msg || e.message);
    if (msg && out.indexOf(String(msg)) === -1) out.push(String(msg));
  }
  return out;
}

/** The accounts in an /accounts answer, flattened: { id, name, org, currency, balance, available_balance, balance_date, transactions }. */
function readAccounts(body) {
  const orgs = {};
  for (const c of (body && body.connections) || []) {
    if (c && c.conn_id) orgs[c.conn_id] = c.org_name || c.name || "";
  }
  const out = [];
  for (const a of (body && body.accounts) || []) {
    if (!a || !a.id) continue;
    const org = (a.org && (a.org.name || a.org.domain)) || orgs[a.conn_id] || "";
    out.push({
      id: String(a.id),
      name: String(a.name || "Account"),
      org: String(org),
      currency: String(a.currency || "USD"),
      balance: money(a.balance),
      available_balance: a["available-balance"] === undefined ? null : money(a["available-balance"]),
      balance_date: a["balance-date"] ? dayOf(a["balance-date"]) : "",
      transactions: (a.transactions || []).filter((t) => t && t.id && !t.pending && Number(t.posted) > 0).map((t) => ({
        id: String(t.id),
        date: dayOf(t.transacted_at && Number(t.transacted_at) > 0 ? t.transacted_at : t.posted),
        amount: money(t.amount),
        payee: String(t.payee || t.description || "").trim().slice(0, 200),
        description: String(t.description || "").trim(),
        memo: String(t.memo || "").trim(),
      })),
    });
  }
  return out;
}

/**
 * What one pull adds, before it's saved. Accounts in use:
 *   { id, name, use: "spending" | "balance", asset, debt, debt_type, sync_from, transactions }
 * `known` says whether an external_id is already saved (a transaction, or a debt
 * payment, or a withdrawal already paired with a payment).
 *
 * Spending accounts:
 * - Money out is an expense, money in is income (a paycheck, or a refund).
 * - Money into a card that reads like a payment is a payment on the card, and the
 *   withdrawal that paid it (same amount, within 5 days, on another spending account)
 *   is the other side of it, not spending.
 * Balance-only accounts bring in no transactions.
 */
function planPull(accounts, known) {
  const isKnown = known || (() => false);
  const plan = { transactions: [], payments: [] };
  const outflows = [];
  for (const a of accounts) {
    if (a.use !== "spending" || (!a.asset && !a.debt)) continue;
    const from = a.sync_from ? String(a.sync_from).slice(0, 10) : "";
    for (const t of a.transactions || []) {
      if (from && t.date < from) continue;
      if (!t.amount) continue;
      const ext = transactionExternalId(a.id, t.id);
      if (isKnown(ext)) continue;
      const note = t.memo && t.memo !== t.payee ? t.memo : (t.description !== t.payee ? t.description : "");
      if (a.debt && t.amount > 0 && looksLikeCardPayment(t.payee + " " + t.description)) {
        plan.payments.push({ external_id: ext, debt: a.debt, date: t.date, amount: t.amount, note: t.payee, from_asset: "", from_external_id: "" });
        continue;
      }
      const tx = {
        external_id: ext, kind: t.amount < 0 ? "expense" : "income", date: t.date, amount: Math.abs(t.amount),
        payee: t.payee, note: note.slice(0, 2000), account: a.name,
        account_asset: a.asset || "", account_debt: a.asset ? "" : a.debt || "",
      };
      plan.transactions.push(tx);
      if (a.asset && t.amount < 0) outflows.push(tx);
    }
  }
  // Pair each new card payment with the withdrawal that paid it: closest date first.
  const used = new Set();
  for (const p of plan.payments) {
    let best = null;
    let bestDays = Infinity;
    for (const o of outflows) {
      if (used.has(o) || Math.round(o.amount * 100) !== Math.round(p.amount * 100)) continue;
      const days = daysApart(o.date, p.date);
      if (days <= PAIR_DAYS && days < bestDays) { best = o; bestDays = days; }
    }
    if (best) {
      used.add(best);
      p.from_asset = best.account_asset;
      p.from_external_id = best.external_id;
    }
  }
  plan.transactions = plan.transactions.filter((t) => !used.has(t));
  return plan;
}

/** Whether a payee is a paycheck from this employer ("ACME CORP PAYROLL" and "Acme Corp"). */
function fromEmployer(payee, employer) {
  const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const e = norm(employer).replace(/\b(INC|LLC|CORP|CORPORATION|CO|COMPANY|LTD)\b/g, "").replace(/\s+/g, " ").trim();
  if (e.length < 3) return false;
  return (" " + norm(payee) + " ").indexOf(" " + e + " ") !== -1;
}

module.exports = {
  PAIR_DAYS, MAX_WINDOW_DAYS, OVERLAP_DAYS,
  decodeBase64, encodeBase64, claimUrlFromToken, splitAccessUrl, checkAccessUrl,
  dayOf, epochOfDay, daysApart, windowStart, isDue, pickMinute, parseMinute,
  looksLikeCardPayment, debtBalance, transactionExternalId, answerErrors, readAccounts, planPull, fromEmployer,
};
