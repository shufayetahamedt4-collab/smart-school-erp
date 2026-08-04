"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Download, MonitorSmartphone, X, ArrowDownToLine, Sparkles } from "lucide-react";

/**
 * The standard `beforeinstallprompt` event is not part of the TS DOM lib,
 * so we declare it here.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface InstallPrompt {
  /** true once the app is running in installed (standalone) mode */
  installed: boolean;
  /** true when the browser supports the install prompt (Chrome/Edge/Android) */
  canPrompt: boolean;
  /** true on iOS Safari — only "Add to Home Screen" instructions are possible */
  isIOS: boolean;
  /** fires the native install prompt; resolves with whether the user accepted */
  promptInstall: () => Promise<boolean>;
}

let swRegistered = false;

function registerServiceWorker() {
  if (swRegistered) return;
  swRegistered = true;
  if ("serviceWorker" in navigator && process.env.NODE_ENV !== "development") {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

/** Shared installability logic + one-time service-worker registration. */
export function useInstallPrompt(): InstallPrompt {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    registerServiceWorker();

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // Safari 16.4+ exposes installed PWAs through display-mode; older iPhones use this:
      (window.navigator as any).standalone === true;
    setInstalled(standalone);
    setIsIOS(/iphone|ipad|ipod/i.test(navigator.userAgent));

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!deferred) return false;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    if (outcome === "accepted") setInstalled(true);
    return outcome === "accepted";
  }, [deferred]);

  return { installed, canPrompt: !!deferred, isIOS, promptInstall };
}

/**
 * Small floating banner (bottom center) shown on every page while the app is
 * installable. Dismissible; hidden on print pages.
 */
export function InstallBanner() {
  const { installed, canPrompt, isIOS, promptInstall } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(false);
  const [showIOSHelp, setShowIOSHelp] = useState(false);
  const pathname = usePathname();

  if (installed || dismissed || pathname?.startsWith("/print")) return null;

  const installable = canPrompt || isIOS;

  return (
    <div className="no-print fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl shadow-slate-900/10 fade-up">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
          <MonitorSmartphone size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold text-slate-800">Install Smart School ERP</div>
          <div className="truncate text-[11px] text-slate-500">One-tap access from your home screen</div>
        </div>
        {installable ? (
          <button
            onClick={async () => {
              if (canPrompt) {
                await promptInstall();
              } else {
                setShowIOSHelp((v) => !v);
              }
            }}
            className="btn btn-primary btn-sm shrink-0"
          >
            <Download size={14} /> Install
          </button>
        ) : (
          <span className="shrink-0 text-[11px] font-semibold text-slate-400">App ready</span>
        )}
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-lg p-1 text-slate-300 transition hover:bg-slate-100 hover:text-slate-500"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
      </div>
      {showIOSHelp && (
        <div className="absolute bottom-16 w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-xl fade-up">
          <p className="text-[12px] leading-relaxed text-slate-600">
            On iPhone/iPad: tap the <b>Share</b> button in Safari, then choose{" "}
            <b>&quot;Add to Home Screen&quot;</b>. The app icon will appear on your home screen.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Rich "Install the app" section used on the marketing page — doubles as the
 * "download the app" entry point for schools.
 */
export function InstallSection() {
  const { installed, canPrompt, isIOS, promptInstall } = useInstallPrompt();
  const [busy, setBusy] = useState(false);

  const handleInstall = async () => {
    if (canPrompt) {
      setBusy(true);
      await promptInstall();
      setBusy(false);
    }
  };

  return (
    <section id="install" className="border-t border-slate-200 bg-white py-16">
      <div className="mx-auto max-w-7xl px-4 md:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
            <Sparkles size={13} /> Works on any device
          </span>
          <h2 className="mt-5 text-3xl font-black tracking-tight text-slate-900">
            Install the app. No app store required.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-500">
            Add Smart School ERP straight to your phone or computer home screen — teachers mark attendance and
            guardians get updates in one tap, even with a flaky connection.
          </p>
        </div>

        <div className="mx-auto mt-10 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { step: "1", title: "Open the site", desc: "Visit this page from your phone or PC browser." },
            { step: "2", title: "Tap “Install”", desc: "Use the button below — or the browser’s Add to Home Screen." },
            { step: "3", title: "Done 🎉", desc: "An app icon appears on your home screen. Open it like any app." },
          ].map((s) => (
            <div key={s.step} className="card p-5 text-center">
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-sm font-black text-white">
                {s.step}
              </div>
              <h3 className="mt-3 text-sm font-extrabold text-slate-900">{s.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{s.desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 text-center">
          {installed ? (
            <p className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
              ✓ App installed — open it from your home screen
            </p>
          ) : canPrompt ? (
            <button onClick={handleInstall} disabled={busy} className="btn btn-primary !px-7 !py-3 !text-base">
              <ArrowDownToLine size={17} /> {busy ? "Installing…" : "Install the app"}
            </button>
          ) : isIOS ? (
            <div>
              <button
                onClick={handleInstall}
                className="btn btn-primary !px-7 !py-3 !text-base"
                title="iOS: use Share → Add to Home Screen"
              >
                <ArrowDownToLine size={17} /> Install the app
              </button>
              <p className="mt-3 text-xs text-slate-500">
                On iPhone/iPad: tap <b>Share</b> in Safari → <b>Add to Home Screen</b>.
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-400">Installing is available once the site is live (HTTPS).</p>
          )}
        </div>
      </div>
    </section>
  );
}
