/**
 * verify-write-freshness.mjs — prove the read cache never hides a write.
 *
 * The read memo makes routes ~3ms, which is only safe if a write drops it.
 * This creates a notice, reads it back immediately (well inside the TTL),
 * then deletes it and confirms it is gone — so a stale-cache regression
 * fails loudly instead of showing up as "my change didn't save" for a user.
 *
 * Usage: node scripts/verify-write-freshness.mjs
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "principal@sunrise.edu", password: "School@123" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

const cookie = await login();
const H = { "Content-Type": "application/json", cookie };
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const readNotices = async () => (await (await fetch(`${BASE}/api/notices?limit=100`, { headers: { cookie } })).json()).data || [];

// Warm the notices read so the create must invalidate a populated cache.
await readNotices();
const title = `cache-freshness-${Date.now()}`;

const created = await (await fetch(`${BASE}/api/notices`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ title, body: "temporary probe", category: "GENERAL" }),
})).json();
const id = created?.data?.id;
check("create returns an id", !!id, String(id));
check("new notice is visible on the very next read (no stale cache)", (await readNotices()).some((n) => n.id === id));

// Notices have no update verb, so exercise the second write path directly:
// a delete must also be visible on the next read, not after the TTL.
const del = await fetch(`${BASE}/api/notices?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: H });
check("delete succeeds", del.ok, `HTTP ${del.status}`);
check("deleted notice is gone on the very next read", !(await readNotices()).some((n) => n.id === id));

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall write-freshness checks passed");
process.exit(failures ? 1 : 0);
