/** "YYYY-MM" for a Date, in local time. */
export function monthOf(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function todayISO(d: Date = new Date()): string {
  return `${monthOf(d)}-${String(d.getDate()).padStart(2, "0")}`;
}

export function nextMonth(month: string, step = 1): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + step, 1);
  return monthOf(d);
}

/** PocketBase filter bounds for a month: start inclusive, end exclusive. */
export function monthRange(month: string): { start: string; end: string } {
  return { start: `${month}-01 00:00:00.000Z`, end: `${nextMonth(month)}-01 00:00:00.000Z` };
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function shortDate(value: string): string {
  if (!value) return "";
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
