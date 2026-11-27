import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  connectSimplefin, createAsset, createDebt, disconnectSimplefin, errorMessage, listAssets, listDebts,
  listSimplefinAccounts, listSimplefinConnections, pullSimplefin, simplefinMinute, toPbDate, updateSimplefinAccount,
  type SimplefinPull,
} from "~/backend/api";
import type { Asset, Debt, SimplefinAccount, SimplefinConnection } from "~/backend/types";
import { Button, Card, ErrorNote, Icon, Modal, SectionTitle, cx } from "~/components/ui";
import { shortDate, todayISO } from "~/lib/dates";
import { money } from "~/lib/money";
import {
  ACCOUNT_KIND_OPTIONS, defaultUse, guessKind, kindOption, morningHourUtc, pullTimeLabel, type AccountUse,
} from "~/lib/simplefin";

export function meta() {
  return [{ title: "Bank accounts · Finance Tracker" }];
}

const BRIDGE_URL = "https://beta-bridge.simplefin.org/";

const USES: { value: AccountUse; label: string; hint: string }[] = [
  { value: "spending", label: "Budget transactions", hint: "Spending and deposits come into the budget, and the balance stays current." },
  { value: "balance", label: "Balance only", hint: "Just the balance, on Assets or Debts. Good for savings, loans and retirement." },
  { value: "ignore", label: "Don't use", hint: "Leave this account out." },
];

/** What someone has chosen for one account, before it's saved. */
interface Choice {
  use: AccountUse;
  /** "new", or "asset:<id>" / "debt:<id>" for something already in the app. */
  target: string;
  /** What a new one is (see ACCOUNT_KIND_OPTIONS). */
  kind: string;
  /** Bring in transactions from this day (YYYY-MM-DD). */
  from: string;
}

const firstOfMonth = () => `${todayISO().slice(0, 7)}-01`;

function initialChoice(a: SimplefinAccount, assets: Asset[], debts: Debt[]): Choice {
  const kind = guessKind(a.name, a.balance);
  const side = kindOption(kind).side;
  const same = (n: string) => n.trim().toLowerCase() === a.name.trim().toLowerCase();
  const byName = side === "asset" ? assets.find((x) => same(x.name)) : debts.find((x) => same(x.name));
  const target = a.asset ? `asset:${a.asset}` : a.debt ? `debt:${a.debt}` : byName ? `${side}:${byName.id}` : "new";
  return {
    use: a.use || defaultUse(kind),
    target,
    kind,
    from: a.sync_from ? a.sync_from.slice(0, 10) : firstOfMonth(),
  };
}

function savedTarget(a: SimplefinAccount) {
  return a.asset ? `asset:${a.asset}` : a.debt ? `debt:${a.debt}` : "";
}

function needsSaving(a: SimplefinAccount, c: Choice) {
  if (!a.use) return true;
  if (a.use !== c.use) return true;
  if (c.use === "ignore") return false;
  if (c.target === "new" || c.target !== savedTarget(a)) return true;
  return c.use === "spending" && c.from !== a.sync_from.slice(0, 10);
}

/** "today at 6:48 AM" or "Nov 25". */
function when(value: string): string {
  if (!value) return "never";
  const d = new Date(value.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "never";
  return new Date().toDateString() === d.toDateString()
    ? `today at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function AccountsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const welcome = params.get("welcome") === "1";
  const [connections, setConnections] = useState<SimplefinConnection[] | null>(null);
  const [accounts, setAccounts] = useState<SimplefinAccount[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [minute, setMinute] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [c, a, as, ds] = await Promise.all([listSimplefinConnections(), listSimplefinAccounts(), listAssets(), listDebts()]);
      setConnections(c);
      setAccounts(a);
      setAssets(as);
      setDebts(ds);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    reload();
    simplefinMinute().then(setMinute).catch(() => setMinute(null));
  }, [reload]);

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle action={connections && connections.length > 0 && (
        <Button small color="aqua" onClick={() => setConnecting(true)}><Icon name="plus" className="h-5 w-5" /> Connect more</Button>
      )}>Bank accounts</SectionTitle>

      {welcome && (
        <Card color="mint" className="pop-in mb-6 p-5">
          <div className="flex flex-wrap items-start gap-4">
            <span className="bob text-5xl" aria-hidden="true">👋</span>
            <div className="min-w-0 flex-1">
              <h3 className="text-xl font-black">Welcome! Connect your banks first?</h3>
              <p className="mt-1 font-semibold opacity-80">
                With SimpleFIN, balances and new transactions come in every morning on their own: checking and cards
                into the budget, savings, loans and retirement onto Assets and Debts. You can also skip this and type
                everything in by hand, and connect later from the bank button at the top.
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap justify-end gap-3">
            <Button color="white" onClick={() => navigate("/budget")}>Skip, I'll enter accounts by hand</Button>
          </div>
        </Card>
      )}

      <p className="-mt-2 mb-5 font-semibold opacity-80">
        Accounts come from <a className="underline" href={BRIDGE_URL} target="_blank" rel="noreferrer">SimpleFIN Bridge</a>,
        which connects to your banks. Pick what each account is for: everyday accounts bring their transactions into
        the budget, and the rest just keep their balance current. Anything can still be entered by hand.
      </p>
      <ErrorNote message={error} />

      {!connections ? (
        <div className="py-16 text-center text-5xl"><span className="bob inline-block">🏦</span></div>
      ) : connections.length === 0 ? (
        <ConnectForm onConnected={reload} />
      ) : (
        <div className="space-y-6">
          {connections.map((c) => (
            <ConnectionCard key={c.id} connection={c} minute={minute}
              accounts={accounts.filter((a) => a.connection === c.id)} assets={assets} debts={debts} onChange={reload} />
          ))}
          {welcome && (
            <div className="flex justify-end">
              <Button color="mint" onClick={() => navigate("/budget")}>Done, show me the budget</Button>
            </div>
          )}
        </div>
      )}

      <Modal open={connecting} title="Connect more accounts" onClose={() => setConnecting(false)} color="aqua">
        <ConnectForm compact onConnected={() => { setConnecting(false); reload(); }} />
      </Modal>
    </div>
  );
}

function ConnectForm({ onConnected, compact }: { onConnected: () => void; compact?: boolean }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await connectSimplefin(token.trim(), morningHourUtc(6));
      setToken("");
      if (res.error) setError(`Connected, but the first pull failed: ${res.error}`);
      onConnected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <form onSubmit={connect} className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm font-semibold opacity-90">
        <li>Open <a className="underline" href={BRIDGE_URL} target="_blank" rel="noreferrer">SimpleFIN Bridge</a>, sign in, and connect your banks there.</li>
        <li>Under <b>Apps</b>, make a <b>setup token</b> for this app and copy it.</li>
        <li>Paste it below. Each token works once; the app keeps the connection, not the token.</li>
      </ol>
      <div>
        <label htmlFor="sfin-token" className="field-label">Setup token</label>
        <textarea id="sfin-token" className="input min-h-[90px] font-mono text-xs" required value={token}
          onChange={(e) => setToken(e.target.value)} placeholder="aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3Jn…" />
      </div>
      <ErrorNote message={error} />
      <div className="flex justify-end">
        <button type="submit" className="btn c-aqua" disabled={busy || !token.trim()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
  if (compact) return body;
  return (
    <Card color="aqua" className="pop-in p-5">
      <div className="mb-3 flex items-center gap-3">
        <span className="text-4xl" aria-hidden="true">🏦</span>
        <h3 className="text-xl font-black">Connect SimpleFIN</h3>
      </div>
      {body}
    </Card>
  );
}

function ConnectionCard({ connection, accounts, assets, debts, minute, onChange }: {
  connection: SimplefinConnection; accounts: SimplefinAccount[]; assets: Asset[]; debts: Debt[];
  minute: number | null; onChange: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Keep what someone is choosing; fill in accounts that are new to the page.
  useEffect(() => {
    setChoices((prev) => {
      const next: Record<string, Choice> = {};
      for (const a of accounts) next[a.id] = prev[a.id] ?? initialChoice(a, assets, debts);
      return next;
    });
  }, [accounts, assets, debts]);

  const pending = accounts.filter((a) => choices[a.id] && needsSaving(a, choices[a.id]));
  const unchosen = accounts.filter((a) => !a.use).length;

  function describe(r: SimplefinPull) {
    const parts = [`${r.transactions} new transaction${r.transactions === 1 ? "" : "s"}`];
    if (r.payments) parts.push(`${r.payments} card payment${r.payments === 1 ? "" : "s"}`);
    return `Pulled ${r.accounts} account${r.accounts === 1 ? "" : "s"}: ${parts.join(" and ")}.`;
  }

  async function saveAndPull() {
    setBusy("Saving…");
    setError(null);
    setResult(null);
    try {
      for (const a of pending) {
        const c = choices[a.id];
        if (c.use === "ignore") {
          await updateSimplefinAccount(a.id, { use: "ignore", asset: "", debt: "" });
          continue;
        }
        let target = c.target;
        if (target === "new") {
          const k = kindOption(c.kind);
          const day = (a.balance_date || toPbDate(todayISO())).slice(0, 10);
          if (k.side === "asset") {
            const made = await createAsset({ name: a.name, type: k.type as Asset["type"], institution: a.org, value: a.balance, as_of: toPbDate(day) });
            target = `asset:${made.id}`;
          } else {
            const owed = a.balance < 0 ? -a.balance : k.type === "credit_card" ? 0 : a.balance;
            const made = await createDebt({ name: a.name, type: k.type as Debt["type"], lender: a.org, balance: owed, original_balance: owed });
            target = `debt:${made.id}`;
          }
        }
        const [side, id] = target.split(":");
        await updateSimplefinAccount(a.id, {
          use: c.use,
          asset: side === "asset" ? id : "",
          debt: side === "debt" ? id : "",
          ...(c.use === "spending" ? { sync_from: toPbDate(c.from) } : {}),
        });
      }
      setBusy("Pulling…");
      setResult(describe(await pullSimplefin(connection.id)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      onChange();
    }
  }

  async function pullNow() {
    setBusy("Pulling…");
    setError(null);
    setResult(null);
    try {
      setResult(describe(await pullSimplefin(connection.id)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      onChange();
    }
  }

  async function disconnect() {
    if (!window.confirm(`Disconnect ${connection.label || "SimpleFIN"}? Its accounts stop updating. Everything it already brought in stays.`)) return;
    try {
      await disconnectSimplefin(connection.id);
      onChange();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card className="pop-in p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xl font-black">{connection.label || "SimpleFIN"}</h3>
          <div className="text-sm font-bold opacity-70">
            Last pulled {when(connection.last_sync)}
            {minute !== null && <> · pulls every morning at {pullTimeLabel(connection.sync_hour_utc, minute)}</>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button small color="white" disabled={!!busy} onClick={pullNow}>Pull now</Button>
          <button className="btn-ghost text-sm" onClick={disconnect} aria-label={`Disconnect ${connection.label}`}>
            <Icon name="trash" className="h-4 w-4" /> Disconnect
          </button>
        </div>
      </div>

      {connection.last_error && (
        <div className="c-butter chunk mt-3 whitespace-pre-line px-4 py-3 text-sm font-bold" style={{ borderRadius: 18, boxShadow: "0 4px 0 var(--cd)" }}>
          {connection.last_error}
        </div>
      )}

      {accounts.length === 0 ? (
        <p className="mt-4 font-semibold opacity-80">No accounts yet. Connect a bank on SimpleFIN Bridge, then pull again.</p>
      ) : (
        <>
          {unchosen > 0 && (
            <p className="mt-4 text-sm font-bold">
              <span className="pill c-peach mr-2">New</span>
              Choose what {unchosen === 1 ? "this account is" : `these ${unchosen} accounts are`} for, then save.
            </p>
          )}
          <ul className="mt-4 space-y-3">
            {accounts.map((a) => choices[a.id] && (
              <AccountRow key={a.id} account={a} choice={choices[a.id]} assets={assets} debts={debts}
                onChange={(patch) => setChoices((cs) => ({ ...cs, [a.id]: { ...cs[a.id], ...patch } }))} />
            ))}
          </ul>
        </>
      )}

      <div className="mt-4 space-y-3">
        <ErrorNote message={error} />
        {result && <div className="c-mint chunk px-4 py-3 text-sm font-bold" role="status" style={{ borderRadius: 18, boxShadow: "0 4px 0 var(--cd)" }}>{result}</div>}
        {pending.length > 0 && (
          <div className="flex justify-end">
            <Button color="mint" disabled={!!busy} onClick={saveAndPull}>
              {busy ?? `Save ${pending.length} account${pending.length === 1 ? "" : "s"} and pull`}
            </Button>
          </div>
        )}
        {busy && pending.length === 0 && <div className="text-right text-sm font-bold opacity-70">{busy}</div>}
      </div>
    </Card>
  );
}

function AccountRow({ account: a, choice: c, assets, debts, onChange }: {
  account: SimplefinAccount; choice: Choice; assets: Asset[]; debts: Debt[]; onChange: (patch: Partial<Choice>) => void;
}) {
  const owes = a.balance < 0;
  const targets = useMemo(() => [
    { value: "new", label: "Add it as a new account" },
    ...assets.map((x) => ({ value: `asset:${x.id}`, label: `Assets: ${x.name}` })),
    ...debts.map((x) => ({ value: `debt:${x.id}`, label: `Debts: ${x.name}` })),
  ], [assets, debts]);

  return (
    <li className={cx("rounded-2xl bg-white/70 p-3", c.use === "ignore" && "opacity-60")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-black">{a.name}</span>
          {!a.use && <span className="pill c-peach ml-2 text-xs">New</span>}
          <span className="ml-2 text-xs font-bold opacity-70">
            {a.org}{a.last_pulled && ` · transactions through ${shortDate(a.last_pulled)}`}
          </span>
        </div>
        <span className="num font-black">{owes ? `${money(-a.balance)} owed` : money(a.balance)}</span>
      </div>

      <div className="mt-2 flex flex-wrap rounded-3xl bg-white p-1 text-sm font-black" role="radiogroup" aria-label={`${a.name} use`}>
        {USES.map((u) => (
          <button key={u.value} type="button" role="radio" aria-checked={c.use === u.value} title={u.hint}
            onClick={() => onChange({ use: u.value })}
            className={cx("flex-1 whitespace-nowrap rounded-full px-3 py-1", c.use === u.value ? "c-sky" : "opacity-60")}
            style={c.use === u.value ? { background: "var(--c)" } : undefined}>
            {u.label}
          </button>
        ))}
      </div>

      {c.use !== "ignore" && (
        <div className={cx("mt-2 grid gap-2", c.target === "new" ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
          <select className="input appearance-none py-2 text-sm" aria-label={`${a.name} goes on`} value={c.target}
            onChange={(e) => onChange({ target: e.target.value })}>
            {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {c.target === "new" && (
            <select className="input appearance-none py-2 text-sm" aria-label={`${a.name} kind`} value={c.kind}
              onChange={(e) => onChange({ kind: e.target.value })}>
              {ACCOUNT_KIND_OPTIONS.map((k) => (
                <option key={k.value} value={k.value}>{k.label} ({k.side === "asset" ? "Assets" : "Debts"})</option>
              ))}
            </select>
          )}
          {c.use === "spending" && (
            <label className="flex items-center gap-2 text-sm font-bold">
              <span className="whitespace-nowrap opacity-80">Transactions from</span>
              <input type="date" className="input py-2 text-sm" aria-label={`${a.name} transactions from`} value={c.from}
                onChange={(e) => onChange({ from: e.target.value })} />
            </label>
          )}
        </div>
      )}
    </li>
  );
}
