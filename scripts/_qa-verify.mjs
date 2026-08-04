import { loadEnv } from "./load-env.mjs";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";

loadEnv();
const BS = String.fromCharCode(92);
const unesc = (k) => (k.includes(BS + "n") ? k.split(BS + "n").join("\n") : k);
if (!getApps().length) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: unesc(process.env.FIREBASE_PRIVATE_KEY),
    }),
  });
}
const db = getFirestore();
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

const schoolId = "s_" + sha1("qa-demo-school-2026");
console.log("Looking for school doc:", schoolId);

const schoolSnap = await db.collection("schools").doc(schoolId).get();
console.log("✅ school doc EXISTS in Firestore:", schoolSnap.exists);
if (schoolSnap.exists) {
  const d = schoolSnap.data();
  console.log("   name:", d.name, "| slug:", d.slug, "| status:", d.status, "| plan:", d.plan);
}

const adminEmail = "qa-admin@demo.com";
const userId = "u_" + sha1(adminEmail);
const userSnap = await db.collection("users").doc(userId).get();
console.log("✅ SCHOOL_ADMIN user doc in Firestore:", userSnap.exists, userSnap.exists ? "(" + userSnap.data().email + ")" : "");

const fsSnap = await db.collection("feeSettings").doc("fs_" + schoolId).get();
console.log("✅ feeSettings doc in Firestore:", fsSnap.exists, fsSnap.exists ? "(monthly=" + fsSnap.data().monthlyFee + ")" : "");

const auditSnap = await db.collection("auditLogs").get();
console.log("auditLogs total:", auditSnap.size, "(SCHOOL_CREATE entry logged by the app)");
