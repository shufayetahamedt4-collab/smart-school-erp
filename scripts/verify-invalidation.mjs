/**
 * verify-invalidation.mjs — prove the stats cache invalidates on submit:
 * login as teacher → read stats (attendanceToday) → POST attendance for a
 * couple of students → read stats again immediately. Second read must
 * reflect the new rows without waiting for the 30s TTL.
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
  });
  if (!res.ok) throw new Error(`login: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
const cookie = await login("teacher@sunrise.edu", "Teacher@123");
const H = { cookie };

const stats = async () => (await (await fetch(`${BASE}/api/stats`, { headers: H })).json()).data;

const before = await stats();
console.log("before: attendanceToday =", before.attendanceToday, "(count of rows this teacher marked today)");

// pick the teacher's first class and pull today's roster (GET /api/attendance returns student ids)
const first = before.myClasses[0];
const today = new Date();
const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
// Find an UNMARKED student across the teacher's classes — marking them
// MUST increase the "records marked today" count by 1 (re-run safe: the
// previous test's students are already marked, so skip those).
let target = null;
let asn = null;
for (const cls of before.myClasses) {
  const roster = (await (await fetch(`${BASE}/api/attendance?classId=${cls.id}&date=${date}`, { headers: H })).json()).data;
  const unmarked = (roster || []).find((s) => s.status === "UNMARKED");
  if (unmarked) {
    asn = before.assignments.find((a) => a.classId === cls.id);
    target = { student: unmarked, classId: cls.id };
    break;
  }
}
if (!target) {
  console.log("⚠️  every student in the teacher's classes is already marked — nothing to submit; re-run after resetting attendance");
  process.exit(0);
}
const rows = [{ studentId: target.student.id, classId: target.classId, sectionId: asn?.sectionId || null, status: "PRESENT", remark: "cache-test" }];

const post = await fetch(`${BASE}/api/attendance`, {
  method: "POST",
  headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ date, rows }),
});
console.log("POST /api/attendance →", post.status, await post.text());

const after = await stats();
console.log("after:  attendanceToday =", after.attendanceToday);

const changed = after.attendanceToday === before.attendanceToday + 1;
console.log(changed ? "✅ INVALIDATION VERIFIED — dashboard reflected the submit immediately" : "❌ STALE — counts did not update");
process.exit(changed ? 0 : 1);
process.exit(ok ? 0 : 1);
