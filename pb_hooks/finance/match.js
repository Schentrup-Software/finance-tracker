// Matching a transaction's statement value (its `payee`) to a vendor.
//
// Plain ES5 so PocketBase's runtime can require() it. app/lib/vendors.ts has the
// same functions for the browser; testing/unit/vendors.test.ts runs both on the
// same cases so they stay in step.

/** Upper case, one space between words. */
function cleanStatement(s) {
  return String(s == null ? "" : s).toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * The stable start of a statement value: trailing words with digits in them
 * (reference numbers, phone numbers, dates, store numbers) are dropped, so every
 * month's charge from the same place reads the same.
 *   "PayPal *StMarysChurch 402-555-0100" -> "PAYPAL *STMARYSCHURCH"
 */
function normalizeStatement(s) {
  const words = cleanStatement(s).split(" ").filter(function (w) { return w !== ""; });
  while (words.length > 1 && /\d/.test(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/** Whether a statement value starts with the pattern, at a word boundary. */
function matchesPattern(statement, pattern) {
  const s = cleanStatement(statement);
  const p = cleanStatement(pattern);
  if (!p || s.indexOf(p) !== 0) return false;
  if (s.length === p.length) return true;
  return !/[A-Z0-9]/.test(s.charAt(p.length)) || !/[A-Z0-9]/.test(p.charAt(p.length - 1));
}

/**
 * The vendor whose longest pattern fits the statement value, or null.
 * vendors: [{ id, matches: [pattern, ...] }]
 */
function matchVendor(statement, vendors) {
  let best = null;
  let bestLength = 0;
  for (let i = 0; i < vendors.length; i++) {
    const v = vendors[i];
    const patterns = Array.isArray(v.matches) ? v.matches : [];
    for (let j = 0; j < patterns.length; j++) {
      const p = cleanStatement(patterns[j]);
      if (p.length > bestLength && matchesPattern(statement, p)) {
        best = v;
        bestLength = p.length;
      }
    }
  }
  return best;
}

module.exports = { cleanStatement: cleanStatement, normalizeStatement: normalizeStatement, matchesPattern: matchesPattern, matchVendor: matchVendor };
