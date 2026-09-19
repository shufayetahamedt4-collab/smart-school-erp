/**
 * bench-stats.mjs — measure /api/stats timings per role against the dev server.
 * Usage: node scripts/bench-stats.mjs [rounds=3]
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const rounds = Number(process.argv[2] || 3);

const ACCOUNTS = [
  { label: "school-admin", email: "principal@sunrise.edu", password: "School@123" },
  { label: "teacher", email: "teacher@sunrise.edu", password: "Teacher@123" },
  { label: "guardian", email: "guardian1@demo.com", password: "Guardian@123" },
];

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  if (!cookie) throw new Error(`login ${email}: no session cookie (body: ${setCookie.slice(0, 120)})`);
  return cookie;
}

async function timeStats(cookie) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/stats`, { headers: { cookie } });
  const ms = Math.round(performance.now() - t0);
  const body = await res.json();
  return { ms, status: res.status, keys: body?.data ? Object.keys(body.data).join(",") : JSON.stringify(body).slice(0, 120) };
}

for (const acct of ACCOUNTS) {
  try {
    const cookie = await login(acct.email, acct.password);
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const r = await timeStats(cookie);
      samples.push(r);
    }
    const best = Math.min(...samples.map((s) => s.ms));
    const last = samples[samples.length - 1];
    console.log(`${acct.label.padEnd(14)} best=${String(best).padStart(6)}ms  last=${last.ms}ms ${last.status}  keys=[${last.keys}]`);
  } catch (e) {
    console.log(`${acct.label.padEnd(14)} ERROR: ${e.message.slice(0, 160)}`);
  }
}
