import { useEffect, useState } from "react";
import {
  agentReaderAvailable, bulkUploadPaystubs, errorMessage, latestPaystub, readPaystubWithAgent,
  type BulkResult, type BulkStub, type LineDraft, type YtdCheck,
} from "~/backend/api";
import type { Asset, Debt, Earner } from "~/backend/types";
import { Button, ErrorNote, Modal, Select, cx } from "~/components/ui";
import { shortDate } from "~/lib/dates";
import { money } from "~/lib/money";
import { depositAmount, fromAgent, linkAccounts, readPaystub, readingLines, readingLooksGood, type PaystubReading } from "~/lib/paystub";
import { readZip } from "~/lib/zip";

/** Reads one paystub PDF: in the browser first, then the OpenClaw agent if that couldn't make sense of it. */
export async function readPaystubFile(file: Blob, name: string, agent: boolean): Promise<PaystubReading | null> {
  let reading: PaystubReading | null = null;
  try {
    const { pdfRows } = await import("~/lib/pdfText");
    reading = readPaystub(await pdfRows(file));
  } catch {
    reading = null;
  }
  if ((!reading || !readingLooksGood(reading)) && agent) {
    try {
      const { toBase64 } = await import("~/lib/pdfText");
      const r = fromAgent(await readPaystubWithAgent(name, "application/pdf", await toBase64(file)));
      if (!reading || readingLooksGood(r) || r.lines.length > reading.lines.length) reading = r;
    } catch {
      // Keep the browser's reading.
    }
  }
  return reading;
}

interface Item {
  name: string;
  data: Blob;
  reading: PaystubReading | null;
  /** Why it can't be saved in bulk, if it can't. */
  problem: string | null;
}

type Step = "pick" | "reading" | "review" | "saving" | "done";

const baseName = (n: string) => n.split("/").pop() || n;

/**
 * Upload a zip of paystub PDFs for one earner. Each PDF is read here, then all of
 * them are saved together: a paystub that's already in the app (often one copied
 * from an earlier paystub because the deposit matched it) just gets its PDF, and
 * a stub's year-to-date pay is checked against the paystubs in the app. If
 * anything doesn't add up, the server keeps none of them.
 */
export function BulkPaystubModal({ earners, debts, assets, onClose, onSaved }: {
  earners: Earner[]; debts: Debt[]; assets: Asset[]; onClose: () => void; onSaved: () => void;
}) {
  const [step, setStep] = useState<Step>("pick");
  const [earner, setEarner] = useState(earners[0]?.id ?? "");
  const [items, setItems] = useState<Item[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState(false);

  useEffect(() => { agentReaderAvailable().then(setAgent); }, []);

  async function readAll(zip: File) {
    setError(null);
    let pdfs: { name: string; data: Uint8Array }[];
    try {
      pdfs = (await readZip(new Uint8Array(await zip.arrayBuffer()))).filter((f) => /\.pdf$/i.test(f.name));
    } catch (err) {
      return setError(errorMessage(err));
    }
    if (pdfs.length === 0) return setError("There are no PDFs in that zip.");
    setStep("reading");
    setProgress({ done: 0, total: pdfs.length });
    const read: Item[] = [];
    for (const f of pdfs) {
      const data = new Blob([f.data as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
      const reading = await readPaystubFile(data, baseName(f.name), agent);
      let problem: string | null = null;
      if (!reading || !reading.pay_date) problem = "Couldn't find the pay date.";
      else if (!reading.gross || !reading.net) problem = "Couldn't find the gross and net pay.";
      else if (!readingLooksGood(reading)) problem = "Some lines couldn't be read.";
      read.push({ name: f.name, data, reading, problem });
      setProgress({ done: read.length, total: pdfs.length });
    }
    read.sort((a, b) => (a.reading?.pay_date ?? "9999").localeCompare(b.reading?.pay_date ?? "9999") || a.name.localeCompare(b.name));
    setItems(read);
    setStep("review");
  }

  const good = items.filter((i) => !i.problem);

  async function save() {
    setStep("saving");
    setError(null);
    try {
      const last = await latestPaystub(earner).catch(() => null);
      const previous: LineDraft[] = (last?.lines ?? []).map((l) => ({
        category: l.category, label: l.label, amount: l.amount, debt: l.debt, asset: l.asset, employer_paid: l.employer_paid,
      }));
      const stubs: BulkStub[] = good.map((it, i) => {
        const r = it.reading!;
        return {
          name: baseName(it.name), file: i, pay_date: r.pay_date!, period_start: r.period_start ?? "", period_end: r.period_end ?? "",
          gross: r.gross!, net: r.net!, deposit: depositAmount(r.net!, r.reimbursements),
          lines: linkAccounts(readingLines(r), previous, debts, assets),
          ytd_gross: r.ytd?.gross ?? 0, ytd_net: r.ytd?.net ?? 0,
        };
      });
      setResults(await bulkUploadPaystubs(earner, stubs, good.map((i) => i.data), good.map((i) => i.name)));
      setStep("done");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setStep("review");
    }
  }

  const earnerName = earners.find((e) => e.id === earner)?.name ?? "";

  return (
    <Modal open title="Upload a zip of paystubs" onClose={onClose} color="sky" wide>
      {step === "pick" && (
        <div className="space-y-4">
          <Select label="Whose paystubs?" value={earner} onChange={(e) => setEarner(e.target.value)}
            options={earners.map((e) => ({ value: e.id, label: e.name }))} />
          <label className="tray flex cursor-pointer flex-col items-center gap-2 px-6 py-8 text-center font-black hover:bg-white">
            <span className="text-4xl" aria-hidden="true">🗂️</span>
            Choose a .zip of paystub PDFs
            <span className="max-w-md text-xs font-semibold opacity-70">
              Each PDF is read right here in your browser{agent ? ", with your OpenClaw agent as a backup" : ""}. Nothing is
              saved until you've looked them over.
            </span>
            <input type="file" accept=".zip,application/zip,application/x-zip-compressed" className="sr-only" aria-label="Zip of paystubs"
              onChange={(e) => e.target.files?.[0] && readAll(e.target.files[0])} />
          </label>
          <ul className="space-y-1 text-sm font-semibold opacity-80">
            <li>• A paystub already in the app, like one filled in from an earlier paystub, keeps its amounts and just gets its PDF.</li>
            <li>• When a stub shows year-to-date pay, it's checked against the paystubs in the app. If they don't add up, none of the zip is saved.</li>
          </ul>
          <ErrorNote message={error} />
        </div>
      )}

      {step === "reading" && (
        <div className="py-10 text-center font-black" aria-live="polite">
          <div className="bob inline-block text-5xl" aria-hidden="true">📄</div>
          <div className="mt-3">Reading paystub {Math.min(progress.done + 1, progress.total)} of {progress.total}…</div>
        </div>
      )}

      {(step === "review" || step === "saving") && (
        <div className="space-y-4">
          <p className="rounded-2xl bg-white/70 px-4 py-3 text-sm font-bold">
            {good.length} of {items.length} paystubs read for {earnerName}.
            {items.length > good.length && " The rest can't be saved this way. Add them one at a time with + Paystub."}
          </p>
          <ul className="space-y-2">
            {items.map((it) => <ReadRow key={it.name} item={it} />)}
          </ul>
          <ErrorNote message={error} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button color="white" onClick={() => { setItems([]); setStep("pick"); setError(null); }} disabled={step === "saving"}>
              Pick another zip
            </Button>
            {good.length > 0 && (
              <Button color="mint" onClick={save} disabled={step === "saving"}>
                {step === "saving" ? "Saving…" : `Save ${good.length} paystub${good.length === 1 ? "" : "s"}`}
              </Button>
            )}
          </div>
        </div>
      )}

      {step === "done" && results && (
        <div className="space-y-4">
          <p className="c-mint rounded-2xl px-4 py-3 text-sm font-black" style={{ background: "var(--c)" }} role="status">
            ✓ Saved. {summary(results)}
          </p>
          <ul className="space-y-2">
            {[...results].sort((a, b) => a.pay_date.localeCompare(b.pay_date)).map((r) => <ResultRow key={r.index} result={r} />)}
          </ul>
          <div className="flex justify-end">
            <Button color="sky" onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ReadRow({ item }: { item: Item }) {
  const r = item.reading;
  return (
    <li className={cx("rounded-2xl px-4 py-3", item.problem ? "c-butter" : "bg-white/80")} style={item.problem ? { background: "var(--c)" } : undefined}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate font-extrabold" title={item.name}>
          {r?.pay_date ? shortDate(r.pay_date) : "No date"} · <span className="font-semibold opacity-70">{baseName(item.name)}</span>
        </span>
        {r?.net ? <span className="num font-black">{money(depositAmount(r.net, r.reimbursements), { cents: true })}</span> : null}
      </div>
      <div className="text-xs font-bold opacity-70">
        {item.problem ?? [
          r?.gross ? `${money(r.gross, { cents: true })} gross` : null,
          r?.ytd?.gross ? `${money(r.ytd.gross, { cents: true })} gross so far this year` : null,
          r?.ytd ? null : "No year-to-date totals",
        ].filter(Boolean).join(" · ")}
      </div>
    </li>
  );
}

const ACTION_LABELS: Record<BulkResult["action"], string> = {
  added: "Added",
  attached: "PDF saved with the paystub already here",
  already: "Already had this PDF",
};

function ytdLabel(c: YtdCheck | undefined, what: string): string | null {
  if (!c) return null;
  if (!c.checked) return `${what} so far this year not checked (not every earlier paystub this year is in the app)`;
  return `✓ ${what} so far this year adds up (${money(c.printed, { cents: true })})`;
}

function ResultRow({ result: r }: { result: BulkResult }) {
  const action = r.action === "attached" && r.source === "repeat" ? "PDF saved with the paystub copied from an earlier one" : ACTION_LABELS[r.action];
  return (
    <li className="rounded-2xl bg-white/80 px-4 py-3">
      <div className="font-extrabold">{shortDate(r.pay_date)} · <span className="font-semibold opacity-70">{r.name}</span></div>
      <div className="text-xs font-bold opacity-70">
        {[action, r.filled ? `filled in ${r.filled} other paycheck${r.filled === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}
      </div>
      {[ytdLabel(r.ytd.gross, "Gross"), ytdLabel(r.ytd.net, "Net")].filter(Boolean).map((t) => (
        <div key={t} className="text-xs font-bold opacity-70">{t}</div>
      ))}
    </li>
  );
}

function summary(results: BulkResult[]): string {
  const added = results.filter((r) => r.action === "added").length;
  const attached = results.filter((r) => r.action === "attached").length;
  const parts = [
    added ? `${added} new paystub${added === 1 ? "" : "s"}` : null,
    attached ? `${attached} PDF${attached === 1 ? "" : "s"} saved with paystubs already here` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") + "." : "Every paystub was already here with its PDF.";
}
