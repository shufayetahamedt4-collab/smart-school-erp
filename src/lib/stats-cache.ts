/**
 * Cache for /api/stats dashboard payloads.
 *
 * Two freshness layers, mirroring the db pull cache:
 *  - a payload is FRESH for 30s and served with no extra work;
 *  - past that it may still be SERVED (while a fresh copy is computed in the
 *    background) for up to STATS_CACHE_SERVE_MS, because recomputing it means
 *    pulling whole collections from Firestore and on this network that costs
 *    seconds — a dashboard that has simply been idle must not pay it.
 *
 * Correctness does not rest on the time window. Entries are keyed per
 * user+school and tagged with the school id, and are invalidated two ways:
 *  - `invalidateStats(schoolId)` (the explicit write-route invalidator), and
 *  - `schoolWriteGeneration(schoolId)` from the db layer, which changes on ANY
 *    write to that school — so a payload is dropped the moment its underlying
 *    data can have changed, even by a route that never calls an invalidator.
 * A dropped entry is recomputed fresh, so a read right after a submit is never
 * stale. The 10-minute serve window is only a backstop for changes made outside
 * the app (seed script, Firestore console).
 */

import { invalidateDbCacheScope, schoolWriteGeneration } from "./db";

/** How long a payload counts as fresh and is served with no background work. */
const TTL_MS = 30_000;

/**
 * How long past its fresh window a payload may still be served while a fresh
 * one is computed behind it. Overridable for tests/tuning.
 */
const SERVE_MS = Number(process.env.STATS_CACHE_SERVE_MS ?? 600_000);

interface Entry {
  at: number;
  payload: any;
  schoolId: string;
  /** The school's write generation when this payload was computed. */
  gen: number;
}

/**
 * The stats cache is PROCESS-wide, not module-wide.
 *
 * Next.js evaluates a shared module like this one more than once in a single
 * server process: the `/api/stats` reader bundle and every write-route bundle
 * that calls `invalidateStats` each carry their own copy, and a hot reload
 * re-instantiates it. Module-scoped maps would therefore be split into several
 * independent caches — the reader's payload would live in one copy while
 * `invalidateStats` cleared another (an eviction that silently misses), and
 * evaluating a new route's bundle would wipe the cache the reader had filled
 * (forcing the seconds-long cold recompute the cache exists to avoid). Pinning
 * the state to one object on `globalThis` keeps exactly one stats cache for the
 * whole process, so a write's invalidation always reaches the reader's copy no
 * matter which bundle performed it.
 *
 *   - `store`: keyed per user+school, tagged with the school and its write gen.
 *   - `computing`: one in-flight recomputation per key, shared by concurrent readers.
 */
interface StatsCacheState {
  store: Map<string, Entry>;
  computing: Map<string, Promise<any>>;
}

const STATS_CACHE_GLOBAL_KEY = "__smartSchoolStatsCache__";
const statsGlobal = globalThis as unknown as { [STATS_CACHE_GLOBAL_KEY]?: StatsCacheState };
const statsState: StatsCacheState =
  statsGlobal[STATS_CACHE_GLOBAL_KEY] ||
  (statsGlobal[STATS_CACHE_GLOBAL_KEY] = { store: new Map(), computing: new Map() });

// The SAME map instances across every module evaluation, so all copies of this
// module read and mutate one cache.
const store = statsState.store;
/** One in-flight recomputation per key, shared by every concurrent reader. */
const computing = statsState.computing;

/** A FRESH payload only. */
export function statsCacheGet(key: string): any | null {
  const hit = store.get(key);
  if (hit && hit.gen === schoolWriteGeneration(hit.schoolId) && Date.now() - hit.at < TTL_MS) {
    return hit.payload;
  }
  return null;
}

/**
 * A payload that may still be served, or null when there is none to serve (no
 * entry, the school has been written to since it was computed, or it is older
 * than the serve window). `stale` marks one past the fresh window, which the
 * caller answers with now and refreshes in the background.
 */
export function statsCacheRead(key: string): { payload: any; stale: boolean } | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.gen !== schoolWriteGeneration(hit.schoolId)) return null;
  const age = Date.now() - hit.at;
  if (age >= SERVE_MS) return null;
  return { payload: hit.payload, stale: age >= TTL_MS };
}

export function statsCachePut(key: string, payload: any, schoolId: string): void {
  store.set(key, { at: Date.now(), payload, schoolId, gen: schoolWriteGeneration(schoolId) });
  prune();
}

/**
 * Compute and cache a payload, collapsing concurrent readers of the same key
 * into ONE recomputation — a cold dashboard can fire several at once, and each
 * recomputation is a full Firestore scan.
 */
export function statsCompute(key: string, schoolId: string, produce: () => Promise<any>): Promise<any> {
  const existing = computing.get(key);
  if (existing) return existing;
  const started = Promise.resolve()
    .then(produce)
    .then((payload) => {
      store.set(key, { at: Date.now(), payload, schoolId, gen: schoolWriteGeneration(schoolId) });
      prune();
      return payload;
    })
    .finally(() => {
      if (computing.get(key) === started) computing.delete(key);
    });
  computing.set(key, started);
  return started;
}

/** Refresh a payload in the background for the next reader. */
export function statsRefresh(key: string, schoolId: string, produce: () => Promise<any>): void {
  if (computing.has(key)) return;
  void statsCompute(key, schoolId, produce).catch(() => null);
}

/** Evict entries nobody may serve any more. */
function prune(): void {
  if (store.size <= 200) return;
  const cutoff = Date.now() - SERVE_MS;
  for (const [k, v] of store) if (v.at < cutoff) store.delete(k);
}

/**
 * Drop cached stats for a school after its underlying data changed.
 * `what` documents the trigger (attendance | homework | marks | exams |
 * students | classes | all) — every payload depends on all of them, so all
 * of the school's entries are invalidated regardless.
 */
export function invalidateStats(
  schoolId: string | null | undefined,
  _what: "attendance" | "homework" | "marks" | "exams" | "students" | "classes" | "all" = "all"
): void {
  if (!schoolId) return;
  for (const [k, v] of store) {
    if (v.schoolId === schoolId) store.delete(k);
  }
  // Write routes that invalidate stats but never touched a reference cache
  // (e.g. exams, student edits) must not keep serving a pre-write pull — but
  // only THIS school's pulls, never another school's cached reads. This also
  // bumps the school's write generation, so any payload still in `store` is
  // treated as stale by the generation check above.
  invalidateDbCacheScope({ schoolId });
}
