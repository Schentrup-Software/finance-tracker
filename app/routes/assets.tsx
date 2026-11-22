import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  createAsset, deleteAsset, errorMessage, fromPbDate, listAssets, listDebts, subscribeAll, toPbDate, updateAsset,
} from "~/backend/api";
import { ASSET_TYPES, type Asset, type AssetType, type Debt } from "~/backend/types";
import {
  Button, Card, EmptyState, ErrorNote, FormActions, Icon, Modal, MoneyInput, SectionTitle, Select, Stat,
  TextArea, TextInput, cx,
} from "~/components/ui";
import { ASSET_EMOJI, ASSET_GROUPS, ASSET_LABELS, equity, groupFor, netWorth } from "~/lib/assets";
import { DEBT_EMOJI } from "~/lib/debts";
import { shortDate, todayISO } from "~/lib/dates";
import { money, parseMoney } from "~/lib/money";

export function meta() {
  return [{ title: "Assets · Finance Tracker" }];
}

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Asset | "new" | null>(null);

  const reload = useCallback(async () => {
    try {
      const [a, d] = await Promise.all([listAssets(), listDebts()]);
      setAssets(a);
      setDebts(d);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => subscribeAll(["assets", "debts", "debt_payments"], reload), [reload]);

  const debtsById = useMemo(() => new Map(debts.map((d) => [d.id, d])), [debts]);
  const totals = useMemo(() => netWorth(assets ?? [], debts), [assets, debts]);
  const groups = useMemo(() => ASSET_GROUPS.map((g) => {
    const items = (assets ?? []).filter((a) => groupFor(a.type).key === g.key);
    return { ...g, items, total: items.reduce((s, a) => s + a.value, 0) };
  }), [assets]);

  if (!assets) {
    return <div className="py-20 text-center text-5xl"><span className="bob inline-block">🏡</span><ErrorNote message={error} /></div>;
  }

  const linked = new Set(assets.flatMap((a) => a.debts ?? []));
  const unlinkedDebt = debts.filter((d) => !linked.has(d.id)).reduce((s, d) => s + d.balance, 0);

  return (
    <div>
      <ErrorNote message={error} />

      <Card color={totals.netWorth >= 0 ? "sky" : "peach"} className="pop-in p-6 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <Stat label="Net worth" value={<span className="text-5xl sm:text-6xl">{money(totals.netWorth)}</span>}
            hint="Everything you own, minus everything you owe." />
          <div className="grid grid-cols-2 gap-4 sm:text-right">
            <Stat label="Assets" value={<span className="text-2xl">{money(totals.totalAssets)}</span>} />
            <Stat label="Debts" value={<span className="text-2xl">−{money(totals.totalDebts)}</span>}
              hint={<Link to="/debts" className="underline underline-offset-2">See debts</Link>} />
          </div>
        </div>
        {totals.totalAssets > 0 && (
          <div className="mt-6">
            <div className="flex h-6 w-full overflow-hidden rounded-full bg-white/60" role="img"
              aria-label={groups.filter((g) => g.total > 0).map((g) => `${g.label} ${money(g.total)}`).join(", ")}>
              {groups.filter((g) => g.total > 0).map((g) => (
                <span key={g.key} className={`c-${g.color} h-full`} title={`${g.label}: ${money(g.total)}`}
                  style={{ width: `${(g.total / totals.totalAssets) * 100}%`, background: "var(--cd)" }} />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm font-extrabold">
              {groups.filter((g) => g.total > 0).map((g) => (
                <span key={g.key} className={`c-${g.color} inline-flex items-center gap-2`}>
                  <span className="h-3 w-3 rounded-full" style={{ background: "var(--cd)" }} />
                  {g.label} {money(g.total)}
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      <SectionTitle action={<Button small color="sky" onClick={() => setEditing("new")}><Icon name="plus" className="h-5 w-5" /> Add asset</Button>}>
        What you own
      </SectionTitle>

      {assets.length === 0 && (
        <EmptyState emoji="🏡" title="No assets yet">
          Add your home, cars, collectibles, savings, 401(k), IRA, HSA and anything else of value. Link a mortgage or
          car loan to see your equity.
        </EmptyState>
      )}

      {groups.filter((g) => g.items.length > 0).map((g) => (
        <section key={g.key} className="mb-8">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className={`c-${g.color} text-xl font-black`}>
              <span className="mr-2 inline-block h-3 w-3 rounded-full align-middle" style={{ background: "var(--cd)" }} />
              {g.label}
            </h3>
            <span className="num font-black opacity-80">{money(g.total)}</span>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((a, i) => (
              <AssetCard key={a.id} asset={a} color={g.color} index={i} debtsById={debtsById} onEdit={() => setEditing(a)} />
            ))}
          </div>
        </section>
      ))}

      {unlinkedDebt > 0 && assets.length > 0 && (
        <p className="tray px-5 py-4 text-sm font-bold">
          {money(unlinkedDebt)} of debt isn't tied to an asset (credit cards, student loans and so on). It still counts
          against net worth.
        </p>
      )}

      <AssetForm open={editing !== null} asset={editing === "new" ? null : editing} debts={debts}
        onClose={() => setEditing(null)} onSaved={reload} />
    </div>
  );
}

function AssetCard({ asset, color, index, debtsById, onEdit }: {
  asset: Asset; color: string; index: number; debtsById: Map<string, Debt>; onEdit: () => void;
}) {
  const type = (asset.type || "other") as AssetType;
  const tied = (asset.debts ?? []).map((id) => debtsById.get(id)).filter(Boolean) as Debt[];
  const eq = equity(asset, debtsById);
  const owedShare = asset.value > 0 ? Math.min(1, (asset.value - eq) / asset.value) : 0;

  return (
    <button type="button" onClick={onEdit}
      className={cx("chunk chunk-press pop-in flex flex-col p-5 text-left", `c-${color}`)} style={{ ["--i" as any]: index }}>
      <div className="flex items-start gap-3">
        <span className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-white/80 text-2xl" aria-hidden="true">
          {ASSET_EMOJI[type]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-lg font-black">{asset.name}</span>
          <span className="block text-sm font-bold opacity-75">
            {ASSET_LABELS[type]}{asset.institution && ` · ${asset.institution}`}
          </span>
        </span>
      </div>
      <div className="num mt-4 text-3xl font-black">{money(asset.value)}</div>
      {asset.as_of && <div className="text-xs font-bold opacity-70">as of {shortDate(fromPbDate(asset.as_of))}</div>}

      {tied.length > 0 && (
        <div className="mt-4 rounded-2xl bg-white/70 p-3">
          <div className="meter !h-3"><span style={{ width: `${(1 - owedShare) * 100}%` }} /></div>
          <div className="mt-2 flex items-center justify-between text-sm font-black">
            <span>Equity</span><span className="num">{money(eq)}</span>
          </div>
          <ul className="mt-1 space-y-0.5 text-xs font-bold opacity-80">
            {tied.map((d) => (
              <li key={d.id} className="flex justify-between gap-2">
                <span className="truncate"><Icon name="link" className="mr-1 h-3 w-3" />{DEBT_EMOJI[(d.type || "other") as keyof typeof DEBT_EMOJI]} {d.name}</span>
                <span className="num">−{money(d.balance)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </button>
  );
}

function AssetForm({ open, asset, debts, onClose, onSaved }: {
  open: boolean; asset: Asset | null; debts: Debt[]; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AssetType>("savings");
  const [institution, setInstitution] = useState("");
  const [value, setValue] = useState("");
  const [asOf, setAsOf] = useState(todayISO());
  const [linked, setLinked] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(asset?.name ?? "");
    setType((asset?.type || "savings") as AssetType);
    setInstitution(asset?.institution ?? "");
    setValue(asset ? String(asset.value) : "");
    setAsOf(asset?.as_of ? fromPbDate(asset.as_of) : todayISO());
    setLinked(asset?.debts ?? []);
    setNotes(asset?.notes ?? "");
    setError(null);
  }, [open, asset]);

  const toggle = (id: string) => setLinked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const data = {
      name: name.trim(), type, institution: institution.trim(), value: parseMoney(value),
      as_of: toPbDate(asOf), debts: linked, notes,
    };
    try {
      if (asset) await updateAsset(asset.id, data);
      else await createAsset(data);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!asset) return;
    try {
      await deleteAsset(asset.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal open={open} title={asset ? "Edit asset" : "Add an asset"} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <TextInput label="Name" required placeholder="Our house" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Type" value={type} onChange={(e) => setType(e.target.value as AssetType)}
            options={ASSET_TYPES.map((t) => ({ value: t, label: `${ASSET_EMOJI[t]} ${ASSET_LABELS[t]}` }))} />
          <TextInput label="Held at" placeholder="Fidelity" value={institution} onChange={(e) => setInstitution(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <MoneyInput label="Value" required value={value} onChange={(e) => setValue(e.target.value)} />
          <TextInput label="Value as of" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>

        <div>
          <div className="field-label">Debts tied to this</div>
          {debts.length === 0 ? (
            <p className="text-sm font-semibold opacity-70">No debts yet. Add a mortgage or loan on the Debts tab to link it here.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {debts.map((d) => {
                const on = linked.includes(d.id);
                return (
                  <button key={d.id} type="button" aria-pressed={on} onClick={() => toggle(d.id)}
                    className={cx("pill !px-4 !py-2 !text-sm transition-transform", on ? "c-coral scale-105" : "c-white")}
                    style={{ boxShadow: on ? "0 3px 0 var(--cd)" : "inset 0 0 0 2px rgba(106,93,123,.15)" }}>
                    {on ? "✓" : "+"} {d.name} <span className="num opacity-70">{money(d.balance)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <ErrorNote message={error} />
        <FormActions saving={busy} color="sky" onDelete={asset ? remove : undefined} deleteLabel="Delete asset"
          submitLabel={asset ? "Save" : "Add asset"} />
      </form>
    </Modal>
  );
}
