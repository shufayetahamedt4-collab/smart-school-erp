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
const roster = (await (await fetch(`${BASE}/api/attendance?classId=${first.id}&date=${date}`, { headers: H })).json()).data;
if (!roster?.length) throw new Error("no students in roster");
const rows = roster.slice(0, 2).map((s) => ({ studentId: s.id, classId: first.id, sectionId: undefined, status: "PRESENT", remark: "cache-test" }));
// need sectionId: roster has no sectionId — resolve from the teacher's assignment
const asn = (await (await fetch(`${BASE}/api/stats`, { headers: H })).json()).data.assignments.find((a) => a.classId === first.id);
rows.forEach((r) => (r.sectionId = asn?.sectionId || null));

const post = await fetch(`${BASE}/api/attendance`, {
  method: "POST",
  headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ date, rows }),
});
console.log("POST /api/attendance →", post.status, await post.text());

const after = await stats();
console.log("after:  attendanceToday =", after.attendanceToday);

const ok = after.attendanceToday === before.attendanceToday + 2;
console.log(ok ? "✅ INVALIDATION VERIFIED — dashboard reflected the submit immediately" : "❌ STALE — counts did not update");
process.exit(ok ? 0 : 1);
