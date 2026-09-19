/**
 * 30s TTL cache for /api/stats dashboard payloads, with tag-based
 * invalidation so a dashboard never shows stale numbers after a submit.
 *
 * Entries are keyed per user+school and tagged with the school id. Write
 * routes call invalidateStats(schoolId) after attendance / homework / marks
 * / class-student changes; every cached payload for that school depends on
 * all of those datasets, so any of them drops the school's entries.
 */

const TTL_MS = 30_000;

interface Entry {
  at: number;
  payload: any;
  schoolId: string;
}

const store = new Map<string, Entry>();

export function statsCacheGet(key: string): any | null {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.payload;
  return null;
}

export function statsCachePut(key: string, payload: any, schoolId: string): void {
  store.set(key, { at: Date.now(), payload, schoolId });
  if (store.size > 200) {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, v] of store) if (v.at < cutoff) store.delete(k);
  }
}

/**
 * Drop cached stats for a school after its underlying data changed.
 * `what` documents the trigger (attendance | homework | marks | students |
 * classes | all) — every payload depends on all of them, so all of the
 * school's entries are invalidated regardless.
 */
export function invalidateStats(
  schoolId: string | null | undefined,
  _what: "attendance" | "homework" | "marks" | "students" | "classes" | "all" = "all"
): void {
  if (!schoolId) return;
  for (const [k, v] of store) {
    if (v.schoolId === schoolId) store.delete(k);
  }
}
