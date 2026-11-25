import { useCallback, useEffect, useState } from "react";
import {
  apiBaseUrl, createApiToken, errorMessage, listApiTokens, revokeApiToken, type ApiToken,
} from "~/backend/api";
import { Button, Card, EmptyState, ErrorNote, FormActions, Icon, Modal, SectionTitle, TextInput, cx } from "~/components/ui";

export function meta() {
  return [{ title: "API tokens · Finance Tracker" }];
}

const HUES = ["lilac", "aqua", "peach", "mint", "sky", "pink", "butter", "coral"];

/** "Nov 25, 2026" (and the time when it was today), in the viewer's time zone. */
function when(value: string): string {
  if (!value) return "";
  const d = new Date(value.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? `today at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function ApiTokensPage() {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setTokens(await listApiTokens());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function revoke(t: ApiToken) {
    if (!window.confirm(`Revoke "${t.name}"? Anything using it (like n8n) stops working right away.`)) return;
    try {
      await revokeApiToken(t.id);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <SectionTitle action={
        <Button small color="lilac" onClick={() => setMaking(true)}><Icon name="plus" className="h-5 w-5" /> New token</Button>
      }>API tokens</SectionTitle>
      <p className="-mt-2 mb-5 font-semibold opacity-80">
        A token lets n8n or a script use the app's API without a password. It can do anything you can do here:
        add and change transactions, envelopes, vendors, debts, assets and paystubs. Tokens never expire, so
        revoke one when you stop using it. Everyone in the household sees these tokens and can revoke them.
      </p>
      <ErrorNote message={error} />

      {!tokens ? (
        <div className="py-16 text-center text-5xl"><span className="bob inline-block">🔑</span></div>
      ) : tokens.length === 0 ? (
        <EmptyState emoji="🔑" title="No tokens yet">
          Make one for each thing that talks to the app, like "n8n", so you can revoke them one at a time.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {tokens.map((t, i) => (
            <li key={t.id}>
              <Card className="pop-in flex flex-wrap items-center gap-4 p-4" style={{ ["--i" as any]: i }}>
                <span className={cx("flex h-12 w-12 flex-none items-center justify-center rounded-full", `c-${HUES[i % HUES.length]}`)}
                  style={{ background: "var(--c)" }} aria-hidden="true">
                  <Icon name="key" className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg font-black">{t.name}</div>
                  <div className="text-sm font-bold opacity-70">
                    <code className="font-mono">{t.prefix}…</code>
                    {" · "}acts as {t.user ? (t.user.name || t.user.email) : "a removed member"}
                    {" · "}made {when(t.created)}
                  </div>
                </div>
                <span className={cx("pill", t.last_used ? "c-mint" : "c-butter")}>
                  {t.last_used ? `Used ${when(t.last_used)}` : "Never used"}
                </span>
                <button className="btn-ghost text-sm" onClick={() => revoke(t)} aria-label={`Revoke ${t.name}`}>
                  <Icon name="trash" className="h-4 w-4" /> Revoke
                </button>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <HowTo />

      <NewToken open={making} onClose={() => setMaking(false)} onMade={(token) => { setMade(token); reload(); }} />
      <ShowToken token={made} onClose={() => setMade(null)} />
    </div>
  );
}

function HowTo() {
  const base = apiBaseUrl();
  return (
    <Card color="sky" className="mt-8 p-5">
      <h3 className="text-lg font-black">Using a token</h3>
      <p className="mt-1 text-sm font-semibold opacity-80">
        Send it as the <code className="font-mono">Authorization</code> header on every request.
        In n8n, make a Header Auth credential with the name <code className="font-mono">Authorization</code> and the token as the value.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-2xl bg-white/80 p-3 text-xs font-semibold">
{`curl -X POST ${base}/api/sync/transactions \\
  -H "Authorization: ft_..." \\
  -H "Content-Type: application/json" \\
  -d '{"records":[{"external_id":"bank-1","kind":"expense",
       "date":"2026-11-21","amount":12.34,"payee":"Publix"}]}'`}
      </pre>
      <p className="mt-2 text-sm font-semibold opacity-80">
        The full list of endpoints is in <code className="font-mono">docs/api.md</code> in the app's repository.
      </p>
    </Card>
  );
}

function NewToken({ open, onClose, onMade }: { open: boolean; onClose: () => void; onMade: (token: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(""); setError(null); } }, [open]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const made = await createApiToken(name.trim());
      onClose();
      onMade(made.token);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="New API token" onClose={onClose} color="lilac">
      <form onSubmit={save} className="space-y-4">
        <TextInput label="Name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="n8n"
          hint="What will use it. The token acts as you and never expires." />
        <ErrorNote message={error} />
        <FormActions saving={busy} submitLabel="Make token" color="lilac" />
      </form>
    </Modal>
  );
}

function ShowToken({ token, onClose }: { token: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [token]);

  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal open={token !== null} title="Your new token" onClose={onClose} color="mint">
      <p className="mb-3 font-semibold">
        Copy it now. This is the only time it's shown; the app keeps just a fingerprint of it.
      </p>
      <label htmlFor="new-token" className="field-label">Token</label>
      <input id="new-token" className="input font-mono text-sm" readOnly value={token ?? ""}
        onFocus={(e) => e.currentTarget.select()} />
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <Button color="white" onClick={copy}><Icon name="copy" className="h-5 w-5" /> {copied ? "Copied" : "Copy"}</Button>
        <Button color="mint" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}
