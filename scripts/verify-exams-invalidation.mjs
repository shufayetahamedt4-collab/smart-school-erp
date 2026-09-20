/**
 * verify-exams-invalidation.mjs — live check that exam create/update/delete
 * immediately invalidate the /api/exams cache (no stale reads inside the
 * 30s TTL window). Uses the demo school's admin account.
 *
 * Usage: node scripts/verify-exams-invalidation.mjs [BASE=http://localhost:58497]
 */
const BASE = process.env.BASE || "http://localhost:58497";
const EMAIL = process.env.ADMIN_EMAIL || "principal@sunrise.edu";
const PASSWORD = process.env.ADMIN_PASSWORD || "School@123";

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✅ ${msg}`);
  else { failures++; console.log(`  ❌ ${msg}`); }
};

const login = async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};
const getJSON = async (cookie, route, opts = {}) => {
  const res = await fetch(`${BASE}${route}`, {
    ...opts,
    headers: { cookie, ...(opts.headers || {}) }, // keep the session cookie on POST/PATCH/DELETE too
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const cookie = await login();
const classId = ((await getJSON(cookie, "/api/classes")).body?.data || [])[0]?.id;
if (!classId) { console.error("no classes found"); process.exit(1); }

// 1. Warm the cache with a plain GET.
await getJSON(cookie, "/api/exams");

// 2. CREATE → immediately visible (POST must invalidate).
const name1 = `ZZ QA Inv Exam ${Date.now()}`;
const created = await getJSON(cookie, "/api/exams", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: name1, classId, year: 2026 }),
});
check(created.status === 201, `create exam (${created.status})`);
const examId = created.body?.data?.id;
check(!!examId, "created exam has an id");
const afterCreate = (await getJSON(cookie, "/api/exams")).body?.data || [];
check(afterCreate.some((e) => e.id === examId), "GET after CREATE shows the new exam (cache invalidated)");

// 3. UPDATE → immediately visible.
const name2 = `${name1} RENAMED`;
const patched = await getJSON(cookie, `/api/exams/${examId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: name2 }),
});
check(patched.status === 200, `rename exam (${patched.status})`);
const afterPatch = (await getJSON(cookie, "/api/exams")).body?.data || [];
check(afterPatch.some((e) => e.id === examId && e.name === name2), "GET after UPDATE shows the renamed exam (cache invalidated)");
check(!afterPatch.some((e) => e.id === examId && e.name === name1), "stale name is gone");

// 4. DELETE → immediately gone.
const del = await getJSON(cookie, `/api/exams/${examId}`, { method: "DELETE" });
check(del.status === 200, `delete exam (${del.status})`);
const afterDelete = (await getJSON(cookie, "/api/exams")).body?.data || [];
check(!afterDelete.some((e) => e.id === examId), "GET after DELETE no longer lists the exam (cache invalidated)");

console.log(failures === 0 ? "\n✅ EXAMS CACHE INVALIDATION CONFIRMED (create/update/delete)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
