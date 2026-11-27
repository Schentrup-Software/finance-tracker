// A stand-in SimpleFIN Bridge for the API checks and the e2e walkthrough.
//
//   node testing/fixtures/simplefin-mock.cjs        # http://localhost:8091
//
// Setup tokens are base64 of http://localhost:8091/claim/<anything>; each works once.
// Its accounts: a checking account (a paycheck, groceries, and the payment to the card),
// a Visa (spending and that payment), savings and a mortgage. Dates are relative to today.
// GET /requests lists the /accounts queries it was sent, for checking the start date.

const http = require("node:http");

const PORT = Number(process.env.SIMPLEFIN_MOCK_PORT || 8091);
const USER = "demo";
const PASS = "s3cret";
const claimed = new Set();
const requests = [];

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const ago = (days) => now() - days * DAY;

function accounts() {
  return {
    errlist: [],
    connections: [{ conn_id: "CON-1", name: "Sunshine Bank", org_id: "ORG-1", sfin_url: "https://example.test/sfin" }],
    accounts: [
      {
        id: "ACT-CHK", conn_id: "CON-1", name: "Everyday Checking", currency: "USD",
        balance: "2450.10", "available-balance": "2450.10", "balance-date": ago(0),
        transactions: [
          { id: "T-PAY", posted: ago(6), amount: "2104.33", description: "ACME CORP PAYROLL", payee: "Acme Corp" },
          { id: "T-PUB", posted: ago(4), amount: "-87.12", description: "PUBLIX #1234", payee: "Publix" },
          { id: "T-CARDPAY", posted: ago(3), amount: "-400.00", description: "VISA ONLINE PAYMENT", payee: "Visa Payment" },
          { id: "T-PENDING", posted: 0, amount: "-5.00", description: "PENDING COFFEE", pending: true },
        ],
      },
      {
        id: "ACT-VISA", conn_id: "CON-1", name: "Sunshine Visa", currency: "USD",
        balance: "-612.40", "balance-date": ago(0),
        transactions: [
          { id: "V-SHELL", posted: ago(5), amount: "-45.50", description: "SHELL OIL 5555", payee: "Shell" },
          { id: "V-PAYMENT", posted: ago(2), amount: "400.00", description: "PAYMENT THANK YOU", payee: "Payment Thank You" },
          { id: "V-REFUND", posted: ago(1), amount: "12.00", description: "TARGET REFUND", payee: "Target" },
        ],
      },
      {
        id: "ACT-SAV", conn_id: "CON-1", name: "High Yield Savings", currency: "USD",
        balance: "10250.00", "balance-date": ago(0),
        transactions: [{ id: "S-INT", posted: ago(3), amount: "31.20", description: "INTEREST" }],
      },
      {
        id: "ACT-MTG", conn_id: "CON-1", name: "Home Mortgage", currency: "USD",
        balance: "-245000.00", "balance-date": ago(0), transactions: [],
      },
    ],
  };
}

function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type || "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "POST" && url.pathname.startsWith("/claim/")) {
    const token = url.pathname.slice(7);
    if (claimed.has(token)) return send(res, 403, "Forbidden", "text/plain");
    claimed.add(token);
    return send(res, 200, `http://${USER}:${PASS}@localhost:${PORT}/simplefin`, "text/plain");
  }
  if (req.method === "GET" && url.pathname === "/simplefin/accounts") {
    const want = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
    if (req.headers.authorization !== want) return send(res, 403, "Forbidden", "text/plain");
    requests.push(Object.fromEntries(url.searchParams));
    const body = accounts();
    if (url.searchParams.get("balances-only") === "1") for (const a of body.accounts) delete a.transactions;
    return send(res, 200, body);
  }
  if (url.pathname === "/requests") return send(res, 200, requests);
  if (url.pathname === "/token") {
    // A fresh setup token, for tests.
    return send(res, 200, Buffer.from(`http://localhost:${PORT}/claim/${Math.random().toString(36).slice(2)}`).toString("base64"), "text/plain");
  }
  send(res, 404, "Not found", "text/plain");
}).listen(PORT, () => console.log(`SimpleFIN mock on http://localhost:${PORT}`));
