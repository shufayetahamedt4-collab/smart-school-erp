"use client";

import { useRouter } from "next/navigation";
import { CalendarCheck, FileText, GraduationCap, LogOut, School, ShieldCheck, UserRound } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen } from "@/components/ui";
import { useMe } from "@/components/Shell";
import { EmptyState, ListCard, ListRow, SectionHeader, Surface } from "@/components/app-ui";
import { initials } from "@/lib/utils";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="min-w-0 text-right text-[13px] font-semibold text-slate-700">{children}</dd>
    </div>
  );
}

/**
 * Guardian → My Profile.
 *
 * Same account fields, the same linked-child card and the same sign-out. The
 * app bar names the screen, so the old `PageHeader` is gone; the details now sit
 * on the app plane as inset surfaces.
 */
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
      {/* identity banner — stacked on phones, one row from sm up */}
      <Surface className="overflow-hidden !p-0">
        <div className="flex flex-col gap-4 bg-gradient-to-r from-sky-600 to-indigo-600 p-5 text-white sm:flex-row sm:items-center sm:gap-5">
          <div className="flex min-w-0 items-center gap-4">
            {user.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.photoUrl} alt="" className="h-14 w-14 shrink-0 rounded-2xl object-cover ring-4 ring-white/20 sm:h-16 sm:w-16" />
            ) : (
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-xl font-black sm:h-16 sm:w-16">
                {initials(user.name)}
              </div>
            )}
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-widest text-sky-100">Guardian account</div>
              <h2 className="truncate text-xl font-black">{user.name}</h2>
              <div className="mt-0.5 truncate text-xs text-sky-100">{user.email || "No email on file"}</div>
            </div>
          </div>
          <div className="sm:ml-auto">
            <Badge tone={qrSession ? "violet" : "green"} className="!bg-white/15 !text-white !ring-white/20">
              {qrSession ? "QR session" : "Password session"}
            </Badge>
          </div>
        </div>
      </Surface>

      <SectionHeader title="Account details" />
      <Surface>
        <dl className="divide-y divide-slate-100">
          <Row label="Name">{user.name}</Row>
          <Row label="Email">{user.email || "—"}</Row>
          <Row label="Phone">{user.phone || "—"}</Row>
          <Row label="Role">Guardian</Row>
          <Row label="School">{me.school?.name || "—"}</Row>
          <Row label="Plan">{me.school?.plan || "—"}</Row>
          <Row label="Sign-in method">{qrSession ? "Student QR code (no password)" : "Email & password"}</Row>
        </dl>
        <div className="mt-2 flex items-center gap-2 border-t border-slate-100 pt-3 text-[11px] text-slate-400">
          <ShieldCheck size={14} className="text-emerald-500" />
          {qrSession
            ? "Opened with your child's QR code — read-only access to their records."
            : "Contact the school office to change your name, email or phone."}
        </div>
      </Surface>

      <SectionHeader title="Linked child" actionHref="/parent" actionLabel="Dashboard" />
      {student ? (
        <>
          <Surface>
            <div className="flex items-center gap-4">
              {student.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={student.photoUrl} alt="" className="h-14 w-14 rounded-2xl object-cover ring-2 ring-sky-100" />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 text-lg font-black text-white">
                  {initials(student.name)}
                </div>
              )}
              <div className="min-w-0">
                <div className="truncate text-base font-black text-slate-900">{student.name}</div>
                <div className="text-xs text-slate-500">{student.admissionNo}</div>
              </div>
            </div>
            <dl className="mt-3 divide-y divide-slate-100 border-t border-slate-100 pt-1">
              <Row label="Class">{student.classRoom?.name || "—"}</Row>
              <Row label="Section">{student.section?.name || "—"}</Row>
              <Row label="Admission no.">{student.admissionNo}</Row>
            </dl>
          </Surface>
          <ListCard className="mt-3">
            <ListRow href="/parent/attendance" icon={CalendarCheck} tone="sky" title="Attendance" />
            <ListRow href="/parent/results" icon={FileText} tone="violet" title="Exam results" />
          </ListCard>
        </>
      ) : (
        <EmptyState
          icon={GraduationCap}
          title="No student linked"
          hint="Ask the school office to link your login to your child's record."
        />
      )}

      <SectionHeader title="Session" />
      <Surface>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12px] text-slate-500">
            <UserRound size={15} className="text-slate-400" />
            Signing out clears this device&apos;s session cookie.
          </div>
          <button onClick={signOut} className="btn btn-secondary min-h-11">
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </Surface>

      <div className="mt-5 flex items-center justify-center gap-2 text-[11px] text-slate-400">
        <School size={13} /> {me.school?.name || "Amar E School"} · Parents App
      </div>
    </div>
  );
}
