import Link from "next/link";
import {
  ArrowRight,
  Crown,
  GraduationCap,
  HeartHandshake,
  School as SchoolIcon,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SECTOR_LIST, sectorHostFor, type SectorKey } from "@/lib/sectors";

const SECTOR_ICON: Record<SectorKey, LucideIcon> = {
  super: Crown,
  school: SchoolIcon,
  teacher: Users,
  guardian: HeartHandshake,
};

/**
 * Shown on the hub host (the bare domain / the platform URL) whenever the four
 * apps have their own addresses. Each sector is a separate app on its own
 * subdomain — this page is only the directory of them, and every card links to a
 * working sign-in screen.
 *
 * When those addresses can't be resolved there is nothing to link to, so
 * `login/page.tsx` renders the hub sign-in form instead of this directory.
 */
export default function PortalChooser({ host, protocol = "http" }: { host: string; protocol?: string }) {
  const apps = SECTOR_LIST.map((s) => {
    const target = sectorHostFor(host, s.key);
    return { sector: s, target, href: target ? `${protocol}://${target}` : null };
  });

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 px-4 py-12">
      <div className="mx-auto w-full max-w-5xl">
        <div className="flex items-center gap-2.5 text-white">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-900/40">
            <GraduationCap size={20} />
          </div>
          <div className="leading-tight">
            <div className="text-base font-extrabold tracking-tight">Amar E School</div>
            <div className="text-[11px] uppercase tracking-widest text-slate-400">One platform · separate apps</div>
          </div>
        </div>

        <h1 className="mt-10 text-3xl font-black tracking-tight text-white sm:text-4xl">Sign in to your app</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
          Each role has its own app on its own address. Pick yours below — you&apos;ll only ever see what that role is
          allowed to do.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map(({ sector, href, target }) => {
            const Icon = SECTOR_ICON[sector.key];
            const body = (
              <>
                <div
                  className="flex h-11 w-11 items-center justify-center rounded-xl text-white shadow-lg transition-transform group-hover:scale-105"
                  style={{ backgroundColor: sector.accent }}
                >
                  <Icon size={20} />
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <h2 className="text-base font-extrabold text-white">{sector.app}</h2>
                  <ArrowRight size={15} className="text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-white" />
                </div>
                <div className="mt-0.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">{sector.label}</div>
                <p className="mt-2 text-xs leading-relaxed text-slate-300">{sector.tagline}</p>
                {target && (
                  <div className="mt-3 truncate font-mono text-[11px] text-slate-400">{target}</div>
                )}
              </>
            );

            return href ? (
              <a
                key={sector.key}
                href={href}
                className="group rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition hover:border-white/25 hover:bg-white/[0.07]"
              >
                {body}
              </a>
            ) : (
              <div key={sector.key} className="rounded-2xl border border-white/5 bg-white/[0.02] p-5 opacity-60">
                {body}
                <div className="mt-3 text-[11px] font-semibold text-slate-400">Address not configured</div>
              </div>
            );
          })}
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-4 text-xs text-slate-400">
          <Link href="/welcome" className="font-semibold text-indigo-400 hover:underline">
            What is Amar E School? →
          </Link>
          <span className="text-slate-700">|</span>
          <span>Guardians can also sign in by scanning the QR code on their child&apos;s ID card.</span>
        </div>
      </div>
    </div>
  );
}
