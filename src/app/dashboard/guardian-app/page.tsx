import QRCode from "qrcode";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Info, QrCode, ShieldCheck, Smartphone, TriangleAlert } from "lucide-react";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { sectorHostFor, requestHost } from "@/lib/sectors";
import { PageHeader } from "@/components/ui";
import { PrintActions } from "@/components/PrintActions";

/**
 * School Admin → Parents App.
 *
 * Gives the school one QR code (and one link) to hand out. A guardian scans it,
 * gets the Parents App branded for this school, installs it and signs in — no
 * hunting for the right app, and nothing to explain over the phone.
 *
 * The code carries no credential: it opens the app, it does not sign anyone in.
 */
export const dynamic = "force-dynamic";

export default async function GuardianAppPage() {
  const session = await getSession();
  // The invite QR is school-wide (it carries the app address only, no
  // per-branch data), so branch admins may share it for their campus too.
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role) || !session.schoolId) redirect("/login");

  const school = await prisma.school.findUnique({
    where: { id: session.schoolId },
    select: { name: true, slug: true, logoUrl: true, themeColor: true },
  });
  if (!school) redirect("/login");

  const h = await headers();
  const host = requestHost(h);
  const protocol = (h.get("x-forwarded-proto") || (process.env.NODE_ENV === "production" ? "https" : "http"))
    .split(",")[0]
    .trim();

  // Prefer the Parents App host; fall back to the configured public origin, then
  // to a relative path (which still works, it just isn't shareable).
  const target = sectorHostFor(host, "guardian");
  const origin = target ? `${protocol}://${target}` : (process.env.APP_URL || "").replace(/\/$/, "");
  // ?install=1 tells the landing page it was reached by scanning, so installing
  // leads there and the first tap takes the browser's install prompt.
  const invitePath = `/s/${school.slug}?install=1`;
  const inviteUrl = `${origin}${invitePath}`;
  const shareable = Boolean(target || origin);

  const qr = await QRCode.toDataURL(inviteUrl, { width: 340, margin: 1, color: { dark: "#0f172a" } });
  const accent = school.themeColor || "#0ea5e9";

  return (
    <div>
      <div className="no-print">
        <PageHeader
          title="Parents App"
          subtitle="One QR code that puts your parents app in every guardian's hand"
        />
      </div>

      {!shareable && (
        <div className="no-print mb-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-bold">The app address is not configured for this host.</p>
            <p className="mt-1 leading-relaxed">
              Set <code className="rounded bg-amber-100 px-1 py-0.5 font-mono">APP_DOMAIN</code> so each app has its own
              address. Until then this code points at a relative path and only works inside this site.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* the printable invite */}
        <div>
          <div
            id="guardian-invite"
            className="print-card mx-auto max-w-md overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl"
          >
            <div className="px-6 py-5 text-white" style={{ backgroundColor: accent }}>
              <div className="flex items-center gap-3">
                {school.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={school.logoUrl} alt="" className="h-11 w-11 rounded-xl bg-white object-contain p-1" />
                ) : (
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/20 text-base font-black">
                    {school.name.slice(0, 1)}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-sm font-extrabold leading-tight">{school.name}</div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-white/80">Parents App</div>
                </div>
              </div>
            </div>

            <div className="px-6 py-6 text-center">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                <Smartphone size={12} /> Scan with your phone camera
              </div>

              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qr}
                alt="Parents App invite QR code"
                className="mx-auto mt-4 h-56 w-56 rounded-2xl bg-white p-2 ring-1 ring-slate-200"
              />

              <h2 className="mt-4 text-lg font-black leading-tight text-slate-900">
                Get the parents app for your child&apos;s school
              </h2>
              <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-slate-500">
                Attendance, homework, results, fees and notices — straight from {school.name}.
              </p>

              <div className="mt-4 space-y-1.5 text-left">
                {[
                  "Scan this code with your phone camera",
                  "Tap Install — the app appears on the home screen, no app store",
                  "Sign in with the details the school gave you, or the QR on your child's ID card",
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-600">
                    <span
                      className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-black text-white"
                      style={{ backgroundColor: accent }}
                    >
                      {i + 1}
                    </span>
                    {step}
                  </div>
                ))}
              </div>

              <div className="mt-4 truncate rounded-lg bg-slate-50 px-3 py-2 font-mono text-[10px] text-slate-500 ring-1 ring-slate-200">
                {inviteUrl}
              </div>
            </div>

            <div className="border-t border-slate-100 bg-slate-50 px-6 py-3 text-center text-[10px] leading-relaxed text-slate-400">
              This code only opens the app — it does not sign anyone in. Safe to display at the school gate or office.
            </div>
          </div>
        </div>

        {/* guidance */}
        <div className="no-print space-y-4">
          <div className="card p-5">
            <div className="flex items-center gap-2">
              <QrCode size={16} className="text-slate-400" />
              <h2 className="text-sm font-extrabold text-slate-900">Share it</h2>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              Print this card, put it on the notice board, or send the link in a school message. The same link works for
              every guardian of {school.name} — it does not identify anyone.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <PrintActions targetId="guardian-invite" fileName={`${school.slug}-parents-app-invite`} />
            </div>
          </div>

          <div className="card p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-emerald-600" />
              <h2 className="text-sm font-extrabold text-slate-900">Why this is safe to display</h2>
            </div>
            <ul className="mt-2 space-y-2 text-xs leading-relaxed text-slate-500">
              <li>
                The code carries the school&apos;s app address only — no token, no session, no personal details.
              </li>
              <li>Each guardian still signs in, so one code can never expose another family&apos;s records.</li>
              <li>Guardians who forget their password can use the QR code on their child&apos;s ID card.</li>
            </ul>
          </div>

          <div className="flex items-start gap-2.5 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3 text-[11px] leading-relaxed text-slate-600">
            <Info size={14} className="mt-0.5 shrink-0 text-sky-600" />
            <p>
              Students do not get their own app — quizzes, homework and results are opened from the Parents App, so the
              child uses the guardian&apos;s phone.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
