import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { firebaseConfigProblem } from "@/lib/firebase";

/**
 * Deployment self-check — the answer to "why is every screen empty / why did
 * sign-in say *Request failed*?" on a host whose environment is not set up.
 *
 * It reports PRESENCE, never values: which variables this process can see, what
 * the host looks like, and the result of one real Firestore read. Nothing here
 * is a secret — and it deliberately has no auth, because the whole point is to
 * be reachable from a browser before anybody can sign in.
 *
 *   GET /api/health            → JSON
 *   GET /api/health?probe=0    → skip the Firestore read (no database password needed)
 *
 * 200 = every required variable is present AND Firestore answered.
 * 503 = something is missing or unreachable; `problems` says what.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const probe = new URL(req.url).searchParams.get("probe") !== "0";

  const env = {
    FIREBASE_PROJECT_ID: Boolean(process.env.FIREBASE_PROJECT_ID),
    FIREBASE_CLIENT_EMAIL: Boolean(process.env.FIREBASE_CLIENT_EMAIL),
    FIREBASE_PRIVATE_KEY: Boolean(process.env.FIREBASE_PRIVATE_KEY),
    JWT_SECRET: Boolean(process.env.JWT_SECRET),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || null,
    appDomain: process.env.APP_DOMAIN || process.env.NEXT_PUBLIC_APP_DOMAIN || null,
    appUrl: process.env.APP_URL || null,
  };

  const problems: string[] = [];
  for (const key of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"] as const) {
    if (!env[key]) problems.push(`${key} is not set`);
  }
  if (!env.JWT_SECRET) {
    // Sessions are signed with a dev fallback when this is missing, which is
    // worse than an error: rotating the real secret later signs everyone out.
    problems.push("JWT_SECRET is unset, so sessions are signed with the built-in development secret");
  }
  if (!env.storageBucket) {
    problems.push("FIREBASE_STORAGE_BUCKET is unset, so uploads fall back to <projectId>.appspot.com");
  }
  const configProblem = firebaseConfigProblem();
  if (configProblem) problems.push(configProblem);

  let firestore: { ok: boolean; readMs?: number; error?: string } | { skipped: true } = { skipped: true };
  if (probe) {
    const started = Date.now();
    try {
      await prisma.school.findFirst({ select: { id: true } });
      firestore = { ok: true, readMs: Date.now() - started };
    } catch (e: any) {
      const message = String(e?.message || e);
      firestore = { ok: false, error: message.length > 400 ? message.slice(0, 400) + "…" : message };
      problems.push(`Firestore read failed: ${firestore.error}`);
    }
  }

  return NextResponse.json(
    {
      data: {
        ok: problems.length === 0,
        problems,
        env,
        firestore,
        runtime: {
          node: process.version,
          host: process.env.NETLIFY ? "netlify" : process.env.K_SERVICE ? "google-cloud" : process.platform,
          commit: process.env.COMMIT_REF || process.env.GIT_COMMIT || null,
        },
      },
    },
    { status: problems.length ? 503 : 200 }
  );
}
