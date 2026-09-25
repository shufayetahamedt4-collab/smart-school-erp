/**
 * seed-kit-demo.mjs — put stock on the shelves so the admission form's kit list
 * has something real to hand out.
 *
 * The demo school's catalogue is empty, which makes "check availability, then
 * distribute" impossible to see or test. This adds a Class 1 kit (textbooks,
 * uniform, ID card) with stock, and ONE item deliberately at zero so the
 * "0 available — can't distribute" state is visible on the form.
 *
 * Idempotent (an item that exists keeps its row, its stock is topped up only
 * with --force). Reversible: --remove deletes the catalogue rows this script
 * owns and their stock — but refuses to delete an item that is currently issued
 * to a student, so a real hand-out is never silently orphaned.
 *
 * Usage:
 *   node scripts/seed-kit-demo.mjs            # add / top up
 *   node scripts/seed-kit-demo.mjs --force    # reset stock to these numbers
 *   node scripts/seed-kit-demo.mjs --remove   # take them back out
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

if (!PROJECT_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error("❌ Missing Firebase Admin credentials in .env (FIREBASE_PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY).");
  process.exit(1);
}

function unescapeKey(k) {
  const BS = String.fromCharCode(92); // backslash
  if (!k.includes(BS + "n")) return k;
  return k.split(BS + "n").join("\n");
}

if (!getApps().length) {
  initializeApp({
    projectId: PROJECT_ID,
    credential: cert({ projectId: PROJECT_ID, clientEmail: CLIENT_EMAIL, privateKey: unescapeKey(PRIVATE_KEY) }),
  });
}
const db = getFirestore();

const REMOVE = process.argv.includes("--remove");
const FORCE = process.argv.includes("--force");

/** The Class 1 kit. `stock: 0` is intentional — it demonstrates the block. */
const KIT = [
  { title: "Class 1 Bangla Book", code: "TB1-BN", type: "TEXTBOOK", price: 320, stock: 40, lowStockThreshold: 5 },
  { title: "Class 1 English Book", code: "TB1-EN", type: "TEXTBOOK", price: 350, stock: 40, lowStockThreshold: 5 },
  { title: "Class 1 Mathematics Book", code: "TB1-MA", type: "TEXTBOOK", price: 380, stock: 40, lowStockThreshold: 5 },
  { title: "Class 1 Science Workbook", code: "WB1-SC", type: "TEXTBOOK", price: 260, stock: 0, lowStockThreshold: 5 },
  { title: "Summer Uniform (shirt + trouser)", code: "UNI-SUM", type: "UNIFORM", price: 950, stock: 30, lowStockThreshold: 5 },
  { title: "Winter Uniform (sweater)", code: "UNI-WIN", type: "UNIFORM", price: 1150, stock: 25, lowStockThreshold: 5 },
  { title: "School ID Card", code: "AST-ID", type: "ASSET", price: 0, stock: 100, lowStockThreshold: 10 },
];

async function main() {
  const schools = await db.collection("schools").where("slug", "==", "sunrise").limit(1).get();
  const schoolDoc = schools.empty ? (await db.collection("schools").limit(1).get()).docs[0] : schools.docs[0];
  if (!schoolDoc) {
    console.error("❌ No school found — run `npm run seed` first.");
    process.exit(1);
  }
  const schoolId = schoolDoc.id;
  console.log(`School: ${schoolDoc.data()?.name || schoolId}`);

  const classes = await db.collection("classes").where("schoolId", "==", schoolId).get();
  const classDoc = classes.docs.find((d) => d.data()?.name === "Class 1") || classes.docs[0];
  if (!classDoc) {
    console.error("❌ No classes found — run `npm run seed` first.");
    process.exit(1);
  }
  const className = classDoc.data()?.name || "Class 1";
  console.log(`Kit class: ${className} (${classDoc.id})`);

  // NB: the shim's collection names (lib/db.ts COLS) — bookCatalog / bookIssues / bookStock.
  const existing = await db.collection("bookCatalog").where("schoolId", "==", schoolId).get();
  const byTitle = new Map(existing.docs.map((d) => [d.data()?.title, d]));

  // ------------------------------------------------------------- --remove path
  if (REMOVE) {
    let gone = 0;
    for (const item of KIT) {
      const doc = byTitle.get(item.title);
      if (!doc) continue;
      const issued = await db.collection("bookIssues").where("bookId", "==", doc.id).where("status", "==", "ISSUED").get();
      if (!issued.empty) {
        console.log(`  ! kept "${item.title}" — ${issued.size} copy(ies) are issued to students`);
        continue;
      }
      const stocks = await db.collection("bookStock").where("bookId", "==", doc.id).get();
      for (const s of stocks.docs) await s.ref.delete();
      await doc.ref.delete();
      gone++;
    }
    console.log(`\n✓ Removed ${gone} catalogue item(s).`);
    return;
  }

  // ---------------------------------------------------------------- add / top up
  let added = 0;
  let topped = 0;
  for (const item of KIT) {
    const doc = byTitle.get(item.title);
    if (!doc) {
      const ref = db.collection("bookCatalog").doc();
      await ref.set({
        id: ref.id,
        schoolId,
        title: item.title,
        code: item.code,
        type: item.type,
        classId: classDoc.id,
        className,
        price: item.price,
      });
      await db.collection("bookStock").add({
        schoolId,
        bookId: ref.id,
        total: item.stock,
        lowStockThreshold: item.lowStockThreshold,
      });
      added++;
      continue;
    }
    const stocks = await db.collection("bookStock").where("bookId", "==", doc.id).get();
    if (stocks.empty) {
      await db.collection("bookStock").add({
        schoolId,
        bookId: doc.id,
        total: item.stock,
        lowStockThreshold: item.lowStockThreshold,
      });
      topped++;
    } else if (FORCE) {
      await stocks.docs[0].ref.update({ total: item.stock, lowStockThreshold: item.lowStockThreshold });
      topped++;
    }
  }

  console.log(`\n✓ Catalogue: ${added} item(s) added, ${topped} stock row(s) written.`);
  console.log(`  ${KIT.filter((k) => k.stock === 0).length} item is deliberately out of stock to show the block.`);
  console.log("  Open: /dashboard/students/new (choose Class 1 to see the kit)");
  console.log("  Undo with: node scripts/seed-kit-demo.mjs --remove");
}

await main();
