import Link from "next/link";
import { InstallSection } from "@/components/InstallApp";
import {
  GraduationCap,
  Users,
  CalendarCheck,
  ClipboardList,
  BookOpen,
  FileText,
  Wallet,
  QrCode,
  Megaphone,
  BarChart3,
  ShieldCheck,
  MessageSquare,
  ArrowRight,
  Sparkles,
  Building2,
  ChevronRight,
} from "lucide-react";

const features = [
  { icon: Users, title: "Multi-Tenant SaaS", desc: "One platform for many schools. Super admin controls subscriptions, schools and revenue analytics." },
  { icon: GraduationCap, title: "Student Admission & Profiles", desc: "Digital admission with ID, roll, guardian info, medical details and unique QR ID cards." },
  { icon: CalendarCheck, title: "Attendance", desc: "One-tap Present / Absent / Late / Leave marking with instant guardian visibility." },
  { icon: ClipboardList, title: "Daily Remarks", desc: "Quick rating buttons — Excellent to Needs Improvement — with optional notes for parents." },
  { icon: BookOpen, title: "Homework & Submissions", desc: "Publish homework with deadlines and attachments; track completion status per student." },
  { icon: FileText, title: "Exams & Report Cards", desc: "Subject-wise marks, automatic grades & GPA, class positions and printable PDF report cards." },
  { icon: Wallet, title: "Fee Management", desc: "Monthly, admission and exam fees with dues, receipts and payment history. bKash & Nagad ready." },
  { icon: QrCode, title: "QR Guardian Login", desc: "Students get a unique QR code. Guardians verify with PIN or phone and enter the parent dashboard." },
  { icon: Megaphone, title: "Notice Board", desc: "Holidays, exam routines, meetings, events and picnics — published to every guardian instantly." },
  { icon: BarChart3, title: "Performance Analytics", desc: "Attendance trends, subject performance and progress graphs for every student." },
  { icon: MessageSquare, title: "Parent-Teacher Messaging", desc: "Direct, in-app messages between teachers and guardians — no phone calls needed." },
  { icon: ShieldCheck, title: "Role-Based Security", desc: "JWT sessions, role-based permissions, school-level data isolation and full audit logs." },
];

const roles = [
  { role: "Super Admin", desc: "Manage schools, subscriptions, revenue dashboard & global settings.", icon: Building2 },
  { role: "School Admin", desc: "Admissions, teachers, classes, exams, fees, notices, ID cards & reports.", icon: Users },
  { role: "Teacher", desc: "Attendance, remarks, homework, marks entry and result publishing.", icon: GraduationCap },
  { role: "Guardian", desc: "Daily reports, results, fees, notices and performance graphs via QR or login.", icon: QrCode },
];

export default function WelcomePage() {
  return (
    <div className="min-h-screen bg-slate-50">
      {/* nav */}
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 md:px-8">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-600/30">
              <GraduationCap size={19} />
            </div>
            <span className="text-base font-extrabold tracking-tight text-slate-900">
              Amar <span className="text-indigo-600">E School</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/login" className="btn btn-ghost hidden sm:inline-flex">
              Sign in
            </Link>
            <Link href="/login" className="btn btn-primary">
              Get Started <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-indigo-50 via-slate-50 to-slate-50" />
        <div className="pointer-events-none absolute -top-24 left-1/2 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-indigo-200/40 blur-3xl" />
        <div className="relative mx-auto max-w-7xl px-4 pb-20 pt-16 md:px-8 md:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
              <Sparkles size={13} /> Kindergarten · Pre-school · Private School · Coaching Institute
            </span>
            <h1 className="mt-6 text-4xl font-black leading-tight tracking-tight text-slate-900 md:text-6xl">
              The all-in-one school ERP &amp;{" "}
              <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
                parent communication
              </span>{" "}
              platform
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base text-slate-600 md:text-lg">
              Manage admissions, attendance, exams, fees and notices — and keep every guardian in the loop with real-time
              reports, homework updates and QR-code access. Paperless, secure and multi-tenant by design.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link href="/login" className="btn btn-primary !px-6 !py-3 !text-base">
                Launch Dashboard <ArrowRight size={17} />
              </Link>
              <a href="#features" className="btn btn-secondary !px-6 !py-3 !text-base">
                Explore features
              </a>
              <a href="#install" className="btn btn-secondary !px-6 !py-3 !text-base">
                Install the app
              </a>
            </div>
          </div>

          {/* mock preview */}
          <div className="mx-auto mt-16 max-w-4xl">
            <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl shadow-indigo-900/10">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {[
                  { label: "Students managed", value: "14,200+" },
                  { label: "Guardians connected", value: "12,800+" },
                  { label: "Reports generated", value: "86k+" },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl bg-slate-50 p-4 text-center">
                    <div className="text-2xl font-black text-indigo-600">{s.value}</div>
                    <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{s.label}</div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-3 rounded-xl border border-slate-100 bg-gradient-to-r from-indigo-50 to-violet-50 p-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm">
                  <QrCode size={22} />
                </div>
                <div className="min-w-0 text-left">
                  <div className="text-sm font-bold text-slate-800">Scan the student QR card → Guardian dashboard</div>
                  <div className="truncate text-xs text-slate-500">Daily report · attendance · homework · results · fees · report card</div>
                </div>
                <ChevronRight className="ml-auto h-5 w-5 shrink-0 text-indigo-400" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* roles */}
      <section className="mx-auto max-w-7xl px-4 pb-16 md:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {roles.map((r) => (
            <div key={r.role} className="card p-5 transition hover:-translate-y-0.5 hover:shadow-md">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                <r.icon size={19} />
              </div>
              <h3 className="mt-3 text-sm font-extrabold text-slate-900">{r.role}</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{r.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* features */}
      <section id="features" className="border-t border-slate-200 bg-white py-16">
        <div className="mx-auto max-w-7xl px-4 md:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-black tracking-tight text-slate-900">Everything a school needs. Nothing it doesn&apos;t.</h2>
            <p className="mt-3 text-sm text-slate-500">
              Sixteen modules from the original proposal — all working together on one database.
            </p>
          </div>
          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div key={f.title} className="card group p-5 transition hover:border-indigo-200 hover:shadow-md">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-600 transition group-hover:bg-indigo-600 group-hover:text-white">
                  <f.icon size={19} />
                </div>
                <h3 className="mt-3 text-sm font-extrabold text-slate-900">{f.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* install the app (PWA) */}
      <InstallSection />

      {/* CTA */}
      <section className="mx-auto max-w-7xl px-4 py-16 md:px-8">
        <div className="rounded-3xl bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-700 px-6 py-12 text-center text-white shadow-xl shadow-indigo-600/30">
          <h2 className="text-3xl font-black tracking-tight">Ready to go paperless?</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-indigo-100">
            Sign in with the demo accounts to explore every module — Super Admin, School Admin, Teacher and Guardian.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link href="/login" className="btn bg-white !px-6 !py-3 !text-base !text-indigo-700 hover:!bg-indigo-50">
              Sign in now <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white py-8 text-center text-xs text-slate-400">
        Amar E School · Multi-Tenant SaaS · Installable web app (PWA)
      </footer>
    </div>
  );
}
