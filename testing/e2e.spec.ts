import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const PAYSTUB_PDF = fileURLToPath(new URL("./fixtures/paystub.pdf", import.meta.url));
const HISTORY_CSV = fileURLToPath(new URL("./fixtures/history.csv", import.meta.url));

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
  await page.getByRole("tab", { name: /Income/ }).click();
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
  await page.getByRole("tab", { name: /Income/ }).click();
  await page.getByRole("button", { name: "Add an earner" }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Name").fill("Joey");
  await d.getByLabel("Employer").fill("Acme Widgets");
  await d.getByRole("button", { name: "Add earner" }).click();

  // A paycheck lands with no paystub on file: the app asks for one.
  await page.getByRole("button", { name: "Income", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Whose paycheck?").selectOption({ label: "Joey" });
  await d.getByLabel("Amount deposited").fill("2363.10");
  await d.getByLabel("Date").fill("2026-11-21");
  await d.getByRole("button", { name: "Add income" }).click();
  await expect(page.getByText(/Joey paycheck of \$2,363\.10 on Nov 21 is different/)).toBeVisible();

  await page.getByRole("button", { name: "Upload paystub" }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Paystub file").setInputFiles(PAYSTUB_PDF);
  await expect(d.getByText("Read from the paystub. Check it over, then save.")).toBeVisible();
  await expect(d.getByLabel("Gross pay")).toHaveValue("3500");
  await expect(d.getByText("✓ Gross minus everything above equals the take-home.")).toBeVisible();
  await expect(d.getByLabel("Pays down")).toHaveValue(/.+/); // linked to the only 401(k) loan
  // Employer contributions are read into their own section, outside the take-home check.
  await expect(d.getByText("Paid by your employer")).toBeVisible();
  await expect(d.getByText("+$341.34")).toBeVisible();
  // The health insurance offset is paid on top of take-home, so the bank got the check amount.
  await expect(d.getByLabel("Reimbursement", { exact: true })).toHaveValue("Health Insurance Offset");
  await expect(d.getByText("$2,363.10")).toBeVisible();
  await d.getByRole("button", { name: "Add an employer contribution" }).scrollIntoViewIfNeeded();
  if (process.env.SCREENSHOTS) await d.screenshot({ path: `${process.env.SCREENSHOTS}/05b-employer-contributions.png` });
  await shot(page, "05-paystub-review");
  await d.getByRole("button", { name: "Save paystub" }).click();
  await expect(page.getByText(/is different/)).toHaveCount(0);
  await expect(page.getByText("Before it hits the bank")).toBeVisible();
  await expect(page.getByText("−$723.93")).toBeVisible(); // taxes
  await expect(page.getByText("−$166.83")).toBeVisible(); // medical + dental + vision
  await expect(page.getByText("+$341.34")).toBeVisible(); // paid by the employer

  // Next paycheck is a cent off: same taxes and deductions are assumed.
  await page.getByRole("button", { name: "Income", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Amount deposited").fill("2363.11");
  await d.getByLabel("Date").fill("2026-11-28");
  await d.getByRole("button", { name: "Add income" }).click();
  await expect(page.getByText(/is different/)).toHaveCount(0);
  await expect(page.getByText("Same as last")).toBeVisible();
  await expect(page.getByText("−$1,447.86")).toBeVisible(); // two paychecks of taxes
  await shot(page, "06-paychecks");

  // The year view lists each line on its own, e.g. federal income tax so far.
  await page.getByRole("tab", { name: /so far/ }).click();
  await expect(page.getByText("Federal income tax")).toBeVisible();
  await shot(page, "07-year-so-far");

  // Both paychecks' 401(k) loan lines paid down the loan.
  await page.getByRole("link", { name: /Debts/ }).click();
  await expect(page.getByText("$5,757.72")).toBeVisible();
  await expect(page.getByText("From paycheck")).toBeVisible();
});

test("import history from a spreadsheet, with annual envelopes", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: /Import history from a spreadsheet/ }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("History file").setInputFiles(HISTORY_CSV);
  await expect(d.getByText(/^11 transactions/)).toBeVisible();
  await expect(d.getByText(/2 account transfers and card payments skipped/)).toBeVisible();
  await expect(d.getByText("already in the app", { exact: false })).toBeVisible(); // Groceries

  await d.getByRole("radiogroup", { name: "Extra type", exact: true }).getByRole("radio", { name: "Annual" }).click();
  await d.getByRole("radiogroup", { name: "Christmas type", exact: true }).getByRole("radio", { name: "Annual" }).click();
  await d.getByLabel("Christmas yearly goal", { exact: true }).fill("3600");
  await d.getByLabel("Christmas balance", { exact: true }).fill("4210");
  // Typed key by key, like a person: the box keeps focus between keys.
  const extra = d.getByLabel("Extra balance", { exact: true });
  await extra.click();
  await extra.pressSequentially("573.74");
  await expect(extra).toHaveValue("573.74");
  await expect(extra).toBeFocused();
  await d.getByLabel("Vacation monthly amount", { exact: true }).fill("500");
  await d.getByLabel("Vacation balance", { exact: true }).fill("391.04");
  await shot(page, "08-import-preview");
  await d.getByRole("button", { name: "Import 11 transactions" }).click();
  await expect(d.getByText(/Imported 11 transactions/)).toBeVisible();
  await d.getByRole("button", { name: "Done" }).click();

  // The month view shows the Annual section with the balances entered.
  const annual = page.getByRole("region", { name: "Annual" });
  await expect(annual.getByRole("button", { name: /Christmas: \$4,210 left of \$3,600/ })).toBeVisible();
  await expect(annual.getByRole("button", { name: /Extra: \$573\.74 left/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Monthly" }).getByRole("button", { name: /Vacation: \$391\.04 left/ })).toBeVisible();
  await expect(page.getByText("Delta Air Lines")).toBeVisible();
  await shot(page, "09-annual-envelopes");

  // Envelopes can be put in any order, and the order is saved.
  const monthlyRegion = page.getByRole("region", { name: "Monthly" });
  const names = () => monthlyRegion.getByRole("button", { name: /^[^:]+: \$/ }).evaluateAll(
    (els) => els.map((el) => el.getAttribute("aria-label")!.split(":")[0]));
  const before = await names();
  await page.getByRole("button", { name: "Reorder" }).click();
  await monthlyRegion.getByRole("button", { name: `Move ${before[1]} up` }).click();
  await expect.poll(names).toEqual([before[1], before[0], ...before.slice(2)]);
  // Dragging the third one to the top.
  const handle = monthlyRegion.getByRole("button", { name: `Drag ${before[2]}` });
  await monthlyRegion.scrollIntoViewIfNeeded();
  const top = (await monthlyRegion.getByRole("button", { name: `Drag ${before[1]}` }).boundingBox())!;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, top.y - 10, { steps: 12 });
  await page.mouse.up();
  const reordered = [before[2], before[1], before[0], ...before.slice(3)];
  await expect.poll(names).toEqual(reordered);
  await page.getByRole("button", { name: "Done" }).click();
  await shot(page, "10-reordered");
  await page.reload();
  await expect.poll(names).toEqual(reordered);

  // Before the import's balances, a month shows what each envelope spent.
  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(page.getByRole("button", { name: /Groceries: \$160 spent/ })).toBeVisible();
});

test("household: the head adds a person, who shares the same budget", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Household" }).click();
  await expect(page.getByText("Head of household")).toBeVisible();
  await page.getByRole("button", { name: "Add a person" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Name").fill("Brie");
  await d.getByLabel("Email").fill("brie@example.test");
  await d.getByLabel("Password").fill("sharedbudget1");
  await d.getByRole("button", { name: "Add to household" }).click();
  await expect(page.getByText("brie@example.test")).toBeVisible();
  await shot(page, "10-household");

  // Brie signs in and sees the same envelopes; what she adds, Joey sees.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Email").fill("brie@example.test");
  await page.getByLabel("Password").fill("sharedbudget1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/budget/);
  await expect(page.getByRole("button", { name: /Christmas: \$4,210/ })).toBeVisible();
  await page.getByRole("button", { name: "Spend", exact: true }).click();
  const s = page.getByRole("dialog");
  await s.getByLabel("From envelope").selectOption({ label: "🥕 Groceries" });
  await s.getByLabel("Amount").fill("12.34");
  await s.getByLabel("Where").fill("Farmers market");
  await s.getByRole("button", { name: "Spend" }).click();
  await page.getByRole("button", { name: "Household" }).click();
  await expect(page.getByRole("button", { name: "Add a person" })).toHaveCount(0); // only the head adds people

  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page);
  await expect(page.getByText("Farmers market")).toBeVisible();

  // The head removes Brie; the household's data stays.
  await page.getByRole("button", { name: "Household" }).click();
  page.once("dialog", (dlg) => dlg.accept());
  await page.getByRole("button", { name: "Remove Brie" }).click();
  await expect(page.getByText("brie@example.test")).toHaveCount(0);
});

test("vendors and taxes: a recurring gift from Bills is matched, tagged and acknowledged", async ({ page }) => {
  await signIn(page);

  async function spend(envelope: string, amount: string, where: string, date?: string) {
    await page.getByRole("button", { name: "Spend", exact: true }).click();
    const s = page.getByRole("dialog");
    await s.getByLabel("From envelope").selectOption({ label: envelope });
    await s.getByLabel("Amount").fill(amount);
    if (date) await s.getByLabel("Date").fill(date);
    await s.getByLabel("Where").fill(where);
    await s.getByRole("button", { name: "Spend" }).click();
    await expect(s).toHaveCount(0);
  }

  // A gift paid from the bills envelope, as the bank writes it.
  await spend("💡 Utilities", "300", "PAYPAL *STMARYSCHURCH 402-555-0100");
  const row = page.getByRole("button", { name: /PAYPAL \*STMARYSCHURCH 402-555-0100/ });
  await expect(row.getByText("who is this?")).toBeVisible();

  // Teach it once: a new vendor, matched on the statement text from now on.
  await row.click();
  let d = page.getByRole("dialog");
  await d.getByLabel("Vendor").selectOption({ label: "+ New vendor…" });
  await d.getByLabel("New vendor's name").fill("St. Mary's Church");
  await expect(d.getByText("Always match “PAYPAL *STMARYSCHURCH” to St. Mary's Church")).toBeVisible();
  await shot(page, "11-transaction-details");
  await d.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: /St\. Mary's Church/ })).toBeVisible();

  // On the Vendors view, mark the church as a charity.
  await page.getByRole("tab", { name: /Vendors/ }).click();
  await page.getByRole("button", { name: /St\. Mary's Church: \$300/ }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Tax").selectOption({ label: "🎁 Donations" });
  await d.getByLabel("EIN").fill("12-3456789");
  await d.getByRole("button", { name: "Save" }).click();
  await expect(d).toHaveCount(0);

  // Statement text with no vendor yet: teach it from the "Who is this?" list.
  await page.getByRole("button", { name: "Who is PUBLIX?" }).click();
  d = page.getByRole("dialog");
  await expect(d.getByLabel("Vendor name")).toHaveValue("Publix");
  await d.getByRole("button", { name: /^Match \d+ payments?$/ }).click();
  await expect(page.getByRole("button", { name: /^Publix: / })).toBeVisible();
  await shot(page, "12-vendors");

  // Next month's gift is matched and tagged on its own; it's $250+, so it needs a receipt.
  await page.getByRole("tab", { name: /Envelopes/ }).click();
  await spend("💡 Utilities", "300", "PayPal *StMarysChurch 402-555-0177");
  const gift = page.getByRole("button", { name: /St\. Mary's Church.*needs receipt/ });
  await expect(gift).toHaveCount(2);

  // The Taxes view totals the gifts and asks for the acknowledgment.
  await page.getByRole("tab", { name: /Taxes/ }).click();
  const giving = page.getByRole("region", { name: /Donations/ });
  await expect(giving.getByText("$600.00").first()).toBeVisible();
  await expect(page.getByText(/2 gift\(s\) of \$250 or more need/)).toBeVisible();
  await giving.getByLabel("Year-end statement from St. Mary's Church").setInputFiles(PAYSTUB_PDF);
  await expect(giving.getByText("✓ Year-end statement")).toBeVisible();
  await expect(page.getByText(/gift\(s\) of \$250 or more need/)).toHaveCount(0);

  // AGI sets the 0.5% floor.
  await page.getByRole("button", { name: "Edit AGI and figures" }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Adjusted gross income (AGI)").fill("100000");
  await d.getByRole("button", { name: "Save" }).click();
  await expect(giving.getByText("$100.00")).toBeVisible(); // 600 given - 500 floor
  await shot(page, "13-taxes");
});

test("API tokens: make one, use it, revoke it", async ({ page, request }) => {
  await signIn(page);
  await page.getByRole("button", { name: "API tokens" }).click();
  await expect(page.getByText("No tokens yet")).toBeVisible();
  await page.getByRole("button", { name: "New token" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Name").pressSequentially("n8n");
  await d.getByRole("button", { name: "Make token" }).click();

  // Shown once, then only its first characters.
  const shown = page.getByRole("dialog", { name: "Your new token" });
  const token = await shown.getByLabel("Token").inputValue();
  expect(token).toMatch(/^ft_[A-Za-z0-9]{40}$/);
  await shot(page, "14-new-token");
  await shown.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(token.slice(0, 7) + "…")).toBeVisible();
  await expect(page.getByText("Never used")).toBeVisible();

  // It works against the API like a signed-in member.
  const res = await request.post("http://localhost:8090/api/sync/envelopes", {
    headers: { Authorization: token },
    data: { records: [{ external_id: "from-n8n", name: "Made by n8n" }] },
  });
  expect((await res.json()).created).toBe(1);
  await page.reload();
  await expect(page.getByText(/Used today/)).toBeVisible();
  await shot(page, "15-api-tokens");

  page.once("dialog", (dlg) => dlg.accept());
  await page.getByRole("button", { name: "Revoke n8n" }).click();
  await expect(page.getByText("No tokens yet")).toBeVisible();
  const after = await request.get("http://localhost:8090/api/collections/envelopes/records", { headers: { Authorization: token } });
  expect(after.status()).toBe(401);
});
