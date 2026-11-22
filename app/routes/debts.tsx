import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  createDebt, createPayment, deleteDebt, deletePayment, errorMessage, fromPbDate, listAssets, listDebts,
  listPayments, listPayrollDebtIds, subscribeAll, toPbDate, updateDebt,
} from "~/backend/api";
import { DEBT_TYPES, type Asset, type Color, type Debt, type DebtPayment, type DebtType } from "~/backend/types";
import {
  Button, Card, EmptyState, ErrorNote, FormActions, Icon, Meter, Modal, MoneyInput, SectionTitle, Select,
  Stat, TextArea, TextInput, cx,
} from "~/components/ui";
import { ASSET_EMOJI } from "~/lib/assets";
import {
  DEBT_EMOJI, DEBT_LABELS, addMonthsLabel, interestLeft, isMortgage, isPayrollLoan, paidShare, payoffMonths,
} from "~/lib/debts";
import { shortDate, todayISO } from "~/lib/dates";
import { money, parseMoney } from "~/lib/money";

export function meta() {
  return [{ title: "Debts · Finance Tracker" }];
}

export default function DebtsPage() {
  const [debts, setDebts] = useState<Debt[] | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [payrollDebts, setPayrollDebts] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Debt | "new" | null>(null);
  const [paying, setPaying] = useState<Debt | null>(null);

  const reload = useCallback(async () => {
    try {
      const [d, a, p] = await Promise.all([listDebts(), listAssets(), listPayrollDebtIds()]);
      setDebts(d);
      setAssets(a);
      setPayrollDebts(p);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => subscribeAll(["debts", "debt_payments", "assets", "paystub_lines"], reload), [reload]);

  const assetsByDebt = useMemo(() => {
    const m = new Map<string, Asset[]>();
    for (const a of assets) for (const id of a.debts ?? []) m.set(id, [...(m.get(id) ?? []), a]);
    return m;
  }, [assets]);

  // Each loan on its own: when it's paid off at its own monthly payment.
  const payoff = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const d of debts ?? []) m.set(d.id, payoffMonths(d.balance, d.interest_rate, d.minimum_payment));
    return m;
  }, [debts]);

  const byPayoff = (a: Debt, b: Debt) => {
    const pa = payoff.get(a.id), pb = payoff.get(b.id);
    return (pa ?? Infinity) - (pb ?? Infinity) || a.balance - b.balance;
  };
  const all = debts ?? [];
  const groups = [
    { key: "loans", title: "Loans and cards", note: null as string | null,
      items: all.filter((d) => !isMortgage(d) && !isPayrollLoan(d) && d.balance > 0).sort(byPayoff) },
    { key: "payroll", title: "Paid from your paycheck", note: "Taken out of your pay before it reaches the bank.",
      items: all.filter((d) => isPayrollLoan(d) && d.balance > 0).sort(byPayoff) },
    { key: "house", title: "The house", note: null,
      items: all.filter((d) => isMortgage(d) && d.balance > 0).sort(byPayoff) },
    { key: "done", title: "Paid off", note: null, items: all.filter((d) => d.balance <= 0) },
  ];

  const totalOwed = all.reduce((s, d) => s + d.balance, 0);
  const monthly = all.filter((d) => d.balance > 0).reduce((s, d) => s + (d.minimum_payment || 0), 0);
  const original = all.reduce((s, d) => s + Math.max(d.original_balance || 0, d.balance), 0);
  const paid = Math.max(0, original - totalOwed);

  if (!debts) {
    return <div className="py-20 text-center text-5xl"><span className="bob inline-block">⛓️</span><ErrorNote message={error} /></div>;
  }

  return (
    <div>
      <ErrorNote message={error} />

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <Card color="coral" className="pop-in p-6">
          <Stat label="Total owed" value={money(totalOwed)} hint={`${all.filter((d) => d.balance > 0).length} loans and cards`} />
        </Card>
        <Card color="peach" className="pop-in p-6" style={{ ["--i" as any]: 1 }}>
          <Stat label="Monthly payments" value={money(monthly)} hint="all loans together" />
        </Card>
        <Card color="mint" className="pop-in p-6" style={{ ["--i" as any]: 2 }}>
          <Stat label="Paid off so far" value={money(paid)}
            hint={original ? `${pct(paid / original)} of ${money(original)}` : "Add starting balances to track this"} />
          <div className="mt-3"><Meter value={original ? paid / original : 0} label="Share paid off" /></div>
        </Card>
      </div>

      <SectionTitle action={<Button small color="coral" onClick={() => setEditing("new")}><Icon name="plus" className="h-5 w-5" /> Add debt</Button>}>
        Debts
      </SectionTitle>

      {all.length === 0 && (
        <EmptyState emoji="🎉" title="No debts here">
          Add credit cards, car loans, student loans, 401(k) loans and the mortgage to track each one's payoff date.
        </EmptyState>
      )}

      {groups.filter((g) => g.items.length > 0).map((g, gi) => (
        <section key={g.key} className={gi > 0 ? "mt-10" : ""}>
          {(gi > 0 || g.key !== "loans") && <h3 className="mb-1 text-xl font-black">{g.title}</h3>}
          {g.note && <p className="mb-3 font-semibold opacity-75">{g.note}</p>}
          <div className="space-y-5">
            {g.items.map((d, i) => (
              <DebtCard key={d.id} debt={d} index={i} months={payoff.get(d.id) ?? null}
                fromPaycheck={payrollDebts.has(d.id)} assets={assetsByDebt.get(d.id) ?? []}
                onEdit={() => setEditing(d)} onPay={() => setPaying(d)} />
            ))}
          </div>
        </section>
      ))}

      <DebtForm open={editing !== null} debt={editing === "new" ? null : editing}
        onClose={() => setEditing(null)} onSaved={reload} />
      {paying && <PaymentModal debt={debts.find((d) => d.id === paying.id) ?? paying} onClose={() => setPaying(null)} onSaved={reload} />}
    </div>
  );
}

function pct(x: number) {
  if (x > 0 && x < 0.01) return "<1%";
  return `${Math.round(x * 100)}%`;
}

function DebtCard({ debt, index, months, fromPaycheck, assets, onEdit, onPay }: {
  debt: Debt; index: number; months: number | null; fromPaycheck: boolean; assets: Asset[]; onEdit: () => void; onPay: () => void;
}) {
  const done = debt.balance <= 0;
  const type = (debt.type || "other") as DebtType;
  const share = paidShare(debt);
  const interest = done ? 0 : interestLeft(debt.balance, debt.interest_rate, debt.minimum_payment);
  return (
    <Card color={done ? "mint" : "white"} className="pop-in p-5 sm:p-6" style={{ ["--i" as any]: index }}>
      <div className="flex flex-wrap items-start gap-4">
        <div className={cx("flex h-14 w-14 flex-none items-center justify-center rounded-full text-2xl", `c-${done ? "mint" : "peach"}`)}
          style={{ background: "var(--c)", boxShadow: "0 4px 0 var(--cd)" }} aria-hidden="true">
          {done ? "🎉" : DEBT_EMOJI[type]}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-xl font-black">{debt.name}</h3>
            {fromPaycheck && <span className="pill c-lilac">From paycheck</span>}
          </div>
          <div className="mt-0.5 text-sm font-bold opacity-75">
            {DEBT_LABELS[type]}{debt.lender && ` · ${debt.lender}`}
            {debt.interest_rate > 0 && ` · ${debt.interest_rate}% APR`}
            {debt.minimum_payment > 0 && ` · ${money(debt.minimum_payment)}/mo`}
            {debt.due_day > 0 && ` · due the ${ordinal(debt.due_day)}`}
          </div>
          {assets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {assets.map((a) => (
                <Link key={a.id} to="/assets" className="pill c-sky hover:brightness-95">
                  <Icon name="link" className="h-3 w-3" /> {ASSET_EMOJI[(a.type || "other") as keyof typeof ASSET_EMOJI]} {a.name}
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="num text-3xl font-black">{done ? "Paid off!" : money(debt.balance)}</div>
          {!done && (
            <div className="text-sm font-bold opacity-75">
              {months === null
                ? debt.minimum_payment ? "payment doesn't cover interest" : "add a monthly payment for a payoff date"
                : <>paid off {addMonthsLabel(months)}</>}
            </div>
          )}
          {!done && interest !== null && interest > 0 && (
            <div className="text-xs font-bold opacity-60">{money(interest)} interest to go</div>
          )}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-4">
        <div className="flex-1"><Meter value={share} color={done ? "mint" : "coral"} label="Paid off" /></div>
        <span className="num w-12 text-right text-sm font-black">{pct(share)}</span>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost text-sm" onClick={onEdit}><Icon name="edit" className="h-4 w-4" /> Edit</button>
        {!done && <Button small color="mint" onClick={onPay}><Icon name="cash" className="h-4 w-4" /> Record a payment</Button>}
      </div>
    </Card>
  );
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function DebtForm({ open, debt, onClose, onSaved }: { open: boolean; debt: Debt | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setF({
      name: debt?.name ?? "", type: debt?.type || "credit_card", lender: debt?.lender ?? "",
      balance: debt ? String(debt.balance) : "", original_balance: debt?.original_balance ? String(debt.original_balance) : "",
      interest_rate: debt?.interest_rate ? String(debt.interest_rate) : "",
      minimum_payment: debt?.minimum_payment ? String(debt.minimum_payment) : "",
      due_day: debt?.due_day ? String(debt.due_day) : "", notes: debt?.notes ?? "",
    });
    setError(null);
  }, [open, debt]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const balance = parseMoney(f.balance);
    const data = {
      name: f.name.trim(), type: f.type as DebtType, lender: f.lender.trim(), balance,
      // The starting balance defaults to today's, so progress can be tracked from here.
      original_balance: f.original_balance ? parseMoney(f.original_balance) : (debt?.original_balance || balance),
      interest_rate: parseFloat(f.interest_rate) || 0, minimum_payment: parseMoney(f.minimum_payment),
      due_day: Math.min(31, Math.max(0, parseInt(f.due_day) || 0)), notes: f.notes,
    };
    try {
      if (debt) await updateDebt(debt.id, data);
      else await createDebt(data);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!debt) return;
    try {
      await deleteDebt(debt.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal open={open} title={debt ? "Edit debt" : "Add a debt"} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <TextInput label="Name" required placeholder="Chase Visa" value={f.name ?? ""} onChange={set("name")} />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Type" value={f.type ?? ""} onChange={set("type")}
            options={DEBT_TYPES.map((t) => ({ value: t, label: `${DEBT_EMOJI[t]} ${DEBT_LABELS[t]}` }))} />
          <TextInput label="Lender" value={f.lender ?? ""} onChange={set("lender")} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <MoneyInput label="Balance today" required value={f.balance ?? ""} onChange={set("balance")} />
          <MoneyInput label="Starting balance" value={f.original_balance ?? ""} onChange={set("original_balance")}
            hint="What it was when you started paying it down." />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <TextInput label="APR %" type="number" step="0.01" min="0" inputMode="decimal" value={f.interest_rate ?? ""} onChange={set("interest_rate")} />
          <MoneyInput label="Monthly payment" value={f.minimum_payment ?? ""} onChange={set("minimum_payment")} />
          <TextInput label="Due day" type="number" min="1" max="31" value={f.due_day ?? ""} onChange={set("due_day")} />
        </div>
        <TextArea label="Notes" value={f.notes ?? ""} onChange={set("notes")} />
        <ErrorNote message={error} />
        <FormActions saving={busy} color="coral" onDelete={debt ? remove : undefined} deleteLabel="Delete debt"
          submitLabel={debt ? "Save" : "Add debt"} />
      </form>
    </Modal>
  );
}

function PaymentModal({ debt, onClose, onSaved }: { debt: Debt; onClose: () => void; onSaved: () => void }) {
  const [payments, setPayments] = useState<DebtPayment[]>([]);
  const [amount, setAmount] = useState(debt.minimum_payment ? String(debt.minimum_payment) : "");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => listPayments(debt.id).then(setPayments).catch((e) => setError(errorMessage(e))), [debt.id]);
  useEffect(() => { load(); }, [load]);

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    const v = parseMoney(amount);
    if (v <= 0) return setError("Enter the payment amount.");
    setBusy(true);
    setError(null);
    try {
      await createPayment({ debt: debt.id, amount: v, date: toPbDate(date), note: note.trim() });
      setNote("");
      await load();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`Pay ${debt.name}`} onClose={onClose} color="mint">
      <div className="mb-4 rounded-2xl bg-white/70 p-4 text-center">
        <div className="text-xs font-extrabold uppercase opacity-70">Balance</div>
        <div className="num text-3xl font-black">{money(debt.balance)}</div>
      </div>
      <form onSubmit={pay} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <MoneyInput label="Payment" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <TextInput label="Date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <TextInput label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Extra payment" />
        <ErrorNote message={error} />
        <button className="btn c-mint w-full" disabled={busy}>{busy ? "Saving…" : "Record payment"}</button>
        <p className="text-center text-xs font-semibold opacity-70">The balance goes down by the payment. Deleting a payment puts it back.</p>
      </form>
      <div className="mt-5">
        <div className="mb-2 font-black">Payment history</div>
        {payments.length === 0 ? <p className="text-sm font-semibold opacity-70">No payments recorded yet.</p> : (
          <ul className="space-y-2">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center gap-3 rounded-2xl bg-white/70 px-4 py-2">
                <span className="w-16 text-xs font-extrabold opacity-70">{shortDate(fromPbDate(p.date))}</span>
                <span className="flex-1 truncate font-bold">{p.note || "Payment"}</span>
                <span className="num font-black">{money(p.amount, { cents: true })}</span>
                <button className="opacity-50 hover:opacity-100" aria-label="Delete payment" onClick={async () => {
                  await deletePayment(p.id).catch((e) => setError(errorMessage(e)));
                  await load();
                  onSaved();
                }}><Icon name="trash" className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
