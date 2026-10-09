/**
 * QA — Phase 3: §9.2 timetable builder backend + certificate generator.
 * Exercises: slot create, teacher double-booking 409, replaceId swap,
 * substitution finder, certificate data (TC + CHARACTER), cleanup.
 *
 *   node scripts/qa-phase3.mjs [baseUrl]
 */

const BASE = process.argv[2] || process.env.BASE || "http://localhost:64512";
const ADMIN = { identifier: "principal@sunrise.edu", password: "School@123" };

let passed = 0;
let failed = 0;
const pass = (n) => { passed++; console.log(`[PASS] ${n}`); };
const fail = (n, d) => { failed++; console.log(`[FAIL] ${n}${d ? ` — ${d}` : ""}`); };
const assert = (n, c, d = "") => (c ? pass(n) : fail(n, d));

async function api(path, { method = "GET", body, cookie, noFollow = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: noFollow ? "manual" : "follow",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, setCookie, headers: res.headers };
}
const cookieOf = (r) =>
  r.setCookie ? r.setCookie.split(";").map((s) => s.trim()).filter((s) => s.startsWith("ss_token=")).join("; ") : null;

async function main() {
  console.log(`QA against ${BASE}\n`);

  // middleware guard
  let r = await api("/dashboard/timetable", { noFollow: true });
  assert("timetable page requires login (307)", r.status === 307 && String(r.headers?.get("location") || "").includes("/login"), `got ${r.status}`);

  const cookie = cookieOf(await api("/api/auth/login", { method: "POST", body: ADMIN }));
  assert("school admin login", !!cookie);

  // reference data
  const [classes, subjects, teachers] = await Promise.all([
    api("/api/classes", { cookie }).then((x) => x.json?.data || []),
    api("/api/subjects", { cookie }).then((x) => x.json?.data || []),
    api("/api/teachers", { cookie }).then((x) => x.json?.data || []),
  ]);
  const cls = classes.find((c) => (c._count?.students ?? 1) >= 0);
  const subjA = subjects[0];
  const subjB = subjects[1] || subjects[0];
  const tA = teachers[0];
  const tB = teachers[1] || teachers[0];
  assert("reference data present (class/subjects/teachers)", !!cls && !!subjA && !!tA, JSON.stringify({ cls: !!cls, subjA: !!subjA, tA: !!tA }));

  const created = [];
  const del = (id) => api(`/api/timetable-slots?id=${id}`, { method: "DELETE", cookie });

  try {
    // --- create slot A (Sun, period 1) ---
    r = await api("/api/timetable-slots", {
      method: "POST", cookie,
      body: { classId: cls.id, subjectId: subjA.id, teacherId: tA.id, dayOfWeek: 0, period: 1 },
    });
    assert("slot A created (teacher A)", r.status === 201, JSON.stringify(r.json));
    created.push(r.json?.data?.id);

    // --- double-booking: teacher A again, same day+period ---
    r = await api("/api/timetable-slots", {
      method: "POST", cookie,
      body: { classId: cls.id, subjectId: subjB.id, teacherId: tA.id, dayOfWeek: 0, period: 1 },
    });
    assert("double-booking blocked with 409", r.status === 409 && /already has a class/.test(r.json?.error || ""), `got ${r.status}: ${JSON.stringify(r.json)}`);

    // --- same teacher, different period is fine ---
    r = await api("/api/timetable-slots", {
      method: "POST", cookie,
      body: { classId: cls.id, subjectId: subjB.id, teacherId: tA.id, dayOfWeek: 0, period: 2 },
    });
    assert("same teacher, different period OK", r.status === 201, JSON.stringify(r.json));
    created.push(r.json?.data?.id);

    // --- replaceId swap: move teacher A from period 2 into period 1's other cell ---
    r = await api("/api/timetable-slots", {
      method: "POST", cookie,
      body: { classId: cls.id, subjectId: subjB.id, teacherId: tA.id, dayOfWeek: 1, period: 1, replaceId: created[1] },
    });
    assert("replaceId swap allowed (move teacher within same period)", r.status === 201, `got ${r.status}: ${JSON.stringify(r.json)}`);
    created.push(r.json?.data?.id);

    // --- second teacher same cell OK ---
    r = await api("/api/timetable-slots", {
      method: "POST", cookie,
      body: { classId: cls.id, subjectId: subjB.id, teacherId: tB.id, dayOfWeek: 0, period: 1 },
    });
    assert("different teacher, same period OK", r.status === 201, JSON.stringify(r.json));
    created.push(r.json?.data?.id);

    // --- list ---
    r = await api(`/api/timetable-slots?classId=${cls.id}`, { cookie });
    const mine = (r.json?.data || []).filter((s) => created.includes(s.id));
    assert("slots list includes created slots with names", mine.length === created.length && mine.every((s) => s.subject?.name && s.teacher?.name), JSON.stringify(mine.map((s) => [s.dayOfWeek, s.period, s.subject?.name, s.teacher?.name])));

    // --- substitution finder (today — likely no approved leaves) ---
    r = await api("/api/timetable-slots", { method: "PUT", cookie, body: { date: new Date().toISOString() } });
    const sub = r.json?.data || {};
    assert("substitution finder returns affected + suggestions arrays", r.status === 200 && Array.isArray(sub.affected) && Array.isArray(sub.suggestions), JSON.stringify(Object.keys(sub)));
    assert("suggestions carry isOnLeave flags", sub.suggestions.every((t) => typeof t.isOnLeave === "boolean"));
  } finally {
    for (const id of created) await del(id);
    pass(`cleanup: deleted ${created.length} QA slot(s)`);
  }

  // ---------------- certificates ----------------
  const students = await api("/api/students", { cookie }).then((x) => x.json?.data || []);
  const student = students[0];
  assert("seed student available", !!student);

  r = await api(`/api/certificates?studentId=${student.id}&type=TC`, { cookie });
  const tc = r.json?.data || {};
  assert("TC data: serial + student + school", r.status === 200 && /^CERT-TC-\d{4}-/.test(tc.serial || "") && tc.student?.name && tc.school?.name, JSON.stringify(tc).slice(0, 200));
  assert("TC carries admission/leaving dates + class", !!tc.student?.admissionDate && tc.student?.className, JSON.stringify(tc.student));

  r = await api(`/api/certificates?studentId=${student.id}&type=CHARACTER`, { cookie });
  const cc = r.json?.data || {};
  assert("CHARACTER data: conduct=Good + CC serial", r.status === 200 && /^CERT-CC-/.test(cc.serial || "") && cc.student?.conduct === "Good", JSON.stringify({ serial: cc.serial, conduct: cc.student?.conduct }));

  r = await api("/api/certificates?studentId=nope&type=TC", { cookie });
  assert("unknown student → 404", r.status === 404, `got ${r.status}`);

  r = await api(`/api/certificates?studentId=${student.id}&type=TC`);
  assert("certificates require auth", r.status === 401, `got ${r.status}`);

  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("QA crashed:", e); process.exit(1); });
