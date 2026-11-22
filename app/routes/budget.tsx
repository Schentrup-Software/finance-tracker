import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  createEnvelope, createTransaction, listEarners, deleteEnvelope, deleteTransaction, errorMessage, fromPbDate,
  loadMonth, setAllocation, startMonth, subscribeAll, toPbDate, updateBudget, updateEnvelope,
  type MonthData,
} from "~/backend/api";
import { ENVELOPE_GROUPS, type Color, type Earner, type Envelope, type EnvelopeGroup, type TransactionKind } from "~/backend/types";
import { EnvelopeArt } from "~/components/EnvelopeArt";
import { Paychecks } from "~/components/Paychecks";
import {
  Button, Card, ColorPicker, EmptyState, ErrorNote, FormActions, Icon, Meter, Modal, MoneyInput,
  RoundButton, SectionTitle, Select, Stat, TextInput, Toggle, cx,
} from "~/components/ui";
import { GROUP_LABELS, STARTER_ENVELOPES, summarize, type EnvelopeSummary } from "~/lib/budget";
import { monthLabel, monthOf, nextMonth, shortDate, todayISO } from "~/lib/dates";
import { money, parseMoney } from "~/lib/money";

export function meta() {
  return [{ title: "Budget · Finance Tracker" }];
}

const GROUP_ORDER = new Map(ENVELOPE_GROUPS.map((g, i) => [g, i]));

export default function BudgetPage() {
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : monthOf();
  const setMonth = (m: string) => setParams(m === monthOf() ? {} : { month: m }, { replace: true });

  const [data, setData] = useState<MonthData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await loadMonth(month));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [month]);

  useEffect(() => {
    setData(null);
    reload();
  }, [reload]);

  useEffect(() => subscribeAll(["envelopes", "budgets", "allocations", "transactions"], reload), [reload]);

  const summary = useMemo(
    () => data && summarize(data.envelopes, data.allocations, data.transactions, data.carried, data.budget?.planned_income ?? 0),
    [data],
  );

  const [openEnvelope, setOpenEnvelope] = useState<string | null>(null);
  const [editing, setEditing] = useState<Envelope | "new" | null>(null);
  const [adding, setAdding] = useState<TransactionKind | null>(null);
  const [editIncome, setEditIncome] = useState(false);

  const sorted = useMemo(() => {
    if (!summary) return [];
    return [...summary.envelopes].sort((a, b) =>
      (GROUP_ORDER.get(a.envelope.group as EnvelopeGroup) ?? 99) - (GROUP_ORDER.get(b.envelope.group as EnvelopeGroup) ?? 99) ||
      a.envelope.sort - b.envelope.sort || a.envelope.name.localeCompare(b.envelope.name));
  }, [summary]);

  const selected = summary?.envelopes.find((e) => e.envelope.id === openEnvelope) ?? null;

  return (
    <div>
      <div className="flex items-center justify-center gap-4">
        <RoundButton label="Previous month" icon="left" onClick={() => setMonth(nextMonth(month, -1))} />
        <h2 className="min-w-[12ch] text-center text-2xl font-black sm:text-3xl">{monthLabel(month)}</h2>
        <RoundButton label="Next month" icon="right" onClick={() => setMonth(nextMonth(month, 1))} />
      </div>
      {month !== monthOf() && (
        <div className="mt-2 text-center">
          <button className="btn-ghost text-sm" onClick={() => setMonth(monthOf())}>Back to this month</button>
        </div>
      )}

      <div className="mt-6"><ErrorNote message={error} /></div>

      {!data ? (
        <div className="py-20 text-center text-5xl"><span className="bob inline-block">✉️</span></div>
      ) : !data.budget ? (
        <StartMonth month={month} hasEnvelopes={data.envelopes.some((e) => !e.archived)} onStarted={reload} />
      ) : summary && (
        <>
          <SummaryRow summary={summary} onEditIncome={() => setEditIncome(true)} />

          <Paychecks month={month} />

          <SectionTitle action={
            <div className="flex gap-2">
              <Button small color="mint" onClick={() => setAdding("expense")}><Icon name="cash" className="h-5 w-5" /> Spend</Button>
              <Button small color="butter" onClick={() => setAdding("income")}><Icon name="plus" className="h-5 w-5" /> Income</Button>
            </div>
          }>Envelopes</SectionTitle>

          {sorted.length === 0 ? (
            <EmptyState emoji="✉️" title="No envelopes yet">
              Give every dollar a job. Make an envelope for each thing you spend cash on.
            </EmptyState>
          ) : null}

          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {sorted.map((s, i) => (
              <EnvelopeCard key={s.envelope.id} s={s} index={i} onOpen={() => setOpenEnvelope(s.envelope.id)} />
            ))}
            <button type="button" onClick={() => setEditing("new")}
              className="tray pop-in flex min-h-[220px] flex-col items-center justify-center gap-2 font-black opacity-80 hover:opacity-100"
              style={{ ["--i" as any]: sorted.length }}>
              <span className="round-btn"><Icon name="plus" /></span>
              New envelope
            </button>
          </div>

          <ActivityList data={data} summary={summary} />
        </>
      )}

      {data?.budget && selected && (
        <EnvelopeModal s={selected} budgetId={data.budget.id} month={month}
          onClose={() => setOpenEnvelope(null)}
          onEdit={() => { setEditing(selected.envelope); setOpenEnvelope(null); }}
          onChanged={reload} />
      )}

      <EnvelopeForm open={editing !== null} envelope={editing === "new" ? null : editing}
        budgetId={data?.budget?.id ?? null} count={data?.envelopes.length ?? 0}
        onClose={() => setEditing(null)} onSaved={reload} />

      {data && (
        <TransactionForm kind={adding} envelopes={sorted.map((s) => s.envelope).filter((e) => !e.archived)} month={month}
          onClose={() => setAdding(null)} onSaved={reload} />
      )}

      {data?.budget && (
        <IncomeForm open={editIncome} budgetId={data.budget.id} value={data.budget.planned_income}
          onClose={() => setEditIncome(false)} onSaved={reload} />
      )}
    </div>
  );
}

// ---------- Starting a month ----------

function StartMonth({ month, hasEnvelopes, onStarted }: { month: string; hasEnvelopes: boolean; onStarted: () => void }) {
  const [income, setIncome] = useState("");
  const [starters, setStarters] = useState(!hasEnvelopes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (starters && !hasEnvelopes) {
        let i = 0;
        for (const s of STARTER_ENVELOPES) await createEnvelope({ ...s, sort: i++, default_amount: 0 });
      }
      await startMonth(month, income === "" ? undefined : parseMoney(income));
      onStarted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card color="butter" className="pop-in mx-auto mt-4 max-w-xl p-8 text-center">
      <div className="bob text-6xl" aria-hidden="true">✉️</div>
      <h3 className="mt-3 text-2xl font-black">Plan {monthLabel(month)}</h3>
      <p className="mt-2 font-semibold opacity-80">
        Write down what you expect to bring home, then give every dollar a job in an envelope.
        {hasEnvelopes && " Envelope amounts start from your last budget."}
      </p>
      <form onSubmit={start} className="mx-auto mt-6 max-w-xs space-y-4 text-left">
        <MoneyInput label="Expected take-home pay" placeholder={hasEnvelopes ? "Same as last month" : "0"}
          value={income} onChange={(e) => setIncome(e.target.value)} />
        {!hasEnvelopes && (
          <Toggle label="Add starter envelopes" checked={starters} onChange={setStarters}
            hint="Giving, Emergency Fund, Housing, Utilities, Groceries, Restaurants, Gas, Fun Money" />
        )}
        <ErrorNote message={error} />
        <button className="btn c-mint w-full" disabled={busy}>{busy ? "Setting up…" : "Start budget"}</button>
      </form>
    </Card>
  );
}

// ---------- Summary ----------

function SummaryRow({ summary, onEditIncome }: { summary: ReturnType<typeof summarize>; onEditIncome: () => void }) {
  const left = summary.leftToBudget;
  const leftColor: Color = left === 0 ? "mint" : left > 0 ? "butter" : "coral";
  const leftHint = left === 0
    ? "Every dollar has a job! 🎉"
    : left > 0 ? "still needs a job" : "more than you make. Trim an envelope.";

  return (
    <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-3">
      <Card color="sky" className="pop-in chunk-press p-6" style={{ ["--i" as any]: 0 }} onClick={onEditIncome}
        role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onEditIncome()}>
        <Stat label="Income plan" value={money(summary.plannedIncome)}
          hint={<>{money(summary.receivedIncome)} received so far <Icon name="edit" className="ml-1 h-4 w-4 align-[-2px]" /></>} />
      </Card>
      <Card color={leftColor} className="pop-in p-6" style={{ ["--i" as any]: 1 }}>
        <Stat label={left < 0 ? "Over budget" : "Left to budget"} value={money(Math.abs(left))} hint={leftHint} />
      </Card>
      <Card color="lilac" className="pop-in p-6" style={{ ["--i" as any]: 2 }}>
        <Stat label="Spent" value={money(summary.spent)} hint={`of ${money(summary.assigned)} in envelopes`} />
        <div className="mt-3"><Meter value={summary.assigned ? summary.spent / summary.assigned : 0} label="Spent of assigned" /></div>
      </Card>
    </div>
  );
}

// ---------- Envelope card ----------

function EnvelopeCard({ s, index, onOpen }: { s: EnvelopeSummary; index: number; onOpen: () => void }) {
  const color = (s.envelope.color || "lilac") as Color;
  const over = s.left < 0;
  return (
    <button type="button" onClick={onOpen}
      className={cx("chunk chunk-press pop-in flex flex-col items-stretch p-4 text-left", `c-${color}`, s.envelope.archived && "opacity-60")}
      style={{ ["--i" as any]: index }}
      aria-label={`${s.envelope.name}: ${money(s.left)} left of ${money(s.planned + s.carried)}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-lg font-black">
          {s.envelope.emoji && <span className="mr-1" aria-hidden="true">{s.envelope.emoji}</span>}
          {s.envelope.name}
        </span>
        {s.envelope.rollover && <span className="pill c-white text-[10px]" title="Leftover cash rolls into next month">ROLLS</span>}
      </div>
      <div className="mx-auto mt-2 w-[78%]"><EnvelopeArt fullness={s.fullness} overspent={over} /></div>
      <div className="mt-2 text-center">
        <div className={cx("num text-2xl font-black", over && "text-[#c45c5c]")}>{money(s.left)}</div>
        <div className="text-xs font-extrabold opacity-75">
          {over ? "overspent" : "left"} of {money(s.planned + s.carried)}
          {s.carried !== 0 && <> · {money(s.carried)} carried</>}
        </div>
      </div>
    </button>
  );
}

// ---------- Envelope details ----------

function EnvelopeModal({ s, budgetId, month, onClose, onEdit, onChanged }: {
  s: EnvelopeSummary; budgetId: string; month: string; onClose: () => void; onEdit: () => void; onChanged: () => void;
}) {
  const color = (s.envelope.color || "lilac") as Color;
  const [planned, setPlanned] = useState(String(s.planned));
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [date, setDate] = useState(defaultDate(month));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setPlanned(String(s.planned)), [s.planned]);

  async function savePlanned() {
    const v = parseMoney(planned);
    if (v === s.planned) return;
    try {
      await setAllocation(budgetId, s.envelope.id, v);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function spend(e: React.FormEvent) {
    e.preventDefault();
    const v = parseMoney(amount);
    if (v <= 0) return setError("Enter how much you spent.");
    setBusy(true);
    setError(null);
    try {
      await createTransaction({ kind: "expense", envelope: s.envelope.id, amount: v, payee: payee.trim(), date: toPbDate(date) });
      setAmount("");
      setPayee("");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`${s.envelope.emoji ? s.envelope.emoji + " " : ""}${s.envelope.name}`} onClose={onClose} color={color}>
      <div className="grid grid-cols-3 gap-3 text-center">
        <MiniStat label="Planned" value={money(s.planned)} />
        <MiniStat label="Spent" value={money(s.spent)} />
        <MiniStat label="Left" value={money(s.left)} />
      </div>
      {s.carried !== 0 && (
        <p className="mt-2 text-center text-sm font-bold opacity-80">Includes {money(s.carried)} carried in from earlier months.</p>
      )}

      <div className="mt-5 flex items-end gap-3">
        <div className="flex-1">
          <MoneyInput label={`Put in for ${monthLabel(month)}`} value={planned}
            onChange={(e) => setPlanned(e.target.value)} onBlur={savePlanned}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur())} />
        </div>
      </div>

      <form onSubmit={spend} className="tray mt-5 space-y-3 p-4">
        <div className="font-black">Spend from this envelope</div>
        <div className="grid grid-cols-2 gap-3">
          <MoneyInput label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          <TextInput label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <TextInput label="Where" placeholder="Publix, Shell, …" value={payee} onChange={(e) => setPayee(e.target.value)} />
        <ErrorNote message={error} />
        <button className="btn c-mint w-full" disabled={busy}>{busy ? "Saving…" : "Take cash out"}</button>
      </form>

      <div className="mt-5">
        <div className="mb-2 font-black">This month</div>
        {s.transactions.length === 0 ? (
          <p className="text-sm font-semibold opacity-70">Nothing spent yet.</p>
        ) : (
          <ul className="space-y-2">
            {s.transactions.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-2xl bg-white/70 px-4 py-2">
                <span className="w-14 text-xs font-extrabold opacity-70">{shortDate(t.date)}</span>
                <span className="flex-1 truncate font-bold">{t.payee || t.note || "Spent"}</span>
                <span className="num font-black">{money(t.amount, { cents: true })}</span>
                <button className="opacity-50 hover:opacity-100" aria-label="Delete" onClick={async () => {
                  await deleteTransaction(t.id).catch((err) => setError(errorMessage(err)));
                  onChanged();
                }}><Icon name="trash" className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6 text-right">
        <button className="btn-ghost" onClick={onEdit}><Icon name="edit" className="h-4 w-4" /> Edit envelope</button>
      </div>
    </Modal>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white/70 px-2 py-3">
      <div className="text-xs font-extrabold uppercase opacity-70">{label}</div>
      <div className="num text-lg font-black">{value}</div>
    </div>
  );
}

function defaultDate(month: string) {
  const today = todayISO();
  return today.startsWith(month) ? today : `${month}-01`;
}

// ---------- Envelope form ----------

function EnvelopeForm({ open, envelope, budgetId, count, onClose, onSaved }: {
  open: boolean; envelope: Envelope | null; budgetId: string | null; count: number; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [color, setColor] = useState<Color>("mint");
  const [group, setGroup] = useState<EnvelopeGroup | "">("");
  const [amount, setAmount] = useState("");
  const [rollover, setRollover] = useState(false);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(envelope?.name ?? "");
    setEmoji(envelope?.emoji ?? "");
    setColor((envelope?.color || ["mint", "sky", "peach", "lilac", "pink", "butter", "aqua", "coral"][count % 8]) as Color);
    setGroup(envelope?.group ?? "");
    setAmount(envelope ? String(envelope.default_amount ?? 0) : "");
    setRollover(envelope?.rollover ?? false);
    setArchived(envelope?.archived ?? false);
    setError(null);
  }, [open, envelope, count]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const data = { name: name.trim(), emoji: emoji.trim(), color, group, default_amount: parseMoney(amount), rollover, archived };
    try {
      if (envelope) {
        await updateEnvelope(envelope.id, data);
      } else {
        const created = await createEnvelope({ ...data, sort: count });
        if (budgetId) await setAllocation(budgetId, created.id, data.default_amount);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!envelope) return;
    try {
      await deleteEnvelope(envelope.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal open={open} title={envelope ? "Edit envelope" : "New envelope"} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-[1fr_88px] gap-3">
          <TextInput label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Groceries" />
          <TextInput label="Emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🥕" maxLength={4} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Category" value={group} onChange={(e) => setGroup(e.target.value as EnvelopeGroup)}
            options={[{ value: "", label: "None" }, ...ENVELOPE_GROUPS.map((g) => ({ value: g, label: GROUP_LABELS[g] }))]} />
          <MoneyInput label="Usual monthly amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <ColorPicker value={color} onChange={setColor} />
        <Toggle label="Roll leftover cash into next month" checked={rollover} onChange={setRollover}
          hint="For sinking funds like car repairs, Christmas or vacations." />
        {envelope && <Toggle label="Archived" checked={archived} onChange={setArchived} hint="Hidden from new months. History is kept." />}
        <ErrorNote message={error} />
        <FormActions saving={busy} onDelete={envelope ? remove : undefined}
          deleteLabel="Delete envelope and its plans" submitLabel={envelope ? "Save" : "Add envelope"} />
      </form>
    </Modal>
  );
}

// ---------- Spending and income ----------

function TransactionForm({ kind, envelopes, month, onClose, onSaved }: {
  kind: TransactionKind | null; envelopes: Envelope[]; month: string; onClose: () => void; onSaved: () => void;
}) {
  const [envelope, setEnvelope] = useState("");
  const [earner, setEarner] = useState("");
  const [earners, setEarners] = useState<Earner[]>([]);
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [date, setDate] = useState(defaultDate(month));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!kind) return;
    if (kind === "income") {
      listEarners().then((es) => {
        const active = es.filter((e) => !e.archived);
        setEarners(active);
        setEarner(active[0]?.id ?? "");
      }).catch(() => setEarners([]));
    }
    setEnvelope(envelopes[0]?.id ?? "");
    setAmount("");
    setPayee("");
    setDate(defaultDate(month));
    setError(null);
  }, [kind, month]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const v = parseMoney(amount);
    if (v <= 0) return setError("Enter an amount.");
    if (kind === "expense" && !envelope) return setError("Pick an envelope.");
    setBusy(true);
    try {
      await createTransaction({
        kind: kind!, amount: v, date: toPbDate(date),
        payee: payee.trim() || (kind === "income" && earner ? `${earners.find((e) => e.id === earner)?.name ?? ""} paycheck`.trim() : ""),
        envelope: kind === "expense" ? envelope : "",
        earner: kind === "income" ? earner : "",
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const isIncome = kind === "income";
  return (
    <Modal open={kind !== null} title={isIncome ? "Money in" : "Spend cash"} onClose={onClose} color={isIncome ? "butter" : "mint"}>
      <form onSubmit={save} className="space-y-4">
        {!isIncome && (
          <Select label="From envelope" value={envelope} onChange={(e) => setEnvelope(e.target.value)}
            options={envelopes.map((e) => ({ value: e.id, label: `${e.emoji ? e.emoji + " " : ""}${e.name}` }))} />
        )}
        {isIncome && earners.length > 0 && (
          <Select label="Whose paycheck?" value={earner} onChange={(e) => setEarner(e.target.value)}
            hint="Paychecks are checked against the last paystub. If the amount changed, you'll be asked for the new paystub."
            options={[...earners.map((e) => ({ value: e.id, label: e.name })), { value: "", label: "Not a paycheck" }]} />
        )}
        <div className="grid grid-cols-2 gap-3">
          <MoneyInput label={isIncome ? "Amount deposited" : "Amount"} required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <TextInput label="Date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <TextInput label={isIncome ? "From" : "Where"} placeholder={isIncome ? "Paycheck" : "Publix"}
          value={payee} onChange={(e) => setPayee(e.target.value)} />
        <ErrorNote message={error} />
        <FormActions saving={busy} color={isIncome ? "butter" : "mint"} submitLabel={isIncome ? "Add income" : "Spend"} />
      </form>
    </Modal>
  );
}

function IncomeForm({ open, budgetId, value, onClose, onSaved }: {
  open: boolean; budgetId: string; value: number; onClose: () => void; onSaved: () => void;
}) {
  const [income, setIncome] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setIncome(String(value)); }, [open, value]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await updateBudget(budgetId, { planned_income: parseMoney(income) });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal open={open} title="Income plan" onClose={onClose} color="sky">
      <form onSubmit={save} className="space-y-4">
        <MoneyInput label="Expected take-home pay this month" value={income} onChange={(e) => setIncome(e.target.value)} />
        <ErrorNote message={error} />
        <FormActions color="sky" />
      </form>
    </Modal>
  );
}

function ActivityList({ data, summary }: { data: MonthData; summary: ReturnType<typeof summarize> }) {
  const names = new Map(data.envelopes.map((e) => [e.id, e]));
  if (data.transactions.length === 0) return null;
  return (
    <>
      <SectionTitle>Activity</SectionTitle>
      <div className="tray p-3 sm:p-4">
        <ul className="divide-y-2 divide-[rgba(106,93,123,.08)]">
          {data.transactions.slice(0, 50).map((t) => {
            const env = names.get(t.envelope);
            const income = t.kind === "income";
            return (
              <li key={t.id} className="flex items-center gap-3 px-2 py-3">
                <span className={cx("flex h-10 w-10 flex-none items-center justify-center rounded-full text-lg",
                  `c-${income ? "butter" : env?.color || "lilac"}`)} style={{ background: "var(--c)" }} aria-hidden="true">
                  {income ? "💰" : env?.emoji || "✉️"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-extrabold">{t.payee || (income ? "Income" : "Spent")}</span>
                  <span className="block text-xs font-bold opacity-70">
                    {shortDate(fromPbDate(t.date))} · {income ? "Income" : env?.name ?? "No envelope"}
                    {t.paystub_status === "needs_paystub" && <span className="pill c-butter ml-2">needs paystub</span>}
                    {t.paystub_status === "matched" && <span className="ml-2 opacity-70">· paystub ✓</span>}
                  </span>
                </span>
                <span className={cx("num font-black", income && "text-[#4c9a63]")}>
                  {income ? "+" : "−"}{money(t.amount, { cents: true })}
                </span>
              </li>
            );
          })}
        </ul>
        {summary.unassignedSpending.length > 0 && (
          <p className="px-2 pt-2 text-sm font-bold opacity-80">
            {summary.unassignedSpending.length} expense(s) have no envelope. They count toward Spent.
          </p>
        )}
      </div>
    </>
  );
}
