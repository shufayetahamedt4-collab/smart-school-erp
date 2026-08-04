import Link from "next/link";
import { QrCode, GraduationCap, ShieldCheck, ChevronRight } from "lucide-react";

export default function QrIndexPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md fade-up rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-xl shadow-slate-900/5">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-600/30">
          <QrCode size={28} />
        </div>
        <h1 className="mt-5 text-xl font-black text-slate-900">Guardian QR Login</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          Every student has a unique QR code on their ID card. Scan it with your phone camera, or open the
          <span className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">/qr/&lt;code&gt;</span>
          link printed on the card, then verify with your PIN or phone number to open your child&apos;s dashboard.
        </p>
        <div className="mt-6 space-y-3 text-left">
          {[
            { icon: QrCode, text: "Open the unique link from the student's QR card" },
            { icon: ShieldCheck, text: "Verify with the student's 4-digit PIN or guardian phone" },
            { icon: GraduationCap, text: "Instantly see daily reports, results, fees & notices" },
          ].map((s, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-3">
              <s.icon size={17} className="shrink-0 text-indigo-600" />
              <span className="text-xs font-semibold text-slate-600">{s.text}</span>
            </div>
          ))}
        </div>
        <Link href="/login" className="btn btn-secondary mt-6 w-full">
          Or sign in with an account <ChevronRight size={15} />
        </Link>
      </div>
    </div>
  );
}
