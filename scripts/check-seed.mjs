/**
 * Firestore seed-state checker.
 * Reports how many documents exist in each collection for the demo school,
 * and marks each seed phase as DONE / PARTIAL / EMPTY.
 *
 * Run:  node scripts/check-seed.mjs
 *
 * This is the "where did we leave off?" tool — run it any time you need to
 * resume an interrupted seed. It only READS Firestore; it never writes.
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

if (!PROJECT_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error("❌ Missing Firebase Admin credentials in .env (FIREBASE_PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY).");
  process.exit(1);
}

/** Turn literal backslash-n (2 chars) into real newlines; leave real newlines alone. */
function unescapeKey(k) {
  const BS = String.fromCharCode(92); // backslash
  if (!k.includes(BS + "n")) return k;
  return k.split(BS + "n").join("\n");
}

if (!getApps().length) {
  initializeApp({
    projectId: PROJECT_ID,
    credential: cert({
      projectId: PROJECT_ID,
      clientEmail: CLIENT_EMAIL,
      privateKey: unescapeKey(PRIVATE_KEY),
    }),
  });
}
const db = getFirestore();

const sha1 = (s) => createHash("sha1").update(s).digest("hex");

/** Expected minimum document counts once the full seed has run. */
const EXPECTED = {
  settings: 1,
  schools: 1,
  feeSettings: 1,
  users: 16, // 1 super admin + 1 school admin + 4 teachers + 10 guardians
  classes: 5,
  sections: 10,
  subjects: 7,
  teachers: 4,
  assignments: 12,
  students: 14,
  fees: 56,
  attendance: 112,
  remarks: 28,
  homeworks: 4, // 5 listed; the ICT one is skipped (no ICT teacher in seed)
  exams: 1,
  marks: 21,
  notices: 5,
  routines: 20, // 7 periods x 5 days, only 4 subjects have teachers
  messages: 1,
  payments: 0,
  auditLogs: 0,
  submissions: 0,
};

/** Seed phases in execution order, with the collection(s) that prove them. */
const PHASES = [
  { name: "1. settings + super admin", prove: ["settings", "users"] },
  { name: "2. school + feeSettings + school admin", prove: ["schools", "feeSettings"] },
  { name: "3. classes + sections + subjects", prove: ["classes", "sections", "subjects"] },
  { name: "4. teachers + assignments", prove: ["teachers", "assignments"] },
  { name: "5. students + guardian accounts", prove: ["students"] },
  { name: "6. fees", prove: ["fees"] },
  { name: "7. attendance (8 days)", prove: ["attendance"] },
  { name: "8. remarks + homework", prove: ["remarks", "homeworks"] },
  { name: "9. exam + marks", prove: ["exams", "marks"] },
  { name: "10. notices + routine + messages", prove: ["notices", "routines", "messages"] },
];

async function countAll() {
  const counts = {};
  const all = Object.keys(EXPECTED);
  // Fresh demo project → collections are small; count all docs (index-free).
  const BATCH = 6;
  for (let i = 0; i < all.length; i += BATCH) {
    await Promise.all(
      all.slice(i, i + BATCH).map(async (name) => {
        try {
          const snap = await db.collection(name).get();
          counts[name] = snap.size;
        } catch (e) {
          counts[name] = -1; // unreachable / no permission
        }
      })
    );
  }
  return counts;
}

function phaseStatus(phase, counts) {
  let any = false,
    done = true,
    missing = [];
  for (const c of phase.prove) {
    const n = counts[c] ?? 0;
    if (n > 0) any = true;
    if (n < (EXPECTED[c] ?? 1)) {
      done = false;
      missing.push(c + "=" + n + "/" + EXPECTED[c]);
    }
  }
  if (!any) return { tag: "EMPTY", detail: missing.join(", ") };
  if (done) return { tag: "DONE", detail: "" };
  return { tag: "PARTIAL", detail: missing.join(", ") };
}

async function main() {
  console.log("");
  console.log("=== Firestore seed-state check — project \"" + PROJECT_ID + "\" ===");
  let counts;
  try {
    counts = await countAll();
  } catch (e) {
    console.error("❌ Could not reach Firestore:", e.message);
    process.exit(1);
  }

  console.log("Collection counts:");
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const n = counts[name] ?? 0;
    const mark = n >= expected ? "✅" : n > 0 ? "⚠️" : "—";
    console.log("  " + mark + " " + name.padEnd(12) + " " + String(n).padStart(4) + "  (expected " + expected + ")");
  }

  console.log("Seed phase status:");
  for (const phase of PHASES) {
    const { tag, detail } = phaseStatus(phase, counts);
    const icon = tag === "DONE" ? "✅" : tag === "PARTIAL" ? "⚠️" : "⬜";
    console.log("  " + icon + " " + phase.name + (detail ? "  — missing: " + detail : ""));
  }

  const incomplete = PHASES.filter((p) => phaseStatus(p, counts).tag !== "DONE");
  console.log("\n----------------------------------------------");
  if (incomplete.length === 0) {
    console.log("✅ Seed appears COMPLETE. Nothing to re-run (re-running is harmless anyway).");
  } else {
    const first = incomplete[0];
    console.log("⏸️  Seed INTERRUPTED. It stopped during phase \"" + first.name + "\".");
    console.log("   → Fix: run  npm run setup  — it is idempotent and will fill in the missing parts.");
    if (first.name !== "1. settings + super admin") {
      console.log("   (Earlier phases are complete; the re-run will skip them and continue.)");
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
