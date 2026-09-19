/**
 * audit-counts.mjs — follow-up 4: verify the db-layer native count() fast
 * path (lone schoolId equality) returns the same numbers as the old
 * in-memory path (pull all docs, take length). Runs both directly against
 * Firestore with the service account, for the seeded school.
 * Usage: node scripts/audit-counts.mjs
 */
import admin from "firebase-admin";
import { readFileSync } from "node:fs";

const serviceAccount = JSON.parse(readFileSync(new URL("../service-account.json", import.meta.url), "utf8"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const schools = await db.collection("schools").get();
const school = schools.docs.find((d) => (d.data().name || "").includes("Sunrise")) || schools.docs[0];
const schoolId = school.id;
console.log(`school: ${school.data().name} (${schoolId})\n`);

const CASES = [
  { label: "students (all)", col: "students", native: (q) => q, memory: () => true },
  { label: "students (active=true)", col: "students", native: (q) => q.where("active", "==", true), memory: (d) => d.active === true },
  { label: "teachers", col: "teachers", native: (q) => q, memory: () => true },
  { label: "classes", col: "classes", native: (q) => q, memory: () => true },
  { label: "exams", col: "exams", native: (q) => q, memory: () => true },
  { label: "notices", col: "notices", native: (q) => q, memory: () => true },
  { label: "fees", col: "fees", native: (q) => q, memory: () => true },
];

let allOk = true;
for (const c of CASES) {
  const base = db.collection(c.col).where("schoolId", "==", schoolId);
  const nativeSnap = await c.native(base).count().get();
  const native = Number(nativeSnap.data().count ?? nativeSnap.data().totalCount ?? 0);
  const memSnap = await base.get();
  const memory = memSnap.docs.filter((d) => c.memory(d.data())).length;
  const ok = native === memory;
  allOk = allOk && ok;
  console.log(`${ok ? "✅" : "❌"} ${c.label.padEnd(24)} native=${String(native).padStart(4)}  memory=${String(memory).padStart(4)}`);
}
console.log(allOk ? "\n✅ AUDIT PASSED — native counts match the old in-memory path" : "\n❌ AUDIT FAILED");
process.exit(allOk ? 0 : 1);
