import { test, expect, type Page } from "@playwright/test";

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

test("debts: snowball order, payments lower the balance", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /Debts/ }).click();

  async function addDebt(name: string, type: string, balance: string, apr: string, min: string) {
    await page.getByRole("button", { name: "Add debt" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Name").fill(name);
    await d.getByLabel("Type").selectOption(type);
    await d.getByLabel("Balance today").fill(balance);
    await d.getByLabel("APR %").fill(apr);
    await d.getByLabel("Minimum").fill(min);
    await d.getByRole("button", { name: "Add debt" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await addDebt("Car loan", "auto", "14200", "6.9", "380");
  await addDebt("Visa", "credit_card", "1850", "22.9", "55");
  await addDebt("Home mortgage", "mortgage", "245000", "3.25", "1650");

  const headings = page.locator("h3");
  await expect(headings.nth(0)).toHaveText("Visa");
  await expect(headings.nth(1)).toHaveText("Car loan");
  await expect(page.getByRole("heading", { name: "The house" })).toBeVisible();

  await page.getByRole("button", { name: "Make a payment" }).first().click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Payment").fill("350");
  await d.getByRole("button", { name: "Record payment" }).click();
  await expect(d.getByText("$1,500").first()).toBeVisible();
  await d.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Extra each month").fill("500");
  await expect(page.getByText(/Debt-free except the house by/)).toBeVisible();
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
