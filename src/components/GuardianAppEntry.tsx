"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  CalendarCheck,
  Check,
  ClipboardList,
  CreditCard,
  Info,
  Megaphone,
  QrCode,
  Share,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
} from "lucide-react";
import { useInstallPrompt } from "@/components/InstallApp";
import { initials } from "@/lib/utils";

export interface EntrySchool {
  name: string;
  slug: string;
  logoUrl: string | null;
  tagline: string | null;
  themeColor: string | null;
}

/**
 * The screen a school's printed invite QR opens.
 *
 * It is deliberately NOT a login: scanning it proves nothing, so the same poster
 * can hang on a school gate without handing anyone a child's records. It only
 * puts the right app — branded for that school — in front of the guardian, who
 * still signs in with the credentials the school issued, or with the QR code on
 * their child's ID card.
 *
 * `fromQr` is set when the invite link is opened with `?install=1`, which is how
 * the school's QR is encoded. In that case installing is the whole point of the
 * visit, so it leads — and the first tap anywhere takes the browser's install
 * prompt, because that tap is the gesture browsers require.
 */
export default function GuardianAppEntry({
  school,
  fromQr = false,
  inApp = false,
  isAndroid = false,
  playStoreUrl = null,
}: {
  school: EntrySchool;
  fromQr?: boolean;
  /** true when this page is already inside the native Android app */
  inApp?: boolean;
  isAndroid?: boolean;
  /** Google Play listing, when the native app has been published */
  playStoreUrl?: string | null;
}) {
  const { installed, canPrompt, isIOS, inAppBrowser, settled, promptInstall } = useInstallPrompt();
  const accent = school.themeColor || "#0ea5e9";
  const prompting = useRef(false);

  const doInstall = async () => {
    if (prompting.current) return;
    prompting.current = true;
    try {
      await promptInstall();
    } finally {
      prompting.current = false;
    }
  };

  // Arrived from the school's QR with an install prompt available: the very next
  // tap installs. Browsers require a user gesture, so this cannot be automatic
  // on load — but it can be the first thing the guardian touches.
  useEffect(() => {
    if (!fromQr || !canPrompt || installed) return;
    const onFirstGesture = () => void doInstall();
    window.addEventListener("pointerdown", onFirstGesture, { once: true });
    return () => window.removeEventListener("pointerdown", onFirstGesture);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromQr, canPrompt, installed]);

  return (
    <div className="min-h-screen bg-white">
      {/* school banner */}
      <div className="px-4 pt-8 pb-6 text-white" style={{ backgroundColor: accent }}>
        <div className="mx-auto flex max-w-lg flex-col items-center text-center">
          {school.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={school.logoUrl} alt="" className="h-16 w-16 rounded-2xl bg-white object-contain p-1 shadow-lg" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/20 text-xl font-black shadow-lg">
              {initials(school.name)}
            </div>
          )}
          <h1 className="mt-4 text-xl font-black leading-tight">{school.name}</h1>
          <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-[11px] font-bold uppercase tracking-widest">
            <ShieldCheck size={12} /> Parents App
          </div>
          {school.tagline && <p className="mt-3 text-xs leading-relaxed text-white/85">{school.tagline}</p>}
        </div>
      </div>

      <div className="mx-auto max-w-lg px-4 pb-12">
        {fromQr && !installed && !inApp && (
          <div className="mt-5 rounded-2xl bg-slate-900 px-4 py-3 text-center text-xs font-bold text-white">
            Two steps: install the app, then sign in.
          </div>
        )}

        {inApp && (
          <div className="mt-5 flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <Check size={16} className="shrink-0 text-emerald-600" />
            <p className="text-xs leading-relaxed text-emerald-800">
              You&apos;re already in the {school.name} app — just sign in.
            </p>
          </div>
        )}

        {/* step 1 — install (the app never asks you to install the app) */}
        {!inApp && (
        <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-black text-white"
              style={{ backgroundColor: accent }}
            >
              1
            </span>
            <h2 className="text-sm font-extrabold text-slate-900">Install the app</h2>
          </div>

          <div className="mt-3 space-y-3">
            {playStoreUrl && isAndroid && !installed && (
              <>
                <a
                  href={playStoreUrl}
                  className="btn w-full !py-3 text-white"
                  style={{ backgroundColor: accent }}
                >
                  <ShoppingBag size={16} /> Get it from Google Play
                </a>
                <div className="text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  or use it without installing
                </div>
              </>
            )}
            {installed ? (
              <p className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                <Check size={13} /> Installed — open {school.name} from your home screen
              </p>
            ) : canPrompt ? (
              <>
                <button
                  onClick={doInstall}
                  className="btn w-full !py-3 text-white"
                  style={{ backgroundColor: accent }}
                >
                  <ArrowDownToLine size={17} /> Tap to install
                </button>
                <p className="mt-2 text-center text-[11px] text-slate-400">
                  One tap — the icon appears on your home screen. No app store, no download.
                </p>
              </>
            ) : inAppBrowser ? (
              /* e.g. opened inside Facebook, Instagram or a QR app's own browser */
              <div className="rounded-xl bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-inset ring-amber-600/20">
                <p className="font-bold">Open this in your phone&apos;s browser first.</p>
                <p className="mt-1">
                  You&apos;re in another app&apos;s built-in browser, which can&apos;t install apps. Tap the{" "}
                  <b>⋯</b> or <b>⋮</b> menu and choose <b>Open in Chrome</b> (Android) or <b>Open in Safari</b> (iPhone),
                  then tap install.
                </p>
              </div>
            ) : isIOS ? (
              <div className="flex items-start gap-2.5 text-xs leading-relaxed text-slate-600">
                <Share size={15} className="mt-0.5 shrink-0 text-slate-400" />
                <span>
                  Tap <b>Share</b> at the bottom of Safari, scroll down and choose{" "}
                  <b>&quot;Add to Home Screen&quot;</b> → <b>Add</b>. (iPhone only allows this from Safari.)
                </span>
              </div>
            ) : !settled ? (
              /* the browser may still hand us its prompt — say nothing wrong yet */
              <p className="text-xs text-slate-400">Getting the install option ready…</p>
            ) : (
              <div className="rounded-xl bg-slate-50 px-3.5 py-3 text-xs leading-relaxed text-slate-600 ring-1 ring-inset ring-slate-200">
                <p className="font-bold text-slate-700">Install from your browser menu</p>
                <p className="mt-1">
                  Open the browser menu (<b>⋮</b> or <b>⋯</b>) and choose <b>Install app</b> or{" "}
                  <b>Add to Home screen</b>. If the option isn&apos;t there, open this link in Chrome (Android) or
                  Safari (iPhone).
                </p>
              </div>
            )}
          </div>
        </div>
        )}

        {/* sign in */}
        <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-black text-white"
              style={{ backgroundColor: accent }}
            >
              {inApp ? 1 : 2}
            </span>
            <h2 className="text-sm font-extrabold text-slate-900">Sign in</h2>
          </div>

          <Link href="/login" className="btn mt-3 w-full !py-3 text-white" style={{ backgroundColor: accent }}>
            Sign in to the Parents App
          </Link>

          <div className="relative py-3">
            <div className="absolute inset-0 flex items-center" aria-hidden="true">
              <div className="w-full border-t border-slate-200" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">or</span>
            </div>
          </div>

          <Link href="/qr" className="btn btn-secondary w-full !py-3">
            <QrCode size={16} /> Scan the QR code on your child&apos;s ID card
          </Link>
          <p className="mt-2 text-center text-[11px] text-slate-400">
            No password needed — verify with your child&apos;s PIN or your phone number.
          </p>
        </div>

        {/* what you get */}
        <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <Smartphone size={15} className="text-slate-400" /> What you get
          </h2>
          <ul className="mt-3 space-y-2.5">
            {[
              { icon: ClipboardList, text: "Daily attendance and teacher remarks" },
              { icon: CalendarCheck, text: "Homework, quizzes and exam results" },
              { icon: CreditCard, text: "Fees, payments and receipts" },
              { icon: Megaphone, text: "School notices, PTM booking and messages" },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-2.5 text-xs text-slate-600">
                <span
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: `${accent}22`, color: accent }}
                >
                  <Icon size={12} />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-5 flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[11px] leading-relaxed text-amber-800">
          <Info size={14} className="mt-0.5 shrink-0" />
          <p>
            This code only opens the app — it does not sign anyone in, and it is safe for the school to display
            publicly. {school.name} will never ask for your password by phone or message.
          </p>
        </div>
      </div>
    </div>
  );
}
