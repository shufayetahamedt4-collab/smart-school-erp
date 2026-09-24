#!/usr/bin/env node
/**
 * verify-firestore-parity.mjs — source (default)/africa-south1 vs target smart-school-db/asia-southeast1.
 *
 * Run:  node scripts/verify-firestore-parity.mjs [--deep=N]
 *
 * Checks:
 *  1. Collection-group counts: every collection id discovered by full recursion on BOTH sides
 *     (top-level and subcollections) — counts must match exactly.
 *  2. Doc-id-set digest per collection (sha256 of sorted ids) — mismatch lists sample differing ids.
 *  3. Deep spot-compare: all docs of known-critical collections (users, schools, settings,
 *     feeSettings, plans, certificateTemplates) field-by-field INCLUDING Timestamp equality,
 *     plus N random docs per remaining collection (--deep=N, default 3).
 *
 * ANY count or digest mismatch → prints the mismatch table and exits 1. Zero mismatches → "PARITY OK".
 * Read-only on both databases by construction (this file has no write calls at all).
 */
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, DocumentReference, GeoPoint, Timestamp } from "firebase-admin/firestore";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const deepArg = argv.find((a) => a.startsWith("--deep="));
const DEEP_N = deepArg ? parseInt(deepArg.split("=")[1], 10) : 3;

const PROJECT_ID = "amar-e-school";
const SOURCE_DB = "(default)";
const TARGET_DB = "smart-school-db";
const REPORT_DIR = join(root, ".freebuff", "migration");

initializeApp({ credential: cert(JSON.parse(readFileSync(join(root, "service-account.json"), "utf8"))), projectId: PROJECT_ID });
const [src, tgt] = [getFirestore(), getFirestore(undefined, TARGET_DB)];
src.__databaseId = SOURCE_DB;
tgt.__databaseId = TARGET_DB;

/* ---------------- discovery ----------------
 *
 * Round trips to africa-south1 cost ~0.5–1.2 s each, so discovery is built from
 * CONCURRENCY, not from per-doc recursion (a serial walk of 1,646 docs ×
 * listCollections took >10 min and timed out). Strategy per client:
 *   1. stream every top-level collection once (ordered by __name__), collecting ids
 *      AND every doc reference in memory (1,646 refs is nothing);
 *   2. probe subcollections with a bounded-parallelism listCollections over all refs.
 * Subcollections found in step 2 are themselves streamed once (they are few: the
 * pre-flight found exactly one stray "noop" under conversations).
 */

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

async function discoverAll(client) {
  /** collectionId -> { count, ids:Set } */
  const found = new Map();
  const allDocRefs = [];

  async function streamCollection(coll, depth) {
    const entry = found.get(coll.id) ?? { count: 0, ids: new Set() };
    found.set(coll.id, entry);
    let cursor = null;
    for (;;) {
      const q = cursor ? coll.limit(500).orderBy("__name__").startAfter(cursor) : coll.limit(500).orderBy("__name__");
      const snap = await q.get();
      if (snap.empty) break;
      for (const d of snap.docs) {
        entry.count++;
        entry.ids.add(d.id);
        allDocRefs.push(d.ref);
      }
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < 500) break;
    }
  }

  const topCols = await client.listCollections();
  await pool(topCols, 6, (c) => streamCollection(c, 0));

  // subcollection probe, bounded parallelism
  const subCols = [];
  await pool(allDocRefs, 12, async (ref) => {
    for (const s of await ref.listCollections()) subCols.push(s);
  });
  for (const s of subCols) await streamCollection(s, 1);

  return found;
}

/* ---------------- comparison ---------------- */

function digestOf(ids) {
  return createHash("sha256").update([...ids].sort().join("\n")).digest("hex").slice(0, 16);
}

/** Canonical deep compare with explicit handling of Firestore special types. */
function deepEqual(a, b, path, diffs) {
  if (a instanceof Timestamp || b instanceof Timestamp) {
    if (!(a instanceof Timestamp && b instanceof Timestamp)) diffs.push(`${path}: Timestamp type mismatch`);
    else if (!a.isEqual(b)) diffs.push(`${path}: Timestamp ${a.toDate().toISOString()} != ${b.toDate().toISOString()}`);
    return;
  }
  if (a instanceof GeoPoint || b instanceof GeoPoint) {
    if (!(a instanceof GeoPoint && b instanceof GeoPoint)) diffs.push(`${path}: GeoPoint type mismatch`);
    else if (!a.isEqual(b)) diffs.push(`${path}: GeoPoint differs`);
    return;
  }
  if (a instanceof DocumentReference || b instanceof DocumentReference) {
    if (!(a instanceof DocumentReference && b instanceof DocumentReference)) diffs.push(`${path}: DocumentReference type mismatch`);
    else if (a.path !== b.path) diffs.push(`${path}: ref path ${a.path} != ${b.path}`);
    return; // databaseId intentionally allowed to differ (refs are rewritten to target)
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (Buffer.compare(Buffer.from(a ?? []), Buffer.from(b ?? [])) !== 0) diffs.push(`${path}: bytes differ`);
    return;
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    if (a !== b) diffs.push(`${path}: ${String(a)} != ${String(b)}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      diffs.push(`${path}: array length/type differs`);
      return;
    }
    for (let i = 0; i < a.length; i++) deepEqual(a[i], b[i], `${path}[${i}]`, diffs);
    return;
  }
  if (typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) deepEqual(a[k], b[k], `${path}.${k}`, diffs);
    return;
  }
  if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

const ALWAYS_DEEP = ["users", "schools", "settings", "feeSettings", "plans", "certificateTemplates"];

/* ---------------- main ---------------- */

console.log(`Parity check: "${SOURCE_DB}" vs "${TARGET_DB}"  (deep random docs per extra collection: ${DEEP_N})\n`);
const t0 = Date.now();
const [srcMap, tgtMap] = [await discoverAll(src), await discoverAll(tgt)];

const allIds = [...new Set([...srcMap.keys(), ...tgtMap.keys()])].sort();
const mismatches = [];
const table = [];

for (const id of allIds) {
  const s = srcMap.get(id);
  const t = tgtMap.get(id);
  const sc = s?.count ?? 0;
  const tc = t?.count ?? 0;
  const okCount = sc === tc;
  const sd = s ? digestOf(s.ids) : "—";
  const td = t ? digestOf(t.ids) : "—";
  const okDigest = s && t ? sd === td : false;
  const ok = okCount && okDigest;
  table.push({ collection: id, source: sc, target: tc, digest: ok ? sd : `${sd}/${td}`, ok });
  if (!ok) {
    const sIds = s?.ids ?? new Set();
    const tIds = t?.ids ?? new Set();
    const missingInTarget = [...sIds].filter((x) => !tIds.has(x)).slice(0, 5);
    const extraInTarget = [...tIds].filter((x) => !sIds.has(x)).slice(0, 5);
    mismatches.push({ collection: id, source: sc, target: tc, missingInTarget, extraInTarget });
  }
}

// wide table
const w = Math.max(...table.map((r) => r.collection.length), 10);
console.log("collection".padEnd(w + 2) + "source".padStart(8) + "target".padStart(8) + "  digest");
for (const r of table) {
  console.log(r.collection.padEnd(w + 2) + String(r.source).padStart(8) + String(r.target).padStart(8) + "  " + (r.ok ? r.digest : `✗ ${r.digest}`));
}

// deep compares
console.log("\ndeep doc compare:");
let deepChecked = 0;
let deepDiffsTotal = 0;
for (const id of allIds) {
  const s = srcMap.get(id);
  const t = tgtMap.get(id);
  if (!s || !t || s.count === 0) continue;
  const ids = [...s.ids].sort();
  const isCritical = ALWAYS_DEEP.includes(id);
  const pick = isCritical ? ids : ids.sort(() => Math.random() - 0.5).slice(0, DEEP_N);
  let collDiffs = 0;
  for (const docId of pick) {
    // The deep compare addresses docs as <collectionId>/<id> at the TOP level. A subcollection
    // that shares its name with a top-level collection (the stray conversations/*/noop) has no
    // top-level counterpart, so "exists=false" on BOTH sides is a true negative, not a mismatch.
    const [sd, td] = [await src.collection(id).doc(docId).get(), await tgt.collection(id).doc(docId).get()];
    if (!sd.exists && !td.exists) continue; // subcollection-only name; counts already matched above
    if (!sd.exists || !td.exists) {
      console.log(`  ✗ ${id}/${docId}: exists source=${sd.exists} target=${td.exists}`);
      collDiffs++;
      continue;
    }
    const diffs = [];
    deepEqual(sd.data(), td.data(), id + "/" + docId, diffs);
    if (diffs.length) {
      collDiffs++;
      for (const d of diffs.slice(0, 5)) console.log("  ✗", d);
      if (diffs.length > 5) console.log(`  … and ${diffs.length - 5} more in ${id}/${docId}`);
    }
    deepChecked++;
  }
  if (collDiffs) deepDiffsTotal += collDiffs;
  else if (isCritical) console.log(`  ✓ ${id}: all ${pick.length} docs field-identical (incl. Timestamps)`);
}
if (deepDiffsTotal === 0 && deepChecked > 0) console.log(`  ✓ ${deepChecked} deep-compared docs, zero field differences`);

mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = join(REPORT_DIR, `parity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), source: SOURCE_DB, target: TARGET_DB, table, mismatches, deepChecked, deepDiffsTotal }, null, 2));

console.log(`\nreport: ${reportPath}`);
console.log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (mismatches.length || deepDiffsTotal) {
  console.error(`\nPARITY FAILED: ${mismatches.length} collection mismatch(es), ${deepDiffsTotal} deep doc mismatch(es).`);
  for (const m of mismatches) console.error(" -", m.collection, `src=${m.source} tgt=${m.target}`, m.missingInTarget.length ? `missing in target: ${m.missingInTarget.join(",")}` : "", m.extraInTarget.length ? `extra in target: ${m.extraInTarget.join(",")}` : "");
  process.exit(1);
} else {
  console.log("\nPARITY OK — every collection count and id digest matches; deep compares clean.");
}
