"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  GraduationCap,
  LogIn,
  Eye,
  EyeOff,
  AlertCircle,
  Check,
  ShieldCheck,
  KeyRound,
  QrCode,
  Crown,
  School as SchoolIcon,
  Users,
  HeartHandshake,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, prefetch } from "@/lib/client";
import { Spinner } from "@/components/ui";
import { SECTORS, sectorForRole, type SectorKey } from "@/lib/sectors";
import { warmListForSector } from "@/lib/route-data";

/** Lucide marks live here (not in the registry) so middleware stays icon-free. */
const SECTOR_ICON: Record<SectorKey, LucideIcon> = {
  super: Crown,
  school: SchoolIcon,
  teacher: Users,
  guardian: HeartHandshake,
};

/** Demo quick-fill accounts, each belonging to exactly one app. */
const DEMO: { sector: SectorKey; role: string; id: string; pw: string }[] = [
  { sector: "super", role: "Super Admin", id: "admin@smartschool.com", pw: "Admin@123" },
  { sector: "school", role: "School Admin", id: "principal@sunrise.edu", pw: "School@123" },
  { sector: "teacher", role: "Teacher", id: "teacher@sunrise.edu", pw: "Teacher@123" },
  { sector: "guardian", role: "Guardian", id: "guardian1@demo.com", pw: "Guardian@123" },
];

/** What the platform-shaped sign-in screen says when there is one address. */
const HUB_BULLETS = [
  "Platform Console — schools, plans, billing and global settings",
  "School Admin — admissions, students, staff, fees and reports",
  "Teacher App — attendance, homework, marks and messages",
  "Parents App — your child's attendance, results, fees and notices",
];

/**
 * The sign-in screen for ONE app. It only offers the credentials and entry
 * points that belong to this sector — a guardian never sees a platform-admin
 * field, and the Super Admin console never offers the QR guardian login.
 *
 * With `hub`, it is instead the sign-in screen for the platform address itself:
 * every account works, because the account (not the hostname) decides which app
 * you land in. That is the only honest shape for a deployment where the four
 * apps have no separate hostnames — a platform URL, a bare IP, a `<site>.netlify.app`
 * — since those hosts serve every app from one address anyway.
 */
export default function LoginForm({ sector: sectorKey, hub = false }: { sector?: SectorKey; hub?: boolean }) {
  const section = sectorKey ? SECTORS[sectorKey] : null;
  const Icon = sectorKey ? SECTOR_ICON[sectorKey] : GraduationCap;
  // One set of names for both shapes, so nothing below has to branch.
  const accent = section?.accent ?? "#4f46e5";
  const appName = section?.app ?? "Amar E School";
  const label = section?.label ?? "One platform · four apps";
  const tagline = section?.tagline ?? "Your account decides which app you land in — nothing else to choose.";
  const bullets = section?.bullets ?? HUB_BULLETS;
  const router = useRouter();
  const searchParams = useSearchParams();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // 2FA challenge state (PRD §14.1)
  const [challenge, setChallenge] = useState<{ challengeId: string; email: string | null } | null>(null);
  const [totp, setTotp] = useState("");
  // forgot-password flow (PRD §3.2)
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [forgotMsg, setForgotMsg] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (challenge) {
        const res = await api<{ redirect: string }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ purpose: "2fa", challengeId: challenge.challengeId, totp }),
        });
        const next = searchParams.get("next");
        // Start warming this app's reads before the destination even mounts, so
        // the dashboard is not the only fast screen on a fresh sign-in.
        prefetch(warmListForSector(sectorKey || "school"), 200);
        router.replace(next || res.redirect);
        return;
      }
      const res = await api<{
        redirect: string;
        twoFactorRequired?: boolean;
        challengeId?: string;
        email?: string;
        user?: { role?: string };
      }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password }),
      });
      if (res.twoFactorRequired && res.challengeId) {
        setChallenge({ challengeId: res.challengeId, email: res.email || null });
        return;
      }
      // On a sector host the app is fixed by the hostname; on the platform
      // address the account just told us which app it belongs to.
      const warmSector = sectorKey ?? sectorForRole(res.user?.role)?.key ?? "school";
      const next = searchParams.get("next");
      prefetch(warmListForSector(warmSector), 200);
      router.replace(next || res.redirect);
    } catch (err: any) {
      setError(err?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api<{ message: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ purpose: "forgot", identifier }),
      });
      setForgotMsg(res.message || "Check your email for the reset code.");
    } catch (err: any) {
      setError(err?.message || "Could not send reset code");
    } finally {
      setLoading(false);
    }
  };

  const demos = hub ? DEMO : DEMO.filter((d) => d.sector === sectorKey);
  const qrEntry = hub || sectorKey === "guardian";

  return (
    <div className="flex min-h-screen bg-white">
      {/* left branding — this app's identity */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-slate-900 p-10 lg:flex">
        <div
          className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full blur-3xl opacity-30"
          style={{ backgroundColor: accent }}
        />
        <div className="pointer-events-none absolute -bottom-24 -left-24 h-80 w-80 rounded-full bg-white/5 blur-3xl" />

        <div className="relative flex items-center gap-2.5 text-white">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl shadow-lg"
            style={{ backgroundColor: accent }}
          >
            <Icon size={20} />
          </div>
          <div className="leading-tight">
            <div className="text-base font-extrabold tracking-tight">{appName}</div>
            <div className="text-[11px] uppercase tracking-widest text-slate-400">
              {section ? "Amar E School" : "Platform"}
            </div>
          </div>
        </div>

        <div className="relative">
          <h2 className="text-4xl font-black leading-tight text-white">{label}</h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-200">{tagline}</p>
          <ul className="mt-8 space-y-3 text-sm text-slate-200">
            {bullets.map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <span
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: `${accent}33`, color: accent }}
                >
                  <Check size={12} />
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-slate-400">© 2026 Amar E School · {appName}</p>
      </div>

      {/* right form — pb-24 keeps the last card clear of the floating install
          banner, which sits over the bottom ~80px of the viewport. */}
      <div className="flex w-full items-center justify-center px-4 pb-24 pt-10 lg:w-1/2">
        <div className="w-full max-w-md fade-up">
          <div className="mb-8 text-center lg:text-left">
            <div
              className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-lg lg:hidden"
              style={{ backgroundColor: accent }}
            >
              <Icon size={22} />
            </div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Sign in</h1>
            <p className="mt-1 text-sm text-slate-600">
              {label} · <span className="font-semibold text-slate-800">{appName}</span>
            </p>
          </div>

          {challenge ? (
            /* ---------------- 2FA verification step ---------------- */
            <form onSubmit={submit} className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3">
                <ShieldCheck size={20} className="shrink-0 text-indigo-600" />
                <div className="text-xs text-slate-600">
                  <p className="text-sm font-bold text-slate-800">Two-factor verification</p>
                  <p>
                    Enter the 6-digit code from your authenticator app{challenge.email ? ` for ${challenge.email}` : ""}. A
                    backup code also works.
                  </p>
                </div>
              </div>
              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}
              <div>
                <label htmlFor="totp" className="label">
                  Verification code
                </label>
                <input
                  id="totp"
                  name="totp"
                  className="input tracking-[0.4em] text-center text-lg font-bold"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  maxLength={10}
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  required
                />
              </div>
              <button type="submit" disabled={loading} className="btn btn-primary w-full !py-3">
                {loading ? <Spinner className="h-4 w-4 border-white/40 border-t-white" /> : <ShieldCheck size={16} />}
                {loading ? "Verifying…" : "Verify & sign in"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setChallenge(null);
                  setTotp("");
                  setError("");
                }}
                className="btn btn-ghost w-full"
              >
                ← Back to login
              </button>
            </form>
          ) : mode === "forgot" ? (
            /* ---------------- forgot password step ---------------- */
            <form onSubmit={submitForgot} className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3">
                <KeyRound size={20} className="shrink-0 text-sky-600" />
                <p className="text-xs text-slate-600">Enter your account email — we&apos;ll send a one-time reset code.</p>
              </div>
              {forgotMsg && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
                  {forgotMsg}
                </div>
              )}
              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}
              <div>
                <label htmlFor="fEmail" className="label">
                  Email
                </label>
                <input
                  id="fEmail"
                  className="input"
                  type="email"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                />
              </div>
              <button type="submit" disabled={loading} className="btn btn-primary w-full !py-3">
                {loading ? <Spinner className="h-4 w-4 border-white/40 border-t-white" /> : <KeyRound size={16} />}
                Send reset code
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setForgotMsg("");
                  setError("");
                }}
                className="btn btn-ghost w-full"
              >
                ← Back to login
              </button>
            </form>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}
              <div>
                <label htmlFor="identifier" className="label">
                  Email or phone
                </label>
                <input
                  id="identifier"
                  name="identifier"
                  className="input"
                  placeholder="you@school.com"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div>
                <label htmlFor="password" className="label">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    className="input pr-10"
                    type={showPw ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(!showPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <button type="submit" disabled={loading} className="btn btn-primary w-full !py-3">
                {loading ? <Spinner className="h-4 w-4 border-white/40 border-t-white" /> : <LogIn size={16} />}
                {loading ? "Signing in…" : "Sign in"}
              </button>
              <div className="flex items-center justify-end text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setMode("forgot");
                    setError("");
                  }}
                  className="font-semibold text-indigo-600 hover:underline"
                >
                  Forgot password?
                </button>
              </div>

              {/* QR login is a guardian, credential-free entry point — it only
                  appears inside the Parents App, never on staff consoles. */}
              {qrEntry && (
                <>
                  <div className="relative py-1">
                    <div className="absolute inset-0 flex items-center" aria-hidden="true">
                      <div className="w-full border-t border-slate-200" />
                    </div>
                    <div className="relative flex justify-center">
                      <span className="bg-white px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        or
                      </span>
                    </div>
                  </div>

                  <Link href="/qr" className="btn btn-secondary w-full !py-3">
                    <QrCode size={16} /> Sign in with a student QR code
                  </Link>
                  <p className="text-center text-[11px] text-slate-500">
                    Guardians: scan the QR code on your child&apos;s ID card.
                  </p>
                </>
              )}
            </form>
          )}

          {demos.length > 0 && (
            <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-400">
                Demo account{demos.length > 1 ? "s" : ""} — click to fill
              </p>
              <div className="space-y-2">
                {demos.map((d) => (
                  <button
                    key={d.role}
                    onClick={() => {
                      setIdentifier(d.id);
                      setPassword(d.pw);
                      setError("");
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-indigo-300 hover:bg-indigo-50"
                  >
                    <div className="text-xs font-bold text-slate-800">{d.role}</div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-500">{d.id}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {hub && (
            <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[11px] leading-relaxed text-slate-600">
              All four apps are served from this address, so sign in below and you land in yours. Giving each app its
              own address is optional: set{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px]">APP_DOMAIN</code> (e.g.{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px]">yourdomain.com</code>) and point
              admin, school, teacher and parents at this deployment.
            </p>
          )}

          <p className="mt-6 text-center text-xs text-slate-500">
            <Link href="/welcome" className="font-semibold text-indigo-600 hover:underline">
              ← What is Amar E School?
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
