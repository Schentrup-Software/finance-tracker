import { useEffect, useMemo, useState } from "react";
import {
  backfillVendor, createVendor, deleteTaxDocument, deleteTransaction, errorMessage, fromPbDate, listTransactionDocuments,
  taxDocumentUrl, toPbDate, updateTransaction, updateVendor, uploadTaxDocument,
} from "~/backend/api";
import {
  TAX_CATEGORIES, TAX_PAID_BY, type Envelope, type TaxCategory, type TaxDocument, type TaxDocumentKind, type TaxPaidBy,
  type Transaction, type Vendor,
} from "~/backend/types";
import { ErrorNote, FormActions, Icon, Modal, MoneyInput, Select, TextInput, Toggle, cx } from "~/components/ui";
import { money, parseMoney } from "~/lib/money";
import {
  ACK_THRESHOLD, PAID_BY_LABELS, TAX_CATEGORY_EMOJI, TAX_CATEGORY_LABELS, categorySource, effectiveCategory, taxYearOf,
} from "~/lib/tax";
import { matchesPattern, normalizeStatement, suggestVendorName } from "~/lib/vendors";

export const vendorLabel = (v: Pick<Vendor, "emoji" | "name">) => `${v.emoji ? v.emoji + " " : ""}${v.name}`;

export const DOC_KIND_LABELS: Record<TaxDocumentKind, string> = {
  receipt: "Receipt", acknowledgment: "Acknowledgment letter", year_end_statement: "Year-end statement", other: "Other",
};

const NEW = "__new__";

/**
 * Edits one transaction: what it was, who it went to (its vendor), and whether
 * it counts at tax time, with its receipts.
 */
export function TransactionDetails({ tx, envelopes, vendors, onClose, onChanged }: {
  tx: Transaction | null; envelopes: Envelope[]; vendors: Vendor[]; onClose: () => void; onChanged: () => void;
}) {
  const [vendor, setVendor] = useState("");
  const [newVendor, setNewVendor] = useState("");
  const [teach, setTeach] = useState(true);
  const [envelope, setEnvelope] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [payee, setPayee] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState<Transaction["tax_category"]>("");
  const [taxAmount, setTaxAmount] = useState("");
  const [paidBy, setPaidBy] = useState<TaxPaidBy | "">("");
  const [taxYear, setTaxYear] = useState(0);
  const [person, setPerson] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [docs, setDocs] = useState<TaxDocument[]>([]);
  const [docKind, setDocKind] = useState<TaxDocumentKind>("receipt");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!tx) return;
    setVendor(tx.vendor);
    setNewVendor(suggestVendorName(tx.payee));
    setTeach(true);
    setEnvelope(tx.envelope);
    setAmount(String(tx.amount));
    setDate(fromPbDate(tx.date));
    setPayee(tx.payee);
    setNote(tx.note);
    setCategory(tx.tax_category);
    setTaxAmount(tx.tax_amount ? String(tx.tax_amount) : "");
    setPaidBy(tx.tax_paid_by);
    setTaxYear(tx.tax_year);
    setPerson(tx.tax_person);
    setAcknowledged(tx.tax_acknowledged);
    setError(null);
    setDocs([]);
    listTransactionDocuments(tx.id).then(setDocs).catch(() => setDocs([]));
  }, [tx]);

  const vendorById = useMemo(() => new Map(vendors.map((v) => [v.id, v])), [vendors]);
  const envelopeById = useMemo(() => new Map(envelopes.map((e) => [e.id, e])), [envelopes]);
  if (!tx) return null;

  const picked = vendor && vendor !== NEW ? vendorById.get(vendor) ?? null : null;
  const pickedEnvelope = envelopeById.get(envelope) ?? null;
  const draft = { tax_category: category };
  const auto = effectiveCategory({ tax_category: "" }, picked, pickedEnvelope);
  const effective = effectiveCategory(draft, picked, pickedEnvelope);
  const source = categorySource({ tax_category: "" }, picked, pickedEnvelope);
  const pattern = normalizeStatement(payee);
  const known = !!picked && (picked.matches ?? []).some((m) => matchesPattern(payee, m));
  const income = tx.kind === "income";
  const year = Number(date.slice(0, 4)) || taxYearOf(tx);
  const deductible = taxAmount ? Math.min(parseMoney(taxAmount), parseMoney(amount)) : parseMoney(amount);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const v = parseMoney(amount);
    if (v <= 0) return setError("Enter an amount.");
    setBusy(true);
    setError(null);
    try {
      let vendorId = vendor;
      let locked = tx!.vendor_locked;
      let learn = false;
      if (vendor === NEW) {
        if (!newVendor.trim()) throw new Error("Give the new vendor a name.");
        const created = await createVendor({ name: newVendor.trim(), matches: pattern && teach ? [pattern] : [] });
        vendorId = created.id;
        learn = !!pattern && teach;
        locked = !learn;
      } else if (vendor !== tx!.vendor || payee !== tx!.payee) {
        // Picked by hand, unless it's taught to match this statement text from now on.
        learn = !!picked && !!pattern && teach && !known;
        locked = !!vendor && !learn && !known;
        if (learn) await updateVendor(picked!.id, { matches: [...(picked!.matches ?? []), pattern] });
      }
      await updateTransaction(tx!.id, {
        vendor: vendorId === NEW ? "" : vendorId, vendor_locked: locked,
        envelope, amount: v, date: toPbDate(date), payee: payee.trim(), note: note.trim(),
        tax_category: category, tax_amount: effective ? parseMoney(taxAmount) : 0,
        tax_paid_by: effective === "medical" ? paidBy : "",
        tax_year: effective === "ira" ? taxYear : 0,
        tax_person: effective === "ira" ? person.trim() : "",
        tax_acknowledged: effective === "charity" ? acknowledged : false,
      });
      if (learn && vendorId) await backfillVendor(vendorId);
      onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await deleteTransaction(tx!.id);
      onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function attach(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const d = await uploadTaxDocument(file, {
        transaction: tx!.id, vendor: picked?.id ?? "", kind: docKind, tax_year: taxYear || year, label: file.name,
      });
      setDocs((ds) => [...ds, d]);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function open(d: TaxDocument) {
    window.open(await taxDocumentUrl(d), "_blank", "noopener");
  }

  const categoryOptions = [
    { value: "", label: auto ? `Automatic: ${TAX_CATEGORY_LABELS[auto]} (from the ${source})` : "Automatic: not deductible" },
    ...TAX_CATEGORIES.map((c) => ({ value: c, label: `${TAX_CATEGORY_EMOJI[c]} ${TAX_CATEGORY_LABELS[c]}` })),
    { value: "none", label: "Not deductible" },
  ];

  return (
    <Modal open title={income ? "Money in" : "Spending"} onClose={onClose} color={income ? "butter" : "white"}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <MoneyInput label="Amount" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <TextInput label="Date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <TextInput label="Statement text" value={payee} onChange={(e) => setPayee(e.target.value)}
          hint={tx.account ? `From ${tx.account}` : "What the bank statement says. Vendors are matched on it."} />
        {!tx.earner && (
          <Select label="Envelope" value={envelope} onChange={(e) => setEnvelope(e.target.value)}
            options={[{ value: "", label: income ? "None: income for the month" : "No envelope" },
              ...envelopes.filter((e) => !e.archived || e.id === tx.envelope).map((e) => ({ value: e.id, label: `${e.emoji ? e.emoji + " " : ""}${e.name}` }))]} />
        )}

        <div className="tray space-y-3 p-4">
          <Select label="Vendor" value={vendor} onChange={(e) => setVendor(e.target.value)}
            hint={vendor && vendor === tx.vendor && !tx.vendor_locked ? "Matched from the statement text." : undefined}
            options={[{ value: "", label: "No vendor" }, ...vendors.filter((v) => !v.archived || v.id === tx.vendor)
              .map((v) => ({ value: v.id, label: vendorLabel(v) })), { value: NEW, label: "+ New vendor…" }]} />
          {vendor === NEW && (
            <TextInput label="New vendor's name" value={newVendor} onChange={(e) => setNewVendor(e.target.value)} required />
          )}
          {pattern && (vendor === NEW || (picked && !known && (vendor !== tx.vendor || payee !== tx.payee))) && (
            <Toggle label={`Always match “${pattern}” to ${vendor === NEW ? newVendor || "this vendor" : picked!.name}`}
              checked={teach} onChange={setTeach}
              hint="Earlier and future payments with this statement text get this vendor, wherever they're paid from." />
          )}
        </div>

        {!tx.earner && (
          <div className={cx("tray space-y-3 p-4", effective && `c-${effective === "charity" ? "pink" : effective === "medical" ? "aqua" : effective === "ira" ? "mint" : "peach"}`)}
            style={effective ? { background: "color-mix(in srgb, var(--c) 45%, white)" } : undefined}>
            <Select label="Tax" value={category} onChange={(e) => setCategory(e.target.value as Transaction["tax_category"])}
              options={categoryOptions} />
            {effective && (
              <>
                <MoneyInput label="Deductible part" value={taxAmount} placeholder={money(parseMoney(amount), { cents: true }).slice(1)}
                  onChange={(e) => setTaxAmount(e.target.value)}
                  hint={effective === "charity" ? "Leave empty if all of it counts. A dinner or gift you got back doesn't." : "Leave empty if all of it counts."} />
                {effective === "medical" && (
                  <Select label="Paid or paid back by" value={paidBy} onChange={(e) => setPaidBy(e.target.value as TaxPaidBy)}
                    hint="Anything an HSA, FSA or insurance paid for doesn't count."
                    options={[{ value: "", label: "Us, out of pocket" }, ...TAX_PAID_BY.map((p) => ({ value: p, label: PAID_BY_LABELS[p] }))]} />
                )}
                {effective === "ira" && (
                  <div className="grid grid-cols-2 gap-3">
                    <TextInput label="Whose IRA" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Joey" />
                    <Select label="Counts for" value={String(taxYear || year)} onChange={(e) => setTaxYear(Number(e.target.value) === year ? 0 : Number(e.target.value))}
                      hint="Contributions until the April deadline can count for the year before."
                      options={[{ value: String(year), label: String(year) }, { value: String(year - 1), label: String(year - 1) }]} />
                  </div>
                )}
                {effective === "charity" && !income && (
                  <Toggle label="We have the charity's written acknowledgment" checked={acknowledged} onChange={setAcknowledged}
                    hint={deductible >= ACK_THRESHOLD
                      ? `Needed for a gift of ${money(ACK_THRESHOLD)} or more. Attaching it below, or the charity's year-end statement, also counts.`
                      : `Only needed for a single gift of ${money(ACK_THRESHOLD)} or more.`} />
                )}
              </>
            )}
            {(effective || docs.length > 0) && (
              <div>
                <div className="field-label">Receipts</div>
                {docs.length > 0 && (
                  <ul className="mb-2 space-y-1">
                    {docs.map((d) => (
                      <li key={d.id} className="flex items-center gap-2 rounded-2xl bg-white/80 px-3 py-2 text-sm font-bold">
                        <button type="button" className="min-w-0 flex-1 truncate text-left underline" onClick={() => open(d)}>
                          {d.label || "Document"}
                        </button>
                        <span className="opacity-60">{d.kind ? DOC_KIND_LABELS[d.kind] : ""}</span>
                        <button type="button" aria-label={`Remove ${d.label || "document"}`} className="opacity-50 hover:opacity-100"
                          onClick={async () => { await deleteTaxDocument(d.id).catch((err) => setError(errorMessage(err))); setDocs((ds) => ds.filter((x) => x.id !== d.id)); onChanged(); }}>
                          <Icon name="trash" className="h-4 w-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label="Kind of document" className="input w-auto py-2 text-sm" value={docKind}
                    onChange={(e) => setDocKind(e.target.value as TaxDocumentKind)}>
                    {(["receipt", "acknowledgment", "other"] as const).map((k) => <option key={k} value={k}>{DOC_KIND_LABELS[k]}</option>)}
                  </select>
                  <label className="btn-ghost cursor-pointer text-sm">
                    <Icon name="plus" className="h-4 w-4" /> Attach a file
                    <input type="file" className="sr-only" aria-label="Attach a receipt" accept="application/pdf,image/*"
                      onChange={(e) => { attach(e.target.files?.[0]); e.target.value = ""; }} />
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        <TextInput label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorNote message={error} />
        <FormActions saving={busy} onDelete={remove} deleteLabel="Delete" color={income ? "butter" : "mint"} />
      </form>
    </Modal>
  );
}

/** A small tax badge for a transaction row. */
export function TaxBadge({ category, warn }: { category: TaxCategory | null; warn?: boolean }) {
  if (!category) return null;
  return (
    <span className={cx("pill ml-2", warn ? "c-coral" : "c-white")} title={warn ? "Needs the charity's acknowledgment" : TAX_CATEGORY_LABELS[category]}>
      {TAX_CATEGORY_EMOJI[category]} {warn ? "needs receipt" : TAX_CATEGORY_LABELS[category]}
    </span>
  );
}

