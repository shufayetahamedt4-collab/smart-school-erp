"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, Plus, Pencil, Power, Trash2, Users, GraduationCap, Check, X, UserPlus, UserMinus, Ban } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, Textarea, Select, Modal, PageHeader, LoadingScreen, EmptyState, ErrorNote } from "@/components/ui";
import { fmtMoney } from "@/lib/utils";
import { useMe } from "@/components/Shell";

interface Branch {
  id: string;
  name: string;
  code?: string | null;
  address?: string | null;
  phone?: string | null;
  enabled?: boolean;
  _count?: { students?: number; staff?: number };
  /** Filled for the main admin — per-branch monitoring (PRD §12.3). */
  monitoring?: {
    students: number;
    staff: number;
    classes: number;
    teachers: number;
    pipeline: Record<string, number>;
    fees: { total: number; paid: number; due: number; unpaid: number };
  } | null;
}

const emptyForm = { name: "", code: "", address: "", phone: "" };

/** A staff/management account as returned by /api/staff. */
interface StaffUser {
  id: string;
  name: string;
  email: string;
  role: string;
  scope?: string;
  branchId?: string | null;
  active?: boolean;
  branch?: { id: string; name: string; code?: string | null } | null;
}

const ROLE_LABELS: Record<string, string> = {
  SCHOOL_ADMIN: "School Admin",
  BRANCH_ADMIN: "Branch Admin",
  REGISTRAR: "Registrar",
  ACCOUNTANT: "Accountant",
  LIBRARIAN: "Librarian",
  FRONT_DESK: "Front Desk",
  TEACHER: "Teacher",
};

/** Roles that can be attached to a branch (mirrors MANAGEMENT_ROLES, PRD §2). */
const ASSIGNABLE_ROLES = ["BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"];

export default function BranchesPage() {
  const { me } = useMe();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const role = me?.user.role;
  const isBranchScoped = me?.user.scope === "BRANCH";
  const canManage = role === "SCHOOL_ADMIN" || role === "SUPER_ADMIN";

  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [staffModal, setStaffModal] = useState<{ branch: Branch } | null>(null);
  const [assignTab, setAssignTab] = useState<"existing" | "new">("existing");
  const [assignForm, setAssignForm] = useState({ userId: "", role: "REGISTRAR", name: "", email: "", password: "" });
  const [assignBusy, setAssignBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<Branch[]>("/api/branches");
      setBranches(data || []);
      if (canManage) {
        const s = await api<StaffUser[]>("/api/staff").catch(() => [] as StaffUser[]);
        setStaff(s || []);
      }
      setError("");
    } catch (e: any) {
      setError(e?.message || "Failed to load branches");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  const [modal, setModal] = useState<{ mode: "create" | "edit"; branch?: Branch } | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const toggleErp = async (b: Branch) => {
    if (!window.confirm(`Turn ${b.enabled ? "OFF" : "ON"} ERP access for "${b.name}"?`)) return;
    try {
      await api(`/api/branches?id=${b.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !b.enabled }) });
      setError("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Update failed");
    }
  };

  const remove = async (b: Branch) => {
    if (!window.confirm(`Delete branch "${b.name}"?`)) return;
    try {
      await api(`/api/branches?id=${b.id}`, { method: "DELETE" });
      setError("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Delete failed");
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (modal?.mode === "edit" && modal.branch) {
        await api(`/api/branches?id=${modal.branch.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: form.name, code: form.code, address: form.address, phone: form.phone,
          }),
        });
      } else {
        await api("/api/branches", { method: "POST", body: JSON.stringify(form) });
      }
      setModal(null);
      await load();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------------ staff assignment (PRD §12.3)
  const staffModalBranch = staffModal?.branch || null;
  const branchStaff = staffModalBranch ? staff.filter((u) => u.branchId === staffModalBranch.id) : [];
  const candidates = staff.filter(
    (u) => u.active !== false && ASSIGNABLE_ROLES.includes(u.role) && u.branchId !== staffModalBranch?.id
  );

  const openStaff = (b: Branch) => {
    setAssignTab("existing");
    setAssignForm({ userId: "", role: "REGISTRAR", name: "", email: "", password: "" });
    setStaffModal({ branch: b });
  };

  const refreshAfter = async () => {
    const [data, s] = await Promise.all([
      api<Branch[]>("/api/branches"),
      api<StaffUser[]>("/api/staff").catch(() => [] as StaffUser[]),
    ]);
    setBranches(data || []);
    setStaff(s || []);
  };

  const assignExisting = async () => {
    if (!staffModalBranch || !assignForm.userId) return;
    setAssignBusy(true);
    setError("");
    try {
      await api(`/api/staff?id=${assignForm.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: assignForm.role, scope: "BRANCH", branchId: staffModalBranch.id }),
      });
      await refreshAfter();
      setAssignForm({ userId: "", role: "REGISTRAR", name: "", email: "", password: "" });
    } catch (e: any) {
      setError(e?.message || "Assign failed");
    } finally {
      setAssignBusy(false);
    }
  };

  const createAndAssign = async () => {
    if (!staffModalBranch) return;
    setAssignBusy(true);
    setError("");
    try {
      await api("/api/staff", {
        method: "POST",
        body: JSON.stringify({
          name: assignForm.name,
          email: assignForm.email,
          password: assignForm.password,
          role: assignForm.role,
          scope: "BRANCH",
          branchId: staffModalBranch.id,
        }),
      });
      await refreshAfter();
      setAssignForm({ userId: "", role: "REGISTRAR", name: "", email: "", password: "" });
      setAssignTab("existing");
    } catch (e: any) {
      setError(e?.message || "Could not create the account");
    } finally {
      setAssignBusy(false);
    }
  };

  const unassign = async (u: StaffUser) => {
    if (!staffModalBranch) return;
    if (!window.confirm(`Move ${u.name} out of "${staffModalBranch.name}" (becomes school-wide staff)?`)) return;
    setError("");
    try {
      await api(`/api/staff?id=${u.id}`, { method: "PATCH", body: JSON.stringify({ scope: "SCHOOL", branchId: null }) });
      await refreshAfter();
    } catch (e: any) {
      setError(e?.message || "Update failed");
    }
  };

  const freezeStaff = async (u: StaffUser) => {
    if (!window.confirm(`Freeze ${u.name}'s account? They will lose ERP access immediately.`)) return;
    setError("");
    try {
      await api(`/api/staff?id=${u.id}`, { method: "DELETE" });
      await refreshAfter();
    } catch (e: any) {
      setError(e?.message || "Update failed");
    }
  };

  if (loading) return <LoadingScreen label="Loading branches…" />;

  return (
    <div className="max-w-5xl">
      <PageHeader
        title={isBranchScoped ? "My Branch" : "Branches & Campuses"}
        subtitle="Multi-branch ERP access and per-campus records (PRD §12.3)"
        actions={canManage ? (
          <button
            className="btn btn-primary"
            onClick={() => { setForm(emptyForm); setModal({ mode: "create" }); }}
          >
            <Plus size={15} /> Add branch
          </button>
        ) : undefined}
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}
{branches.length === 0 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title="No branches yet"
            description="Create branch/campus accounts. Each branch keeps its own students, staff and finances under your school."
            action={canManage ? (
              <button className="btn btn-primary btn-sm" onClick={() => { setForm(emptyForm); setModal({ mode: "create" }); }}>
                <Plus size={14} /> Add your first branch
              </button>
            ) : undefined}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {branches.map((b) => (
            <Card key={b.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                      <Building2 size={18} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-bold text-slate-800">{b.name}</h3>
                      <p className="truncate text-xs text-slate-400">
                        {[b.code, b.address].filter(Boolean).join(" · ") || "No address set"}
                      </p>
                    </div>
                  </div>
                </div>
                <Badge tone={b.enabled === false ? "red" : "green"}>
                  {b.enabled === false ? "ERP off" : "ERP on"}
                </Badge>
              </div>

              <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <GraduationCap size={14} className="text-slate-400" /> {b._count?.students ?? 0} students
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Users size={14} className="text-slate-400" /> {b._count?.staff ?? 0} staff
                </span>
                {b.phone && <span>{b.phone}</span>}
              </div>

              {/* Per-branch monitoring — main admin only (PRD §12.3) */}
              {b.monitoring && (role === "SCHOOL_ADMIN" || role === "SUPER_ADMIN") && (
                <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Branch overview</div>
                  <div className="mt-2 grid grid-cols-4 gap-2 text-center">
                    {[
                      { label: "Students", value: b.monitoring.students },
                      { label: "Teachers", value: b.monitoring.teachers },
                      { label: "Classes", value: b.monitoring.classes },
                      { label: "Staff", value: b.monitoring.staff },
                    ].map((s) => (
                      <div key={s.label} className="rounded-lg bg-white px-1 py-2">
                        <div className="text-sm font-bold text-slate-800">{s.value}</div>
                        <div className="text-[10px] text-slate-400">{s.label}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                    <span>Fees: <b className="text-slate-700">{fmtMoney(b.monitoring.fees.paid)}</b> collected</span>
                    <span>
                      Due: <b className={b.monitoring.fees.due > 0 ? "text-rose-600" : "text-slate-700"}>{fmtMoney(b.monitoring.fees.due)}</b>
                    </span>
                    {Object.entries(b.monitoring.pipeline).map(([st, n]) => (
                      <span key={st}>
                        {st.replace(/_/g, " ").toLowerCase()}: <b className="text-slate-700">{n}</b>
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-slate-200/70 pt-2">
                    <Link className="text-[11px] font-semibold text-indigo-600 hover:underline" href={`/dashboard/students?branchId=${b.id}`}>Students →</Link>
                    <Link className="text-[11px] font-semibold text-indigo-600 hover:underline" href={`/dashboard/teachers?branchId=${b.id}`}>Teachers →</Link>
                    <Link className="text-[11px] font-semibold text-indigo-600 hover:underline" href={`/dashboard/fees?branchId=${b.id}`}>Fees →</Link>
                    <Link className="text-[11px] font-semibold text-indigo-600 hover:underline" href={`/dashboard/admissions?branchId=${b.id}`}>Admissions →</Link>
                  </div>
                </div>
              )}

              {(canManage || role === "BRANCH_ADMIN") && (
                <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3">
                  {canManage && (
                    <button className="btn btn-secondary btn-sm" onClick={() => openStaff(b)}>
                      <UserPlus size={13} /> Assign staff ({b._count?.staff ?? 0})
                    </button>
                  )}
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => { setForm({ name: b.name, code: b.code || "", address: b.address || "", phone: b.phone || "" }); setModal({ mode: "edit", branch: b }); }}
                  >
                    <Pencil size={13} /> Edit
                  </button>
                  {canManage && (
                    <button className="btn btn-secondary btn-sm" onClick={() => toggleErp(b)}>
                      <Power size={13} /> {b.enabled === false ? "Enable ERP" : "Disable ERP"}
                    </button>
                  )}
                  {canManage && (b._count?.students ?? 0) === 0 && (b._count?.staff ?? 0) === 0 && (
                    <button className="btn btn-secondary btn-sm !text-rose-600" onClick={() => remove(b)}>
                      <Trash2 size={13} /> Delete
                    </button>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={modal?.mode === "edit" ? "Edit branch" : "Add a branch"}
      >
        <div className="space-y-4">
          <Field label="Branch name" hint="e.g. Sunrise School — Chattogram">
            <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Branch name" />
          </Field>
          <Field label="Branch code">
            <TextInput value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. CGP / optional" />
          </Field>
          <Field label="Address">
            <Textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="City, area, road…" />
          </Field>
          <Field label="Phone">
            <TextInput value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+880 …" />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <button className="btn btn-secondary" onClick={() => setModal(null)}><X size={14} /> Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving || !form.name.trim()}>
              {saving ? null : <Check size={14} />} {saving ? "Saving…" : modal?.mode === "edit" ? "Save changes" : "Add branch"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ------------------------------------------------ assign staff to a branch */}
      <Modal
        open={!!staffModal}
        onClose={() => setStaffModal(null)}
        title={staffModalBranch ? `People of ${staffModalBranch.name}` : ""}
      >
        <div className="space-y-5">
          {error && <ErrorNote message={error} />}

          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Assigned to this branch</div>
            {branchStaff.length === 0 ? (
              <p className="mt-2 text-xs text-slate-400">
                Nobody yet. Assign a branch admin, registrar, accountant, librarian or front desk below.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {branchStaff.map((u) => (
                  <div key={u.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-slate-700">
                        {u.name}
                        {u.active === false && <span className="ml-1 text-[10px] font-bold text-rose-500">(frozen)</span>}
                      </div>
                      <div className="truncate text-[11px] text-slate-400">{u.email}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge tone="indigo">{ROLE_LABELS[u.role] || u.role}</Badge>
                      <button className="btn btn-secondary btn-sm !px-2" title="Move to school-wide staff" onClick={() => unassign(u)}>
                        <UserMinus size={13} />
                      </button>
                      {u.active !== false && (
                        <button className="btn btn-secondary btn-sm !px-2 !text-rose-600" title="Freeze account" onClick={() => freezeStaff(u)}>
                          <Ban size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-slate-100 pt-4">
            <div className="flex gap-1.5">
              <button
                className={`btn btn-sm ${assignTab === "existing" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setAssignTab("existing")}
              >
                Existing staff
              </button>
              <button
                className={`btn btn-sm ${assignTab === "new" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setAssignTab("new")}
              >
                New person
              </button>
            </div>

            {assignTab === "existing" ? (
              <div className="mt-3 space-y-3">
                <Field label="Pick a staff member" hint="Anyone not already assigned to this branch.">
                  <Select value={assignForm.userId} onChange={(e) => setAssignForm({ ...assignForm, userId: e.target.value })}>
                    <option value="">— choose —</option>
                    {candidates.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} · {ROLE_LABELS[u.role] || u.role}
                        {u.branch?.name ? ` (now: ${u.branch.name})` : " (school-wide)"}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Role in this branch">
                  <Select value={assignForm.role} onChange={(e) => setAssignForm({ ...assignForm, role: e.target.value })}>
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                    ))}
                  </Select>
                </Field>
                {assignForm.role === "BRANCH_ADMIN" && (
                  <p className="text-[11px] text-slate-400">
                    Branch admins run this branch like a school admin — classes, students, fees, exams — but only inside it.
                  </p>
                )}
                <div className="flex justify-end">
                  <button className="btn btn-primary btn-sm" onClick={assignExisting} disabled={assignBusy || !assignForm.userId}>
                    <UserPlus size={14} /> {assignBusy ? "Assigning…" : "Assign to branch"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <Field label="Full name">
                  <TextInput value={assignForm.name} onChange={(e) => setAssignForm({ ...assignForm, name: e.target.value })} placeholder="e.g. Rafiq Islam" />
                </Field>
                <Field label="Email" hint="They sign in with this email.">
                  <TextInput value={assignForm.email} onChange={(e) => setAssignForm({ ...assignForm, email: e.target.value })} placeholder="name@school.com" />
                </Field>
                <Field label="Temporary password" hint="At least 6 characters — they can change it later.">
                  <TextInput type="password" value={assignForm.password} onChange={(e) => setAssignForm({ ...assignForm, password: e.target.value })} placeholder="••••••" />
                </Field>
                <Field label="Role in this branch">
                  <Select value={assignForm.role} onChange={(e) => setAssignForm({ ...assignForm, role: e.target.value })}>
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                    ))}
                  </Select>
                </Field>
                {assignForm.role === "BRANCH_ADMIN" && (
                  <p className="text-[11px] text-slate-400">
                    Branch admins run this branch like a school admin — classes, students, fees, exams — but only inside it.
                  </p>
                )}
                <div className="flex justify-end">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={createAndAssign}
                    disabled={assignBusy || !assignForm.name.trim() || !assignForm.email.trim() || assignForm.password.length < 6}
                  >
                    <UserPlus size={14} /> {assignBusy ? "Creating…" : "Create & assign"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}