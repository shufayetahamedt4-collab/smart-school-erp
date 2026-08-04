"use client";

import { useEffect, useState } from "react";
import { Plus, Users, Pencil, Trash2, BookOpen } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, Field, TextInput, Select, Modal, PageHeader, EmptyState, LoadingScreen, ErrorNote } from "@/components/ui";
import { initials, fmtDate } from "@/lib/utils";

interface Teacher {
  id: string; designation: string | null; qualification: string | null; joinDate: string | null;
  user: { id: string; name: string; email: string; active: boolean };
  assignments: { id: string; classRoom: { name: string }; section: { name: string } | null; subject: { name: string } }[];
}

interface ClassRow { id: string; name: string; sections: { id: string; name: string }[] }
interface SubjectRow { id: string; name: string }

export default function TeachersPage() {
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", email: "", designation: "", qualification: "", phone: "", password: "Teacher@123" });
  const [assignForm, setAssignForm] = useState({ classId: "", sectionId: "", subjectId: "" });

  const load = () =>
    Promise.all([api<Teacher[]>("/api/teachers"), api<ClassRow[]>("/api/classes"), api<SubjectRow[]>("/api/subjects")])
      .then(([t, c, s]) => { setTeachers(t); setClasses(c); setSubjects(s); })
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const create = async () => {
    setError("");
    try {
      await api("/api/teachers", { method: "POST", body: JSON.stringify(form) });
      setOpen(false);
      setForm({ name: "", email: "", designation: "", qualification: "", phone: "", password: "Teacher@123" });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const assign = async (teacherId: string) => {
    setError("");
    try {
      await api("/api/assignments", { method: "POST", body: JSON.stringify({ ...assignForm, teacherId }) });
      setAssignOpen(null);
      setAssignForm({ classId: "", sectionId: "", subjectId: "" });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const removeAssignment = async (assignmentId: string) => {
    await api(`/api/assignments?id=${assignmentId}`, { method: "DELETE" });
    load();
  };

  if (loading) return <LoadingScreen />;
  const selClass = classes.find((c) => c.id === assignForm.classId);

  return (
    <div>
      <PageHeader title="Teachers" subtitle={`${teachers.length} teachers on staff`} actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> Add Teacher</button>} />

      <Card>
        {teachers.length === 0 ? (
          <EmptyState icon={Users} title="No teachers yet" description="Add your first teacher to start assigning classes." />
        ) : (
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
            {teachers.map((t) => (
              <div key={t.id} className="rounded-2xl border border-slate-200 p-4 transition hover:border-indigo-200 hover:shadow-md">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-black text-white">{initials(t.user.name)}</div>
                  <div className="min-w-0">
                    <div className="truncate font-bold text-slate-800">{t.user.name}</div>
                    <div className="truncate text-xs text-slate-400">{t.user.email}</div>
                  </div>
                  <Badge tone={t.user.active ? "green" : "red"}>{t.user.active ? "Active" : "Inactive"}</Badge>
                </div>
                <div className="mt-3 space-y-0.5 text-xs text-slate-500">
                  <div><span className="font-semibold text-slate-400">Designation:</span> {t.designation || "—"}</div>
                  <div><span className="font-semibold text-slate-400">Qualification:</span> {t.qualification || "—"}</div>
                  <div><span className="font-semibold text-slate-400">Joined:</span> {fmtDate(t.joinDate)}</div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {t.assignments.map((a, i) => (
                    <span key={i} className="badge bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
                      {a.subject.name} · {a.classRoom.name}
                      <button onClick={() => removeAssignment(a.id)} className="ml-1 hover:text-rose-500">×</button>
                    </span>
                  ))}
                  {!t.assignments.length && <span className="text-xs text-slate-400">No assignments yet</span>}
                </div>
                <button className="btn btn-secondary btn-sm mt-3 w-full" onClick={() => setAssignOpen(t.id)}>
                  <BookOpen size={14} /> Assign classes / subjects
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* add teacher modal */}
      <Modal open={open} onClose={() => setOpen(false)} title="Add teacher">
        <div className="space-y-4">
          {error && <ErrorNote message={error} />}
          <Field label="Full name *"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email *"><TextInput type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Designation"><TextInput value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} placeholder="Senior Teacher" /></Field>
            <Field label="Qualification"><TextInput value={form.qualification} onChange={(e) => setForm({ ...form, qualification: e.target.value })} placeholder="M.A." /></Field>
          </div>
          <Field label="Phone"><TextInput value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Password" hint="Teacher login password"><TextInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={create} disabled={!form.name || !form.email}>Add teacher</button>
          </div>
        </div>
      </Modal>

      {/* assign modal */}
      <Modal open={!!assignOpen} onClose={() => setAssignOpen(null)} title="Assign class & subject">
        <div className="space-y-4">
          <Field label="Class">
            <Select value={assignForm.classId} onChange={(e) => setAssignForm({ ...assignForm, classId: e.target.value, sectionId: "" })}>
              <option value="">Select…</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Section">
            <Select value={assignForm.sectionId} onChange={(e) => setAssignForm({ ...assignForm, sectionId: e.target.value })}>
              <option value="">All sections</option>
              {selClass?.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Subject">
            <Select value={assignForm.subjectId} onChange={(e) => setAssignForm({ ...assignForm, subjectId: e.target.value })}>
              <option value="">Select…</option>
              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setAssignOpen(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => assign(assignOpen!)} disabled={!assignForm.classId || !assignForm.subjectId}>Assign</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
