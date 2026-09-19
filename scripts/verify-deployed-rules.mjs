/**
 * verify-deployed-rules.mjs — one-off QA: compare DEPLOYED rules vs local files.
 *
 * Authenticates with the local service-account.json (Firebase Admin),
 * calls the Release/Rules API to get the currently-released rulesets for
 * cloud.firestore and firebase.storage, and diffs them against the local
 * firestore.rules / storage.rules sources.
 *
 * Usage: node scripts/verify-deployed-rules.mjs
 * Prints MATCH or DIFF verdicts; exit code 0 = both match, 1 = mismatch/error.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "amar-e-school";
const API = "https://firebaserules.googleapis.com/v1";

// Scope: rules deployment requires the Firebase Rules System service account
// flow — the service account token works for GetRelease/GetRuleset reads.
const auth = new GoogleAuth({
  keyFile: path.join(ROOT, "service-account.json"),
  scopes: ["https://www.googleapis.com/auth/firebase", "https://www.googleapis.com/auth/cloud-platform"],
});
const client = await auth.getClient();
const token = await client.getAccessToken();

async function api(pathUrl) {
  const res = await fetch(`${API}${pathUrl}`, {
    headers: { Authorization: `Bearer ${token.token}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${await res.text()}`);
  return res.json();
}

async function releasedSource(service) {
  const release = await api(`/projects/${PROJECT}/releases/${service}`);
  if (!release.rulesetName) throw new Error(`Release ${service} has no ruleset_name`);
  const rulesetId = release.rulesetName;
  const ruleset = await api(`/${rulesetId}`);
  const files = (ruleset.source?.files || []).map((f) => f.content).join("\n");
  return { files, rulesetId, releaseName: release.name };
}

function normalize(s) {
  return s.replace(/\r\n/g, "\n").trim();
}

let failed = false;
for (const [service, localFile] of [
  ["cloud.firestore", "firestore.rules"],
  ["firebase.storage/amar-e-school.firebasestorage.app", "storage.rules"],
]) {
  try {
    const local = normalize(readFileSync(path.join(ROOT, localFile), "utf8"));
    const { files, rulesetId } = await releasedSource(service);
    const remote = normalize(files);
    const match = local === remote;
    console.log(`${match ? "✅ MATCH" : "❌ DIFF"}  ${service}  (ruleset ${rulesetId.split("/").pop()})`);
    if (!match) {
      failed = true;
      const a = local.split("\n"), b = remote.split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) console.log(`   line ${i + 1}:\n   local : ${JSON.stringify(a[i] ?? "(eof)")}\n   remote: ${JSON.stringify(b[i] ?? "(eof)")}`);
      }
    }
  } catch (e) {
    failed = true;
    console.error(`❌ ERROR ${service}: ${e.message.slice(0, 400)}`);
  }
}
process.exit(failed ? 1 : 0);
