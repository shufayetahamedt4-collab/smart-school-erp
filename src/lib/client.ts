"use client";

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
const memo = new Map<string, { at: number; data: any }>();
const inflight = new Map<string, Promise<any>>();

/** Drop every cached read. */
export function clearApiCache(): void {
  memo.clear();
  inflight.clear();
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

  if (method !== "GET" || opts.cache === "no-store") {
    const data = await request<T>(url, req);
    if (method !== "GET") clearApiCache();
    return data;
  }

  const key = `GET ${url}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < READ_TTL_MS) {
    revalidate<T>(key, url, req);
    return hit.data;
  }

  // Collapse concurrent identical reads (several panels can ask on mount).
  let pending = inflight.get(key);
  if (!pending) {
    pending = request<T>(url, req)
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
 * free: `api()` already collapses concurrent and cached reads.
 *
 * `staggerMs` spreads a large batch (the post-sign-in sector warm) over time so
 * twenty requests do not all hit Firestore at once. Hover uses the default of 0
 * because the click may arrive immediately.
 */
export function prefetch(urls: Iterable<string>, staggerMs = 0): void {
  let i = 0;
  for (const url of urls) {
    const run = () => void api(url).catch(() => null);
    if (staggerMs > 0) setTimeout(run, i * staggerMs);
    else run();
    i++;
  }
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!clean.length) return "";
  return "?" + clean.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}
