import { useCallback, useEffect, useMemo, useState } from "react";
import {
  backfillVendor, createVendor, deleteVendor, errorMessage, listEnvelopes, listTransactionsBetween, listUnmatched,
  listVendorTransactions, listVendors, mergeVendor, subscribeAll, updateVendor, type UnmatchedStatement,
} from "~/backend/api";
import {
  CADENCES, TAX_CATEGORIES, type Cadence, type Color, type Envelope, type TaxCategory, type Transaction, type Vendor,
} from "~/backend/types";
import {
  Button, ColorPicker, EmptyState, ErrorNote, FormActions, Icon, Modal, MoneyInput, SectionTitle, Select, TextArea,
  TextInput, Toggle, cx,
} from "~/components/ui";
import { TransactionDetails, vendorLabel } from "~/components/TransactionDetails";
import { monthLabel, nextMonth, shortDate, todayISO } from "~/lib/dates";
import { money, parseMoney } from "~/lib/money";
import { TAX_CATEGORY_EMOJI, TAX_CATEGORY_LABELS, maskTin } from "~/lib/tax";
import {
  CADENCE_LABELS, cleanStatement, guessRecurring, monthlyCost, recurringState, spendingByVendor,
  suggestVendorName, type RecurringState,
} from "~/lib/vendors";

type Period = "month" | "year" | "12m";

function periodRange(period: Period, month: string) {
  const y = Number(month.slice(0, 4));
  if (period === "month") {
    return { from: `${month}-01`, to: `${nextMonth(month)}-01`, label: monthLabel(month), before: `${monthLabel(nextMonth(month, -12))}` };
  }
  if (period === "year") return { from: `${y}-01-01`, to: `${y + 1}-01-01`, label: String(y), before: String(y - 1) };
  const start = nextMonth(month, -11);
  return { from: `${start}-01`, to: `${nextMonth(month)}-01`, label: `${monthLabel(start)} to ${monthLabel(month)}`, before: "the 12 months before" };
}

const yearEarlier = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return todayISO(d);
}

/**
 * Who the money goes to: spending by vendor, recurring payments (and ones that
 * were missed or changed), and statement text that isn't matched to a vendor yet.
 */
export function VendorsView({ month }: { month: string }) {
  const [period, setPeriod] = useState<Period>("month");
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [unmatched, setUnmatched] = useState<UnmatchedStatement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Vendor | "new" | null>(null);
  const [learning, setLearning] = useState<UnmatchedStatement | null>(null);
  const [showAll, setShowAll] = useState(false);

  const range = periodRange(period, month);
  const today = todayISO();

  const reload = useCallback(async () => {
    try {
      const [v, e, t, r, u] = await Promise.all([
        listVendors(), listEnvelopes(), listTransactionsBetween(yearEarlier(range.from), range.to),
        listTransactionsBetween(daysAgo(400), daysAgo(-1)), listUnmatched(),
      ]);
      setVendors(v);
      setEnvelopes(e);
      setTxs(t);
      setRecent(r);
      setUnmatched(u);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [range.from, range.to]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => subscribeAll(["vendors", "transactions"], reload), [reload]);

  const vendorById = useMemo(() => new Map(vendors.map((v) => [v.id, v])), [vendors]);
  const envelopeById = useMemo(() => new Map(envelopes.map((e) => [e.id, e])), [envelopes]);

  const spending = useMemo(() => {
    if (!txs) return [];
    const inRange = txs.filter((t) => t.date.slice(0, 10) >= range.from);
    const before = txs.filter((t) => t.date.slice(0, 10) < yearEarlier(range.to));
    return spendingByVendor(inRange, before);
  }, [txs, range.from, range.to]);

  const byVendor = useMemo(() => {
    const m = new Map<string, Transaction[]>();
    for (const t of recent) if (t.vendor) (m.get(t.vendor) ?? m.set(t.vendor, []).get(t.vendor)!).push(t);
    return m;
  }, [recent]);

  const recurring = vendors.filter((v) => v.recurring && !v.archived)
    .map((v) => ({ v, state: recurringState(v, byVendor.get(v.id) ?? [], today) }))
    .sort((a, b) => (a.state.next || "9").localeCompare(b.state.next || "9"));
  const suggestions = vendors.filter((v) => !v.recurring && !v.archived)
    .map((v) => ({ v, guess: guessRecurring(byVendor.get(v.id) ?? []) }))
    .filter((x) => x.guess);
  const perMonth = recurring.reduce((s, { v }) => s + monthlyCost(v.recurring as Cadence, v.expected_amount), 0);

  async function markRecurring(v: Vendor, g: NonNullable<ReturnType<typeof guessRecurring>>) {
    try {
      await updateVendor(v.id, { recurring: g.cadence, expected_amount: g.amount, expected_day: g.day });
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!txs) return <div className="mt-6"><ErrorNote message={error} /></div>;
  const shown = showAll ? spending : spending.slice(0, 25);
  const total = spending.reduce((s, r) => s + r.total, 0);

  return (
    <section aria-label="Vendors">
      <div className="mt-6"><ErrorNote message={error} /></div>

      <SectionTitle action={
        <Button small color="white" onClick={() => setEditing("new")}><Icon name="plus" className="h-5 w-5" /> Vendor</Button>
      }>Recurring</SectionTitle>
      {recurring.length === 0 && suggestions.length === 0 ? (
        <EmptyState emoji="🔁" title="No recurring payments yet">
          Once a vendor has been paid three times on a schedule, it shows up here to mark as recurring.
        </EmptyState>
      ) : (
        <div className="tray p-3 sm:p-4">
          {recurring.length > 0 && (
            <p className="px-2 pb-2 text-sm font-bold opacity-80">About {money(perMonth)} a month in recurring payments.</p>
          )}
          <ul className="divide-y-2 divide-[rgba(106,93,123,.08)]">
            {recurring.map(({ v, state }) => (
              <RecurringRow key={v.id} v={v} state={state} onOpen={() => setEditing(v)} />
            ))}
            {suggestions.map(({ v, guess }) => (
              <li key={v.id} className="flex flex-wrap items-center gap-3 px-2 py-3">
                <VendorDot v={v} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-extrabold">{v.name}</span>
                  <span className="block text-xs font-bold opacity-70">
                    Looks recurring: about {money(guess!.amount, { cents: true })} {CADENCE_LABELS[guess!.cadence].toLowerCase()}
                  </span>
                </span>
                <Button small color="sky" onClick={() => markRecurring(v, guess!)}>Mark as recurring</Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <SectionTitle action={
        <div className="inline-flex rounded-full bg-[rgba(106,93,123,.08)] p-1 text-sm font-black" role="tablist" aria-label="Period">
          {([["month", "Month"], ["year", "Year"], ["12m", "12 months"]] as const).map(([p, label]) => (
            <button key={p} type="button" role="tab" aria-selected={period === p} onClick={() => setPeriod(p)}
              className={cx("rounded-full px-4 py-2", period === p && "bg-white shadow")}>{label}</button>
          ))}
        </div>
      }>Where the money goes</SectionTitle>
      <p className="-mt-2 mb-3 px-1 text-sm font-bold opacity-75">
        {range.label}: {money(total)} spent. Compared with {range.before}.
      </p>
      {spending.length === 0 ? (
        <EmptyState emoji="🧾" title="Nothing spent in this period" />
      ) : (
        <div className="tray p-3 sm:p-4">
          <ul className="divide-y-2 divide-[rgba(106,93,123,.08)]">
            {shown.map((r) => {
              const v = vendorById.get(r.vendor);
              const change = r.total - r.before;
              return (
                <li key={r.vendor || "none"}>
                  <button type="button" disabled={!v} onClick={() => v && setEditing(v)}
                    className="flex w-full items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-white/60 disabled:hover:bg-transparent"
                    aria-label={`${v ? v.name : "No vendor yet"}: ${money(r.total, { cents: true })}`}>
                    {v ? <VendorDot v={v} /> : <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-white/70 text-lg" aria-hidden="true">❔</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-extrabold">
                        {v ? v.name : "No vendor yet"}
                        {v?.tax_category && <span className="ml-2" title={TAX_CATEGORY_LABELS[v.tax_category]}>{TAX_CATEGORY_EMOJI[v.tax_category]}</span>}
                      </span>
                      <span className="block truncate text-xs font-bold opacity-70">
                        {r.count} payment{r.count === 1 ? "" : "s"}
                        {r.envelopes.length > 0 && <> · {r.envelopes.map((id) => envelopeById.get(id)?.name ?? "").filter(Boolean).join(", ")}</>}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="num block font-black">{money(r.total, { cents: true })}</span>
                      {r.before > 0 && Math.abs(change) >= 0.01 && (
                        <span className={cx("num block text-xs font-extrabold", change > 0 ? "text-[#c45c5c]" : "text-[#4c9a63]")}>
                          {change > 0 ? "+" : "−"}{money(Math.abs(change))} vs {money(r.before)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {spending.length > shown.length && (
            <button className="btn-ghost mt-2 text-sm" onClick={() => setShowAll(true)}>Show all {spending.length}</button>
          )}
        </div>
      )}

      {unmatched.length > 0 && (
        <>
          <SectionTitle>Who is this?</SectionTitle>
          <p className="-mt-2 mb-3 px-1 text-sm font-bold opacity-75">
            Statement text that isn't matched to a vendor yet. Teach it once and every payment with that text is matched.
          </p>
          <div className="tray p-3 sm:p-4">
            <ul className="divide-y-2 divide-[rgba(106,93,123,.08)]">
              {unmatched.slice(0, 30).map((u) => (
                <li key={u.pattern} className="flex flex-wrap items-center gap-3 px-2 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm font-bold">{u.example}</span>
                    <span className="block text-xs font-bold opacity-70">
                      {u.count} payment{u.count === 1 ? "" : "s"} · {money(u.total, { cents: true })} · last {shortDate(u.last_date)}
                    </span>
                  </span>
                  <Button small color="butter" onClick={() => setLearning(u)} aria-label={`Who is ${u.pattern}?`}>Who is this?</Button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <VendorForm open={editing !== null} vendor={editing === "new" ? null : editing} vendors={vendors} envelopes={envelopes}
        onClose={() => setEditing(null)} onSaved={reload} />
      <LearnVendor item={learning} vendors={vendors} onClose={() => setLearning(null)} onSaved={reload} />
    </section>
  );
}

function VendorDot({ v }: { v: Pick<Vendor, "emoji" | "color" | "name"> }) {
  return (
    <span className={cx("flex h-10 w-10 flex-none items-center justify-center rounded-full text-lg font-black", `c-${v.color || "lilac"}`)}
      style={{ background: "var(--c)" }} aria-hidden="true">
      {v.emoji || v.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const STATUS_TEXT: Record<RecurringState["status"], string> = { ok: "", none: "", missed: "missed", changed: "amount changed" };

function RecurringRow({ v, state, onOpen }: { v: Vendor; state: RecurringState; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-white/60">
        <VendorDot v={v} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-extrabold">
            {v.name}
            {(state.status === "missed" || state.status === "changed") && (
              <span className="pill c-coral ml-2">{STATUS_TEXT[state.status]}</span>
            )}
          </span>
          <span className="block text-xs font-bold opacity-70">
            {CADENCE_LABELS[v.recurring as Cadence]}
            {state.last && <> · last {shortDate(state.last)} ({money(state.lastAmount, { cents: true })})</>}
            {state.next && <> · next about {shortDate(state.next)}</>}
          </span>
        </span>
        <span className="num font-black">{money(v.expected_amount, { cents: true })}</span>
      </button>
    </li>
  );
}

// ---------- Teaching a statement value ----------

const NEW = "__new__";

/** Ties a statement value to a vendor (new or existing) and matches every payment with it. */
export function LearnVendor({ item, vendors, onClose, onSaved }: {
  item: UnmatchedStatement | null; vendors: Vendor[]; onClose: () => void; onSaved: () => void;
}) {
  const [pattern, setPattern] = useState("");
  const [vendor, setVendor] = useState(NEW);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [tax, setTax] = useState<TaxCategory | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!item) return;
    setPattern(item.pattern);
    setVendor(NEW);
    setName(suggestVendorName(item.example));
    setEmoji("");
    setTax("");
    setError(null);
  }, [item]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const p = cleanStatement(pattern);
    if (!p) return setError("Enter the start of the statement text.");
    setBusy(true);
    setError(null);
    try {
      let id = vendor;
      if (vendor === NEW) {
        if (!name.trim()) throw new Error("Give the vendor a name.");
        id = (await createVendor({ name: name.trim(), emoji: emoji.trim(), matches: [p], tax_category: tax })).id;
      } else {
        const v = vendors.find((x) => x.id === vendor)!;
        await updateVendor(v.id, { matches: [...new Set([...(v.matches ?? []), p])] });
      }
      await backfillVendor(id);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={item !== null} title="Who is this?" onClose={onClose} color="butter">
      {item && (
        <form onSubmit={save} className="space-y-4">
          <p className="rounded-2xl bg-white/70 px-4 py-3 font-mono text-sm font-bold">{item.example}</p>
          <TextInput label="Statement text starts with" value={pattern} onChange={(e) => setPattern(e.target.value)}
            hint="Reference numbers and dates at the end are left off, so every month's payment matches." />
          <Select label="This is" value={vendor} onChange={(e) => setVendor(e.target.value)}
            options={[{ value: NEW, label: "+ A new vendor" }, ...vendors.filter((v) => !v.archived).map((v) => ({ value: v.id, label: vendorLabel(v) }))]} />
          {vendor === NEW && (
            <>
              <div className="grid grid-cols-[1fr_88px] gap-3">
                <TextInput label="Vendor name" required value={name} onChange={(e) => setName(e.target.value)} />
                <TextInput label="Emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={4} />
              </div>
              <Select label="Tax" value={tax} onChange={(e) => setTax(e.target.value as TaxCategory)}
                options={[{ value: "", label: "Not deductible" }, ...TAX_CATEGORIES.map((c) => ({ value: c, label: `${TAX_CATEGORY_EMOJI[c]} ${TAX_CATEGORY_LABELS[c]}` }))]} />
            </>
          )}
          <ErrorNote message={error} />
          <FormActions saving={busy} color="butter" submitLabel={`Match ${item.count} payment${item.count === 1 ? "" : "s"}`} />
        </form>
      )}
    </Modal>
  );
}

// ---------- Vendor form ----------

export function VendorForm({ open, vendor, vendors, envelopes, onClose, onSaved }: {
  open: boolean; vendor: Vendor | null; vendors: Vendor[]; envelopes: Envelope[]; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [color, setColor] = useState<Color>("lilac");
  const [matches, setMatches] = useState("");
  const [envelope, setEnvelope] = useState("");
  const [recurring, setRecurring] = useState<Cadence | "">("");
  const [expected, setExpected] = useState("");
  const [day, setDay] = useState("");
  const [tax, setTax] = useState<TaxCategory | "">("");
  const [legalName, setLegalName] = useState("");
  const [address, setAddress] = useState("");
  const [tin, setTin] = useState("");
  const [showTin, setShowTin] = useState(false);
  const [notes, setNotes] = useState("");
  const [archived, setArchived] = useState(false);
  const [mergeInto, setMergeInto] = useState("");
  const [history, setHistory] = useState<Transaction[]>([]);
  const [details, setDetails] = useState<Transaction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadHistory = useCallback(() => {
    if (vendor) listVendorTransactions(vendor.id).then(setHistory).catch(() => setHistory([]));
  }, [vendor]);

  useEffect(() => {
    if (!open) return;
    setName(vendor?.name ?? "");
    setEmoji(vendor?.emoji ?? "");
    setColor((vendor?.color || "lilac") as Color);
    setMatches((vendor?.matches ?? []).join("\n"));
    setEnvelope(vendor?.default_envelope ?? "");
    setRecurring(vendor?.recurring ?? "");
    setExpected(vendor?.expected_amount ? String(vendor.expected_amount) : "");
    setDay(vendor?.expected_day ? String(vendor.expected_day) : "");
    setTax(vendor?.tax_category ?? "");
    setLegalName(vendor?.legal_name ?? "");
    setAddress(vendor?.address ?? "");
    setTin(vendor?.tin ?? "");
    setShowTin(!vendor?.tin);
    setNotes(vendor?.notes ?? "");
    setArchived(vendor?.archived ?? false);
    setMergeInto("");
    setHistory([]);
    setError(null);
    loadHistory();
  }, [open, vendor, loadHistory]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const list = [...new Set(matches.split("\n").map(cleanStatement).filter(Boolean))];
    const data = {
      name: name.trim(), emoji: emoji.trim(), color, matches: list, default_envelope: envelope,
      recurring, expected_amount: recurring ? parseMoney(expected) : 0, expected_day: recurring ? Math.min(31, Math.max(0, Math.round(Number(day) || 0))) : 0,
      tax_category: tax, legal_name: legalName.trim(), address: address.trim(), tin: tin.trim(), notes: notes.trim(), archived,
    };
    try {
      const saved = vendor ? await updateVendor(vendor.id, data) : await createVendor(data);
      if (list.length) await backfillVendor(saved.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!vendor) return;
    try {
      await deleteVendor(vendor.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function merge() {
    if (!vendor || !mergeInto) return;
    try {
      await mergeVendor(vendor.id, mergeInto);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const total = history.reduce((s, t) => s + (t.kind === "expense" ? t.amount : -t.amount), 0);

  return (
    <>
    <Modal open={open && !details} title={vendor ? vendorLabel(vendor) : "New vendor"} onClose={onClose} color={vendor?.color || "white"}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-[1fr_88px] gap-3">
          <TextInput label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="St. Mary's Church" />
          <TextInput label="Emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="⛪" maxLength={4} />
        </div>
        <TextArea label="Statement text it starts with (one per line)" value={matches}
          onChange={(e) => setMatches(e.target.value)} placeholder="PAYPAL *STMARYSCHURCH" />
        <Select label="Usual envelope" value={envelope} onChange={(e) => setEnvelope(e.target.value)}
          options={[{ value: "", label: "None" }, ...envelopes.filter((e) => !e.archived || e.id === envelope).map((e) => ({ value: e.id, label: `${e.emoji ? e.emoji + " " : ""}${e.name}` }))]} />
        <div className="grid grid-cols-3 gap-3">
          <Select label="Recurring" value={recurring} onChange={(e) => setRecurring(e.target.value as Cadence)}
            options={[{ value: "", label: "No" }, ...CADENCES.map((c) => ({ value: c, label: CADENCE_LABELS[c] }))]} />
          {recurring && <MoneyInput label="Usual amount" value={expected} onChange={(e) => setExpected(e.target.value)} />}
          {recurring && recurring !== "weekly" && recurring !== "biweekly" && (
            <TextInput label="Day of month" type="number" min={1} max={31} value={day} onChange={(e) => setDay(e.target.value)} />
          )}
        </div>

        <div className="tray space-y-3 p-4">
          <Select label="Tax" value={tax} onChange={(e) => setTax(e.target.value as TaxCategory)}
            hint="Every payment to this vendor counts, wherever it's paid from (a transaction can still say otherwise)."
            options={[{ value: "", label: "Not deductible" }, ...TAX_CATEGORIES.map((c) => ({ value: c, label: `${TAX_CATEGORY_EMOJI[c]} ${TAX_CATEGORY_LABELS[c]}` }))]} />
          {tax && (
            <>
              <TextInput label="Legal name" value={legalName} onChange={(e) => setLegalName(e.target.value)}
                placeholder={name || "As it appears on their letters"} />
              <TextInput label="Address" value={address} onChange={(e) => setAddress(e.target.value)} />
              {showTin ? (
                <TextInput label={tax === "child_care" ? "TIN (EIN or SSN)" : "EIN"} value={tin} onChange={(e) => setTin(e.target.value)}
                  autoComplete="off" hint={tax === "child_care" ? "Form 2441 needs each provider's name, address and TIN." : undefined} />
              ) : (
                <div>
                  <div className="field-label">{tax === "child_care" ? "TIN" : "EIN"}</div>
                  <button type="button" className="btn-ghost text-sm" onClick={() => setShowTin(true)}>{maskTin(tin)} · Change</button>
                </div>
              )}
            </>
          )}
        </div>

        <ColorPicker value={color} onChange={setColor} />
        <TextInput label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {vendor && <Toggle label="Archived" checked={archived} onChange={setArchived} hint="Still matched, but left out of lists." />}

        {vendor && history.length > 0 && (
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-black">Payments</span>
              <span className="num text-sm font-black opacity-80">{money(total, { cents: true })} in all</span>
            </div>
            <ul className="max-h-60 space-y-1 overflow-y-auto">
              {history.slice(0, 50).map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => setDetails(t)}
                    className="flex w-full items-center gap-3 rounded-2xl bg-white/70 px-3 py-2 text-left text-sm hover:bg-white">
                    <span className="w-20 font-extrabold opacity-70">{shortDate(t.date)} {t.date.slice(0, 4)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs font-bold opacity-80">{t.payee}</span>
                    <span className={cx("num font-black", t.kind === "income" && "text-[#4c9a63]")}>
                      {t.kind === "income" ? "+" : ""}{money(t.amount, { cents: true })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {vendor && vendors.length > 1 && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Select label="Merge into another vendor" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}
                options={[{ value: "", label: "Pick a vendor…" }, ...vendors.filter((v) => v.id !== vendor.id).map((v) => ({ value: v.id, label: vendorLabel(v) }))]} />
            </div>
            <Button small color="white" disabled={!mergeInto} onClick={merge}>Merge</Button>
          </div>
        )}

        <ErrorNote message={error} />
        <FormActions saving={busy} onDelete={vendor ? remove : undefined} deleteLabel="Delete vendor"
          submitLabel={vendor ? "Save" : "Add vendor"} />
      </form>
    </Modal>
    {open && (
      <TransactionDetails tx={details} envelopes={envelopes} vendors={vendors}
        onClose={() => setDetails(null)} onChanged={() => { loadHistory(); onSaved(); }} />
    )}
    </>
  );
}

