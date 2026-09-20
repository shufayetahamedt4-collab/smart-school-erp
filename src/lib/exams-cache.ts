/**
 * 30s TTL cache for the /api/exams list payload, tagged per school so write
 * routes (exam create/update/delete, mark entry — mark counts feed the list)
 * can drop a school's entries immediately instead of serving stale data for
 * the TTL window.
 */

const TTL_MS = 30_000;

interface Entry {
  at: number;
  data: any;
  schoolId: string;
}

const store = new Map<string, Entry>();

export function examsCacheGet(key: string): any | null {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  return null;
}

export function examsCachePut(key: string, data: any, schoolId: string): void {
  store.set(key, { at: Date.now(), data, schoolId });
  if (store.size > 100) {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, v] of store) if (v.at < cutoff) store.delete(k);
  }
}

export function invalidateExamsCache(schoolId: string | null | undefined): void {
  if (!schoolId) return;
  for (const [k, v] of store) if (v.schoolId === schoolId) store.delete(k);
}
