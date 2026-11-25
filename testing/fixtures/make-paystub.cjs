// Renders testing/fixtures/paystub.pdf: a sample paystub in a common payroll layout.
// Run: node testing/fixtures/make-paystub.cjs  (uses the Playwright Chromium)
const path = require("path");
const { chromium } = require("playwright");

const html = `<!doctype html><html><body style="font-family:Arial;font-size:12px;padding:30px">
<h2>Acme Widgets Inc — Earnings Statement</h2>
<table style="width:60%">
<tr><td>Employee</td><td>Joey Example</td></tr>
<tr><td>Period Beginning:</td><td>11/01/2026</td></tr>
<tr><td>Period Ending:</td><td>11/14/2026</td></tr>
<tr><td>Pay Date:</td><td>11/21/2026</td></tr></table>
<h3>Earnings</h3>
<table style="width:100%"><tr><th align=left>Earnings</th><th>rate</th><th>hours</th><th>this period</th><th>year to date</th></tr>
<tr><td>Regular</td><td align=right>43.7500</td><td align=right>80.00</td><td align=right>3,500.00</td><td align=right>77,000.00</td></tr>
<tr><td><b>Gross Pay</b></td><td></td><td></td><td align=right>$3,500.00</td><td align=right>77,000.00</td></tr></table>
<h3>Deductions</h3>
<table style="width:100%"><tr><th align=left>Statutory</th><th>this period</th><th>year to date</th></tr>
<tr><td>Federal Income Tax</td><td align=right>-312.45</td><td align=right>6,873.90</td></tr>
<tr><td>Social Security Tax</td><td align=right>-207.70</td><td align=right>4,569.40</td></tr>
<tr><td>Medicare Tax</td><td align=right>-48.58</td><td align=right>1,068.76</td></tr>
<tr><td>GA State Income Tax</td><td align=right>-155.20</td><td align=right>3,414.40</td></tr>
<tr><td>Medical</td><td align=right>-142.31</td><td align=right>3,130.82</td></tr>
<tr><td>Dental</td><td align=right>-18.40</td><td align=right>404.80</td></tr>
<tr><td>Vision</td><td align=right>-6.12</td><td align=right>134.64</td></tr>
<tr><td>401K</td><td align=right>-175.00</td><td align=right>3,850.00</td></tr>
<tr><td>401K Loan 1</td><td align=right>-121.14</td><td align=right>2,665.08</td></tr></table>
<h3><span>Net Pay</span> <span style="margin-left:200px">$2,313.10</span></h3>
<h3>Employer Contributions</h3>
<table style="width:100%"><tr><th align=left>Description</th><th>this period</th><th>year to date</th></tr>
<tr><td>Employee Medical Insurance</td><td align=right>236.34</td><td align=right>4,955.06</td></tr>
<tr><td>Traditional 401(k)</td><td align=right>105.00</td><td align=right>2,310.00</td></tr></table>
<h3>Summary</h3>
<table style="width:100%"><tr><th align=left>Description</th><th>this period</th><th>year to date</th></tr>
<tr><td>Net Pay</td><td align=right>2,313.10</td><td align=right>50,888.20</td></tr>
<tr><td>Total Reimbursements</td><td align=right>50.00</td><td align=right>1,100.00</td></tr>
<tr><td>Health Insurance Offset</td><td align=right>50.00</td><td align=right>1,000.00</td></tr>
<tr><td>Travel Stipend</td><td align=right>0.00</td><td align=right>100.00</td></tr>
<tr><td>Check Amount</td><td align=right>2,363.10</td><td align=right>51,988.20</td></tr></table>
</body></html>`;

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: path.join(__dirname, "paystub.pdf"), format: "Letter" });
  await browser.close();
})();
