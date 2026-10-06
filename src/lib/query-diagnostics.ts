/**
 * Query diagnostics + pushdown classification.
 *
 * Pure, dependency-free (no firebase-admin, no node: imports) so it is safe to
 * unit-test and to import from anywhere the data layer runs. It is the SINGLE
 * source of truth for "which predicates may be pushed into a Firestore query",
 * shared by `db.ts` (which enforces it) and the regression test (which asserts
 * it) — so the two can never drift.
 *
 * It exists to make the expensive failure mode loud and greppable: a query that
 * contains a predicate the layer knows how to push, but which ends up pulling a
 * whole collection into memory instead.
 *
 * Safety: nothing here logs a predicate VALUE. Only field names, operators and
 * classifications are ever emitted, so ids, emails, tokens and credentials
 * cannot leak through the diagnostic.
 */

export type Pushdown = { field: string; op: "==" | "in"; value: any };
export type Unpushed = { field: string; reason: string };

/** How a single collection read was served. */
export type QueryClass =
  | "NATIVE_COUNT" // answered by Firestore's count() aggregation
  | "BATCHED_BY_ID" // resolved with a batched getAll (one round trip)
  | "SAFE_PUSHED" // every predicate reached Firestore
  | "PARTIAL_PUSH" // some predicates pushed, the rest filtered in memory
  | "FULL_COLLECTION_FALLBACK" // nothing pushed — the whole collection is pulled
  | "OTHER"; // unfiltered by design (an empty where)

/** Why a predicate was NOT pushed. Kept human-readable for the report. */
export const PUSHDOWN_REASON = {
  ID: "synthetic id — documents keep their id out of band",
  RELATION: "relation field — stored under its foreign key, not this name",
  NULL: "null/undefined — a missing field matches null in memory but not in Firestore",
  DATE: "Date value — Firestore Timestamp precision differs",
  OPERATOR: "operator predicate — in-memory semantics differ from Firestore",
  LOGICAL: "logical operator (OR/AND/NOT) — not a field equality",
  EMPTY_IN: "empty `in` list",
  LARGE_IN: "`in` list exceeds Firestore's 30-value limit",
  NON_SCALAR_IN: "`in` list contains a non-scalar value",
  ARRAY: "array/object value — Firestore equality differs",
} as const;

const LOGICAL_KEYS = new Set(["OR", "AND", "NOT"]);

/** Firestore pushes scalar equality/in identically to this layer's `eq`. */
function isScalar(v: any): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * The subset of a Prisma-style `where` that may be pushed into the Firestore
 * query. MUST stay in lockstep with `unpushedReasons` below.
 *
 * `isRelationField(field)` tells this module whether `field` names a relation on
 * the current model (the caller owns the relation registry).
 */
export function pushdownConditionsFor(
  where: Record<string, any> | undefined,
  isRelationField: (field: string) => boolean
): Pushdown[] {
  if (!where) return [];
  const out: Pushdown[] = [];
  for (const [field, cond] of Object.entries(where)) {
    if (field === "id" || LOGICAL_KEYS.has(field)) continue;
    if (isRelationField(field)) continue;
    if (cond === undefined || cond === null || cond instanceof Date) continue;
    if (isScalar(cond)) {
      out.push({ field, op: "==", value: cond });
      continue;
    }
    if (typeof cond === "object" && !Array.isArray(cond)) {
      const entries = Object.entries(cond);
      if (entries.length === 1 && entries[0][0] === "in") {
        const vals = entries[0][1];
        if (Array.isArray(vals) && vals.length > 0 && vals.length <= 30 && vals.every(isScalar)) {
          out.push({ field, op: "in", value: vals });
        }
      }
    }
  }
  // Stable order so two call sites that differ only in key order share a cache key.
  out.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return out;
}

/** Every predicate in `where` that could NOT be pushed, and why. */
export function unpushedReasons(
  where: Record<string, any> | undefined,
  isRelationField: (field: string) => boolean
): Unpushed[] {
  if (!where) return [];
  const out: Unpushed[] = [];
  for (const [field, cond] of Object.entries(where)) {
    if (field === "id") {
      out.push({ field, reason: PUSHDOWN_REASON.ID });
      continue;
    }
    if (LOGICAL_KEYS.has(field)) {
      out.push({ field, reason: PUSHDOWN_REASON.LOGICAL });
      continue;
    }
    if (isRelationField(field)) {
      out.push({ field, reason: PUSHDOWN_REASON.RELATION });
      continue;
    }
    // `match()` skips an undefined condition entirely — it is not a predicate.
    if (cond === undefined) continue;
    if (cond === null) {
      out.push({ field, reason: PUSHDOWN_REASON.NULL });
      continue;
    }
    if (cond instanceof Date) {
      out.push({ field, reason: PUSHDOWN_REASON.DATE });
      continue;
    }
    if (isScalar(cond)) continue; // pushed
    if (Array.isArray(cond)) {
      out.push({ field, reason: PUSHDOWN_REASON.ARRAY });
      continue;
    }
    if (typeof cond === "object") {
      const entries = Object.entries(cond);
      if (entries.length === 1 && entries[0][0] === "in") {
        const vals = entries[0][1];
        if (!Array.isArray(vals)) out.push({ field, reason: PUSHDOWN_REASON.OPERATOR });
        else if (vals.length === 0) out.push({ field, reason: PUSHDOWN_REASON.EMPTY_IN });
        else if (vals.length > 30) out.push({ field, reason: PUSHDOWN_REASON.LARGE_IN });
        else if (!vals.every(isScalar)) out.push({ field, reason: PUSHDOWN_REASON.NON_SCALAR_IN });
        // else: pushed
        continue;
      }
      out.push({ field, reason: PUSHDOWN_REASON.OPERATOR });
      continue;
    }
    out.push({ field, reason: PUSHDOWN_REASON.OPERATOR });
  }
  return out;
}

/**
 * Fields whose predicate this layer CAN push (per `pushdownConditionsFor`).
 * Used by the regression guard to prove nothing supported is left unpushed.
 */
export function pushableFields(
  where: Record<string, any> | undefined,
  isRelationField: (field: string) => boolean
): string[] {
  if (!where) return [];
  const out: string[] = [];
  for (const [field, cond] of Object.entries(where)) {
    if (field === "id" || LOGICAL_KEYS.has(field) || isRelationField(field)) continue;
    if (cond === undefined || cond === null || cond instanceof Date) continue;
    if (isScalar(cond)) {
      out.push(field);
      continue;
    }
    if (typeof cond === "object" && !Array.isArray(cond)) {
      const entries = Object.entries(cond);
      if (entries.length === 1 && entries[0][0] === "in") {
        const vals = entries[0][1];
        if (Array.isArray(vals) && vals.length > 0 && vals.length <= 30 && vals.every(isScalar)) out.push(field);
      }
    }
  }
  return out;
}

/**
 * The regression condition, in one line: a predicate this layer supports that
 * did NOT reach Firestore. Always empty while the layer is correct; a non-empty
 * result is exactly what the guard exists to catch.
 */
export function supportedButUnpushed(
  where: Record<string, any> | undefined,
  isRelationField: (field: string) => boolean
): string[] {
  const pushed = new Set(pushdownConditionsFor(where, isRelationField).map((p) => p.field));
  return pushableFields(where, isRelationField).filter((f) => !pushed.has(f));
}

/** Does this `where` resolve by document id (one batched getAll)? */
export function isIdBatch(where: Record<string, any> | undefined): boolean {
  const id = where?.id;
  if (id === undefined) return false;
  if (typeof id === "string") return true;
  return !!id && typeof id === "object" && Array.isArray((id as any).in);
}

export interface QueryClassification {
  cls: QueryClass;
  pushed: Pushdown[];
  unpushed: Unpushed[];
  idBatch: boolean;
}

export function classifyWhere(
  where: Record<string, any> | undefined,
  isRelationField: (field: string) => boolean
): QueryClassification {
  const pushed = pushdownConditionsFor(where, isRelationField);
  const unpushed = unpushedReasons(where, isRelationField);
  const idBatch = isIdBatch(where);
  let cls: QueryClass;
  if (idBatch) cls = "BATCHED_BY_ID";
  else if (!where || Object.keys(where).length === 0) cls = "OTHER";
  else if (pushed.length > 0 && unpushed.length === 0) cls = "SAFE_PUSHED";
  else if (pushed.length > 0) cls = "PARTIAL_PUSH";
  else cls = "FULL_COLLECTION_FALLBACK";
  return { cls, pushed, unpushed, idBatch };
}

// ---------------------------------------------------------------------------
// Performance budget
// ---------------------------------------------------------------------------

/**
 * Models where a whole-collection pull is expensive because the collection is
 * expected to grow with the school (or the platform), so a full scan is worth
 * warning about. A model that is small by design (plans, fee settings) is not.
 */
export const HIGH_CARDINALITY_MODELS = new Set<string>([
  "student",
  "attendance",
  "examMark",
  "fee",
  "payment",
  "message",
  "notice",
  "auditLog",
  "homework",
  "dailyRemark",
  "admission",
  "user",
]);

export function highCardinalityModels(): Set<string> {
  const extra = (process.env.DB_QUERY_DIAG_HIGH_CARDINALITY || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!extra.length) return HIGH_CARDINALITY_MODELS;
  return new Set([...HIGH_CARDINALITY_MODELS, ...extra]);
}

// ---------------------------------------------------------------------------
// Runtime diagnostic (development/test only)
// ---------------------------------------------------------------------------

/** A query event, deliberately free of predicate values. */
export interface QueryDiagEvent {
  kind: "fetch" | "count";
  model: string;
  cls: QueryClass;
  /** field+op only, e.g. "schoolId==", "studentId in" */
  pushed: string[];
  unpushed: Unpushed[];
  /** true when an equality/in on schoolId proves the tenant scope */
  schoolScoped: boolean;
  warn?: string;
}

const events: QueryDiagEvent[] = [];
const repeatSeen = new Map<string, { n: number; at: number }>();
const REPEAT_WINDOW_MS = 30_000;
const REPEAT_THRESHOLD = 3;

export function diagEnabled(): boolean {
  return process.env.DB_QUERY_DIAG === "1";
}

/** Sanitized one-line rendering — field names/ops and classifications only. */
export function formatQueryDiag(e: QueryDiagEvent): string {
  const pushed = e.pushed.length ? e.pushed.join(",") : "-";
  const unpushed = e.unpushed.length ? e.unpushed.map((u) => u.field).join(",") : "-";
  const scope = e.schoolScoped ? "school-scoped" : "unscoped";
  return `[query-diag] ${e.kind} ${e.model} -> ${e.cls} | pushed=${pushed} | in-memory=${unpushed} | ${scope}`;
}

function pushLabel(p: Pushdown[]): string[] {
  return p.map((x) => (x.op === "in" ? `${x.field} in` : `${x.field}==`));
}

/**
 * Record one collection read. Logs when DB_QUERY_DIAG=1 and applies the
 * performance budget (full scan on a high-cardinality model; repeated identical
 * reads). Never throws, never mutates application state.
 */
export function recordQuery(input: {
  kind: "fetch" | "count";
  model: string;
  cls: QueryClass;
  pushed: Pushdown[];
  unpushed: Unpushed[];
  schoolScoped: boolean;
}): QueryDiagEvent {
  const e: QueryDiagEvent = {
    kind: input.kind,
    model: input.model,
    cls: input.cls,
    pushed: pushLabel(input.pushed),
    unpushed: input.unpushed,
    schoolScoped: input.schoolScoped,
  };

  const highCard = highCardinalityModels().has(input.model);
  if (e.cls === "FULL_COLLECTION_FALLBACK" && highCard) {
    e.warn = `whole-collection scan on high-cardinality model "${input.model}"`;
  }

  const key = `${e.kind}:${input.model}:${e.pushed.join(",")}`;
  const now = Date.now();
  const seen = repeatSeen.get(key);
  if (!seen || now - seen.at > REPEAT_WINDOW_MS) repeatSeen.set(key, { n: 1, at: now });
  else {
    seen.n += 1;
    if (seen.n > REPEAT_THRESHOLD && !e.warn) {
      e.warn = `repeated identical Firestore read (${seen.n}× in ${Math.round((now - seen.at) / 1000)}s)`;
    }
  }

  events.push(e);
  if (diagEnabled()) {
    console.log(formatQueryDiag(e));
    if (e.warn) console.warn(`[query-diag][budget] ${e.warn}`);
  }
  return e;
}

/** An include/N+1 observation. */
export interface IncludeDiagEvent {
  model: string;
  key: string;
  /** how many related Firestore reads this include caused for the request */
  relatedReads: number;
  /** how many of those were deduplicated by the per-request cache */
  deduped: number;
  nPlusOne: boolean;
}

export function recordInclude(e: IncludeDiagEvent): void {
  events.length; // keep the array referenced; includes are reported separately
  if (!diagEnabled()) return;
  console.log(
    `[include-diag] ${e.model}.${e.key} related_reads=${e.relatedReads} deduped=${e.deduped} N+1=${e.nPlusOne ? "YES" : "NO"}`
  );
}

/** Drain the recorded events (used by tests; keeps memory bounded in dev). */
export function drainQueryDiags(): QueryDiagEvent[] {
  const out = events.slice();
  events.length = 0;
  return out;
}

/** Test helper. */
export function resetQueryDiags(): void {
  events.length = 0;
  repeatSeen.clear();
}
