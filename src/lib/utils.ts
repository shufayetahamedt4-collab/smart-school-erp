export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function fmtDate(d?: Date | string | null, withTime = false): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  const datePart = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  if (!withTime) return datePart;
  const timePart = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
}

export function fmtMoney(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "৳0";
  const num = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(num)) return "৳0";
  return `৳${num.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function todayISO(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

export function todayMidnight(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}

export function pct(n: number, total: number): number {
  if (!total) return 0;
  return Math.round((n / total) * 100);
}

export function classOf(schoolName: string): string {
  return schoolName
    .split(" ")
    .filter((w) => /^[a-z0-9]+$/i.test(w) && !["a", "an", "the", "and", "of"].includes(w.toLowerCase()))
    .map((w) => w[0]?.toUpperCase())
    .join("")
    .slice(0, 3) || "SC";
}
