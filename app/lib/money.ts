const whole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/** $1,234 for big round numbers, $12.34 when there are cents. */
export function money(n: number, opts: { cents?: boolean } = {}): string {
  const v = Number.isFinite(n) ? n : 0;
  const showCents = opts.cents ?? Math.round(v * 100) % 100 !== 0;
  return (showCents ? cents : whole).format(v);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Parses "1,234.50" or "$12" from a form field. Empty or invalid is 0. */
export function parseMoney(s: string | number | null | undefined): number {
  if (typeof s === "number") return s;
  const n = parseFloat(String(s ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? round2(n) : 0;
}
