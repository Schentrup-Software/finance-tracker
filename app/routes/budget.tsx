import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  createEnvelope, createTransaction, listEarners, listWaitingDeposits, deleteEnvelope, deleteTransaction, errorMessage, fromPbDate,
  listTaxDocuments, listVendors, loadMonth, setAllocation, startMonth, subscribeAll, toPbDate, updateBudget, updateEnvelope,
  type MonthData,
} from "~/backend/api";
import {
  ENVELOPE_GROUPS, TAX_CATEGORIES, type Color, type Earner, type Envelope, type EnvelopeGroup, type TaxCategory,
  type TaxDocument, type Transaction, type TransactionKind, type Vendor,
} from "~/backend/types";
import { EnvelopeArt } from "~/components/EnvelopeArt";
import { ImportHistory } from "~/components/ImportHistory";
import { Paychecks } from "~/components/Paychecks";
import { TaxesView } from "~/components/Taxes";
import { TaxBadge, TransactionDetails } from "~/components/TransactionDetails";
import { VendorsView } from "~/components/Vendors";
import {
  Button, Card, ColorPicker, EmptyState, ErrorNote, FormActions, Icon, Meter, Modal, MoneyInput,
  RoundButton, SectionTitle, Select, Stat, TextInput, Toggle, cx,
} from "~/components/ui";
import { GROUP_LABELS, STARTER_ENVELOPES, isAnnual, monthLeftShare, monthlyToGoal, summarize, type EnvelopeSummary } from "~/lib/budget";
import { monthLabel, monthOf, nextMonth, shortDate, todayISO } from "~/lib/dates";
import { money, parseMoney } from "~/lib/money";
import { TAX_CATEGORY_EMOJI, TAX_CATEGORY_LABELS, taxRows, type TaxRow } from "~/lib/tax";

export function meta() {
  return [{ title: "Budget · Finance Tracker" }];
}

const GROUP_ORDER = new Map(ENVELOPE_GROUPS.map((g, i) => [g, i]));

const VIEWS = [
  { key: "envelopes", label: "Envelopes", emoji: "✉️" },
  { key: "income", label: "Income", emoji: "💼" },
  { key: "vendors", label: "Vendors", emoji: "🏪" },
  { key: "taxes", label: "Taxes", emoji: "🧾" },
] as const;
type View = (typeof VIEWS)[number]["key"];

export default function BudgetPage() {
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : monthOf();
  const view: View = VIEWS.some((v) => v.key === params.get("view")) ? (params.get("view") as View) : "envelopes";
  const go = (m: string, v: View) => setParams({
    ...(m === monthOf() ? {} : { month: m }), ...(v === "envelopes" ? {} : { view: v }),
  }, { replace: true });
  const setMonth = (m: string) => go(m, view);

  const [data, setData] = useState<MonthData | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [docs, setDocs] = useState<TaxDocument[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [d, v, td, w] = await Promise.all([
        loadMonth(month), listVendors(), listTaxDocuments(Number(month.slice(0, 4))), listWaitingDeposits(),
      ]);
      setData(d);
      setVendors(v);
      setDocs(td);
      setWaiting(w.length);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [month]);

  useEffect(() => {
    setData(null);
    reload();
  }, [reload]);

  useEffect(() => subscribeAll(["envelopes", "budgets", "allocations", "transactions", "vendors", "paystubs"], reload), [reload]);

  const summary = useMemo(
    () => data && summarize(data.envelopes, data.allocations, data.transactions, data.carried,
      data.budget?.planned_income ?? 0, month, data.yearSpent),
    [data],
  );

  const [openEnvelope, setOpenEnvelope] = useState<string | null>(null);
  const [editing, setEditing] = useState<Envelope | "new" | null>(null);
  const [adding, setAdding] = useState<TransactionKind | null>(null);
  const [editIncome, setEditIncome] = useState(false);
  const [importing, setImporting] = useState(false);
  const [details, setDetails] = useState<Transaction | null>(null);

  const sorted = useMemo(() => {
    if (!summary) return [];
    return [...summary.envelopes].sort((a, b) =>
      (GROUP_ORDER.get(a.envelope.group as EnvelopeGroup) ?? 99) - (GROUP_ORDER.get(b.envelope.group as EnvelopeGroup) ?? 99) ||
      a.envelope.sort - b.envelope.sort || a.envelope.name.localeCompare(b.envelope.name));
  }, [summary]);

  const monthly = sorted.filter((s) => !isAnnual(s.envelope));
  const annual = sorted.filter((s) => isAnnual(s.envelope));
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

      <div className="mt-5 flex justify-center">
        <div className="inline-flex rounded-full bg-[rgba(106,93,123,.08)] p-1 font-black" role="tablist" aria-label="Budget views">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => go(month, v.key)}
              className={cx("rounded-full px-4 py-2 sm:px-5", view === v.key && "bg-white shadow")}>
              <span aria-hidden="true">{v.emoji}</span> {v.label}
              {v.key === "income" && waiting > 0 && (
                <span className="ml-1.5 inline-block h-2.5 w-2.5 rounded-full bg-[var(--coral-deep)] align-middle" title="A paycheck needs its paystub" />
              )}
            </button>
          ))}
        </div>
      </div>

      {view === "vendors" ? (
        <VendorsView month={month} />
      ) : view === "taxes" ? (
        <TaxesView key={month.slice(0, 4)} initialYear={Number(month.slice(0, 4))} />
      ) : (
      <>
      <div className="mt-6"><ErrorNote message={error} /></div>

      {!data ? (
        <div className="py-20 text-center text-5xl"><span className="bob inline-block">✉️</span></div>
      ) : !data.budget ? (
        <StartMonth month={month} hasEnvelopes={data.envelopes.some((e) => !e.archived)} onStarted={reload}
          onImport={() => setImporting(true)} />
      ) : summary && view === "income" ? (
        <>
          <SummaryRow summary={summary} onEditIncome={() => setEditIncome(true)} />
          <Paychecks month={month} onAddIncome={() => setAdding("income")} />
        </>
      ) : summary && (
        <>
          {waiting > 0 && (
            <div className="tray mt-2 flex flex-wrap items-center justify-between gap-3 px-5 py-4 font-semibold">
              <span>
                <span aria-hidden="true">💼 </span>
                {waiting === 1 ? "A paycheck is" : `${waiting} paychecks are`} waiting for a paystub.
              </span>
              <Button small color="sky" onClick={() => go(month, "income")}>Go to Income</Button>
            </div>
          )}

          <SectionTitle action={
            <div className="flex flex-wrap justify-end gap-2">
              <Button small color="mint" onClick={() => setAdding("expense")}><Icon name="cash" className="h-5 w-5" /> Spend</Button>
              <Button small color="butter" onClick={() => setAdding("income")}><Icon name="plus" className="h-5 w-5" /> Income</Button>
            </div>
          }>Envelopes</SectionTitle>

          {sorted.length === 0 ? (
            <EmptyState emoji="✉️" title="No envelopes yet">
              Give every dollar a job. Make an envelope for each thing you spend cash on.
            </EmptyState>
          ) : null}

          <EnvelopeGroup title="Monthly" items={monthly} offset={0} month={month}
            onOpen={setOpenEnvelope} onNew={() => setEditing("new")} />
          {annual.length > 0 && (
            <EnvelopeGroup title="Annual" items={annual} offset={monthly.length} month={month} onOpen={setOpenEnvelope} />
          )}

          <div className="mt-4 text-right">
            <button className="btn-ghost text-sm" onClick={() => setImporting(true)}>
              <Icon name="plus" className="h-4 w-4" /> Import history from a spreadsheet
            </button>
          </div>

          <ActivityList data={data} summary={summary} vendors={vendors} docs={docs} onOpen={setDetails} />
        </>
      )}
      </>
      )}

      {data?.budget && selected && (
        <EnvelopeModal s={selected} budgetId={data.budget.id} month={month}
          onClose={() => setOpenEnvelope(null)}
          onEdit={() => { setEditing(selected.envelope); setOpenEnvelope(null); }}
          onOpenTx={(t) => { setDetails(t); setOpenEnvelope(null); }}
          onChanged={reload} />
      )}

      {data && (
        <TransactionDetails tx={details} envelopes={data.envelopes} vendors={vendors}
          onClose={() => setDetails(null)} onChanged={reload} />
      )}

      <EnvelopeForm open={editing !== null} envelope={editing === "new" ? null : editing}
        budgetId={data?.budget?.id ?? null} count={data?.envelopes.length ?? 0}
        onClose={() => setEditing(null)} onSaved={reload} />

      {data && (
        <TransactionForm kind={adding} envelopes={sorted.map((s) => s.envelope).filter((e) => !e.archived)} month={month}
          onClose={() => setAdding(null)} onSaved={reload} />
      )}

      <ImportHistory open={importing} onClose={() => setImporting(false)} onDone={reload} />

      {data?.budget && (
        <IncomeForm open={editIncome} budgetId={data.budget.id} value={data.budget.planned_income}
          onClose={() => setEditIncome(false)} onSaved={reload} />
      )}
    </div>
  );
}

// ---------- Starting a month ----------

function StartMonth({ month, hasEnvelopes, onStarted, onImport }: {
  month: string; hasEnvelopes: boolean; onStarted: () => void; onImport: () => void;
}) {
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
      {!hasEnvelopes && (
        <button className="btn-ghost mt-4 text-sm" onClick={onImport}>Or import your history from a spreadsheet</button>
      )}
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

// ---------- Envelope list ----------

const COLLAPSED_KEY = "ft.collapsedGroups";

function readCollapsed(title: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]).includes(title);
  } catch {
    return false;
  }
}

function writeCollapsed(title: string, collapsed: boolean) {
  try {
    const list = (JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]).filter((t) => t !== title);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed ? [...list, title] : list));
  } catch {
    // Collapsing still works for this visit.
  }
}

function EnvelopeGroup({ title, items, offset, month, onOpen, onNew }: {
  title: string; items: EnvelopeSummary[]; offset: number; month: string; onOpen: (id: string) => void; onNew?: () => void;
}) {
  const total = items.reduce((sum, s) => sum + (s.historyOnly ? 0 : s.left), 0);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readCollapsed(title)), [title]);
  const toggle = () => { writeCollapsed(title, !collapsed); setCollapsed(!collapsed); };
  const pace = month === monthOf() ? monthLeftShare(month) : null;

  return (
    <section className="mt-5" aria-label={title}>
      <button type="button" onClick={toggle} aria-expanded={!collapsed}
        className="flex w-full items-baseline justify-between gap-3 rounded-2xl px-2 py-1 text-left hover:bg-[rgba(var(--ink-rgb),.05)]">
        <span className="flex items-center gap-2 text-xl font-black">
          <Icon name="right" className={cx("h-5 w-5 transition-transform", !collapsed && "rotate-90")} />
          {title}
        </span>
        {items.some((s) => !s.historyOnly) && (
          <span className="num text-xl font-black" title="Cash in these envelopes">{money(total, { cents: true })}</span>
        )}
      </button>
      {!collapsed && (
        <div className="tray mt-2 overflow-hidden">
          {items.map((s, i) => (
            <EnvelopeRow key={s.envelope.id} s={s} index={offset + i} pace={isAnnual(s.envelope) ? null : pace}
              onOpen={() => onOpen(s.envelope.id)} />
          ))}
          {onNew && (
            <button type="button" onClick={onNew}
              className="flex w-full items-center gap-3 px-5 py-4 font-black opacity-80 hover:bg-white hover:opacity-100">
              <span className="round-btn h-9 w-9"><Icon name="plus" className="h-5 w-5" /></span>
              New envelope
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function EnvelopeRow({ s, index, pace, onOpen }: {
  s: EnvelopeSummary; index: number; pace: number | null; onOpen: () => void;
}) {
  const color = (s.envelope.color || "lilac") as Color;
  const over = s.left < 0;
  const annual = isAnnual(s.envelope);
  const of = annual && s.envelope.goal ? s.envelope.goal : s.planned + s.carried + s.added;
  return (
    <button type="button" onClick={onOpen}
      className={cx("pop-in block w-full border-b-[3px] border-[rgba(var(--ink-rgb),.06)] px-5 py-3 text-left hover:bg-white",
        `c-${color}`, s.envelope.archived && "opacity-60")}
      style={{ ["--i" as any]: index }}
      aria-label={s.historyOnly ? `${s.envelope.name}: ${money(s.spent)} spent` : `${s.envelope.name}: ${money(s.left)} left of ${money(of)}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="w-8 shrink-0">
            {s.envelope.emoji
              ? <span className="text-xl" aria-hidden="true">{s.envelope.emoji}</span>
              : <EnvelopeArt fullness={s.historyOnly ? 0 : s.fullness} overspent={over && !s.historyOnly} />}
          </span>
          <span className="truncate text-lg font-black">{s.envelope.name}</span>
          {annual
            ? <span className="pill c-white text-[10px]" title="Saves toward a yearly goal">YEARLY</span>
            : s.envelope.rollover && <span className="pill c-white text-[10px]" title="Leftover cash rolls into next month">ROLLS</span>}
        </span>
        <span className="shrink-0 text-right leading-tight">
          {s.historyOnly ? (
            <>
              <span className="num block text-lg font-black">{money(s.spent, { cents: true })}</span>
              <span className="num block text-xs font-extrabold opacity-70">spent</span>
            </>
          ) : (
            <>
              <span className={cx("num block text-lg font-black", over && "text-[#c45c5c]")}>{money(s.left, { cents: true })}</span>
              <span className="num block text-xs font-extrabold opacity-70"
                title={annual ? (s.envelope.goal ? "Yearly goal" : "Saved") : "Budgeted this month"}>
                {money(of, { cents: true })}
              </span>
            </>
          )}
        </span>
      </div>
      <div className="relative mt-2">
        <div className="meter h-3">
          <span style={{ width: `${Math.round((s.historyOnly ? 0 : s.fullness) * 100)}%` }} />
        </div>
        {pace !== null && !s.historyOnly && (
          <span className="absolute -bottom-1 -top-1 w-[3px] -translate-x-1/2 rounded-full bg-[rgb(var(--ink-rgb))] opacity-60"
            style={{ left: `${pace * 100}%` }} title="Where you'd be if you spent evenly through the month" />
        )}
      </div>
    </button>
  );
}

// ---------- Envelope details ----------

function EnvelopeModal({ s, budgetId, month, onClose, onEdit, onOpenTx, onChanged }: {
  s: EnvelopeSummary; budgetId: string; month: string; onClose: () => void; onEdit: () => void;
  onOpenTx: (t: Transaction) => void; onChanged: () => void;
}) {
  const color = (s.envelope.color || "lilac") as Color;
  const annual = isAnnual(s.envelope);
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
      {annual ? (
        <div className="grid grid-cols-3 gap-3 text-center">
          <MiniStat label="Saved" value={money(s.left)} />
          <MiniStat label="Yearly goal" value={s.envelope.goal ? money(s.envelope.goal) : "None"} />
          <MiniStat label="Spent this year" value={money(s.yearSpent)} />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 text-center">
          <MiniStat label="Planned" value={money(s.planned)} />
          <MiniStat label="Spent" value={money(s.spent)} />
          <MiniStat label={s.historyOnly ? "Money back" : "Left"} value={money(s.historyOnly ? s.added : s.left)} />
        </div>
      )}
      {s.historyOnly ? (
        <p className="mt-2 text-center text-sm font-bold opacity-80">
          This month is from your imported history, before the balances you entered, so only spending is shown.
        </p>
      ) : (s.carried !== 0 || s.added !== 0) && (
        <p className="mt-2 text-center text-sm font-bold opacity-80">
          {s.carried !== 0 && <>Includes {money(s.carried)} carried in from earlier months. </>}
          {s.added !== 0 && <>{money(s.added)} was put straight back in this month.</>}
        </p>
      )}

      <div className="mt-5 flex items-end gap-3">
        <div className="flex-1">
          <MoneyInput label={`Put in for ${monthLabel(month)}`} value={planned} min={undefined}
            onChange={(e) => setPlanned(e.target.value)} onBlur={savePlanned}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur())}
            hint={annual && s.envelope.goal > 0 && !s.historyOnly
              ? `${money(monthlyToGoal(s.envelope.goal, s.left - s.planned, month), { cents: true })} a month reaches the ${money(s.envelope.goal)} goal by December.`
              : undefined} />
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
                <button type="button" className="flex-1 truncate text-left font-bold hover:underline" onClick={() => onOpenTx(t)}>
                  {t.payee || t.note || (t.kind === "income" ? "Money back" : "Spent")}
                </button>
                <span className={cx("num font-black", t.kind === "income" && "text-[#4c9a63]")}>
                  {t.kind === "income" ? "+" : ""}{money(t.amount, { cents: true })}
                </span>
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
  const [period, setPeriod] = useState<"monthly" | "annual">("monthly");
  const [goal, setGoal] = useState("");
  const [opening, setOpening] = useState("");
  const [tax, setTax] = useState<TaxCategory | "">("");
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
    setPeriod(envelope?.period === "annual" ? "annual" : "monthly");
    setGoal(envelope?.goal ? String(envelope.goal) : "");
    setOpening(envelope?.opening_date ? String(envelope.opening_balance ?? 0) : "");
    setTax(envelope?.tax_category ?? "");
    setError(null);
  }, [open, envelope, count]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const data = {
      name: name.trim(), emoji: emoji.trim(), color, group, default_amount: parseMoney(amount),
      rollover: rollover || period === "annual", archived, period, goal: period === "annual" ? parseMoney(goal) : 0,
      tax_category: tax,
      ...(envelope?.opening_date ? { opening_balance: parseMoney(opening) } : {}),
    };
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
        <Select label="Kind of envelope" value={period} onChange={(e) => setPeriod(e.target.value as "monthly" | "annual")}
          options={[{ value: "monthly", label: "Monthly: spent month by month" }, { value: "annual", label: "Annual: saves toward a yearly goal" }]} />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Category" value={group} onChange={(e) => setGroup(e.target.value as EnvelopeGroup)}
            options={[{ value: "", label: "None" }, ...ENVELOPE_GROUPS.map((g) => ({ value: g, label: GROUP_LABELS[g] }))]} />
          <MoneyInput label="Usual monthly amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        {period === "annual" && (
          <MoneyInput label="Yearly goal" value={goal} onChange={(e) => setGoal(e.target.value)}
            hint="What you plan to spend from it in a year, like Christmas or donations. Leftover cash always stays in it." />
        )}
        {envelope?.opening_date && (
          <MoneyInput label={`Balance on ${shortDate(envelope.opening_date)}, ${envelope.opening_date.slice(0, 4)}`} min={undefined}
            value={opening} onChange={(e) => setOpening(e.target.value)}
            hint="Set when you imported your history. The envelope's balance counts from here." />
        )}
        <Select label="Tax" value={tax} onChange={(e) => setTax(e.target.value as TaxCategory)}
          hint="Spending from this envelope counts toward this at tax time. A vendor or a single payment can still say otherwise."
          options={[{ value: "", label: "Not deductible" }, ...TAX_CATEGORIES.map((c) => ({ value: c, label: `${TAX_CATEGORY_EMOJI[c]} ${TAX_CATEGORY_LABELS[c]}` }))]} />
        <ColorPicker value={color} onChange={setColor} />
        {period === "monthly" && (
          <Toggle label="Roll leftover cash into next month" checked={rollover} onChange={setRollover}
            hint="For sinking funds like car repairs or vacations." />
        )}
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

function ActivityList({ data, summary, vendors, docs, onOpen }: {
  data: MonthData; summary: ReturnType<typeof summarize>; vendors: Vendor[]; docs: TaxDocument[]; onOpen: (t: Transaction) => void;
}) {
  const names = new Map(data.envelopes.map((e) => [e.id, e]));
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const year = Number(data.transactions[0]?.date.slice(0, 4)) || 0;
  const tagged = new Map<string, TaxRow>(taxRows(data.transactions, vendorById, names, docs, year).map((r) => [r.tx.id, r]));
  if (data.transactions.length === 0) return null;
  return (
    <>
      <SectionTitle>Activity</SectionTitle>
      <div className="tray p-3 sm:p-4">
        <ul className="divide-y-2 divide-[rgba(106,93,123,.08)]">
          {data.transactions.slice(0, 50).map((t) => {
            const env = names.get(t.envelope);
            const vendor = vendorById.get(t.vendor);
            const income = t.kind === "income";
            const tax = tagged.get(t.id);
            return (
              <li key={t.id}>
                <button type="button" onClick={() => onOpen(t)}
                  className="flex w-full items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-white/60">
                  <span className={cx("flex h-10 w-10 flex-none items-center justify-center rounded-full text-lg",
                    `c-${income && !env ? "butter" : env?.color || "lilac"}`)} style={{ background: "var(--c)" }} aria-hidden="true">
                    {income && !env ? "💰" : env?.emoji || "✉️"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-extrabold" title={vendor && t.payee ? t.payee : undefined}>
                      {vendor ? `${vendor.emoji ? vendor.emoji + " " : ""}${vendor.name}` : t.payee || (income ? "Income" : "Spent")}
                      {tax && <TaxBadge category={tax.category} warn={tax.needsAck} />}
                    </span>
                    <span className="block text-xs font-bold opacity-70">
                      {shortDate(fromPbDate(t.date))} · {env ? (income ? `Into ${env.name}` : env.name) : income ? "Income" : "No envelope"}
                      {t.account && <> · {t.account}</>}
                      {t.paystub_status === "needs_paystub" && <span className="pill c-butter ml-2">needs paystub</span>}
                      {t.paystub_status === "matched" && <span className="ml-2 opacity-70">· paystub ✓</span>}
                      {!vendor && t.payee && !t.earner && (!income || env) && <span className="pill c-white ml-2">who is this?</span>}
                    </span>
                  </span>
                  <span className={cx("num font-black", income && "text-[#4c9a63]")}>
                    {income ? "+" : "−"}{money(t.amount, { cents: true })}
                  </span>
                </button>
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
