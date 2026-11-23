import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteTaxDocument, errorMessage, getTaxYear, listEnvelopes, listTaxDocuments, listTransactionsBetween, listVendors,
  loadYearPaystubs, saveTaxYear, subscribeAll, taxDocumentUrl, uploadTaxDocument,
} from "~/backend/api";
import type { Color, Envelope, TaxCategory, TaxDocument, TaxYear, Transaction, Vendor } from "~/backend/types";
import {
  Button, Card, EmptyState, ErrorNote, FormActions, Icon, Modal, MoneyInput, RoundButton, SectionTitle, Stat, TextInput,
  Toggle, cx,
} from "~/components/ui";
import { DOC_KIND_LABELS, TaxBadge, TransactionDetails, vendorLabel } from "~/components/TransactionDetails";
import { shortDate } from "~/lib/dates";
import { money, parseMoney } from "~/lib/money";
import {
  PAID_BY_LABELS, TAX_CATEGORY_EMOJI, TAX_CATEGORY_LABELS, agiEstimate, maskTin, rowsToCsv, settingsFor, taxRows,
  yearReport, type ByWhom, type TaxReport, type TaxRow, type TaxSettings,
} from "~/lib/tax";
import { makeZip } from "~/lib/zip";

interface YearData {
  saved: TaxYear | null;
  txs: Transaction[];
  vendors: Vendor[];
  envelopes: Envelope[];
  docs: TaxDocument[];
  estimate: number;
}

/**
 * Deductible spending for a tax year: donations, medical, child care and IRA
 * contributions, with the floors and limits applied and what's still missing.
 */
export function TaxesView({ initialYear }: { initialYear: number }) {
  const [year, setYear] = useState(initialYear);
  const [data, setData] = useState<YearData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Transaction | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // IRA contributions made until the April deadline can count for this year.
      const [saved, txs, vendors, envelopes, docs, stubs] = await Promise.all([
        getTaxYear(year), listTransactionsBetween(`${year}-01-01`, `${year + 1}-05-01`), listVendors(), listEnvelopes(),
        listTaxDocuments(year), loadYearPaystubs(year),
      ]);
      setData({ saved, txs, vendors, envelopes, docs, estimate: agiEstimate(stubs.paystubs, stubs.lines) });
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [year]);

  useEffect(() => { setData(null); reload(); }, [reload]);
  useEffect(() => subscribeAll(["transactions", "vendors", "envelopes", "tax_documents", "tax_years"], reload), [reload]);

  const vendorById = useMemo(() => new Map((data?.vendors ?? []).map((v) => [v.id, v])), [data]);
  const envelopeById = useMemo(() => new Map((data?.envelopes ?? []).map((e) => [e.id, e])), [data]);
  const settings = useMemo(() => settingsFor(year, data?.saved), [year, data]);
  const rows = useMemo(() => (data ? taxRows(data.txs, vendorById, envelopeById, data.docs, year) : []), [data, vendorById, envelopeById, year]);
  const report = useMemo(() => yearReport(rows, settings), [rows, settings]);

  async function uploadStatement(vendor: Vendor, file: File | undefined) {
    if (!file) return;
    try {
      await uploadTaxDocument(file, { vendor: vendor.id, kind: "year_end_statement", tax_year: year, label: file.name });
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeDoc(d: TaxDocument) {
    try {
      await deleteTaxDocument(d.id);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function download(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadDocs() {
    if (!data?.docs.length) return;
    setBusy("Collecting documents…");
    try {
      const entries = [];
      for (const d of data.docs) {
        const res = await fetch(await taxDocumentUrl(d));
        const tx = data.txs.find((t) => t.id === d.transaction);
        const who = vendorById.get(d.vendor)?.name ?? tx?.payee ?? "document";
        const ext = d.file.split(".").pop();
        const base = (d.label || d.file).replace(/\.[^.]*$/, "");
        entries.push({ name: `${who} - ${d.kind ? DOC_KIND_LABELS[d.kind] : "Document"} - ${base}.${ext}`, data: new Uint8Array(await res.arrayBuffer()) });
      }
      download(`tax-documents-${year}.zip`, new Blob([makeZip(entries)], { type: "application/zip" }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Taxes">
      <div className="mt-6 flex items-center justify-center gap-4">
        <RoundButton label="Previous tax year" icon="left" onClick={() => setYear(year - 1)} />
        <h2 className="min-w-[10ch] text-center text-2xl font-black sm:text-3xl">Taxes {year}</h2>
        <RoundButton label="Next tax year" icon="right" onClick={() => setYear(year + 1)} />
      </div>
      <div className="mt-4"><ErrorNote message={error} /></div>

      {!data ? (
        <div className="py-20 text-center text-5xl"><span className="bob inline-block">🧾</span></div>
      ) : (
        <>
          <Summary report={report} onEdit={() => setEditing(true)} />

          {report.todo.length > 0 && (
            <Card color="butter" className="pop-in mt-6 p-5" aria-label="To do">
              <div className="mb-2 font-black">To do before filing</div>
              <ul className="space-y-1 text-sm font-bold">
                {report.todo.map((t) => (
                  <li key={t.key} className="flex gap-2"><span aria-hidden="true">•</span>
                    {t.key === "agi" || t.key === "figures" || t.key === "children"
                      ? <button className="text-left underline" onClick={() => setEditing(true)}>{t.text}</button>
                      : <span>{t.text}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {rows.length === 0 ? (
            <div className="mt-8">
              <EmptyState emoji="🧾" title={`Nothing tagged for ${year} yet`}>
                Give a vendor or an envelope a tax category (Donations, Medical, Child care or IRA) and its spending shows up here.
              </EmptyState>
            </div>
          ) : (
            <>
              <CategorySection category="charity" color="pink" title="Donations"
                lines={[
                  ["Given", report.charity.total],
                  [`Floor: ${settings.charity_floor_pct}% of AGI`, -report.charity.floor],
                  ["Deductible", report.charity.deductible],
                ]}
                groups={report.charity.byVendor} rows={report.charity.rows} onOpen={setDetails}
                extra={(g) => g.vendor && (
                  <StatementCell vendor={g.vendor} docs={data.docs} onUpload={uploadStatement} onRemove={removeDoc} />
                )} />

              <CategorySection category="medical" color="aqua" title="Medical and dental"
                lines={[
                  ["Paid out of pocket", report.medical.total],
                  [`Floor: ${settings.medical_floor_pct}% of AGI`, -report.medical.floor],
                  ["Deductible", report.medical.deductible],
                ]}
                note={report.medical.excluded > 0 ? `${money(report.medical.excluded, { cents: true })} paid by an HSA, FSA or insurance is left out.` : undefined}
                groups={report.medical.byVendor} rows={report.medical.rows} onOpen={setDetails} />

              <CategorySection category="child_care" color="peach" title="Child care (Form 2441)"
                lines={[
                  ["Paid", report.childCare.total],
                  [`Cap for ${settings.qualifying_children || "no"} child${settings.qualifying_children === 1 ? "" : "ren"}`, report.childCare.cap],
                  ["Qualifying expenses", report.childCare.qualifying],
                ]}
                groups={report.childCare.byVendor} rows={report.childCare.rows} onOpen={setDetails}
                extra={(g) => g.vendor && (
                  <span className="text-xs font-bold opacity-75">
                    {g.vendor.legal_name || g.vendor.name}{g.vendor.address && <> · {g.vendor.address}</>}
                    {g.vendor.tin ? <> · TIN {maskTin(g.vendor.tin)}</> : <span className="pill c-coral ml-1">no TIN</span>}
                  </span>
                )} />

              <CategorySection category="ira" color="mint" title="Traditional IRA"
                lines={[
                  ...report.ira.people.map((p) => [`${p.person || "Unnamed"}${p.over ? " (over the limit)" : ""}`, p.total] as [string, number]),
                  [`Limit each (${money(settings.ira_limit + settings.ira_catch_up)} at 50+)`, settings.ira_limit],
                ]}
                note={{
                  below: undefined, unknown: "Enter AGI to see whether the deduction phases out.",
                  in: `AGI is inside the ${money(settings.ira_phaseout_start)} to ${money(settings.ira_phaseout_end)} phase-out range, so only part may be deductible.`,
                  above: `AGI is above ${money(settings.ira_phaseout_end)}: a spouse covered at work likely can't deduct it.`,
                }[report.ira.phaseout]}
                groups={[]} rows={report.ira.rows} onOpen={setDetails} />

              <div className="mt-8 flex flex-wrap justify-end gap-2">
                <Button small color="white" onClick={() => download(`tax-${year}.csv`, new Blob([rowsToCsv(rows, envelopeById)], { type: "text/csv" }))}>
                  Download CSV
                </Button>
                <Button small color="white" disabled={!data.docs.length || !!busy} onClick={downloadDocs}>
                  {busy ?? `Download documents (${data.docs.length})`}
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {data && (
        <TaxYearForm open={editing} year={year} saved={data.saved} settings={settings} estimate={data.estimate}
          onClose={() => setEditing(false)} onSaved={reload} />
      )}
      {data && (
        <TransactionDetails tx={details} envelopes={data.envelopes} vendors={data.vendors}
          onClose={() => setDetails(null)} onChanged={reload} />
      )}
    </section>
  );
}

function Summary({ report, onEdit }: { report: TaxReport; onEdit: () => void }) {
  const s = report.settings;
  const itemize = report.difference > 0;
  return (
    <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-3">
      <Card color="sky" className="pop-in chunk-press p-6" style={{ ["--i" as any]: 0 }} onClick={onEdit}
        role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onEdit()} aria-label="Edit AGI and figures">
        <Stat label="AGI" value={s.agi ? money(s.agi) : "Not set"}
          hint={<>Floors are a share of this <Icon name="edit" className="ml-1 h-4 w-4 align-[-2px]" /></>} />
      </Card>
      <Card color="lilac" className="pop-in p-6" style={{ ["--i" as any]: 1 }}>
        <Stat label="Itemized" value={money(report.itemized)}
          hint={`${money(report.charity.deductible + report.medical.deductible)} from the budget + ${money(s.other_itemized)} other`} />
      </Card>
      <Card color={itemize ? "mint" : "butter"} className="pop-in p-6" style={{ ["--i" as any]: 2 }}>
        <Stat label={itemize ? "Itemizing saves" : "Standard is bigger by"} value={money(Math.abs(report.difference))}
          hint={`Standard ${money(s.standard_deduction)}${report.charity.nonitemizer ? ` + ${money(report.charity.nonitemizer)} of gifts` : ""}`} />
      </Card>
    </div>
  );
}

const SECTION_ID = (c: TaxCategory) => `tax-${c}`;

function CategorySection({ category, color, title, lines, note, groups, rows, onOpen, extra }: {
  category: TaxCategory; color: Color; title: string; lines: [string, number][]; note?: string;
  groups: ByWhom[]; rows: TaxRow[]; onOpen: (t: Transaction) => void; extra?: (g: ByWhom) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={SECTION_ID(category)}>
      <SectionTitle>
        <span id={SECTION_ID(category)}><span aria-hidden="true">{TAX_CATEGORY_EMOJI[category]}</span> {title}</span>
      </SectionTitle>
      <Card color={color} className="p-5">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {lines.map(([label, value], i) => (
            <div key={label} className="rounded-2xl bg-white/70 px-4 py-3">
              <dt className="text-xs font-extrabold uppercase opacity-70">{label}</dt>
              <dd className={cx("num text-xl font-black", i === lines.length - 1 && "text-2xl")}>
                {value < 0 ? "−" : ""}{money(Math.abs(value), { cents: true })}
              </dd>
            </div>
          ))}
        </dl>
        {note && <p className="mt-3 text-sm font-bold opacity-80">{note}</p>}
        {groups.length > 0 && (
          <ul className="mt-4 space-y-2">
            {groups.map((g) => (
              <li key={g.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-white/70 px-4 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-extrabold">{g.vendor ? vendorLabel(g.vendor) : "No vendor"}</span>
                  {extra?.(g)}
                </span>
                <span className="text-xs font-bold opacity-70">{g.count}×</span>
                <span className="num font-black">{money(g.total, { cents: true })}</span>
              </li>
            ))}
          </ul>
        )}
        <button className="btn-ghost mt-3 text-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : "Show"} {rows.length} payment{rows.length === 1 ? "" : "s"}
          {rows.some((r) => r.needsAck) && <span className="pill c-coral">{rows.filter((r) => r.needsAck).length} need a receipt</span>}
        </button>
        {(open || rows.some((r) => r.needsAck)) && (
          <ul className="mt-2 space-y-1">
            {rows.filter((r) => open || r.needsAck).map((r) => (
              <li key={r.tx.id}>
                <button type="button" onClick={() => onOpen(r.tx)}
                  className={cx("flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-sm hover:bg-white",
                    r.excluded ? "bg-white/40 opacity-60" : "bg-white/70")}>
                  <span className="w-16 font-extrabold opacity-70">{shortDate(r.tx.date)}</span>
                  <span className="min-w-0 flex-1 truncate font-bold">
                    {r.vendor?.name ?? r.tx.payee ?? "Payment"}
                    {r.tx.tax_person && <> · {r.tx.tax_person}</>}
                    {r.excluded && <> · paid by {PAID_BY_LABELS[r.excluded]}</>}
                    {r.tx.tax_amount > 0 && <> · {money(r.tx.amount, { cents: true })} paid</>}
                    {r.needsAck && <TaxBadge category={r.category} warn />}
                  </span>
                  <span className="num font-black">{r.amount < 0 ? "−" : ""}{money(Math.abs(r.excluded ? r.tx.amount : r.amount), { cents: true })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function StatementCell({ vendor, docs, onUpload, onRemove }: {
  vendor: Vendor; docs: TaxDocument[]; onUpload: (v: Vendor, f: File | undefined) => void; onRemove: (d: TaxDocument) => void;
}) {
  const mine = docs.filter((d) => d.vendor === vendor.id && d.kind === "year_end_statement");
  if (mine.length) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs font-bold">
        {mine.map((d) => (
          <span key={d.id} className="pill c-mint">
            <button type="button" className="underline" onClick={async () => window.open(await taxDocumentUrl(d), "_blank", "noopener")}>
              ✓ Year-end statement
            </button>
            <button type="button" aria-label="Remove year-end statement" onClick={() => onRemove(d)}>×</button>
          </span>
        ))}
      </span>
    );
  }
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 text-xs font-extrabold underline opacity-80 hover:opacity-100">
      <Icon name="plus" className="h-3 w-3" /> Year-end statement
      <input type="file" className="sr-only" accept="application/pdf,image/*" aria-label={`Year-end statement from ${vendor.name}`}
        onChange={(e) => { onUpload(vendor, e.target.files?.[0]); e.target.value = ""; }} />
    </label>
  );
}

// ---------- AGI and the year's figures ----------

const FIGURES: { key: keyof TaxSettings; label: string; pct?: boolean; count?: boolean }[] = [
  { key: "standard_deduction", label: "Standard deduction" },
  { key: "charity_floor_pct", label: "Charity floor (% of AGI)", pct: true },
  { key: "charity_cash_cap_pct", label: "Cash gift cap (% of AGI)", pct: true },
  { key: "nonitemizer_charity_cap", label: "Gift deduction without itemizing" },
  { key: "medical_floor_pct", label: "Medical floor (% of AGI)", pct: true },
  { key: "care_cap_one", label: "Child care cap, one child" },
  { key: "care_cap_two", label: "Child care cap, two or more" },
  { key: "ira_limit", label: "IRA limit per person" },
  { key: "ira_catch_up", label: "IRA catch-up at 50+" },
  { key: "ira_phaseout_start", label: "IRA phase-out starts (covered at work)" },
  { key: "ira_phaseout_end", label: "IRA phase-out ends" },
];

function TaxYearForm({ open, year, saved, settings, estimate, onClose, onSaved }: {
  open: boolean; year: number; saved: TaxYear | null; settings: TaxSettings; estimate: number; onClose: () => void; onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const v: Record<string, string> = {};
    for (const k of ["agi", "other_itemized", "qualifying_children", ...FIGURES.map((f) => f.key)] as (keyof TaxSettings)[]) {
      v[k] = settings[k] ? String(settings[k]) : "";
    }
    setValues(v);
    setConfirmed(settings.confirmed);
    setError(null);
    // Only when the form opens: a reload while it's open must not wipe what's being typed.
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const data: Record<string, number | boolean> = { year, confirmed };
    for (const [k, v] of Object.entries(values)) data[k] = k === "qualifying_children" ? Math.max(0, Math.round(Number(v) || 0)) : parseMoney(v);
    try {
      await saveTaxYear(saved, data);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={`Tax year ${year}`} onClose={onClose} color="sky">
      <form onSubmit={save} className="space-y-4">
        <MoneyInput label="Adjusted gross income (AGI)" value={values.agi ?? ""} onChange={set("agi")}
          hint={estimate ? `About ${money(estimate)} from this year's paystubs (gross minus pre-tax deductions). Use the return's number once you have it.` : "From the return, or your best guess until then."} />
        {estimate > 0 && !values.agi && (
          <button type="button" className="btn-ghost -mt-2 text-sm" onClick={() => setValues((v) => ({ ...v, agi: String(estimate) }))}>
            Use {money(estimate)} for now
          </button>
        )}
        <MoneyInput label="Other itemized deductions" value={values.other_itemized ?? ""} onChange={set("other_itemized")}
          hint="Mortgage interest, state and property taxes and the like, reconciled at year end." />
        <TextInput label="Children the child care was for" type="number" min={0} max={20} value={values.qualifying_children ?? ""}
          onChange={set("qualifying_children")} />

        <div className="tray space-y-3 p-4">
          <div className="font-black">IRS figures for {year}</div>
          {!settings.confirmed && !saved?.confirmed && (
            <p className="text-sm font-bold opacity-80">These were copied from an earlier year. Check them against the IRS, then tick the box below.</p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FIGURES.map((f) => f.pct ? (
              <TextInput key={f.key} label={f.label} type="number" step="0.01" min={0} value={values[f.key] ?? ""} onChange={set(f.key)} />
            ) : (
              <MoneyInput key={f.key} label={f.label} value={values[f.key] ?? ""} onChange={set(f.key)} />
            ))}
          </div>
          <Toggle label="These figures are checked" checked={confirmed} onChange={setConfirmed} />
        </div>
        <ErrorNote message={error} />
        <FormActions saving={busy} color="sky" />
      </form>
    </Modal>
  );
}
