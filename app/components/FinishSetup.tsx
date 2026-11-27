import { useEffect, useState } from "react";
import { errorMessage, finishSimplefinSetup, simplefinStatus } from "~/backend/api";
import { Button, Card, ErrorNote, Modal } from "~/components/ui";
import { shortDate, todayISO } from "~/lib/dates";

/**
 * Onboarding step 2, on the budget page while a SimpleFIN connection is held: import the
 * spreadsheet history (which finishes setup itself), or finish without it. Finishing starts
 * SimpleFIN's transactions; with no history imported it offers to start from the 1st of the month.
 */
export function FinishSetup({ version, onImport, onFinished }: { version: number; onImport: () => void; onFinished: () => void }) {
  const [holding, setHolding] = useState(false);
  const [imported, setImported] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    simplefinStatus().then((s) => { setHolding(s.holding); setImported(s.imported); }).catch(() => setHolding(false));
  }, [version]);

  const monthStart = `${todayISO().slice(0, 7)}-01`;

  async function finish(from?: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await finishSimplefinSetup(from);
      setAsking(false);
      setHolding(false);
      setDone(r.errors.length
        ? `Setup is done. SimpleFIN couldn't pull just now (${r.errors.join("; ")}); it will try again tomorrow morning.`
        : `Setup is done. SimpleFIN brought in ${r.transactions} transaction${r.transactions === 1 ? "" : "s"}, and pulls every morning from now on.`);
      onFinished();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="c-mint chunk mt-4 flex flex-wrap items-center justify-between gap-3 px-5 py-4 font-bold" role="status"
        style={{ borderRadius: 22, boxShadow: "0 6px 0 var(--cd)" }}>
        <span>🎉 {done}</span>
        <Button small color="white" onClick={() => setDone(null)}>OK</Button>
      </div>
    );
  }
  if (!holding) return null;

  return (
    <>
      <Card color="butter" className="pop-in mt-4 p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span className="text-4xl" aria-hidden="true">📄</span>
          <div className="min-w-0 flex-1">
            <h3 className="text-xl font-black">Step 2: bring in your history</h3>
            <p className="mt-1 font-semibold opacity-80">
              Import your spreadsheet (like a Goodbudget export) and match its accounts to SimpleFIN's. The spreadsheet
              covers everything up to its last day, and SimpleFIN picks up after that, so nothing comes in twice.
              Your banks' transactions start coming in when this step is done.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <Button color="white" disabled={busy} onClick={() => (imported ? finish() : setAsking(true))}>Finish without importing</Button>
          <Button color="mint" disabled={busy} onClick={onImport}>Import history</Button>
        </div>
        <div className="mt-3"><ErrorNote message={error} /></div>
      </Card>

      <Modal open={asking} title="Start from the 1st?" onClose={() => setAsking(false)} color="butter">
        <p className="font-semibold">
          No history was imported, so SimpleFIN would bring in transactions from today on. Start from{" "}
          {shortDate(monthStart)} instead, so this month's spending so far is in the budget too?
        </p>
        <ErrorNote message={error} />
        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <Button color="white" disabled={busy} onClick={() => finish()}>From today</Button>
          <Button color="mint" disabled={busy} onClick={() => finish(monthStart)}>From {shortDate(monthStart)}</Button>
        </div>
      </Modal>
    </>
  );
}
