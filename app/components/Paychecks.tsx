import { useCallback, useEffect, useMemo, useState } from "react";
import {
  agentReaderAvailable, createEarner, deleteEarner, deletePaystub, errorMessage, fromPbDate, latestPaystub,
  listAssets, listDebts, listPaystubLines, loadPaychecks, paystubFileUrl, readPaystubWithAgent, savePaystub, subscribeAll,
  toPbDate, updateEarner, type LineDraft, type PaycheckData,
} from "~/backend/api";
import {
  PAY_FREQUENCIES, type Asset, type Color, type Debt, type Earner, type PayFrequency, type Paystub,
  type PaystubCategory, type PaystubLine, type Transaction,
} from "~/backend/types";
import {
  Button, Card, ColorPicker, ErrorNote, FormActions, Icon, Modal, MoneyInput, SectionTitle, Select, TextInput,
  Toggle, cx,
} from "~/components/ui";
import { monthLabel, shortDate, todayISO } from "~/lib/dates";
import { money, parseMoney, round2 } from "~/lib/money";
import {
  CATEGORY_GROUPS, CATEGORY_LABELS, CONTRIBUTION_ASSET_TYPES, fromAgent, isContributionCategory, isLoanCategory,
  readPaystub, readingLooksGood, totalsByCategory, totalsByGroup,
  unexplained, type PaystubReading,
} from "~/lib/paystub";

const FREQ_LABELS: Record<PayFrequency, string> = {
  weekly: "Every week", biweekly: "Every two weeks", semimonthly: "Twice a month", monthly: "Monthly",
};

const SOURCE_LABELS: Record<string, string> = { upload: "From paystub", manual: "Typed in", repeat: "Same as last" };

/**
 * The paycheck side of the budget: deposits waiting for a paystub, what came
 * out of each paycheck before it reached the bank, and the household's earners.
 */
export function Paychecks({ month, onAddIncome }: { month: string; onAddIncome?: () => void }) {
  const [data, setData] = useState<PaycheckData | null>(null);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingEarner, setEditingEarner] = useState<Earner | "new" | null>(null);
  const [stub, setStub] = useState<{ paystub?: Paystub; earner?: string; tx?: Transaction } | null>(null);

  const reload = useCallback(async () => {
    try {
      const [d, debtList, assetList] = await Promise.all([loadPaychecks(month), listDebts(), listAssets()]);
      setData(d);
      setDebts(debtList);
      setAssets(assetList);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [month]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => subscribeAll(["earners", "paystubs", "paystub_lines", "transactions", "assets"], reload), [reload]);

  const earnerById = useMemo(() => new Map((data?.earners ?? []).map((e) => [e.id, e])), [data]);

  if (!data) return <ErrorNote message={error} />;
  const activeEarners = data.earners.filter((e) => !e.archived);

  return (
    <section aria-label="Paychecks">
      <ErrorNote message={error} />

      {data.waiting.map((t) => (
        <WaitingDeposit key={t.id} tx={t} earner={earnerById.get(t.earner)}
          onUpload={() => setStub({ earner: t.earner, tx: t })} />
      ))}

      <SectionTitle action={
        <div className="flex flex-wrap justify-end gap-2">
          {onAddIncome && (
            <Button small color="butter" onClick={onAddIncome}><Icon name="plus" className="h-5 w-5" /> Income</Button>
          )}
          {activeEarners.length > 0 && (
            <Button small color="sky" onClick={() => setStub({ earner: activeEarners[0].id })}>
              <Icon name="plus" className="h-5 w-5" /> Paystub
            </Button>
          )}
          <Button small color="white" onClick={() => setEditingEarner("new")}><Icon name="plus" className="h-5 w-5" /> Earner</Button>
        </div>
      }>Paychecks</SectionTitle>

      {activeEarners.length === 0 ? (
        <div className="tray px-6 py-6 text-center font-semibold">
          <div className="text-4xl" aria-hidden="true">💼</div>
          <div className="mt-2 text-lg font-black">Add who brings home a paycheck</div>
          <p className="mx-auto mt-1 max-w-lg opacity-80">
            Add each person's paycheck, then upload a paystub. The app tracks taxes, healthcare, retirement and
            401(k) loans that come out before the money reaches the bank.
          </p>
          <Button color="sky" className="mt-4" onClick={() => setEditingEarner("new")}>Add an earner</Button>
        </div>
      ) : (
        <BeforeTheBank data={data} earnerById={earnerById} month={month}
          onOpen={(p) => setStub({ paystub: p })} onEditEarner={setEditingEarner} />
      )}

      <EarnerForm open={editingEarner !== null} earner={editingEarner === "new" ? null : editingEarner}
        onClose={() => setEditingEarner(null)} onSaved={reload} />

      {stub && (
        <PaystubModal earners={activeEarners} debts={debts} assets={assets} initial={stub}
          onClose={() => setStub(null)} onSaved={reload} />
      )}
    </section>
  );
}

// ---------- Deposits waiting for a paystub ----------

function WaitingDeposit({ tx, earner, onUpload }: { tx: Transaction; earner?: Earner; onUpload: () => void }) {
  return (
    <Card color="butter" className="pop-in mt-5 flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
      <div className="text-3xl" aria-hidden="true">📄</div>
      <div className="flex-1 font-bold">
        <div className="text-lg font-black">
          {earner?.name ?? "A"} paycheck of {money(tx.amount, { cents: true })} on {shortDate(fromPbDate(tx.date))} is different
        </div>
        <div className="opacity-80">
          It doesn't match the last paystub to the cent, so taxes or deductions may have changed. Upload this paystub to keep
          them right.
        </div>
      </div>
      <Button color="mint" onClick={onUpload}>Upload paystub</Button>
    </Card>
  );
}

// ---------- What came out before the bank ----------

function BeforeTheBank({ data, earnerById, month, onOpen, onEditEarner }: {
  data: PaycheckData; earnerById: Map<string, Earner>; month: string;
  onOpen: (p: Paystub) => void; onEditEarner: (e: Earner) => void;
}) {
  const [range, setRange] = useState<"month" | "year">("month");
  const year = month.slice(0, 4);
  const shown = range === "month" ? { paystubs: data.paystubs, lines: data.lines } : data.year;
  const linesByStub = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of data.lines) m.set(l.paystub, round2((m.get(l.paystub) ?? 0) + l.amount));
    return m;
  }, [data.lines]);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.2fr_1fr]">
      <Card className="pop-in p-6">
        <div className="mb-4 inline-flex rounded-full bg-[rgba(106,93,123,.08)] p-1 text-sm font-black" role="tablist" aria-label="Period">
          {(["month", "year"] as const).map((r) => (
            <button key={r} type="button" role="tab" aria-selected={range === r} onClick={() => setRange(r)}
              className={cx("rounded-full px-4 py-1.5", range === r ? "bg-white shadow" : "opacity-60")}>
              {r === "month" ? monthLabel(month) : `${year} so far`}
            </button>
          ))}
        </div>
        <Breakdown paystubs={shown.paystubs} lines={shown.lines} earnerById={earnerById}
          empty={range === "month" ? `No paystubs for ${monthLabel(month)} yet.` : `No paystubs in ${year} yet.`}
          detailed={range === "year"} />
      </Card>

      <div className="tray p-4">
        <div className="mb-2 flex flex-wrap gap-2">
          {[...earnerById.values()].filter((e) => !e.archived).map((e) => (
            <button key={e.id} type="button" onClick={() => onEditEarner(e)}
              className={cx("pill !px-3 !py-1.5 !text-sm", `c-${e.color || "sky"}`)} style={{ boxShadow: "0 3px 0 var(--cd)" }}>
              💼 {e.name} <Icon name="edit" className="h-3 w-3 opacity-60" />
            </button>
          ))}
        </div>
        {data.paystubs.length === 0 ? (
          <p className="px-1 py-2 text-sm font-semibold opacity-70">
            When a paycheck lands (added below or synced from the bank), it shows here with its paystub.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.paystubs.map((p) => {
              const e = earnerById.get(p.earner);
              return (
                <li key={p.id}>
                  <button type="button" onClick={() => onOpen(p)}
                    className="flex w-full items-center gap-3 rounded-2xl bg-white/80 px-4 py-3 text-left hover:bg-white">
                    <span className={cx("h-3 w-3 flex-none rounded-full", `c-${e?.color || "sky"}`)} style={{ background: "var(--cd)" }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-extrabold">{e?.name ?? "Paycheck"} · {shortDate(fromPbDate(p.pay_date))}</span>
                      <span className="block text-xs font-bold opacity-70">
                        {money(p.gross)} gross · {money(linesByStub.get(p.id) ?? 0, { cents: true })} taken out · {SOURCE_LABELS[p.source] ?? ""}
                      </span>
                    </span>
                    <span className="num font-black">{money(p.net, { cents: true })}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Gross → what came out → take-home, for a set of paystubs. */
function Breakdown({ paystubs, lines, earnerById, empty, detailed }: {
  paystubs: Paystub[]; lines: PaystubLine[]; earnerById: Map<string, Earner>; empty: string; detailed: boolean;
}) {
  const gross = round2(paystubs.reduce((s, p) => s + p.gross, 0));
  const net = round2(paystubs.reduce((s, p) => s + p.net, 0));
  const groups = totalsByGroup(lines).filter((g) => g.total > 0);

  // Per earner, for households with more than one paycheck.
  const earnerOfStub = new Map(paystubs.map((p) => [p.id, p.earner]));
  const earnerIds = [...new Set(paystubs.map((p) => p.earner))];
  const perEarner = (category: PaystubCategory) => earnerIds.map((id) =>
    round2(lines.filter((l) => l.category === category && earnerOfStub.get(l.paystub) === id).reduce((s, l) => s + l.amount, 0)));

  if (gross <= 0) return <p className="font-semibold opacity-75">{empty}</p>;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-sm font-extrabold uppercase tracking-wide opacity-75">Before it hits the bank</div>
          <div className="num text-3xl font-black">{money(gross)} <span className="text-lg opacity-60">gross</span></div>
        </div>
        <div className="text-right">
          <div className="text-sm font-extrabold uppercase tracking-wide opacity-75">Take-home</div>
          <div className="num text-3xl font-black text-[#4c9a63]">{money(net)}</div>
        </div>
      </div>
      <div className="mt-4 flex h-6 w-full overflow-hidden rounded-full bg-[rgba(106,93,123,.08)]" role="img"
        aria-label={[...groups.map((g) => `${g.group.label} ${money(g.total)}`), `Take-home ${money(net)}`].join(", ")}>
        {groups.map((g) => (
          <span key={g.group.key} className={`c-${g.group.color} h-full`} title={`${g.group.label}: ${money(g.total)}`}
            style={{ width: `${(g.total / gross) * 100}%`, background: "var(--cd)" }} />
        ))}
        <span className="c-mint h-full" style={{ width: `${(net / gross) * 100}%`, background: "var(--c)" }} title="Take-home" />
      </div>
      <ul className="mt-4 space-y-3">
        {groups.map((g) => (
          <li key={g.group.key} className={`c-${g.group.color}`}>
            <div className="flex items-center gap-3 font-bold">
              <span className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: "var(--c)" }} aria-hidden="true">
                {g.group.emoji}
              </span>
              <span className="flex-1">{g.group.label}</span>
              <span className="num font-black">−{money(g.total, { cents: true })}</span>
              <span className="num w-12 text-right text-xs opacity-60">{Math.round((g.total / gross) * 100)}%</span>
            </div>
            {detailed && (
              <ul className="ml-12 mt-1 space-y-0.5 text-sm font-semibold">
                {totalsByCategory(lines.filter((l) => g.group.categories.includes(l.category))).map((c) => (
                  <li key={c.category} className="flex gap-3">
                    <span className="flex-1 opacity-80">{CATEGORY_LABELS[c.category]}</span>
                    {earnerIds.length > 1 && perEarner(c.category).map((v, i) => (
                      <span key={earnerIds[i]} className="num w-24 text-right text-xs opacity-60"
                        title={earnerById.get(earnerIds[i])?.name}>
                        {earnerById.get(earnerIds[i])?.name}: {money(v)}
                      </span>
                    ))}
                    <span className="num w-24 text-right font-black">{money(c.total, { cents: true })}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------- Earners ----------

function EarnerForm({ open, earner, onClose, onSaved }: { open: boolean; earner: Earner | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [employer, setEmployer] = useState("");
  const [freq, setFreq] = useState<PayFrequency>("biweekly");
  const [color, setColor] = useState<Color>("sky");
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(earner?.name ?? "");
    setEmployer(earner?.employer ?? "");
    setFreq((earner?.pay_frequency || "biweekly") as PayFrequency);
    setColor((earner?.color || "sky") as Color);
    setArchived(earner?.archived ?? false);
    setError(null);
  }, [open, earner]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const d = { name: name.trim(), employer: employer.trim(), pay_frequency: freq, color, archived };
      if (earner) await updateEarner(earner.id, d);
      else await createEarner(d);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!earner) return;
    try {
      await deleteEarner(earner.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal open={open} title={earner ? "Edit earner" : "Add an earner"} onClose={onClose} color="sky">
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Name" required placeholder="Joey" value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label="Employer" value={employer} onChange={(e) => setEmployer(e.target.value)} />
        </div>
        <Select label="Paid" value={freq} onChange={(e) => setFreq(e.target.value as PayFrequency)}
          options={PAY_FREQUENCIES.map((f) => ({ value: f, label: FREQ_LABELS[f] }))} />
        <ColorPicker value={color} onChange={setColor} />
        {earner && <Toggle label="No longer paid" checked={archived} onChange={setArchived} hint="Hidden; past paystubs are kept." />}
        <ErrorNote message={error} />
        <FormActions color="sky" saving={busy} onDelete={earner ? remove : undefined}
          deleteLabel="Delete earner and paystubs" submitLabel={earner ? "Save" : "Add earner"} />
      </form>
    </Modal>
  );
}

// ---------- Paystub: upload, read, check, save ----------

type Step = "pick" | "reading" | "review";

function PaystubModal({ earners, debts, assets, initial, onClose, onSaved }: {
  earners: Earner[]; debts: Debt[]; assets: Asset[];
  initial: { paystub?: Paystub; earner?: string; tx?: Transaction };
  onClose: () => void; onSaved: () => void;
}) {
  const existing = initial.paystub ?? null;
  const [step, setStep] = useState<Step>(existing ? "review" : "pick");
  const [earner, setEarner] = useState(existing?.earner ?? initial.earner ?? earners[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [payDate, setPayDate] = useState(existing ? fromPbDate(existing.pay_date) : initial.tx ? fromPbDate(initial.tx.date) : todayISO());
  const [periodStart, setPeriodStart] = useState(existing ? fromPbDate(existing.period_start) : "");
  const [periodEnd, setPeriodEnd] = useState(existing ? fromPbDate(existing.period_end) : "");
  const [gross, setGross] = useState(existing ? String(existing.gross) : "");
  const [net, setNet] = useState(existing ? String(existing.net) : initial.tx ? String(initial.tx.amount) : "");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState(false);

  useEffect(() => { agentReaderAvailable().then(setAgent); }, []);
  useEffect(() => {
    if (existing) listPaystubLines(existing.id).then((ls) => setLines(ls.map((l) => ({ id: l.id, category: l.category, label: l.label, amount: l.amount, debt: l.debt, asset: l.asset }))));
  }, [existing]);

  const loanDebts = debts.filter((d) => d.type === "401k_loan" || d.balance > 0);

  /**
   * Links loan lines to their debt and contribution lines to their account: the
   * same one as on the last paystub, else the only one of the right kind.
   */
  function withDebts(ls: LineDraft[], previous: LineDraft[]): LineDraft[] {
    const k401 = debts.filter((d) => d.type === "401k_loan" && d.balance > 0);
    const samePrev = (l: LineDraft, key: "debt" | "asset") =>
      previous.find((p) => p[key] && p.category === l.category && p.label === l.label) ??
      previous.find((p) => p[key] && p.category === l.category);
    return ls.map((l) => {
      if (isLoanCategory(l.category) && !l.debt) {
        return { ...l, debt: samePrev(l, "debt")?.debt ?? (l.category === "401k_loan" && k401.length === 1 ? k401[0].id : "") };
      }
      if (isContributionCategory(l.category) && !l.asset) {
        const types = CONTRIBUTION_ASSET_TYPES[l.category] ?? [];
        const fits = assets.filter((a) => types.includes(a.type));
        return { ...l, asset: samePrev(l, "asset")?.asset ?? (fits.length === 1 ? fits[0].id : "") };
      }
      return l;
    });
  }

  async function previousLines(): Promise<LineDraft[]> {
    const last = earner ? await latestPaystub(earner) : null;
    return (last?.lines ?? []).map((l) => ({ category: l.category, label: l.label, amount: l.amount, debt: l.debt, asset: l.asset }));
  }

  function apply(r: PaystubReading, previous: LineDraft[]) {
    if (r.pay_date) setPayDate(r.pay_date);
    if (r.period_start) setPeriodStart(r.period_start);
    if (r.period_end) setPeriodEnd(r.period_end);
    if (r.gross !== null) setGross(String(r.gross));
    if (r.net !== null) setNet(String(r.net));
    setLines(withDebts(r.lines.map((l) => ({ ...l, debt: "", asset: "" })), previous));
  }

  async function readWithAgent(f: File): Promise<PaystubReading> {
    const { toBase64 } = await import("~/lib/pdfText");
    return fromAgent(await readPaystubWithAgent(f.name, f.type || "application/pdf", await toBase64(f)));
  }

  async function read(f: File) {
    setFile(f);
    setStep("reading");
    setError(null);
    setNote(null);
    const previous = await previousLines().catch(() => []);
    let reading: PaystubReading | null = null;
    try {
      if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) {
        const { pdfRows } = await import("~/lib/pdfText");
        reading = readPaystub(await pdfRows(f));
      }
    } catch {
      reading = null;
    }
    if ((!reading || !readingLooksGood(reading)) && agent) {
      setNote("Asking your OpenClaw agent to read it…");
      try {
        const fromAgentReading = await readWithAgent(f);
        if (!reading || readingLooksGood(fromAgentReading) || fromAgentReading.lines.length > reading.lines.length) {
          reading = fromAgentReading;
        }
      } catch (err) {
        setError(`OpenClaw couldn't read it: ${errorMessage(err)}`);
      }
    }
    if (reading) {
      apply(reading, previous);
      setNote(readingLooksGood(reading)
        ? "Read from the paystub. Check it over, then save."
        : "Some of this paystub couldn't be read. Fill in or fix what's missing.");
    } else {
      setLines(withDebts(previous, previous));
      setNote("This file couldn't be read, so last paystub's deductions are filled in. Update them to match.");
    }
    setStep("review");
  }

  async function startFromLast() {
    const previous = await previousLines();
    const last = earner ? await latestPaystub(earner) : null;
    if (last) setGross(String(last.paystub.gross));
    setLines(previous);
    setNote(previous.length ? "Filled in from the last paystub." : null);
    setStep("review");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!earner) return setError("Pick whose paycheck this is.");
    setBusy(true);
    setError(null);
    try {
      await savePaystub(existing, {
        earner, pay_date: toPbDate(payDate), period_start: toPbDate(periodStart), period_end: toPbDate(periodEnd),
        gross: parseMoney(gross), net: parseMoney(net),
        source: existing?.source && existing.source !== "repeat" ? existing.source : file ? "upload" : "manual",
        ...(initial.tx ? { transaction: initial.tx.id } : {}),
      }, lines.filter((l) => l.amount > 0), file);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing) return;
    try {
      await deletePaystub(existing.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const gap = unexplained(parseMoney(gross), parseMoney(net), lines);
  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <Modal open title={existing ? "Paystub" : "Add a paystub"} onClose={onClose} color="sky">
      {step === "pick" && (
        <div className="space-y-4">
          <Select label="Whose paycheck?" value={earner} onChange={(e) => setEarner(e.target.value)}
            options={earners.map((e) => ({ value: e.id, label: e.name }))} />
          {initial.tx && (
            <p className="rounded-2xl bg-white/70 px-4 py-3 text-sm font-bold">
              For the {money(initial.tx.amount, { cents: true })} deposit on {shortDate(fromPbDate(initial.tx.date))}.
            </p>
          )}
          <label className="tray flex cursor-pointer flex-col items-center gap-2 px-6 py-8 text-center font-black hover:bg-white">
            <span className="text-4xl" aria-hidden="true">📄</span>
            Choose the paystub PDF
            <span className="text-xs font-semibold opacity-70">
              Read right here in your browser{agent ? ", with your OpenClaw agent as a backup" : ""}.
            </span>
            <input type="file" accept="application/pdf,image/*" className="sr-only" aria-label="Paystub file"
              onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
          </label>
          <div className="text-center">
            <button type="button" className="btn-ghost text-sm" onClick={startFromLast}>No PDF? Type it in</button>
          </div>
          <ErrorNote message={error} />
        </div>
      )}

      {step === "reading" && (
        <div className="py-10 text-center font-black">
          <div className="bob inline-block text-5xl" aria-hidden="true">📄</div>
          <div className="mt-3">{note ?? "Reading the paystub…"}</div>
        </div>
      )}

      {step === "review" && (
        <form onSubmit={save} className="space-y-4">
          {note && <p className="rounded-2xl bg-white/70 px-4 py-3 text-sm font-bold">{note}</p>}
          {existing?.source === "repeat" && (
            <p className="rounded-2xl bg-white/70 px-4 py-3 text-sm font-bold">
              Copied from the previous paystub because the deposit matched it to the cent. Change anything that's different,
              or upload the real paystub.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Select label="Whose paycheck?" value={earner} onChange={(e) => setEarner(e.target.value)}
              options={earners.map((e) => ({ value: e.id, label: e.name }))} />
            <TextInput label="Pay date" type="date" required value={payDate} onChange={(e) => setPayDate(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MoneyInput label="Gross pay" required value={gross} onChange={(e) => setGross(e.target.value)} />
            <MoneyInput label="Net pay (take-home)" required value={net} onChange={(e) => setNet(e.target.value)} />
          </div>

          <div>
            <div className="field-label">Taken out of this paycheck</div>
            <ul className="space-y-2">
              {lines.map((l, i) => (
                <li key={i} className="rounded-2xl bg-white/70 p-3">
                  <div className="grid grid-cols-[1fr_120px_auto] items-center gap-2">
                    <select aria-label="Category" className="input !py-2 text-sm" value={l.category}
                      onChange={(e) => setLine(i, { category: e.target.value as PaystubCategory })}>
                      {CATEGORY_GROUPS.map((g) => (
                        <optgroup key={g.key} label={g.label}>
                          {g.categories.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                        </optgroup>
                      ))}
                    </select>
                    <input aria-label="Amount" className="input num !py-2 text-right text-sm" inputMode="decimal" type="number" step="0.01" min="0"
                      value={l.amount || ""} onChange={(e) => setLine(i, { amount: parseMoney(e.target.value) })} />
                    <button type="button" aria-label="Remove line" className="opacity-50 hover:opacity-100"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Icon name="trash" className="h-4 w-4" /></button>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <input aria-label="Label on paystub" className="input !py-2 text-sm" placeholder="As printed on the paystub"
                      value={l.label} onChange={(e) => setLine(i, { label: e.target.value })} />
                    {isContributionCategory(l.category) && (
                      <select aria-label="Goes into" className="input !py-2 text-sm" value={l.asset}
                        onChange={(e) => setLine(i, { asset: e.target.value })}>
                        <option value="">Goes into… (pick the account)</option>
                        {assets.map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.value)})</option>)}
                      </select>
                    )}
                    {isLoanCategory(l.category) && (
                      <select aria-label="Pays down" className="input !py-2 text-sm" value={l.debt}
                        onChange={(e) => setLine(i, { debt: e.target.value })}>
                        <option value="">Pays down… (pick the loan)</option>
                        {loanDebts.map((d) => <option key={d.id} value={d.id}>{d.name} ({money(d.balance)})</option>)}
                      </select>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <button type="button" className="btn-ghost mt-2 text-sm"
              onClick={() => setLines((ls) => [...ls, { category: "federal_tax", label: "", amount: 0, debt: "", asset: "" }])}>
              <Icon name="plus" className="h-4 w-4" /> Add a line
            </button>
          </div>

          <div className={cx("rounded-2xl px-4 py-3 text-sm font-black", Math.abs(gap) < 0.01 ? "c-mint" : "c-butter")}
            style={{ background: "var(--c)" }}>
            {Math.abs(gap) < 0.01
              ? "✓ Gross minus everything above equals the take-home."
              : `${money(Math.abs(gap), { cents: true })} ${gap > 0 ? "isn't accounted for. Add the missing line." : "too much is listed. Check the amounts."}`}
          </div>

          {existing?.file && (
            <button type="button" className="btn-ghost text-sm"
              onClick={async () => window.open(await paystubFileUrl(existing), "_blank", "noopener")}>
              <Icon name="link" className="h-4 w-4" /> Open the paystub file
            </button>
          )}
          {!existing && file && <p className="text-xs font-bold opacity-70">The PDF is saved with the paystub.</p>}
          {existing && !file && (
            <label className="btn-ghost cursor-pointer text-sm">
              <Icon name="plus" className="h-4 w-4" /> Read a paystub file into this
              <input type="file" accept="application/pdf,image/*" className="sr-only" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
            </label>
          )}

          <ErrorNote message={error} />
          <FormActions color="sky" saving={busy} onDelete={existing ? remove : undefined} deleteLabel="Delete paystub"
            submitLabel="Save paystub" />
        </form>
      )}
    </Modal>
  );
}

