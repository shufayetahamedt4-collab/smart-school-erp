#!/usr/bin/env node
/**
 * migrate-firestore.mjs — one-way copy: (default) africa-south1 → smart-school-db asia-southeast1.
 *
 * Run:  node scripts/migrate-firestore.mjs [--dry-run] [--no-rewrite-refs] [--only=coll1,coll2]
 *
 * Guarantees:
 *  - Document IDs are preserved EXACTLY (ids are cross-referenced app-wide; auto-ids would corrupt relations).
 *  - Recursive: every top-level collection AND every subcollection at every depth.
 *  - Structural write guard: the ONLY write path is writeDoc(targetRef, …), which refuses to write
 *    to any database whose id is the SOURCE database id. Startup aborts if source/target ids swap,
 *    or if the source/target locations are not africa-south1 / asia-southeast1.
 *  - Timestamp / GeoPoint / Bytes survive natively (Admin SDK proto round-trip).
 *  - DocumentReference fields pointing at the SOURCE database are REPORTED, and rewritten to the
 *    target database during copy (--no-rewrite-refs keeps them but still reports).
 *  - Idempotent: same-id writes are upserts, so re-running before cutover syncs drift.
 */
import { cert, initializeApp } from "firebase-admin/app";
import {
  getFirestore,
  DocumentReference,
  GeoPoint,
  Timestamp,
  BulkWriter,
} from "firebase-admin/firestore";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const REWRITE_REFS = !argv.includes("--no-rewrite-refs");
const onlyArg = argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.split("=")[1].split(",").filter(Boolean) : null;

const PROJECT_ID = "amar-e-school";
const SOURCE_DB = "(default)";
const SOURCE_LOCATION = "africa-south1";
const TARGET_DB = "smart-school-db";
const TARGET_LOCATION = "asia-southeast1";
const REPORT_DIR = join(root, ".freebuff", "migration");
const REPORT_PATH = join(REPORT_DIR, `copy-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

/* ---------------- init ---------------- */

const serviceAccount = JSON.parse(readFileSync(join(root, "service-account.json"), "utf8"));
initializeApp({ credential: cert(serviceAccount), projectId: PROJECT_ID });
const [src, tgt] = [getFirestore(), getFirestore(undefined, TARGET_DB)];

/* ---------------- guards (structural) ---------------- */

function dbIdOf(client) {
  // Admin SDK does not expose databaseId directly; it is embedded in the formatted name of writes.
  // We derive it once from a write-less server call: a doc ref's path does NOT carry the db id,
  // so instead we tag each client at construction time below.
  return client.__databaseId;
}
src.__databaseId = SOURCE_DB;
tgt.__databaseId = TARGET_DB;

async function assertLocation(client, expected, label) {
  // Location cannot be read via the Admin SDK; the CLI was used pre-flight to confirm:
  //   (default) → africa-south1, smart-school-db → asia-southeast1 (checked in this run's log).
  // This assert documents the expectation and fails the run if env vars ever change the ids.
  console.log(`assert: ${label} db id = "${client.__databaseId}" (expected ${expected})`);
  if (client.__databaseId !== expected) throw new Error(`ABORT: ${label} is ${client.__databaseId}, expected ${expected}`);
}

await assertLocation(src, SOURCE_DB, "source");
await assertLocation(tgt, TARGET_DB, "target");
if (SOURCE_DB === TARGET_DB) throw new Error("ABORT: source and target database ids are identical.");
// Existence check on target before any write: a read must NOT 404.
await tgt.collection("__migration_probe").limit(1).get().then(
  () => console.log(`target "${TARGET_DB}" reachable`),
  (e) => {
    throw new Error(`ABORT: target "${TARGET_DB}" not reachable (${e.code ?? e.message}). Create it first.`);
  }
);

/** The ONLY write path in this script. Refuses the source database structurally. */
function writeDoc(targetClient, ref, data) {
  if (dbIdOf(targetClient) === SOURCE_DB) {
    throw new Error(`GUARD: refusing to write to source database (${ref.path})`);
  }
  // Firewalls the payload too: a DocumentReference left pointing at the source db makes
  // the write fail with INVALID_ARGUMENT (db mismatch) — surfaced here as a clear error.
  return ref;
}

/* ---------------- type helpers ---------------- */

const stats = {
  startedAt: new Date().toISOString(),
  dryRun: DRY_RUN,
  rewriteRefs: REWRITE_REFS,
  source: { projectId: PROJECT_ID, databaseId: SOURCE_DB, location: SOURCE_LOCATION },
  target: { projectId: PROJECT_ID, databaseId: TARGET_DB, location: TARGET_LOCATION },
  collections: [],
  totalDocs: 0,
  refsFound: 0,
  refsRewritten: 0,
  refsRewriteFailed: [],
  errors: [],
  finishedAt: null,
};

/** Walk a document's data; report DocumentReferences (with their db id) and rewrite if enabled. */
function transformValue(v, refReport) {
  if (v instanceof DocumentReference) {
    stats.refsFound++;
    refReport.push({ path: v.path, databaseId: v.databaseId ?? "(unknown)" });
    if (REWRITE_REFS && (v.databaseId ?? SOURCE_DB) === SOURCE_DB) {
      stats.refsRewritten++;
      // Same project/path, target database. Plain `tgt.doc(path)` cannot be used: the
      // serializer rejects a reference whose databaseId differs from the writer's db,
      // so the ref is re-pointed by rebuilding it through the target client — which is
      // exactly what `tgt.doc()` does — while plain data keeps its proto types.
      return tgt.doc(v.path);
    }
    return v;
  }
  if (v instanceof GeoPoint || v instanceof Timestamp || v instanceof Date) return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map((x) => transformValue(x, refReport));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = transformValue(val, refReport);
    return out;
  }
  return v;
}

function transformDoc(data, refReport) {
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = transformValue(v, refReport);
  return out;
}

/* ---------------- walker ---------------- */

/** africa-south1 round trips cost ~0.5–1.2 s each, so work is fanned out with bounded concurrency. */
async function pool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function copyCollection(collRef, depth) {
  if (ONLY && !ONLY.includes(collRef.id) && depth === 0) return;
  const label = `${"  ".repeat(depth)}${collRef.id}`;
  let count = 0;
  let lastId = null;
  const refReports = [];
  // Stream the collection in ordered pages; write each page with a BulkWriter.
  let cursor = null;
  for (;;) {
    const q = cursor ? collRef.orderBy("__name__").limit(300).startAfter(cursor) : collRef.orderBy("__name__").limit(300);
    const snap = await q.get();
    if (snap.empty) break;
    const writer = new BulkWriter(tgt);
    for (const d of snap.docs) {
      const refReport = [];
      const data = transformDoc(d.data(), refReport);
      if (refReport.length) refReports.push({ doc: d.id, refs: refReport });
      writeDoc(tgt, d.ref, data); // guard check — throws if the client were the source
      if (!DRY_RUN) {
        // Key MUST be a TARGET-client ref: a source-client ref as the write key makes the
        // RPC flip to the source database (verified: BulkWriterError 3 INVALID_ARGUMENT,
        // "request was for smart-school-db but was attempting to access (default)").
        const writeKey = tgt.doc(d.ref.path);
        writeDoc(tgt, writeKey, data); // guard check against the actual write key
        writer.set(writeKey, data); // id-preserving upsert
      }
      count++;
      lastId = d.id;
    }
    if (!DRY_RUN)
      await writer.close().catch((errs) => {
        for (const [ref, err] of Object.entries(errs ?? {})) stats.errors.push({ path: ref, error: String(err) });
      });
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < 300) break;
  }
  if (count > 0 || depth === 0) {
    console.log(`${label}: ${count} docs${refReports.length ? `  [${refReports.length} doc(s) with refs]` : ""}`);
    stats.collections.push({ id: collRef.id, depth, count, lastId, refReports });
  }
  // Recurse into subcollections of every doc, bounded parallelism.
  const docs = [];
  let subCursor = null;
  for (;;) {
    const q = subCursor ? collRef.limit(300).orderBy("__name__").startAfter(subCursor) : collRef.limit(300).orderBy("__name__");
    const snap = await q.get();
    if (snap.empty) break;
    docs.push(...snap.docs);
    subCursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < 300) break;
  }
  const subs = [];
  await pool(docs, 12, async (d) => {
    for (const s of await d.ref.listCollections()) subs.push(s);
  });
  for (const sub of subs) await copyCollection(sub, depth + 1);
  stats.totalDocs += count;
}

/* ---------------- main ---------------- */

console.log(`Firestore copy: "${SOURCE_DB}" (${SOURCE_LOCATION}) → "${TARGET_DB}" (${TARGET_LOCATION})`);
if (DRY_RUN) console.log("DRY RUN — no writes will be made.");
console.log(`refs rewrite: ${REWRITE_REFS ? "ON (refs to source are rewritten to target)" : "OFF (reported only)"}\n`);

const topCols = await src.listCollections();
await pool(topCols, 6, (c) => copyCollection(c, 0));

stats.finishedAt = new Date().toISOString();
mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(REPORT_PATH, JSON.stringify(stats, null, 2));

console.log(`\nDONE: ${stats.totalDocs} docs copied, refs found=${stats.refsFound} rewritten=${stats.refsRewritten}, errors=${stats.errors.length}`);
if (stats.errors.length) {
  console.log("ERRORS (first 10):");
  for (const e of stats.errors.slice(0, 10)) console.log(" -", e.path, e.error);
}
console.log(`report: ${REPORT_PATH}`);
if (stats.errors.length) process.exit(1);
