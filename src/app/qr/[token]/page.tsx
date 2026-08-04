"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GraduationCap, ShieldCheck, KeyRound, Phone, AlertCircle, Loader2 } from "lucide-react";
import { api } from "@/lib/client";
import { initials } from "@/lib/utils";
import { Spinner } from "@/components/ui";

interface QrStudent {
  id: string;
  name: string;
  admissionNo: string;
  photoUrl: string | null;
  guardianName: string | null;
  guardianRelation: string | null;
  schoolName: string;
  classRoom: { name: string } | null;
  section: { name: string } | null;
}

export default function QrVerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [student, setStudent] = useState<QrStudent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"pin" | "phone">("pin");
  const [pin, setPin] = useState("");
  const [phone, setPhone] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState("");

  useEffect(() => {
    api<{ token: string; student: QrStudent }>(`/api/qr/${token}`)
      .then((d) => setStudent(d.student))
      .catch((e) => setError(e?.message || "Invalid QR code"))
      .finally(() => setLoading(false));
  }, [token]);

  const verify = async () => {
    setVerifyError("");
    setVerifying(true);
    try {
      const res = await api<{ redirect: string }>("/api/qr/verify", {
        method: "POST",
        body: JSON.stringify({ token, pin: mode === "pin" ? pin : undefined, phone: mode === "phone" ? phone : undefined }),
      });
      router.replace(res.redirect);
    } catch (e: any) {
      setVerifyError(e?.message || "Verification failed");
    } finally {
      setVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (error || !student) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-sm rounded-2xl border border-rose-200 bg-white p-8 text-center shadow-lg">
          <AlertCircle className="mx-auto text-rose-500" size={32} />
          <h1 className="mt-4 text-lg font-black text-slate-900">Invalid QR code</h1>
          <p className="mt-2 text-sm text-slate-500">{error}</p>
          <Link href="/qr" className="btn btn-primary mt-6 w-full">Back</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md fade-up">
        <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-900/5">
          {/* student header */}
          <div className="flex items-center gap-4">
            {student.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={student.photoUrl} alt="" className="h-16 w-16 rounded-2xl object-cover ring-2 ring-indigo-100" />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-lg font-black text-white">
                {initials(student.name)}
              </div>
            )}
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-widest text-indigo-600">{student.schoolName}</div>
              <h1 className="truncate text-lg font-black text-slate-900">{student.name}</h1>
              <div className="text-xs text-slate-500">
                {student.classRoom?.name || "—"} {student.section?.name ? `· Section ${student.section.name}` : ""} · {student.admissionNo}
              </div>
            </div>
          </div>

          <div className="my-5 border-t border-dashed border-slate-200" />

          <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
            <ShieldCheck size={17} className="text-emerald-600" />
            Guardian verification
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {student.guardianName ? `Guardian: ${student.guardianName} (${student.guardianRelation || "Guardian"})` : "Enter the PIN shown on the student record."}
          </p>

          {/* mode tabs */}
          <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
            {(["pin", "phone"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-bold transition ${
                  mode === m ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {m === "pin" ? <KeyRound size={13} /> : <Phone size={13} />}
                {m === "pin" ? "Student PIN" : "Guardian phone"}
              </button>
            ))}
          </div>

          {mode === "pin" ? (
            <input
              className="input mt-3 text-center text-lg font-black tracking-[0.5em]"
              placeholder="••••"
              maxLength={6}
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
          ) : (
            <input
              className="input mt-3"
              placeholder="+880 1XXX-XXXXXX"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          )}

          {verifyError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
              <AlertCircle size={15} className="mt-0.5 shrink-0" /> {verifyError}
            </div>
          )}

          <button onClick={verify} disabled={verifying || (mode === "pin" ? pin.length < 4 : phone.length < 5)} className="btn btn-primary mt-4 w-full !py-3">
            {verifying ? <Loader2 size={16} className="animate-spin" /> : <GraduationCap size={16} />}
            {verifying ? "Verifying…" : "Open Parent Dashboard"}
          </button>

          <p className="mt-4 text-center text-xs text-slate-400">
            <Link href="/login" className="font-semibold text-indigo-600 hover:underline">
              Have an account? Sign in instead
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
