"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { GraduationCap, LogIn, Eye, EyeOff, AlertCircle, Check, ShieldCheck, KeyRound } from "lucide-react";
import { api } from "@/lib/client";
import { Spinner } from "@/components/ui";

const DEMO = [
  { role: "Super Admin", id: "admin@smartschool.com", pw: "Admin@123" },
  { role: "School Admin", id: "principal@sunrise.edu", pw: "School@123" },
  { role: "Teacher", id: "teacher@sunrise.edu", pw: "Teacher@123" },
  { role: "Guardian", id: "guardian1@demo.com", pw: "Guardian@123" },
];

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-slate-50" />}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
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
        router.replace(next || res.redirect);
        return;
      }
      const res = await api<{ redirect: string; twoFactorRequired?: boolean; challengeId?: string; email?: string }>(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ identifier, password }),
        }
      );
      if (res.twoFactorRequired && res.challengeId) {
        setChallenge({ challengeId: res.challengeId, email: res.email || null });
        return;
      }
      const next = searchParams.get("next");
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

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* left branding */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-slate-900 p-10 lg:flex">
        <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-indigo-600/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 h-80 w-80 rounded-full bg-violet-600/20 blur-3xl" />
        <Link href="/" className="relative flex items-center gap-2.5 text-white">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-900/40">
            <GraduationCap size={20} />
          </div>
          <span className="text-lg font-extrabold tracking-tight">Amar E School</span>
        </Link>

        <div className="relative">
          <h2 className="text-4xl font-black leading-tight text-white">
            One platform for your whole <span className="text-indigo-400">school journey</span>
          </h2>
          <ul className="mt-8 space-y-3 text-sm text-slate-300">
            {[
              "Admission, attendance, exams, fees & notices — paperless",
              "Guardians stay updated through QR login & daily reports",
              "Multi-tenant SaaS with a revenue dashboard for admins",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-indigo-300">
                  <Check size={12} />
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-slate-500">© 2026 Amar E School · Demo environment</p>
      </div>

      {/* right form */}
      <div className="flex w-full items-center justify-center px-4 py-10 lg:w-1/2">
        <div className="w-full max-w-md fade-up">
          <div className="mb-8 text-center lg:text-left">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-600/30 lg:hidden">
              <GraduationCap size={22} />
            </div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Welcome back</h1>
            <p className="mt-1 text-sm text-slate-500">Sign in to your Amar E School console.</p>
          </div>

          {challenge ? (
            /* ---------------- 2FA verification step ---------------- */
            <form onSubmit={submit} className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3">
                <ShieldCheck size={20} className="shrink-0 text-indigo-600" />
                <div className="text-xs text-slate-600">
                  <p className="text-sm font-bold text-slate-800">Two-factor verification</p>
                  <p>Enter the 6-digit code from your authenticator app{challenge.email ? ` for ${challenge.email}` : ""}. A backup code also works.</p>
                </div>
              </div>
              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}
              <div>
                <label htmlFor="totp" className="label">Verification code</label>
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
              <button type="button" onClick={() => { setChallenge(null); setTotp(""); setError(""); }} className="btn btn-ghost w-full">
                ← Back to login
              </button>
            </form>
          ) : mode === "forgot" ? (
            /* ---------------- forgot password step ---------------- */
            <form onSubmit={submitForgot} className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3">
                <KeyRound size={20} className="shrink-0 text-sky-600" />
                <p className="text-xs text-slate-600">Enter your account email — we'll send a one-time reset code.</p>
              </div>
              {forgotMsg && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">{forgotMsg}</div>
              )}
              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}
              <div>
                <label htmlFor="fEmail" className="label">Email</label>
                <input id="fEmail" className="input" type="email" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
              </div>
              <button type="submit" disabled={loading} className="btn btn-primary w-full !py-3">
                {loading ? <Spinner className="h-4 w-4 border-white/40 border-t-white" /> : <KeyRound size={16} />}
                Send reset code
              </button>
              <button type="button" onClick={() => { setMode("login"); setForgotMsg(""); setError(""); }} className="btn btn-ghost w-full">
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
              <label htmlFor="identifier" className="label">Email or phone</label>
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
              <label htmlFor="password" className="label">Password</label>
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
                <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading} className="btn btn-primary w-full !py-3">
              {loading ? <Spinner className="h-4 w-4 border-white/40 border-t-white" /> : <LogIn size={16} />}
              {loading ? "Signing in…" : "Sign in"}
            </button>
            <div className="flex items-center justify-between text-xs">
              <button type="button" onClick={() => { setMode("forgot"); setError(""); }} className="font-semibold text-indigo-600 hover:underline">
                Forgot password?
              </button>
              <Link href="/qr" className="font-semibold text-slate-500 hover:underline">
                QR login
              </Link>
            </div>
          </form>
          )}

          <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-4">
            <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-400">Demo accounts — click to fill</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DEMO.map((d) => (
                <button
                  key={d.role}
                  onClick={() => {
                    setIdentifier(d.id);
                    setPassword(d.pw);
                    setError("");
                  }}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left transition hover:border-indigo-300 hover:bg-indigo-50"
                >
                  <div className="text-xs font-bold text-slate-800">{d.role}</div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-500">{d.id}</div>
                </button>
              ))}
            </div>
          </div>

          <p className="mt-6 text-center text-xs text-slate-400">
            <Link href="/welcome" className="font-semibold text-indigo-600 hover:underline">
              ← View the welcome page
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
