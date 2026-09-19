/**
 * parity-diff-qr.mjs — follow-up check 1: parity for a GUARDIAN session
 * that HAS studentId (QR login → fast path). Logs in via /api/qr/verify on
 * NEW (3000) and OLD (3001), fetches /api/stats, deep-diffs the JSON
 * (objects unordered, arrays — including trend — in order).
 *
 * Credentials are read from the environment, never hardcoded:
 *   QR_TOKEN=<student qrToken> QR_PIN=<student qrPin> node scripts/parity-diff-qr.mjs
 * (values live in Firestore: students → qrToken / qrPin for the linked student)
 */
const NEW_BASE = "http://localhost:3000";
const OLD_BASE = "http://localhost:3001";

const QR = { token: process.env.QR_TOKEN || "", pin: process.env.QR_PIN || "" };
if (!QR.token || !QR.pin) {
  console.error(
    "❌ Missing credentials. Set QR_TOKEN and QR_PIN env vars (the linked student's qrToken/qrPin from Firestore) and re-run:\n" +
      "  QR_TOKEN=<token> QR_PIN=<pin> node scripts/parity-diff-qr.mjs"
  );
  process.exit(1);
}

async function qrLogin(base) {
  const res = await fetch(`${base}/api/qr/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: QR.token, pin: QR.pin }),
  });
  if (!res.ok) throw new Error(`qr login @${base}: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error(`no cookie from ${base}`);
  return cookie;
}

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

const cNew = await qrLogin(NEW_BASE);
const cOld = await qrLogin(OLD_BASE);
const [rNew, rOld] = await Promise.all([
  fetch(`${NEW_BASE}/api/stats`, { headers: { cookie: cNew } }),
  fetch(`${OLD_BASE}/api/stats`, { headers: { cookie: cOld } }),
]);
const jNew = await rNew.json();
const jOld = await rOld.json();

// sanity: the fast path must have been taken (student-scoped data present)
console.log("new payload keys:", Object.keys(jNew.data || {}).join(","));
console.log("new fees.total =", jNew.data?.fees?.total, "| attendance.total =", jNew.data?.attendance?.total, "| marksCount =", jNew.data?.marksCount);

const diffs = diff(jOld, jNew, "data");
if (!diffs.length) {
  console.log("✅ QR guardian (studentId session): IDENTICAL — including trend arrays");
} else {
  console.log(`⚠️  ${diffs.length} difference(s):`);
  for (const d of diffs.slice(0, 60)) console.log(`   ${d.path}\n     old: ${d.old}\n     new: ${d.new}`);
  if (diffs.length > 60) console.log(`   … ${diffs.length - 60} more`);
}
