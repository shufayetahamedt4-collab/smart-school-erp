/**
 * verify-sweep-routes.mjs — correctness spot checks for the route sweep.
 * Logs in as all three roles and asserts the rewritten GETs return
 * well-formed, populated payloads (fees/homework/attendance/meetings/
 * routines/exams). Uses the seeded demo school.
 * Usage: node scripts/verify-sweep-routes.mjs
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const ROLES = [
  { label: "admin", email: "principal@sunrise.edu", password: "School@123" },
  { label: "teacher", email: "teacher@sunrise.edu", password: "Teacher@123" },
  { label: "guardian", email: "guardian1@demo.com", password: "Guardian@123" },
];

const fails = [];
function check(cond, label) {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) fails.push(label);
}

async function login(role) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: role.email, password: role.password }),
  });
  if (!res.ok) throw new Error(`login ${role.email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
async function get(cookie, route) {
  const res = await fetch(`${BASE}${route}`, { headers: { cookie }, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })();

for (const role of ROLES) {
  console.log(`\n### ${role.label}`);
  const cookie = await login(role);
  check(Boolean(cookie), "login sets cookie");

  const stats = await get(cookie, "/api/stats");
  check(stats.status === 200 && stats.json?.data, "stats 200 + data");
  // A real class id — stats' myClasses/assignments may point at empty classes.
  // (Guardians can't list classes and don't probe attendance below.)
  let c1 = "";
  if (role.label !== "guardian") {
    const cls = await get(cookie, "/api/classes");
    c1 = (cls.json?.data || [])[0]?.id || "";
    check(Boolean(c1), "a class exists to probe attendance");
  }

  if (role.label !== "guardian") {
    // Attendance with a real class
    const att = await get(cookie, `/api/attendance?classId=${c1}&date=${TODAY}`);
    const rows = att.json?.data || [];
    check(att.status === 200 && Array.isArray(rows) && rows.length > 0, `attendance rows > 0 (${rows.length})`);
    check(rows.every((r) => typeof r.name === "string" && ["PRESENT", "ABSENT", "LATE", "UNMARKED"].includes(r.status)), "attendance rows well-formed");

    // Homework — teacher names resolved, submissions arrays present
    const hw = await get(cookie, "/api/homework");
    const hws = hw.json?.data || [];
    check(hw.status === 200 && Array.isArray(hws), "homework 200 + array");
    if (hws.length) {
      const withTeacher = hws.find((h) => h.teacher?.user?.name);
      check(Boolean(withTeacher), "homework teacher names resolved");
      check(hws.every((h) => Array.isArray(h.submissions)), "homework submissions arrays present");
    }

    // Exams — _count.marks present
    const ex = await get(cookie, "/api/exams");
    const exs = ex.json?.data || [];
    check(ex.status === 200 && Array.isArray(exs), "exams 200 + array");
    check(exs.every((e) => typeof e._count?.marks === "number"), "exams _count.marks numeric");
    if (exs.length) check(exs.some((e) => e.classRoom?.name), "exams classRoom names resolved");

    // Routines — names resolved
    const ro = await get(cookie, `/api/routines${c1 ? `?classId=${c1}` : ""}`);
    const ros = ro.json?.data || [];
    check(ro.status === 200 && Array.isArray(ros), "routines 200 + array");
    if (ros.length) check(ros.some((r) => r.subject?.name || r.teacher?.user?.name || r.classRoom?.name), "routines relation names resolved");
  }

  // Fees — role-appropriate visibility
  const fees = await get(cookie, "/api/fees");
  const feeArr = fees.json?.data?.fees || [];
  check(fees.status === 200 && Array.isArray(feeArr), "fees 200 + array");
  // Parity with the legacy include semantics: payments present (array),
  // installments key intentionally ABSENT (old db layer dropped that include).
  check(feeArr.every((f) => Array.isArray(f.payments)), "fees payments arrays");
  check(feeArr.every((f) => !("installments" in f)), "fees installments key absent (legacy parity)");
  if (role.label !== "guardian") {
    check(feeArr.length > 0, `${role.label} sees fees (${feeArr.length})`);
    check(feeArr.every((f) => !f.student || typeof f.student.name === "string"), "fees student names resolved");
    if (role.label === "admin") check(Array.isArray(fees.json?.data?.templates), "fees templates array present (admin) — collection may be empty in seed");
  } else {
    check(feeArr.length > 0, `guardian sees own fees (${feeArr.length})`);
  }

  // Meetings
  const mt = await get(cookie, "/api/meetings");
  const mtArr = mt.json?.data || [];
  check(mt.status === 200 && Array.isArray(mtArr), "meetings 200 + array");
  if (role.label === "guardian") {
    // Legacy parity: teacher docs have no `name`, so the key serializes as
    // undefined (absent in JSON). booked must always be a boolean.
    check(mtArr.every((m) => (m.teacher === undefined || typeof m.teacher === "string") && typeof m.booked === "boolean"), "guardian meetings shape (booked flag; teacher key absent per legacy)");
  } else if (mtArr.length) {
    const withBooking = mtArr.find((m) => (m.bookings || []).length > 0);
    if (withBooking) {
      const b = withBooking.bookings[0];
      check(b.student === null || typeof b.student?.name === "string", "staff meeting booking student resolved");
      check(b.guardian === null || typeof b.guardian?.name === "string", "staff meeting booking guardian resolved");
    }
  }
}

console.log(fails.length ? `\n❌ ${fails.length} check(s) failed` : "\n✅ all spot checks passed");
process.exit(fails.length ? 1 : 0);
