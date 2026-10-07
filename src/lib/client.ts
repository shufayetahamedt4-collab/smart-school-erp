"use client";

import { normalizeInstitutionType, normalizeMode, type InstitutionType, type Mode } from "@/lib/institution";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Session read cache — the client half of "click and it is there".
 *
 * Every page in this app is a client component that mounts and *then* fetches,
 * so without a cache each navigation pays a fresh round trip on top of the
 * page load. Two behaviours fix the feel:
 *
 *  - a GET already answered earlier in this session renders immediately and
 *    refreshes itself in the background, so the *next* visit is fresh too;
 *  - any write (POST/PUT/PATCH/DELETE, or an upload) empties the cache, so a
 *    submit is never followed by its own pre-write read.
 *
 * A 401/403 also clears it: a session that just ended must not keep painting
 * the previous role's cached pages.
 *
 * One-off reads that must never be served from cache can pass
 * `{ cache: "no-store" }`.
 */
const READ_TTL_MS = 60_000;

/**
 * A cached read is served without a background refresh for this long after it
 * was written. A warm-up prefetch (hover or the background sector batch) fills
 * the cache, and the page's own read lands some time later — a click plus an
 * RSC round trip, which in dev can be several seconds. Without this window the
 * page re-fetched every endpoint the warm had just populated.
 */
const REVALIDATE_AFTER_MS = 10_000;
const memo = new Map<string, { at: number; data: any }>();
const inflight = new Map<string, Promise<any>>();

/** Drop every cached read. */
export function clearApiCache(): void {
  memo.clear();
  inflight.clear();
}

/* --------------------------------------------------------------- UI mode */

/**
 * Mode-scoped reads (docs/COLLEGE-DECISIONS.md §3, §9).
 *
 * The client memo is keyed by URL alone, so two modes would otherwise share one
 * entry: switching to College would paint the School payload (or vice-versa)
 * until the TTL expired. A BOTH tenant therefore carries its mode in the URL,
 * which keeps the two contexts' cached reads apart — and only for the endpoints
 * whose server behaviour depends on mode, and only for a BOTH tenant, so a
 * SCHOOL or COLLEGE tenant's URLs stay exactly what they are today.
 */
const MODE_SCOPED_PATHS: ReadonlySet<string> = new Set([
  "/api/stats",
  "/api/exams",
  "/api/grading-scheme",
  "/api/routine-config",
]);

let modeContext: { type: InstitutionType; mode: Mode } | null = null;

/**
 * Tell the client cache which mode is active. Called by the shell once the
 * session payload resolves (and again after a switch). A change drops every
 * cached read, so nothing computed for the previous mode can be served for the
 * new one.
 */
export function setClientMode(
  institutionType: InstitutionType | null | undefined,
  mode: Mode | null | undefined
): void {
  const type = normalizeInstitutionType(institutionType);
  const next: Mode = normalizeMode(mode);
  const changed = !modeContext || modeContext.type !== type || modeContext.mode !== next;
  modeContext = { type, mode: next };
  if (changed) clearApiCache();
}

/** The URL a mode-scoped read should actually hit — identity unless BOTH. */
function scopedUrl(url: string): string {
  if (!modeContext || modeContext.type !== "BOTH") return url;
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  if (!MODE_SCOPED_PATHS.has(path)) return url;
  if (/([?&])mode=/.test(url)) return url;
  return `${url}${q === -1 ? "?" : "&"}mode=${modeContext.mode}`;
}

async function request<T>(url: string, opts: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) clearApiCache();
    throw new ApiError(body?.error || "Request failed", res.status);
  }
  return body?.data as T;
}

/** Refresh a cached entry without making the current caller wait for it. */
function revalidate<T>(key: string, url: string, opts: RequestInit): void {
  if (inflight.has(key)) return;
  const p = request<T>(url, opts)
    .then((data) => {
      memo.set(key, { at: Date.now(), data });
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
}

export async function api<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const method = (opts.method || "GET").toUpperCase();
  const req: RequestInit = {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  };

  // A write always goes alone, and empties the read cache so a submit is never
  // followed by its own pre-write read.
  if (method !== "GET") {
    const data = await request<T>(url, req);
    clearApiCache();
    return data;
  }

  const scoped = scopedUrl(url);
  const key = `GET ${scoped}`;
  const noStore = opts.cache === "no-store";

  // A `no-store` read must always observe the network, so it is never served
  // from the memo below.
  if (!noStore) {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < READ_TTL_MS) {
      // Refresh only once the cached copy is meaningfully old: a prefetch that
      // just landed must not be re-fetched a moment later by the page's own read.
      if (Date.now() - hit.at >= REVALIDATE_AFTER_MS) revalidate<T>(key, scoped, req);
      return hit.data;
    }
  }

  // Collapse concurrent identical reads (several panels can ask on mount).
  //
  // This covers `no-store` reads too: a request already in flight is by
  // definition a fresh network read, so sharing it can never serve stale data —
  // it only removes a duplicate round trip, e.g. the header bell and a dashboard
  // panel each asking for `?countOnly=1` on the same mount. The response is
  // still memoised, so ordinary readers may reuse it.
  let pending = inflight.get(key);
  if (!pending) {
    pending = request<T>(scoped, req)
      .then((data) => {
        memo.set(key, { at: Date.now(), data });
        return data;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending as Promise<T>;
}

export async function upload(url: string, form: FormData): Promise<any> {
  const res = await fetch(url, { method: "POST", body: form });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error || "Upload failed", res.status);
  clearApiCache();
  return body?.data;
}

/**
 * Warm reads a screen is about to need, without waiting for them.
 *
 * Hovering a sidebar entry fires the same GETs that entry's page will issue.
 * They land in the memo above (and in the server's read cache), so the click
 * renders from cache instead of paying a 0.5–1.2s Firestore round trip. A
 * prefetch is never allowed to surface a failure, and duplicate hovers are
 * free: `api()` already collapses concurrent and cached reads, and a URL that
 * is already cached or in flight is skipped outright.
 *
 * Two modes:
 *  - hover (default `staggerMs = 0`): fire immediately, because the click may
 *    arrive the instant the pointer lands; duplicates collapse in `api()`.
 *  - background batch (`staggerMs > 0`, the post-sign-in sector warm): wait
 *    until the browser is idle, then fetch ONE at a time, so the page the user
 *    is looking at always wins the connection. The old behaviour spaced only
 *    the *starts* by `staggerMs`, piling a dozen slow reads on top of the
 *    page's own reads.
 */
export function prefetch(urls: Iterable<string>, staggerMs = 0): void {
  const list = [...urls].filter((url) => !isFresh(url));
  if (!list.length) return;

  if (staggerMs <= 0) {
    for (const url of list) void api(url).catch(() => null);
    return;
  }

  const start = () => {
    let i = 0;
    const next = () => {
      if (i >= list.length) return;
      const url = list[i++];
      void api(url)
        .catch(() => null)
        .finally(() => setTimeout(next, staggerMs));
    };
    next();
  };

  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
  };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(start, { timeout: 2_000 });
  else setTimeout(start, 1_500);
}

/** True when a read is already cached (TTL-fresh) or in flight — nothing to warm. */
function isFresh(url: string): boolean {
  const key = `GET ${scopedUrl(url)}`;
  if (inflight.has(key)) return true;
  const hit = memo.get(key);
  return !!hit && Date.now() - hit.at < READ_TTL_MS;
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!clean.length) return "";
  return "?" + clean.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

