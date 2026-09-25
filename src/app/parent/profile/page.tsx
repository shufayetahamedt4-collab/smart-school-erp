"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarCheck, FileText, GraduationCap, LogOut, School, ShieldCheck, UserRound } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen } from "@/components/ui";
import { useMe } from "@/components/Shell";
import { initials } from "@/lib/utils";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-semibold text-slate-700">{children}</dd>
    </div>
  );
}

export default function ParentProfilePage() {
  const { me } = useMe();
  const router = useRouter();

  if (!me) return <LoadingScreen label="Loading profile…" />;

  const user = me.user;
  const student = me.student;
  const qrSession = user.id.startsWith("qr-");

  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.replace("/login");
  };

  return (
    <div>
      <PageHeader
        title="My Profile"
        subtitle="Your account details and the child linked to this login"
        actions={
          <button onClick={signOut} className="btn btn-secondary btn-sm">
            <LogOut size={14} /> Sign out
          </button>
        }
      />

      {/* identity banner — stacked on phones, one row from sm up */}
      <Card className="mb-6 overflow-hidden">
        <div className="flex flex-col gap-4 bg-gradient-to-r from-indigo-600 to-violet-600 p-5 text-white sm:flex-row sm:items-center sm:gap-5 sm:p-6">
          <div className="flex min-w-0 items-center gap-4">
            {user.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.photoUrl} alt="" className="h-14 w-14 shrink-0 rounded-2xl object-cover ring-4 ring-white/20 sm:h-16 sm:w-16" />
            ) : (
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-xl font-black sm:h-16 sm:w-16">{initials(user.name)}</div>
            )}
            <div className="min-w-0">
              <div className="text-xs font-bold uppercase tracking-widest text-indigo-200">Guardian account</div>
              <h2 className="truncate text-xl font-black">{user.name}</h2>
              <div className="mt-0.5 truncate text-xs text-indigo-200">{user.email || "No email on file"}</div>
            </div>
          </div>
          <div className="sm:ml-auto">
            <Badge tone={qrSession ? "violet" : "green"} className="!bg-white/15 !text-white !ring-white/20">
              {qrSession ? "QR session" : "Password session"}
            </Badge>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* account details */}
        <Card>
          <CardHeader title="Account details" subtitle="What the school has on file for this login" />
          <dl className="divide-y divide-slate-100 px-5 py-2">
            <Row label="Name">{user.name}</Row>
            <Row label="Email">{user.email || "—"}</Row>
            <Row label="Phone">{user.phone || "—"}</Row>
            <Row label="Role">Guardian</Row>
            <Row label="School">{me.school?.name || "—"}</Row>
            <Row label="Plan">{me.school?.plan || "—"}</Row>
            <Row label="Sign-in method">{qrSession ? "Student QR code (no password)" : "Email & password"}</Row>
          </dl>
          <div className="flex items-center gap-2 border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">
            <ShieldCheck size={14} className="text-emerald-500" />
            {qrSession
              ? "Opened with your child's QR code — read-only access to their records."
              : "Contact the school office to change your name, email or phone."}
          </div>
        </Card>

        {/* linked child */}
        <Card>
          <CardHeader
            title="Linked child"
            subtitle={student ? "The student this login can view" : "No child linked yet"}
            action={
              <Link href="/parent" className="btn btn-ghost btn-sm">
                Dashboard
              </Link>
            }
          />
          {student ? (
            <>
              <div className="flex items-center gap-4 px-5 py-4">
                {student.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={student.photoUrl} alt="" className="h-14 w-14 rounded-2xl object-cover ring-2 ring-indigo-100" />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-lg font-black text-white">
                    {initials(student.name)}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-base font-black text-slate-900">{student.name}</div>
                  <div className="text-xs text-slate-500">{student.admissionNo}</div>
                </div>
              </div>
              <dl className="divide-y divide-slate-100 border-t border-slate-100 px-5 py-2">
                <Row label="Class">{student.classRoom?.name || "—"}</Row>
                <Row label="Section">{student.section?.name || "—"}</Row>
                <Row label="Admission no.">{student.admissionNo}</Row>
              </dl>
              <div className="grid grid-cols-2 gap-2 border-t border-slate-100 p-4">
                <Link href="/parent/attendance" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50">
                  <CalendarCheck size={14} className="text-indigo-600" /> Attendance
                </Link>
                <Link href="/parent/results" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50">
                  <FileText size={14} className="text-indigo-600" /> Exam results
                </Link>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
              <GraduationCap size={26} className="text-slate-300" />
              <p className="text-sm font-bold text-slate-700">No student linked</p>
              <p className="max-w-xs text-xs text-slate-500">Ask the school office to link your login to your child&apos;s record.</p>
            </div>
          )}
        </Card>
      </div>

      {/* session */}
      <Card className="mt-6">
        <CardHeader title="Session" subtitle="You are signed in on this device" />
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <UserRound size={15} className="text-slate-400" />
            Signing out clears this device&apos;s session cookie.
          </div>
          <button onClick={signOut} className="btn btn-secondary">
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </Card>

      <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-slate-400">
        <School size={13} /> {me.school?.name || "Amar E School"} · Parent portal
      </div>
    </div>
  );
}
