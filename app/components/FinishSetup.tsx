import { useEffect, useState } from "react";
import { errorMessage, finishSimplefinSetup, simplefinStatus } from "~/backend/api";
import { Button, ErrorNote, Modal } from "~/components/ui";
import { shortDate, todayISO } from "~/lib/dates";

/**
 * The end of onboarding when the budget is started by hand. Each time `trigger` goes up (after
 * "Start budget"), a SimpleFIN connection still held since the bank step is finished: its
 * transactions start, with a first pull now. With no history imported it first asks whether to
 * start from today or the 1st of the month. (Importing history finishes setup on its own.)
 */
export function FinishSetup({ trigger, onFinished }: { trigger: number; onFinished: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (trigger === 0) return;
    simplefinStatus()
      .then((s) => {
        if (!s.holding) return;
        if (s.imported) void finish();
        else setAsking(true);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  const monthStart = `${todayISO().slice(0, 7)}-01`;

  async function finish(from?: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await finishSimplefinSetup(from);
      setAsking(false);
      setDone(r.errors.length
        ? `SimpleFIN couldn't pull just now (${r.errors.join("; ")}); it will try again tomorrow morning.`
        : `SimpleFIN brought in ${r.transactions} transaction${r.transactions === 1 ? "" : "s"}, and pulls every morning from now on.`);
      onFinished();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {done && (
        <div className="c-mint chunk mt-4 flex flex-wrap items-center justify-between gap-3 px-5 py-4 font-bold" role="status"
          style={{ borderRadius: 22, boxShadow: "0 6px 0 var(--cd)" }}>
          <span>🎉 {done}</span>
          <Button small color="white" onClick={() => setDone(null)}>OK</Button>
        </div>
      )}
      {/* Closing without choosing keeps the default: from today. */}
      <Modal open={asking} title="Start from the 1st?" onClose={() => { if (!busy) void finish(); }} color="butter">
        <p className="font-semibold">
          No history was imported, so your banks' transactions would come in from today on. Start from{" "}
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
