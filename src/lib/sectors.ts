/**
 * Sector registry — "one platform, separate apps".
 *
 * The product ships as several independent web apps (Platform Console, School
 * Admin, Teacher App, Parents App, Student App) that all talk to the SAME
 * backend and database. The split is by HOSTNAME: each app answers on its own
 * subdomain, renders its own sign-in screen and its own navigation, and is
 * refused access to every other app's area.
 *
 *   admin.<domain>    → Super Admin (platform console)
 *   school.<domain>   → School Admin (+ Accountant / Librarian / Front Desk)
 *   teacher.<domain>  → Teacher
 *   parents.<domain>  → Guardian (parents)
 *
 * There is deliberately no student app. Students do not carry phones in class,
 * so every family-facing facility (homework, results, materials AND quizzes)
 * lives in the Parents App, which the child uses on the guardian's device. The
 * STUDENT role still exists in the data layer — it is what the APIs, the
 * permission matrix and the isolation fixtures scope "a child's own records"
 * to — but it has no app, no host and no sign-in screen.
 *
 * Locally, `<label>.localhost` resolves to 127.0.0.1 in every modern browser,
 * so `parents.localhost:3000` is a real working app on a dev machine.
 *
 * This module is intentionally dependency-free (no prisma, no node: imports):
 * it is imported from middleware, which runs on the Edge runtime.
 */

export const SECTOR_KEYS = ["super", "school", "teacher", "guardian"] as const;
export type SectorKey = (typeof SECTOR_KEYS)[number];

export interface Sector {
  key: SectorKey;
  /** Subdomain labels that resolve to this app (the first is canonical). */
  hosts: string[];
  /** Every role this app is allowed to serve. */
  roles: string[];
  /** Short product name for this app. */
  app: string;
  /** Full name shown on the sign-in screen. */
  label: string;
  /** One-line pitch on the sign-in screen. */
  tagline: string;
  /** What this app does — shown as bullets on its sign-in screen. */
  bullets: string[];
  /** Accent colour used for branding. */
  accent: string;
  /** Where a signed-in user of this app lands. */
  home: string;
  /** The URL prefix this app owns. */
  prefix: string;
}

export const SECTORS: Record<SectorKey, Sector> = {
  super: {
    key: "super",
    hosts: ["admin", "super", "console"],
    roles: ["SUPER_ADMIN"],
    app: "Platform Console",
    label: "Super Admin Console",
    tagline: "Run the platform — schools, plans, billing and global settings.",
    bullets: ["Every school, plan and subscription in one console", "Revenue, invoices and MRR at a glance", "Global settings, branding and platform health"],
    accent: "#7c3aed",
    home: "/admin",
    prefix: "/admin",
  },
  school: {
    key: "school",
    hosts: ["school", "app", "erp", "dashboard"],
    roles: ["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"],
    app: "School Admin",
    label: "School Admin Console",
    tagline: "Admissions, students, staff, fees and reports for your school.",
    bullets: ["Paperless admissions, attendance and exam results", "Fees, ledger and reconciliation in one place", "Notices, PTM slots and staff coordination"],
    accent: "#4f46e5",
    home: "/dashboard",
    prefix: "/dashboard",
  },
  teacher: {
    key: "teacher",
    hosts: ["teacher", "teachers"],
    roles: ["TEACHER"],
    app: "Teacher App",
    label: "Teacher Portal",
    tagline: "Attendance, homework, marks and messages — straight from the classroom.",
    bullets: ["Mark attendance and daily remarks in seconds", "Homework, quizzes and marks entry", "Message guardians directly"],
    accent: "#0d9488",
    home: "/teacher",
    prefix: "/teacher",
  },
  guardian: {
    key: "guardian",
    hosts: ["parents", "parent", "guardian"],
    roles: ["GUARDIAN"],
    app: "Parents App",
    label: "Guardian Portal",
    tagline: "Your child's attendance, results, fees and notices — all in one place.",
    bullets: ["Daily attendance, remarks and exam results", "Pay fees online and see the ledger", "Notices, homework, PTM booking and messages"],
    accent: "#0ea5e9",
    home: "/parent",
    prefix: "/parent",
  },
};

export const SECTOR_LIST: Sector[] = SECTOR_KEYS.map((k) => SECTORS[k]);

/**
 * Paths that belong to every app (or to no app): sign-in, the marketing page,
 * the public admission form, printing helpers and the two credential-free
 * entries into the Parents App (/qr for a child's ID card, /s/<slug> for the
 * school's printed invite link).
 */
export const SHARED_PREFIXES = ["/login", "/welcome", "/qr", "/apply", "/print", "/s"];

export function isSharedPath(pathname: string): boolean {
  return SHARED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** Strip a port (and IPv6 brackets) from a Host header. */
export function stripPort(host: string): string {
  const h = (host || "").trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(1, end);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

/** The ":port" part of a Host header, or "". */
export function portOf(host: string): string {
  const h = (host || "").trim();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? "" : h.slice(end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? "" : h.slice(colon);
}

const byLabel = (() => {
  const map = new Map<string, Sector>();
  for (const s of SECTOR_LIST) for (const l of s.hosts) map.set(l, s);
  return map;
})();

/**
 * The hostname the visitor actually typed.
 *
 * `host` is the direct answer on a plain Next server, but a platform that proxies
 * to a serverless function (Netlify, Cloud Run behind a load balancer, a CDN) may
 * rewrite it and put the public hostname in `x-forwarded-host` instead. Sector
 * routing, the cross-app redirects and the invite QR all depend on the hostname
 * the school really sees, so prefer the forwarded one and fall back to `host`.
 */
export function requestHost(headers: { get(name: string): string | null }): string {
  const forwarded = (headers.get("x-forwarded-host") || "").split(",")[0].trim();
  return forwarded || headers.get("host") || "";
}

/**
 * Which app does this host serve? `null` means the hub (the bare domain, the
 * platform's own URL, `127.0.0.1`, an unknown host) — the hub stays
 * host-agnostic so local development, the seeded harnesses and the default
 * App Hosting URL keep working.
 */
export function resolveSector(host: string): Sector | null {
  const h = stripPort(host);
  if (!h) return null;
  const first = h.split(".")[0];
  if (!first || first === "www") return null;
  return byLabel.get(first) ?? null;
}

/** Which app does this role belong to? */
export function sectorForRole(role: string | null | undefined): Sector | null {
  if (!role) return null;
  return SECTOR_LIST.find((s) => s.roles.includes(role)) ?? null;
}

/** Resolved lazily so this module stays safe to import from client components. */
const appDomain = () =>
  (process.env.APP_DOMAIN || process.env.NEXT_PUBLIC_APP_DOMAIN || "").trim().replace(/^\.+|\.+$/g, "");

/**
 * The absolute host of another app on this deployment, or `null` when it can't
 * be determined safely — in which case callers must fall back to serving the
 * request on the current host rather than sending the user to a dead address.
 *
 * Resolution order: APP_DOMAIN env (production), then `<label>.localhost`
 * (dev). A bare IP host has no subdomain form, so it yields null.
 */
export function sectorHostFor(host: string, key: SectorKey): string | null {
  const label = SECTORS[key].hosts[0];
  const domain = appDomain();
  if (domain) return `${label}.${domain}`;

  const h = stripPort(host);
  const parts = h.split(".");
  if (parts.length > 1 && byLabel.has(parts[0])) parts.shift();
  const base = parts.join(".");
  if (base === "localhost") return `${label}.localhost${portOf(host)}`;
  return null;
}

/** The hub (marketing / no app) host for this deployment, or null if unknown. */
export function hubHostFor(host: string): string | null {
  const domain = appDomain();
  if (domain) return domain;
  const h = stripPort(host);
  const parts = h.split(".");
  if (parts.length > 1 && byLabel.has(parts[0])) parts.shift();
  const base = parts.join(".");
  if (base === "localhost") return `localhost${portOf(host)}`;
  return null;
}
