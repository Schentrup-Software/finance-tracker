import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const PAYSTUB_PDF = fileURLToPath(new URL("./fixtures/paystub.pdf", import.meta.url));

const EMAIL = "joey@example.test";
const PASSWORD = "envelopes123";
const SHOTS = process.env.SCREENSHOTS; // folder to save screenshots in, if set

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.describe.configure({ mode: "serial" });

test("first visit creates the account, then sign-up closes", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  await shot(page, "01-setup");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/budget/);

  const res = await request.get("http://localhost:8090/api/finance/setup");
  expect((await res.json()).signupOpen).toBe(false);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/budget/);
}

test("budget: start a month with starter envelopes, fund and spend", async ({ page }) => {
  await signIn(page);
  await page.getByLabel("Expected take-home pay").fill("5000");
  await page.getByRole("button", { name: "Start budget" }).click();
  await expect(page.getByRole("heading", { name: "Envelopes" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Groceries:/ })).toBeVisible();

  // Fund groceries with $600 and spend $120.45 from it.
  await page.getByRole("button", { name: /^Groceries:/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Put in for/).fill("600");
  await dialog.getByLabel(/Put in for/).press("Enter");
  await dialog.getByLabel("Amount").fill("120.45");
  await dialog.getByLabel("Where").fill("Publix");
  await dialog.getByRole("button", { name: "Take cash out" }).click();
  await expect(dialog.getByText("Publix")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  await expect(page.getByRole("button", { name: /^Groceries: \$479\.55 left of \$600/ })).toBeVisible();
  await expect(page.getByText("$4,400").first()).toBeVisible(); // left to budget

  await page.getByRole("button", { name: "Income", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Amount").fill("2500");
  await page.getByRole("dialog").getByLabel("From").fill("Paycheck");
  await page.getByRole("button", { name: "Add income" }).click();
  await expect(page.getByText("$2,500 received so far")).toBeVisible();
  await shot(page, "02-budget");
});

test("debts: each loan has its own payoff date, payments lower the balance", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /Debts/ }).click();

  async function addDebt(name: string, type: string, balance: string, apr: string, min: string) {
    await page.getByRole("button", { name: "Add debt" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Name").fill(name);
    await d.getByLabel("Type").selectOption(type);
    await d.getByLabel("Balance today").fill(balance);
    await d.getByLabel("APR %").fill(apr);
    await d.getByLabel("Monthly payment").fill(min);
    await d.getByRole("button", { name: "Add debt" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await addDebt("Car loan", "auto", "14200", "6.9", "380");
  await addDebt("Visa", "credit_card", "1850", "22.9", "55");
  await addDebt("Home mortgage", "mortgage", "245000", "3.25", "1650");

  await expect(page.getByRole("heading", { name: "The house" })).toBeVisible();
  await expect(page.getByText(/paid off \w+ \d{4}/).first()).toBeVisible();
  await expect(page.getByText(/snowball|debt-free/i)).toHaveCount(0);

  await page.locator("div.chunk", { has: page.getByRole("heading", { name: "Visa" }) })
    .getByRole("button", { name: "Record a payment" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Payment").fill("350");
  await d.getByRole("button", { name: "Record payment" }).click();
  await expect(d.getByText("$1,500").first()).toBeVisible();
  await d.getByRole("button", { name: "Close" }).click();
  await shot(page, "03-debts");
});

test("assets: link a mortgage to the house and see equity", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /Assets/ }).click();

  async function addAsset(name: string, type: string, value: string, link?: string) {
    await page.getByRole("button", { name: "Add asset" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Name").fill(name);
    await d.getByLabel("Type").selectOption(type);
    await d.getByLabel("Value", { exact: true }).fill(value);
    if (link) await d.getByRole("button", { name: new RegExp(link) }).click();
    await d.getByRole("button", { name: "Add asset" }).click();
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
  await addAsset("Our house", "real_estate", "385000", "Home mortgage");
  await addAsset("Honda Pilot", "vehicle", "21000", "Car loan");
  await addAsset("Fidelity 401(k)", "401k", "96500");
  await addAsset("Family HSA", "hsa", "7400");
  await addAsset("Emergency fund", "savings", "12000");
  await addAsset("Baseball cards", "collectible", "2300");

  await expect(page.getByText("$140,000")).toBeVisible(); // house equity
  // 524,200 assets - (1,500 + 14,200 + 245,000) debts
  await expect(page.getByText("$263,500").first()).toBeVisible();
  await shot(page, "04-assets");
});

test("paychecks: read a PDF paystub, then match the next paycheck to the cent", async ({ page }) => {
  await signIn(page);

  // A 401(k) loan that the paystub pays down.
  await page.getByRole("link", { name: /Debts/ }).click();
  await page.getByRole("button", { name: "Add debt" }).click();
  let d = page.getByRole("dialog");
  await d.getByLabel("Name").fill("401(k) loan");
  await d.getByLabel("Type").selectOption("401k_loan");
  await d.getByLabel("Balance today").fill("6000");
  await d.getByLabel("Monthly payment").fill("262.47");
  await d.getByRole("button", { name: "Add debt" }).click();
  await expect(page.getByRole("heading", { name: "Paid from your paycheck" })).toBeVisible();

  await page.getByRole("link", { name: /Budget/ }).click();
  await page.getByRole("button", { name: "Add an earner" }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Name").fill("Joey");
  await d.getByLabel("Employer").fill("Acme Widgets");
  await d.getByRole("button", { name: "Add earner" }).click();

  // A paycheck lands with no paystub on file: the app asks for one.
  await page.getByRole("button", { name: "Income", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Whose paycheck?").selectOption({ label: "Joey" });
  await d.getByLabel("Amount deposited").fill("2313.10");
  await d.getByLabel("Date").fill("2026-11-21");
  await d.getByRole("button", { name: "Add income" }).click();
  await expect(page.getByText(/Joey paycheck of \$2,313\.10 on Nov 21 is different/)).toBeVisible();

  await page.getByRole("button", { name: "Upload paystub" }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Paystub file").setInputFiles(PAYSTUB_PDF);
  await expect(d.getByText("Read from the paystub. Check it over, then save.")).toBeVisible();
  await expect(d.getByLabel("Gross pay")).toHaveValue("3500");
  await expect(d.getByText("✓ Gross minus everything above equals the take-home.")).toBeVisible();
  await expect(d.getByLabel("Pays down")).toHaveValue(/.+/); // linked to the only 401(k) loan
  await shot(page, "05-paystub-review");
  await d.getByRole("button", { name: "Save paystub" }).click();
  await expect(page.getByText(/is different/)).toHaveCount(0);
  await expect(page.getByText("Before it hits the bank")).toBeVisible();
  await expect(page.getByText("−$723.93")).toBeVisible(); // taxes
  await expect(page.getByText("−$166.83")).toBeVisible(); // medical + dental + vision

  // Next paycheck is a cent off: same taxes and deductions are assumed.
  await page.getByRole("button", { name: "Income", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Amount deposited").fill("2313.11");
  await d.getByLabel("Date").fill("2026-11-28");
  await d.getByRole("button", { name: "Add income" }).click();
  await expect(page.getByText(/is different/)).toHaveCount(0);
  await expect(page.getByText("Same as last")).toBeVisible();
  await expect(page.getByText("−$1,447.86")).toBeVisible(); // two paychecks of taxes
  await shot(page, "06-paychecks");

  // Both paychecks' 401(k) loan lines paid down the loan.
  await page.getByRole("link", { name: /Debts/ }).click();
  await expect(page.getByText("$5,757.72")).toBeVisible();
  await expect(page.getByText("From paycheck")).toBeVisible();
});
