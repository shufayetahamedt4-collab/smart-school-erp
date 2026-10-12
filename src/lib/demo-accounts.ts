/**
 * The demo quick-fill accounts on the sign-in screen (pilot-fix-1 item 4).
 *
 * These are the accounts `scripts/seed.mjs` creates — and that script refuses to
 * run anywhere but the local Firestore emulator (`requireEmulator()`), so they
 * exist in a demo database, never in a deployment.
 *
 * They used to be a constant inside the CLIENT sign-in component. That put the
 * credentials in the production JavaScript bundle and rendered a "click to fill"
 * card on the live sign-in page of every deployment. They now live here, on the
 * server: `src/app/login/page.tsx` hands this list to the form, and on a
 * deployment it hands over an EMPTY list instead — no credentials in the bundle,
 * no card on the screen, and nothing to remove by hand later.
 *
 * Keep this module importable ONLY from server components. The form receives the
 * list as a prop and imports this module's TYPE alone.
 */
import { isProductionEnv, type EnvLike } from "./pilot-guards";
import type { SectorKey } from "./sectors";

export interface DemoAccount {
  /** The one app this account belongs to. */
  sector: SectorKey;
  role: string;
  id: string;
  pw: string;
}

/** The seeded demo logins, exactly as the emulator seed creates them. */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  { sector: "super", role: "Super Admin", id: "admin@smartschool.com", pw: "Admin@123" },
  { sector: "school", role: "School Admin", id: "principal@sunrise.edu", pw: "School@123" },
  { sector: "teacher", role: "Teacher", id: "teacher@sunrise.edu", pw: "Teacher@123" },
  { sector: "guardian", role: "Guardian", id: "guardian1@demo.com", pw: "Guardian@123" },
];

/**
 * What the sign-in page may offer to quick-fill: nothing on a deployment.
 *
 * A deployment has no seeded demo accounts, so the honest answer there is the
 * empty list.
 */
export function demoAccountsFor(env: EnvLike): DemoAccount[] {
  return isProductionEnv(env) ? [] : DEMO_ACCOUNTS;
}
