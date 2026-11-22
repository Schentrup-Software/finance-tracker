import { useMemo, useState } from "react";
import { errorMessage, importBudgets, listEnvelopes, syncRecords, toPbDate, updateEnvelope } from "~/backend/api";
import { COLORS, type Envelope } from "~/backend/types";
import { ErrorNote, Modal, cx } from "~/components/ui";
import { envelopeExternalId, guessEnvelopeStyle, parseCsv, planImport, type ImportPlan } from "~/lib/importer";
import { shortDate } from "~/lib/dates";
import { money, parseMoney } from "~/lib/money";

interface EnvelopeChoice {
  name: string;
  lastUsed: string;
  count: number;
  existing: Envelope | null;
  period: "monthly" | "annual";
  goal: string;
  monthly: string;
  balance: string;
  active: boolean;
}

const LOOKS_ANNUAL = /christmas|holiday|annual|yearly|birthday/i;

/** Imports a transaction history spreadsheet (CSV), e.g. a Goodbudget export. */
export function ImportHistory({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [fileName, setFileName] = useState("");
  const [choices, setChoices] = useState<EnvelopeChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function reset() {
    setPlan(null);
    setFileName("");
    setChoices([]);
    setError(null);
    setProgress(null);
    setDone(null);
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    reset();
    setFileName(file.name);
    try {
      if (/\.xlsx?$/i.test(file.name)) throw new Error("Save the spreadsheet as CSV first (File → Save As → CSV), then pick that file.");
      const p = planImport(parseCsv(await file.text()));
      if (p.transactions.length === 0) throw new Error("No transactions were found in that file.");
      const existing = await listEnvelopes();
      const byName = new Map(existing.map((e) => [e.name.trim().toLowerCase(), e]));
      const yearAgo = `${Number(p.lastDate.slice(0, 4)) - 1}${p.lastDate.slice(4)}`;
      setChoices(p.envelopes.map((f) => {
        const ex = byName.get(f.name.toLowerCase()) ?? null;
        const annual = ex ? ex.period === "annual" : LOOKS_ANNUAL.test(f.name);
        return {
          name: f.name, lastUsed: f.lastUsed, count: f.count, existing: ex,
          period: annual ? "annual" : "monthly",
          goal: ex?.goal ? String(ex.goal) : "",
          monthly: ex?.default_amount ? String(ex.default_amount) : "",
          balance: "",
          active: ex ? !ex.archived : f.lastUsed > yearAgo,
        };
      }));
      setPlan(p);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const change = (i: number, patch: Partial<EnvelopeChoice>) =>
    setChoices((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  async function runImport() {
    if (!plan) return;
    setError(null);
    try {
      const openingDate = `${plan.lastDate} 23:59:59.999Z`;
      setProgress("Setting up envelopes…");
      // Envelopes already in the app keep their settings; they only get an id to match on.
      const ids = new Map<string, string>();
      for (const c of choices) {
        if (c.existing && !c.existing.external_id) await updateEnvelope(c.existing.id, { external_id: envelopeExternalId(c.name) });
        ids.set(c.name, c.existing?.external_id || envelopeExternalId(c.name));
      }
      await syncRecords("envelopes", choices.map((c, i) => {
        const opening = { opening_balance: parseMoney(c.balance), opening_date: openingDate };
        const common = { external_id: ids.get(c.name)!, period: c.period, goal: parseMoney(c.goal), rollover: true, archived: !c.active, ...opening };
        if (c.existing) return { ...common, default_amount: c.monthly === "" ? c.existing.default_amount : parseMoney(c.monthly) };
        const style = guessEnvelopeStyle(c.name);
        return {
          ...common, name: c.name, emoji: style.emoji, group: style.group,
          color: COLORS[i % COLORS.length], default_amount: parseMoney(c.monthly), sort: 100 + i,
        };
      }));

      setProgress("Adding the months…");
      const months = plan.months.map((m) => ({
        month: m.month,
        planned_income: m.income,
        allocations: Object.entries(m.moved).map(([name, amount]) => ({ envelope_external_id: ids.get(name)!, amount })),
      }));
      for (let i = 0; i < months.length; i += 120) await importBudgets(months.slice(i, i + 120));

      const total = plan.transactions.length;
      setProgress(`Adding transactions: 0 of ${total.toLocaleString()}`);
      await syncRecords("transactions", plan.transactions.map((t) => ({
        external_id: t.external_id, kind: t.kind, date: toPbDate(t.date), amount: t.amount,
        payee: t.payee, note: t.note, account: t.account,
        ...(t.envelope ? { envelope_external_id: ids.get(t.envelope) } : { envelope: "" }),
      })), (n) => setProgress(`Adding transactions: ${n.toLocaleString()} of ${total.toLocaleString()}`));

      setProgress(null);
      setDone(`Imported ${total.toLocaleString()} transactions and ${choices.length} envelopes. Importing the same file again won't make duplicates.`);
      onDone();
    } catch (err) {
      setProgress(null);
      setError(errorMessage(err));
    }
  }

  const income = useMemo(() => plan?.months.reduce((s, m) => s + m.income, 0) ?? 0, [plan]);
  const close = () => { if (!progress) { reset(); onClose(); } };

  return (
    <Modal open={open} title="Import history" onClose={close} wide>
      {done ? (
        <div className="text-center">
          <div className="bob text-5xl" aria-hidden="true">🎉</div>
          <p className="mt-3 font-bold">{done}</p>
          <button className="btn c-mint mt-5" onClick={close}>Done</button>
        </div>
      ) : !plan ? (
        <div className="space-y-4">
          <p className="font-semibold opacity-80">
            Pick a CSV of your transactions, like a Goodbudget export (Date, Envelope, Account, Name, Notes, Amount, Details).
            Spending, refunds, split transactions, income and envelope transfers come in. Envelopes are created as needed.
          </p>
          <label className="tray flex cursor-pointer flex-col items-center gap-2 p-8 text-center font-black">
            <span className="text-4xl" aria-hidden="true">📄</span>
            {fileName || "Choose a CSV file"}
            <input type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only" aria-label="History file"
              onChange={(e) => readFile(e.target.files?.[0])} />
          </label>
          <ErrorNote message={error} />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="tray p-4 text-sm font-bold">
            <div className="text-base font-black">
              {plan.transactions.length.toLocaleString()} transactions, {shortDate(plan.firstDate)}, {plan.firstDate.slice(0, 4)} to {shortDate(plan.lastDate)}, {plan.lastDate.slice(0, 4)}
            </div>
            <div className="mt-1 opacity-80">
              {plan.months.length} months · {money(income)} of income
              {plan.skipped.accountMoves > 0 && <> · {plan.skipped.accountMoves} account transfers and card payments skipped</>}
              {plan.skipped.adjustments > 0 && <> · {plan.skipped.adjustments} balance adjustments skipped</>}
            </div>
            {plan.problems.length > 0 && (
              <div className="mt-2 text-[#c45c5c]">
                {plan.problems.length} row(s) couldn't be read and will be left out: {plan.problems.slice(0, 3).join(" ")}
              </div>
            )}
          </div>

          <div>
            <div className="font-black">Envelopes</div>
            <p className="text-sm font-semibold opacity-80">
              The file doesn't say how much was put into each envelope every month, so enter what each one holds
              as of {shortDate(plan.lastDate)}. Balances count from there. Earlier months show what was spent.
            </p>
            <ul className="mt-3 space-y-2">
              {choices.map((c, i) => (
                <li key={c.name} className={cx("rounded-2xl bg-white/70 p-3", !c.active && "opacity-60")}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-black">{c.name}</span>
                      <span className="ml-2 text-xs font-bold opacity-70">
                        {c.count} entries · last {shortDate(c.lastUsed)}, {c.lastUsed.slice(0, 4)}
                        {c.existing && " · already in the app"}
                      </span>
                    </div>
                    <label className="flex items-center gap-2 text-sm font-bold">
                      <input type="checkbox" checked={c.active} onChange={(e) => change(i, { active: e.target.checked })} />
                      Keep in use
                    </label>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-[auto_1fr_1fr]">
                    <div className="col-span-2 flex rounded-full bg-white p-1 text-sm font-black sm:col-span-1" role="radiogroup" aria-label={`${c.name} type`}>
                      {(["monthly", "annual"] as const).map((p) => (
                        <button key={p} type="button" role="radio" aria-checked={c.period === p} onClick={() => change(i, { period: p })}
                          className={cx("flex-1 rounded-full px-3 py-1", c.period === p ? "c-sky" : "opacity-60")}
                          style={c.period === p ? { background: "var(--c)" } : undefined}>
                          {p === "monthly" ? "Monthly" : "Annual"}
                        </button>
                      ))}
                    </div>
                    <SmallMoney label={c.period === "annual" ? `${c.name} yearly goal` : `${c.name} monthly amount`}
                      placeholder={c.period === "annual" ? "Yearly goal" : "Per month"}
                      value={c.period === "annual" ? c.goal : c.monthly}
                      onChange={(v) => change(i, c.period === "annual" ? { goal: v } : { monthly: v })} />
                    <SmallMoney label={`${c.name} balance`} placeholder={`Balance ${shortDate(plan.lastDate)}`} allowNegative
                      value={c.balance} onChange={(v) => change(i, { balance: v })} />
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <ErrorNote message={error} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button className="btn-ghost" disabled={!!progress} onClick={reset}>Pick another file</button>
            <button className="btn c-mint" disabled={!!progress} onClick={runImport}>
              {progress ?? `Import ${plan.transactions.length.toLocaleString()} transactions`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SmallMoney({ label, placeholder, value, onChange, allowNegative }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; allowNegative?: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-black opacity-60">$</span>
      <input className="input num py-2 pl-7 text-sm" type="number" step="0.01" min={allowNegative ? undefined : 0} inputMode="decimal"
        aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
