import { useMemo, useState } from "react";
import {
  errorMessage, importBudgets, listAssets, listDebts, listEnvelopes, listSimplefinAccounts, pullSimplefin, syncRecords,
  toPbDate, updateAsset, updateDebt, updateEnvelope, updateSimplefinAccount,
} from "~/backend/api";
import { COLORS, type Asset, type Debt, type Envelope, type SimplefinAccount } from "~/backend/types";
import { ErrorNote, Modal, cx } from "~/components/ui";
import {
  accountExternalId, envelopeExternalId, guessEnvelopeStyle, parseCsv, planImport,
  type AccountKind, type FoundAccount, type ImportPlan,
} from "~/lib/importer";
import { shortDate } from "~/lib/dates";
import { money, parseMoney } from "~/lib/money";
import { defaultUse, suggestMatch } from "~/lib/simplefin";

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

interface AccountChoice {
  found: FoundAccount;
  kind: AccountKind | "skip";
  /** What's already in the app under this name: a bank account (asset) or a card (debt). */
  asset: Asset | null;
  debt: Debt | null;
  balance: string;
  /** The SimpleFIN account it is, if any: its balance fills in, and new transactions come from it after the import. */
  sfin: string;
}

/** The day after a "YYYY-MM-DD" day. */
function dayAfter(day: string): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 1));
  return d.toISOString().slice(0, 10);
}

/** What a SimpleFIN balance means for this kind of account: what a card owes is positive. */
function sfinAmount(a: SimplefinAccount, card: boolean): number {
  return card ? Math.max(0, -a.balance) : a.balance;
}

const ACCOUNT_KINDS: { value: AccountKind | "skip"; label: string }[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit card" },
  { value: "cash", label: "Cash" },
  { value: "skip", label: "Skip" },
];

const LOOKS_ANNUAL = /christmas|holiday|annual|yearly|birthday/i;

/** Imports a transaction history spreadsheet (CSV), e.g. a Goodbudget export. */
export function ImportHistory({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [fileName, setFileName] = useState("");
  const [choices, setChoices] = useState<EnvelopeChoice[]>([]);
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [sfinAccounts, setSfinAccounts] = useState<SimplefinAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function reset() {
    setPlan(null);
    setFileName("");
    setChoices([]);
    setAccounts([]);
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
      const [existing, assets, debts, sfinAll] = await Promise.all([
        listEnvelopes(), listAssets(), listDebts(), listSimplefinAccounts().catch(() => [] as SimplefinAccount[]),
      ]);
      const sfin = sfinAll.filter((s) => s.use !== "ignore");
      setSfinAccounts(sfin);
      const taken = new Set<string>();
      const find = <T extends { name: string; external_id: string }>(list: T[], name: string) =>
        list.find((r) => r.external_id === accountExternalId(name)) ??
        list.find((r) => r.name.trim().toLowerCase() === name.toLowerCase()) ?? null;
      setAccounts(p.accounts.map((a) => {
        const asset = find(assets, a.name);
        const debt = find(debts, a.name);
        // What's already in the app wins over the guess.
        const kind = debt && !asset ? "credit_card"
          : asset && !debt && ["checking", "savings", "cash"].includes(asset.type) ? asset.type as AccountKind
          : a.type;
        // A SimpleFIN account already filling this asset or debt, or the one whose name fits best.
        const linked = sfin.find((s) => (asset && s.asset === asset.id) || (debt && s.debt === debt.id));
        const match = linked ?? suggestMatch(a.name, kind, sfin.filter((s) => !s.asset && !s.debt && !taken.has(s.id)));
        if (match) taken.add(match.id);
        return { found: a, kind, asset, debt, balance: "", sfin: match?.id ?? "" };
      }));
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
  const changeAccount = (i: number, patch: Partial<AccountChoice>) =>
    setAccounts((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  async function runImport() {
    if (!plan) return;
    setError(null);
    try {
      const openingDate = `${plan.lastDate} 23:59:59.999Z`;
      setProgress("Setting up accounts…");
      const lastDay = toPbDate(plan.lastDate);
      // Bank accounts are assets and cards are debts. Each gets an id to match on.
      const assetIds = new Map<string, string>();
      const debtIds = new Map<string, string>();
      const assetRecords: object[] = [];
      const debtRecords: object[] = [];
      const finalBalances: object[] = [];
      const sfinById = new Map(sfinAccounts.map((s) => [s.id, s]));
      for (const a of accounts) {
        if (a.kind === "skip") continue;
        const name = a.found.name;
        const fromBank = sfinById.get(a.sfin);
        const typed = a.balance !== "" ? parseMoney(a.balance) : fromBank ? sfinAmount(fromBank, a.kind === "credit_card") : null;
        if (a.kind === "credit_card") {
          const ext = a.debt?.external_id || accountExternalId(name);
          if (a.debt && !a.debt.external_id) await updateDebt(a.debt.id, { external_id: ext });
          if (!a.debt) debtRecords.push({ external_id: ext, name, type: "credit_card", balance: 0 });
          // Card payments below lower the balance; this puts it back where it belongs.
          finalBalances.push({ external_id: ext, balance: typed ?? a.debt?.balance ?? 0 });
          debtIds.set(name, ext);
        } else {
          const ext = a.asset?.external_id || accountExternalId(name);
          if (a.asset && !a.asset.external_id) await updateAsset(a.asset.id, { external_id: ext });
          if (!a.asset) assetRecords.push({ external_id: ext, name, type: a.kind, value: typed ?? 0, as_of: lastDay });
          else if (typed !== null) assetRecords.push({ external_id: ext, value: typed, as_of: lastDay });
          assetIds.set(name, ext);
        }
      }
      if (assetRecords.length) await syncRecords("assets", assetRecords);
      if (debtRecords.length) await syncRecords("debts", debtRecords);

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
        ...(assetIds.has(t.account) ? { account_asset_external_id: assetIds.get(t.account) } : { account_asset: "" }),
        ...(debtIds.has(t.account) ? { account_debt_external_id: debtIds.get(t.account) } : { account_debt: "" }),
        ...(t.envelope ? { envelope_external_id: ids.get(t.envelope) } : { envelope: "" }),
      })), (n) => setProgress(`Adding transactions: ${n.toLocaleString()} of ${total.toLocaleString()}`));

      // Money moved into a card is a payment on it, from the account that paid.
      const payments = plan.transfers.filter((t) => debtIds.has(t.to)).map((t) => ({
        external_id: t.external_id, debt_external_id: debtIds.get(t.to), date: toPbDate(t.date), amount: t.amount,
        note: [t.payee, t.note].filter(Boolean).join(" · "),
        ...(assetIds.has(t.from) ? { from_asset_external_id: assetIds.get(t.from) } : { from_asset: "" }),
      }));
      if (payments.length) {
        setProgress("Adding card payments…");
        await syncRecords("debt_payments", payments);
      }
      if (finalBalances.length) await syncRecords("debts", finalBalances);

      // Matched SimpleFIN accounts take over from the day after the file ends.
      const linkedAccounts = accounts.filter((a) => a.kind !== "skip" && a.sfin);
      let pullNote = "";
      if (linkedAccounts.length) {
        setProgress("Linking SimpleFIN accounts…");
        const [assetsNow, debtsNow] = await Promise.all([listAssets(), listDebts()]);
        const connections = new Set<string>();
        for (const a of linkedAccounts) {
          const card = a.kind === "credit_card";
          const ext = card ? debtIds.get(a.found.name) : assetIds.get(a.found.name);
          const target = card ? debtsNow.find((d) => d.external_id === ext) : assetsNow.find((x) => x.external_id === ext);
          if (!target) continue;
          await updateSimplefinAccount(a.sfin, {
            use: defaultUse(a.kind), asset: card ? "" : target.id, debt: card ? target.id : "",
            sync_from: toPbDate(dayAfter(plan.lastDate)),
          });
          const s = sfinById.get(a.sfin);
          if (s) connections.add(s.connection);
        }
        setProgress("Pulling new transactions from SimpleFIN…");
        let pulled = 0;
        for (const c of connections) {
          try {
            pulled += (await pullSimplefin(c)).transactions;
          } catch (err) {
            pullNote = ` SimpleFIN couldn't pull just now (${errorMessage(err)}); it will try again tomorrow morning.`;
          }
        }
        if (!pullNote) {
          pullNote = ` ${linkedAccounts.length} account${linkedAccounts.length === 1 ? " is" : "s are"} linked to SimpleFIN` +
            `, with ${pulled} newer transaction${pulled === 1 ? "" : "s"} pulled.`;
        }
      }

      setProgress(null);
      const made = assetIds.size + debtIds.size;
      setDone(`Imported ${total.toLocaleString()} transactions, ${choices.length} envelopes` +
        (made ? `, ${made} account${made === 1 ? "" : "s"} and ${payments.length} card payment${payments.length === 1 ? "" : "s"}` : "") +
        ". Importing the same file again won't make duplicates." + pullNote);
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
              {plan.transfers.length > 0 && <> · {plan.transfers.length} transfer{plan.transfers.length === 1 ? "" : "s"} between accounts</>}
              {plan.skipped.accountMoves > 0 && <> · {plan.skipped.accountMoves} one-sided account moves skipped</>}
              {plan.skipped.adjustments > 0 && <> · {plan.skipped.adjustments} balance adjustments skipped</>}
            </div>
            {plan.problems.length > 0 && (
              <div className="mt-2 text-[#c45c5c]">
                {plan.problems.length} row(s) couldn't be read and will be left out: {plan.problems.slice(0, 3).join(" ")}
              </div>
            )}
          </div>

          {accounts.length > 0 && (
            <div>
              <div className="font-black">Accounts</div>
              <p className="text-sm font-semibold opacity-80">
                Checking, savings and cash accounts go on Assets, and credit cards on Debts. Transfers from an account
                into a card become payments on the card. Check each guess, and enter what the account held
                (or what the card owed) on {shortDate(plan.lastDate)}.
                {sfinAccounts.length > 0 && <> Match each one to its SimpleFIN account to fill in today's balance and
                  bring in transactions after {shortDate(plan.lastDate)} every morning.</>}
              </p>
              <ul className="mt-3 space-y-2">
                {accounts.map((a, i) => {
                  const card = a.kind === "credit_card";
                  const existing = card ? a.debt : a.kind === "skip" ? null : a.asset;
                  return (
                    <li key={a.found.name} className={cx("rounded-2xl bg-white/70 p-3", a.kind === "skip" && "opacity-60")}>
                      <div className="min-w-0">
                        <span className="font-black">{a.found.name}</span>
                        <span className="ml-2 text-xs font-bold opacity-70">
                          {a.found.count} entries · {a.found.reason}
                          {existing && " · already in the app"}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr]">
                        <div className="flex flex-wrap rounded-3xl bg-white p-1 text-sm font-black" role="radiogroup" aria-label={`${a.found.name} kind`}>
                          {ACCOUNT_KINDS.map((k) => (
                            <button key={k.value} type="button" role="radio" aria-checked={a.kind === k.value}
                              onClick={() => changeAccount(i, { kind: k.value })}
                              className={cx("flex-1 whitespace-nowrap rounded-full px-3 py-1", a.kind === k.value ? "c-sky" : "opacity-60")}
                              style={a.kind === k.value ? { background: "var(--c)" } : undefined}>
                              {k.label}
                            </button>
                          ))}
                        </div>
                        {a.kind !== "skip" && sfinAccounts.length > 0 && (
                          <select className="input appearance-none py-2 text-sm sm:col-span-2" aria-label={`${a.found.name} SimpleFIN account`}
                            value={a.sfin} onChange={(e) => changeAccount(i, { sfin: e.target.value })}>
                            <option value="">Not in SimpleFIN (enter by hand)</option>
                            {sfinAccounts.map((s) => (
                              <option key={s.id} value={s.id}
                                disabled={accounts.some((o, j) => j !== i && o.kind !== "skip" && o.sfin === s.id)}>
                                SimpleFIN: {s.name}{s.org ? ` (${s.org})` : ""}
                              </option>
                            ))}
                          </select>
                        )}
                        {a.kind !== "skip" && (
                          <SmallMoney label={card ? `${a.found.name} owed` : `${a.found.name} balance`}
                            placeholder={sfinAccounts.some((s) => s.id === a.sfin)
                              ? `${money(sfinAmount(sfinAccounts.find((s) => s.id === a.sfin)!, card))} from SimpleFIN`
                              : existing
                              ? `Keep ${money(card ? a.debt!.balance : a.asset!.value)}`
                              : `${card ? "Owed" : "Balance"} ${shortDate(plan.lastDate)}`}
                            allowNegative={!card} value={a.balance} onChange={(v) => changeAccount(i, { balance: v })} />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

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
