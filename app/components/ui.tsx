import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { COLORS, type Color } from "~/backend/types";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// ---------- Icons (stroke icons in the toddler-games style) ----------

const ICONS = {
  plus: "M12 5v14M5 12h14",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  close: "M6 6l12 12M18 6 6 18",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  cash: "M3 7h18v10H3zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 10v4M18 10v4",
  key: "M14.5 13a4.5 4.5 0 1 0-4-2.5L3 18v3h3v-2h2v-2h2l1.5-1.5a4.5 4.5 0 0 0 3 0zM16 7.5h.01",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14c2 .7 3 2.8 3 6",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cx("inline-block", className)}
      fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

// ---------- Buttons ----------

export function Button({
  color = "lilac", small, className, children, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { color?: Color | "white"; small?: boolean }) {
  return (
    <button type="button" {...rest} className={cx("btn", `c-${color}`, small && "btn-sm", className)}>
      {children}
    </button>
  );
}

export function RoundButton({ label, icon, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: IconName }) {
  return (
    <button type="button" aria-label={label} title={label} {...rest} className={cx("round-btn", rest.className)}>
      <Icon name={icon} />
    </button>
  );
}

// ---------- Layout bits ----------

export function Card({ color = "white", className, children, ...rest }: React.HTMLAttributes<HTMLDivElement> & { color?: Color | "white" }) {
  return (
    <div {...rest} className={cx("chunk", `c-${color}`, className)}>
      {children}
    </div>
  );
}

export function Stat({ label, value, hint, className }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="text-sm font-extrabold uppercase tracking-wide opacity-75">{label}</div>
      <div className="num text-3xl font-black sm:text-4xl">{value}</div>
      {hint && <div className="mt-1 text-sm font-bold opacity-80">{hint}</div>}
    </div>
  );
}

export function Meter({ value, color, label }: { value: number; color?: Color; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={cx("meter", color && `c-${color}`)} role="meter" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={pct} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 mt-10 flex items-center justify-between gap-3">
      <h2 className="text-2xl font-black">{children}</h2>
      {action}
    </div>
  );
}

export function EmptyState({ emoji, title, children }: { emoji: string; title: string; children?: ReactNode }) {
  return (
    <div className="tray flex flex-col items-center px-6 py-10 text-center">
      <div className="bob text-6xl" aria-hidden="true">{emoji}</div>
      <div className="mt-3 text-xl font-black">{title}</div>
      {children && <div className="mt-2 max-w-md font-semibold opacity-80">{children}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="c-coral chunk px-4 py-3 text-sm font-bold" style={{ borderRadius: 18, boxShadow: "0 4px 0 var(--cd)" }}>
      {message}
    </div>
  );
}

// ---------- Modal ----------

export function Modal({ open, title, onClose, children, color = "white", wide = false }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; color?: Color | "white"; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers often pass a new onClose on every render. Keep the latest in a ref so the
  // effect below runs only when the modal opens; rerunning it moved focus to the close
  // button after every keystroke.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-6"
      role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-[rgba(106,93,123,.35)] backdrop-blur-[2px]" onClick={onClose} />
      <div ref={ref} className={cx("chunk pop-in relative max-h-[92vh] w-full overflow-y-auto p-6", wide ? "max-w-3xl" : "max-w-lg", `c-${color}`)}>
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="text-2xl font-black">{title}</h2>
          <RoundButton label="Close" icon="close" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- Form fields ----------

export function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="field-label">{label}</label>
      {children(id)}
      {hint && <div className="mt-1 text-xs font-semibold opacity-70">{hint}</div>}
    </div>
  );
}

export function TextInput({ label, hint, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return <Field label={label} hint={hint}>{(id) => <input id={id} className="input" {...rest} />}</Field>;
}

export function MoneyInput({ label, hint, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="relative">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-black opacity-60">$</span>
          <input id={id} className="input num pl-8" inputMode="decimal" type="number" step="0.01" min="0" {...rest} />
        </div>
      )}
    </Field>
  );
}

export function Select({ label, options, hint, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: string; hint?: string; options: { value: string; label: string }[];
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select id={id} className="input appearance-none" {...rest}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </Field>
  );
}

export function TextArea({ label, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return <Field label={label}>{(id) => <textarea id={id} className="input min-h-[80px]" {...rest} />}</Field>;
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={cx("mt-0.5 flex h-8 w-14 flex-none items-center rounded-full p-1 transition-colors",
        checked ? "bg-mint-deep" : "bg-[rgba(106,93,123,.18)]", "peer-focus-visible:outline peer-focus-visible:outline-4")}>
        <span className={cx("h-6 w-6 rounded-full bg-white shadow transition-transform", checked && "translate-x-6")} />
      </span>
      <span>
        <span className="block font-extrabold">{label}</span>
        {hint && <span className="block text-xs font-semibold opacity-70">{hint}</span>}
      </span>
    </label>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: Color) => void }) {
  return (
    <div>
      <div className="field-label">Colour</div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
        {COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c}
            onClick={() => onChange(c)}
            className={cx("h-10 w-10 rounded-full transition-transform", `c-${c}`, value === c && "scale-110")}
            style={{
              background: "var(--c)",
              boxShadow: value === c ? "0 0 0 4px var(--cd), 0 3px 0 4px var(--ink)" : "0 3px 0 var(--cd)",
            }} />
        ))}
      </div>
    </div>
  );
}

/** Save and delete buttons for a form. Delete needs a second tap, so a stray tap never loses data. */
export function FormActions({ onDelete, deleteLabel = "Delete", saving, submitLabel = "Save", color = "mint" }: {
  onDelete?: () => void; deleteLabel?: string; saving?: boolean; submitLabel?: string; color?: Color;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      {onDelete ? (
        <button type="button" className={cx("btn-ghost text-sm", armed && "c-coral !bg-coral")}
          onClick={() => (armed ? onDelete() : setArmed(true))}>
          <Icon name="trash" className="h-4 w-4" /> {armed ? "Tap again to delete" : deleteLabel}
        </button>
      ) : <span />}
      <button type="submit" className={cx("btn", `c-${color}`)} disabled={saving}>
        {saving ? "Saving…" : submitLabel}
      </button>
    </div>
  );
}
