"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  School, UserCog, BookOpen, Layers, Wallet, Check, Plus, X, ArrowRight, ArrowLeft,
  Sparkles, PartyPopper,
} from "lucide-react";
import { api } from "@/lib/client";
import { Field, TextInput, Textarea, ErrorNote, LoadingScreen } from "@/components/ui";
import { fmtMoney } from "@/lib/utils";

/**
 * PRD §3.3 — Self-serve onboarding wizard.
 * 5 steps: School profile → Admin account → Classes → Subjects → Fees,
 * then a review screen and one POST /api/onboarding to create everything.
 * If the signed-in admin already belongs to a school, the wizard runs in
 * "extend" mode (skips the admin step, adds classes/subjects/fees).
 */

interface ClassDef { name: string; sections: string[] }
interface Status {
  onboarded: boolean;
  school: { id: string; name: string; slug: string; status: string } | null;
  progress: { classes: number; subjects: number; fees: boolean };
}

const STEPS = [
  { key: "profile", label: "School", icon: School },
  { key: "admin", label: "Admin", icon: UserCog },
  { key: "classes", label: "Classes", icon: Layers },
  { key: "subjects", label: "Subjects", icon: BookOpen },
  { key: "fees", label: "Fees", icon: Wallet },
];

const SECTION_PRESETS = ["A", "B", "C"];
const COMMON_SUBJECTS = ["Bangla", "English", "Mathematics", "Science", "Social Science", "Religion", "ICT", "Arts", "Physical Education"];
const QUICK_CLASSES: { label: string; names: string[] }[] = [
  { label: "Play · Nursery · KG", names: ["Play", "Nursery", "KG"] },
  { label: "Class 1–5", names: ["Class 1", "Class 2", "Class 3", "Class 4", "Class 5"] },
  { label: "Class 6–10", names: ["Class 6", "Class 7", "Class 8", "Class 9", "Class 10"] },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<any>(null);

  // step 1 — school profile
  const [school, setSchool] = useState({ name: "", address: "", phone: "", email: "", tagline: "", themeColor: "#4f46e5" });
  // step 2 — admin (only for new-school mode)
  const [admin, setAdmin] = useState({ name: "", email: "", password: "" });
  // step 3 — classes
  const [classes, setClasses] = useState<ClassDef[]>([]);
  const [newClass, setNewClass] = useState("");
  // step 4 — subjects
  const [subjects, setSubjects] = useState<string[]>([]);
  const [newSubject, setNewSubject] = useState("");
  // step 5 — fees
  const [fees, setFees] = useState({ monthlyFee: "1500", admissionFee: "5000" });

  useEffect(() => {
    Promise.all([
      api<Status>("/api/onboarding").catch(() => null),
      api<{ user: { id: string; name: string; email: string | null; role: string } }>("/api/auth/me").catch(() => null),
    ])
      .then(([st, me]) => {
        setAuthed(!!me);
        setRole(me?.user?.role || null);
        if (st) {
          setStatus(st);
          if (st.school) {
            // Extend mode — prefill profile from the existing school.
            setSchool((s) => ({ ...s, name: st.school!.name }));
            if (me?.user) setAdmin({ name: me.user.name, email: me.user.email || "", password: "" });
            if (st.onboarded) setStep(2); // jump straight to classes
          } else if (me?.user) {
            setAdmin({ name: me.user.name, email: me.user.email || "", password: "" });
          }
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const extendMode = !!status?.school;
  const adminStepVisible = !extendMode;

  const canNext = useMemo(() => {
    if (step === 0) return !!school.name.trim();
    if (step === 1) return adminStepVisible ? !!admin.email.trim() && !!admin.password : true;
    if (step === 2) return true; // classes optional
    if (step === 3) return true; // subjects optional
    if (step === 4) return true; // fees optional (defaults apply)
    return true;
  }, [step, school, admin, adminStepVisible]);

  const addClass = (name: string, sections: string[] = ["A", "B"]) => {
    const n = name.trim();
    if (!n || classes.some((c) => c.name.toLowerCase() === n.toLowerCase())) return;
    setClasses((cs) => [...cs, { name: n, sections }]);
  };
  const toggleSubject = (name: string) => {
    setSubjects((ss) => (ss.includes(name) ? ss.filter((s) => s !== name) : [...ss, name]));
  };

  const submit = async () => {
    setBusy(true); setError("");
    try {
      const payload: any = {
        school: {
          ...(extendMode && status?.school ? { id: status.school.id } : {}),
          name: school.name.trim(),
          address: school.address || null,
          phone: school.phone || null,
          email: school.email || null,
          tagline: school.tagline || null,
          themeColor: school.themeColor,
        },
        admin: adminStepVisible ? { name: admin.name, email: admin.email.trim(), password: admin.password } : undefined,
        classes: classes.map((c) => ({ name: c.name, sections: c.sections })),
        subjects: subjects.map((s) => ({ name: s })),
        fees: { monthlyFee: Number(fees.monthlyFee) || 0, admissionFee: Number(fees.admissionFee) || 0 },
      };
      const res = await api<any>("/api/onboarding", { method: "POST", body: JSON.stringify(payload) });
      setDone(res);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen label="Loading setup wizard…" />;

  if (!authed) {
    return (
      <Centered>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-600"><Sparkles size={26} /></div>
          <h1 className="text-xl font-black text-slate-900">Set up your school</h1>
          <p className="mt-2 text-sm text-slate-500">Sign in with your admin account first, then run this wizard to configure your school.</p>
          <Link href="/login" className="btn btn-primary mt-5 inline-flex">Go to login</Link>
        </div>
      </Centered>
    );
  }

  if (authed && role && !(role === "SCHOOL_ADMIN" || role === "SUPER_ADMIN")) {
    return (
      <Centered>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-600"><Sparkles size={26} /></div>
          <h1 className="text-xl font-black text-slate-900">Admins only</h1>
          <p className="mt-2 text-sm text-slate-500">The setup wizard is available to school and platform administrators. You are signed in as {role.replace("_", " ").toLowerCase()}.</p>
          <Link href="/" className="btn btn-secondary mt-5 inline-flex">Back to home</Link>
        </div>
      </Centered>
    );
  }

  if (done) {
    return (
      <Centered>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-600"><PartyPopper size={26} /></div>
          <h1 className="text-xl font-black text-slate-900">{done.extended ? "Setup updated!" : "Your school is ready!"}</h1>
          <p className="mt-2 text-sm text-slate-500">
            {done.classesCreated} class(es), {done.sectionsCreated} section(s) and {done.subjectsCreated} subject(s) configured.
            {done.fees ? ` Fees: ${fmtMoney((done.fees as any).monthlyFee)}/month.` : ""}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Link href="/dashboard" className="btn btn-primary">Open dashboard <ArrowRight size={14} /></Link>
            <Link href="/dashboard/settings" className="btn btn-secondary">School settings</Link>
          </div>
        </div>
      </Centered>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-10">
      <div className="mx-auto max-w-2xl px-4">
        <div className="mb-6 text-center">
          <div className="text-[11px] font-bold uppercase tracking-widest text-indigo-500">Setup wizard</div>
          <h1 className="mt-1 text-2xl font-black text-slate-900">{extendMode ? `Extend ${status?.school?.name}` : "Create your school"}</h1>
          <p className="mt-1 text-sm text-slate-500">Five quick steps — you can change everything later in Settings.</p>
        </div>

        {/* stepper */}
        <div className="mb-6 flex items-center justify-center gap-1 sm:gap-2">
          {STEPS.filter((s) => s.key !== "admin" || adminStepVisible).map((s, i) => {
            const idx = STEPS.indexOf(s);
            const active = step === idx;
            const past = step > idx;
            return (
              <button key={s.key} onClick={() => setStep(idx)} className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold transition">
                <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${active ? "brand-bg text-white" : past ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
                  {past ? <Check size={14} /> : <s.icon size={14} />}
                </span>
                <span className={active ? "text-slate-900" : "text-slate-400"}>{s.label}</span>
                {i < STEPS.filter((x) => x.key !== "admin" || adminStepVisible).length - 1 && <span className="hidden text-slate-300 sm:inline">→</span>}
              </button>
            );
          })}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          {error && <div className="mb-4"><ErrorNote message={error} /></div>}

          {/* STEP 1 — school profile */}
          {step === 0 && (
            <div className="space-y-4">
              <StepTitle icon={School} title="School profile" sub="How your school appears across the app." />
              <Field label="School name *">
                <TextInput value={school.name} onChange={(e) => setSchool({ ...school, name: e.target.value })} placeholder="e.g. Sunrise Model School" disabled={extendMode} />
              </Field>
              <Field label="Tagline">
                <TextInput value={school.tagline} onChange={(e) => setSchool({ ...school, tagline: e.target.value })} placeholder="e.g. Learning today, leading tomorrow" />
              </Field>
              <Field label="Address">
                <Textarea value={school.address} onChange={(e) => setSchool({ ...school, address: e.target.value })} placeholder="Street, area, city" />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Phone"><TextInput value={school.phone} onChange={(e) => setSchool({ ...school, phone: e.target.value })} placeholder="+880…" /></Field>
                <Field label="Email"><TextInput type="email" value={school.email} onChange={(e) => setSchool({ ...school, email: e.target.value })} placeholder="office@school.edu" /></Field>
              </div>
              <Field label="Brand color">
                <div className="flex items-center gap-3">
                  <input type="color" value={school.themeColor} onChange={(e) => setSchool({ ...school, themeColor: e.target.value })} className="h-10 w-14 cursor-pointer rounded-lg border border-slate-200" />
                  <span className="text-xs text-slate-400">Used for buttons and accents (white-label §12.2).</span>
                </div>
              </Field>
            </div>
          )}

          {/* STEP 2 — admin account */}
          {step === 1 && adminStepVisible && (
            <div className="space-y-4">
              <StepTitle icon={UserCog} title="Admin account" sub="This account manages the whole school." />
              <Field label="Admin name"><TextInput value={admin.name} onChange={(e) => setAdmin({ ...admin, name: e.target.value })} placeholder="Full name" /></Field>
              <Field label="Admin email *"><TextInput type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} placeholder="principal@school.edu" /></Field>
              <Field label="Password *"><TextInput type="password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} placeholder="Min 6 characters" /></Field>
            </div>
          )}
          {step === 1 && !adminStepVisible && (
            <div className="space-y-3 text-sm text-slate-500">
              <StepTitle icon={UserCog} title="Admin account" sub="You are signed in — this school keeps your admin account." />
              <div className="rounded-xl bg-slate-50 p-4 font-semibold text-slate-700">{admin.name || "Admin"} · {admin.email}</div>
            </div>
          )}

          {/* STEP 3 — classes */}
          {step === 2 && (
            <div className="space-y-4">
              <StepTitle icon={Layers} title="Classes & sections" sub="Add the classes your school runs, with sections." />
              <div className="flex flex-wrap gap-2">
                {QUICK_CLASSES.map((q) => (
                  <button key={q.label} className="btn btn-secondary btn-sm" onClick={() => q.names.forEach((n) => addClass(n))}>
                    <Plus size={12} /> {q.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <TextInput value={newClass} onChange={(e) => setNewClass(e.target.value)} placeholder="Custom class name…" onKeyDown={(e) => { if (e.key === "Enter") { addClass(newClass); setNewClass(""); } }} />
                <button className="btn btn-primary" onClick={() => { addClass(newClass); setNewClass(""); }}><Plus size={14} /> Add</button>
              </div>
              <div className="space-y-2">
                {classes.map((c, i) => (
                  <div key={c.name} className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-2.5">
                    <div className="font-bold text-slate-800">{c.name}</div>
                    <div className="flex items-center gap-1.5">
                      {SECTION_PRESETS.map((s) => (
                        <button key={s}
                          onClick={() => setClasses((cs) => cs.map((x, xi) => xi === i ? { ...x, sections: x.sections.includes(s) ? x.sections.filter((y) => y !== s) : [...x.sections, s].sort() } : x))}
                          className={`rounded-lg px-2 py-1 text-xs font-bold ${c.sections.includes(s) ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-400"}`}>
                          {s}
                        </button>
                      ))}
                      <button onClick={() => setClasses((cs) => cs.filter((_, xi) => xi !== i))} className="ml-1 rounded-lg p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-500"><X size={14} /></button>
                    </div>
                  </div>
                ))}
                {!classes.length && <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-400">No classes yet — use a quick-add preset above (you can also add them later).</div>}
              </div>
            </div>
          )}

          {/* STEP 4 — subjects */}
          {step === 3 && (
            <div className="space-y-4">
              <StepTitle icon={BookOpen} title="Subjects" sub="Pick the common ones or add your own." />
              <div className="flex flex-wrap gap-2">
                {COMMON_SUBJECTS.map((s) => (
                  <button key={s} onClick={() => toggleSubject(s)}
                    className={`rounded-xl px-3 py-1.5 text-xs font-bold transition ${subjects.includes(s) ? "brand-bg text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <TextInput value={newSubject} onChange={(e) => setNewSubject(e.target.value)} placeholder="Custom subject…" onKeyDown={(e) => { if (e.key === "Enter" && newSubject.trim()) { toggleSubject(newSubject.trim()); setNewSubject(""); } }} />
                <button className="btn btn-primary" onClick={() => { if (newSubject.trim()) { toggleSubject(newSubject.trim()); setNewSubject(""); } }}><Plus size={14} /> Add</button>
              </div>
            </div>
          )}

          {/* STEP 5 — fees */}
          {step === 4 && (
            <div className="space-y-4">
              <StepTitle icon={Wallet} title="Fee structure" sub="Defaults used when creating students — change anytime." />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Monthly fee (৳)"><TextInput type="number" value={fees.monthlyFee} onChange={(e) => setFees({ ...fees, monthlyFee: e.target.value })} /></Field>
                <Field label="Admission fee (৳)"><TextInput type="number" value={fees.admissionFee} onChange={(e) => setFees({ ...fees, admissionFee: e.target.value })} /></Field>
              </div>
            </div>
          )}

          {/* nav buttons */}
          <div className="mt-6 flex items-center justify-between border-t border-slate-100 pt-4">
            <button className="btn btn-secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
              <ArrowLeft size={14} /> Back
            </button>
            {step < 4 ? (
              <button className="btn btn-primary" onClick={() => setStep((s) => (extendMode && s === 0 ? 2 : s + 1))} disabled={!canNext}>Continue <ArrowRight size={14} /></button>
            ) : (
              <button className="btn btn-primary" onClick={submit} disabled={busy || !school.name.trim()}>
                <Check size={14} /> {busy ? "Setting up…" : extendMode ? "Save setup" : "Create school"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">{children}</div>;
}

function StepTitle({ icon: Icon, title, sub }: { icon: any; title: string; sub: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><Icon size={18} /></div>
      <div>
        <div className="text-sm font-black text-slate-900">{title}</div>
        <div className="text-xs text-slate-400">{sub}</div>
      </div>
    </div>
  );
}
