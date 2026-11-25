import { describe, expect, it } from "vitest";
import type { Envelope, TaxDocument, Transaction, Vendor } from "~/backend/types";
import {
  agiEstimate, deductibleAmount, effectiveCategory, maskTin, rowsToCsv, settingsFor, taxRows, taxYearOf, yearReport,
} from "~/lib/tax";
import { crc32, makeZip } from "~/lib/zip";

const base = { owner: "u", created: "", updated: "" };
let n = 0;
const tx = (extra: Partial<Transaction> = {}): Transaction => ({
  ...base, id: `t${++n}`, kind: "expense", envelope: "", earner: "", paystub_status: "", date: "2027-03-01 12:00:00.000Z",
  amount: 100, payee: "", note: "", account: "", external_id: "", vendor: "", vendor_locked: false, tax_category: "",
  tax_amount: 0, tax_paid_by: "", tax_year: 0, tax_person: "", tax_acknowledged: false, ...extra,
});
const vendor = (id: string, extra: Partial<Vendor> = {}): Vendor => ({
  ...base, id, name: id, emoji: "", color: "", matches: [], default_envelope: "", recurring: "", expected_amount: 0,
  expected_day: 0, tax_category: "", legal_name: "", address: "", tin: "", notes: "", archived: false, external_id: "", ...extra,
});
const envelope = (id: string, extra: Partial<Envelope> = {}): Envelope => ({
  ...base, id, name: id, group: "", color: "", emoji: "", default_amount: 0, rollover: false, sort: 0, archived: false,
  period: "", goal: 0, opening_balance: 0, opening_date: "", tax_category: "", external_id: "", ...extra,
});
const doc = (extra: Partial<TaxDocument>): TaxDocument => ({
  ...base, id: `d${++n}`, file: "f.pdf", tax_year: 2027, kind: "receipt", label: "", transaction: "", vendor: "", ...extra,
});

describe("which transactions count", () => {
  it("takes the transaction's category, else the vendor's, else the envelope's", () => {
    const church = vendor("church", { tax_category: "charity" });
    const medEnv = envelope("med", { tax_category: "medical" });
    expect(effectiveCategory(tx(), church, medEnv)).toBe("charity");
    expect(effectiveCategory(tx(), null, medEnv)).toBe("medical");
    expect(effectiveCategory(tx({ tax_category: "child_care" }), church, medEnv)).toBe("child_care");
    expect(effectiveCategory(tx({ tax_category: "none" }), church, medEnv)).toBeNull();
    expect(effectiveCategory(tx(), null, null)).toBeNull();
  });

  it("uses the deductible part when set, and money back counts against the total", () => {
    expect(deductibleAmount(tx({ amount: 80 }))).toBe(80);
    expect(deductibleAmount(tx({ amount: 80, tax_amount: 30 }))).toBe(30);
    expect(deductibleAmount(tx({ amount: 80, tax_amount: 300 }))).toBe(80);
    expect(deductibleAmount(tx({ amount: 25, kind: "income" }))).toBe(-25);
  });

  it("an IRA contribution in April can count for the year before", () => {
    expect(taxYearOf(tx({ date: "2028-04-10 12:00:00.000Z" }))).toBe(2028);
    expect(taxYearOf(tx({ date: "2028-04-10 12:00:00.000Z", tax_year: 2027 }))).toBe(2027);
  });
});

describe("the year-end summary", () => {
  const church = vendor("church", { tax_category: "charity" });
  const daycare = vendor("daycare", { tax_category: "child_care", address: "1 Main St" });
  const vendors = new Map([church, daycare].map((v) => [v.id, v]));
  const envelopes = new Map([envelope("med", { tax_category: "medical" })].map((e) => [e.id, e]));

  const gifts = Array.from({ length: 12 }, (_, i) =>
    tx({ vendor: "church", amount: 200, date: `2027-${String(i + 1).padStart(2, "0")}-01 12:00:00.000Z` }));
  const bigGift = tx({ vendor: "church", amount: 1000, date: "2027-12-20 12:00:00.000Z" });
  const otherYear = tx({ vendor: "church", amount: 999, date: "2026-12-31 12:00:00.000Z" });
  const doctor = tx({ envelope: "med", amount: 9000 });
  const hsaPaid = tx({ envelope: "med", amount: 400, tax_paid_by: "hsa" });
  const refund = tx({ envelope: "med", amount: 500, kind: "income" });
  const care = tx({ vendor: "daycare", amount: 8000 });
  const ira = tx({ tax_category: "ira", amount: 8000, tax_person: "Joey", date: "2028-04-01 12:00:00.000Z", tax_year: 2027 });
  const paycheck = tx({ kind: "income", earner: "joey", envelope: "med", amount: 3000 });
  const all = [...gifts, bigGift, otherYear, doctor, hsaPaid, refund, care, ira, paycheck];

  const settings = { ...settingsFor(2027), agi: 100000, other_itemized: 20000, qualifying_children: 1 };

  it("2027 copies the 2026 figures until someone confirms them", () => {
    const s = settingsFor(2027);
    expect(s.confirmed).toBe(false);
    expect(s.charity_floor_pct).toBe(0.5);
    expect(settingsFor(2026).confirmed).toBe(true);
  });

  it("applies the 0.5% charity floor and flags gifts of $250+ without an acknowledgment", () => {
    const r = yearReport(taxRows(all, vendors, envelopes, [], 2027), settings);
    expect(r.charity.total).toBe(3400);
    expect(r.charity.floor).toBe(500);
    expect(r.charity.deductible).toBe(2900);
    expect(r.charity.rows.filter((x) => x.needsAck).map((x) => x.tx.id)).toEqual([bigGift.id]);
    expect(r.todo.map((t) => t.key)).toContain("ack");
  });

  it("a charity's year-end statement clears every gift that year", () => {
    const docs = [doc({ vendor: "church", kind: "year_end_statement", tax_year: 2027 })];
    const r = yearReport(taxRows(all, vendors, envelopes, docs, 2027), settings);
    expect(r.charity.rows.some((x) => x.needsAck)).toBe(false);
    const lastYear = [doc({ vendor: "church", kind: "year_end_statement", tax_year: 2026 })];
    expect(yearReport(taxRows(all, vendors, envelopes, lastYear, 2027), settings).charity.rows.some((x) => x.needsAck)).toBe(true);
  });

  it("applies the 7.5% medical floor, leaving out HSA-paid and refunded costs", () => {
    const m = yearReport(taxRows(all, vendors, envelopes, [], 2027), settings).medical;
    expect(m.total).toBe(8500);
    expect(m.excluded).toBe(400);
    expect(m.floor).toBe(7500);
    expect(m.deductible).toBe(1000);
  });

  it("caps child care for Form 2441 and asks for the provider's TIN", () => {
    const r = yearReport(taxRows(all, vendors, envelopes, [], 2027), settings);
    expect(r.childCare.total).toBe(8000);
    expect(r.childCare.qualifying).toBe(3000);
    expect(r.todo.find((t) => t.key === "tin")?.text).toContain("daycare");
    expect(yearReport(taxRows(all, vendors, envelopes, [], 2027), { ...settings, qualifying_children: 2 }).childCare.qualifying).toBe(6000);
  });

  it("totals IRA contributions per person for the tax year they count for", () => {
    const r = yearReport(taxRows(all, vendors, envelopes, [], 2027), settings);
    expect(r.ira.people).toEqual([{ person: "Joey", total: 8000, over: true }]);
    expect(r.ira.phaseout).toBe("below");
    expect(yearReport([], { ...settings, agi: 140000 }).ira.phaseout).toBe("in");
  });

  it("compares itemizing with the standard deduction plus the non-itemizer gift deduction", () => {
    const r = yearReport(taxRows(all, vendors, envelopes, [], 2027), settings);
    expect(r.itemized).toBe(2900 + 1000 + 20000);
    expect(r.standard).toBe(32200 + 2000);
    expect(r.difference).toBe(23900 - 34200);
  });

  it("asks for AGI before applying floors", () => {
    const r = yearReport(taxRows(all, vendors, envelopes, [], 2027), { ...settings, agi: 0 });
    expect(r.todo[0].key).toBe("agi");
    expect(r.charity.deductible).toBe(3400);
  });

  it("exports the rows as CSV", () => {
    const csv = rowsToCsv(taxRows([bigGift, ira], vendors, envelopes, [], 2027), envelopes);
    expect(csv.split("\n")[0]).toMatch(/^Date,Category,Vendor/);
    expect(csv).toContain("2027-12-20,Donations,church");
    expect(csv).toContain("Traditional IRA");
  });
});

describe("helpers", () => {
  it("estimates AGI from paystubs: gross minus pre-tax lines", () => {
    const stubs = [{ id: "a", gross: 3500 }, { id: "b", gross: 3500 }];
    const lines = [
      { paystub: "a", category: "401k" as const, amount: 300 }, { paystub: "a", category: "federal_tax" as const, amount: 400 },
      { paystub: "b", category: "medical" as const, amount: 100 }, { paystub: "x", category: "401k" as const, amount: 999 },
      // An employer contribution isn't part of gross pay, so it doesn't lower AGI.
      { paystub: "a", category: "401k" as const, amount: 191.67, employer_paid: true },
    ];
    expect(agiEstimate(stubs, lines)).toBe(6600);
  });

  it("masks a TIN", () => {
    expect(maskTin("12-3456789")).toBe("•••••6789");
  });

  it("writes a ZIP the standard way", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    const zip = makeZip([{ name: "a.txt", data: new TextEncoder().encode("hi") }, { name: "a.txt", data: new Uint8Array([1]) }]);
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new TextDecoder().decode(zip)).toContain("a (2).txt");
  });
});
