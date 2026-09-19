/**
 * parity-diff.mjs — fetch /api/stats per role from NEW (3000) and OLD (3001)
 * servers and deep-diff the JSON. Objects compared unordered, arrays ordered.
 * Usage: node scripts/parity-diff.mjs
 */
const NEW_BASE = "http://localhost:3000";
const OLD_BASE = "http://localhost:3001";

const ACCOUNTS = [
  { label: "school-admin", email: "principal@sunrise.edu", password: "School@123" },
  { label: "teacher", email: "teacher@sunrise.edu", password: "Teacher@123" },
  { label: "guardian", email: "guardian1@demo.com", password: "Guardian@123" },
];

async function login(base, email, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} @${base}: ${res.status}`);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error(`no cookie from ${base}`);
  return cookie;
}

// deep diff: returns array of {path, old, new} — objects unordered, arrays in order
function diff(a, b, path = "", out = []) {
  const ta = Array.isArray(a) ? "array" : a instanceof Date ? "date" : typeof a;
  const tb = Array.isArray(b) ? "array" : b instanceof Date ? "date" : typeof b;
  if (ta !== tb) {
    out.push({ path: path || "(root)", old: ta, new: tb });
    return out;
  }
  if (ta === "array") {
    const len = Math.max((a || []).length, (b || []).length);
    if ((a || []).length !== (b || []).length) out.push({ path: `${path}.length`, old: (a || []).length, new: (b || []).length });
    for (let i = 0; i < len; i++) diff(a?.[i], b?.[i], `${path}[${i}]`, out);
    return out;
  }
  if (ta === "object") {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of [...keys].sort()) {
      if (!(k in (a || {}))) out.push({ path: `${path}.${k}`, old: "(absent)", new: JSON.stringify(b[k]).slice(0, 80) });
      else if (!(k in (b || {}))) out.push({ path: `${path}.${k}`, old: JSON.stringify(a[k]).slice(0, 80), new: "(absent)" });
      else diff(a[k], b[k], path ? `${path}.${k}` : k, out);
    }
    return out;
  }
  if (ta === "date" || a !== b) {
    out.push({ path: path || "(root)", old: JSON.stringify(a), new: JSON.stringify(b) });
  }
  return out;
}

for (const acct of ACCOUNTS) {
  try {
    const [cNew, cOld] = await Promise.all([
      login(NEW_BASE, acct.email, acct.password),
      login(OLD_BASE, acct.email, acct.password),
    ]);
    const [rNew, rOld] = await Promise.all([
      fetch(`${NEW_BASE}/api/stats`, { headers: { cookie: cNew } }),
      fetch(`${OLD_BASE}/api/stats`, { headers: { cookie: cOld } }),
    ]);
    const jNew = await rNew.json();
    const jOld = await rOld.json();
    const diffs = diff(jOld, jNew, "data");
    if (!diffs.length) {
      console.log(`✅ ${acct.label}: IDENTICAL (keys: ${Object.keys(jNew.data || {}).join(",")})`);
    } else {
      console.log(`⚠️  ${acct.label}: ${diffs.length} difference(s)`);
      for (const d of diffs.slice(0, 40)) {
        console.log(`   ${d.path}\n     old: ${d.old}\n     new: ${d.new}`);
      }
      if (diffs.length > 40) console.log(`   … ${diffs.length - 40} more`);
    }
  } catch (e) {
    console.log(`❌ ${acct.label}: ${e.message}`);
  }
}
