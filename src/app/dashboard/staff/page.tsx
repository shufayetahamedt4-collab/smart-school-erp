"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil, Save, X, ShieldCheck, UserCog, KeyRound, Power } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, Select, Modal, PageHeader, LoadingScreen, EmptyState, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { useMe } from "@/components/Shell";

interface Branch {
  id: string;
  name: string;
  code?: string | null;
  enabled?: boolean;
}

interface StaffUser {
  id: string;
  name: string;
  email: string | null;
  phone?: string | null;
  role: string;
  scope?: "SCHOOL" | "BRANCH" | null;
  branchId?: string | null;
  active?: boolean;
  branch?: { id: string; name: string; code?: string | null } | null;
}

const ROLE_OPTIONS = ["BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"];

const emptyForm = {
  name: "", email: "", password: "", role: "REGISTRAR" as string, scope: "BRANCH" as "SCHOOL" | "BRANCH", branchId: "",
};

export default function StaffPage() {
  const { me } = useMe();
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const role = me?.user.role;
  const branchScoped = me?.user.scope === "BRANCH";
  const canManage = role === "SCHOOL_ADMIN" || role === "BRANCH_ADMIN";

  const load = async () => {
    setLoading(true);
    try {
      const [s, b] = await Promise.all([
        api<StaffUser[]>("/api/staff"),
        api<Branch[]>("/api/branches"),
      ]);
      setStaff(s || []);
      setBranches(b || []);
      setError("");
    } catch (e: any) {
      setError(e?.message || "Failed to load staff");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [modal, setModal] = useState<{ mode: "create" | "edit"; staff?: StaffUser } | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [resetPassword, setResetPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const branchName = (id?: string | null) => branches.find((x) => x.id === id)?.name || "—";

  const toggleActive = async (s: StaffUser) => {
    if (!window.confirm(s.active === false ? `Reactivate ${s.name}?` : `Freeze ${s.name}? They will no longer be able to sign in.`)) return;
    try {
      await api(`/api/staff?id=${s.id}`, { method: "PATCH", body: JSON.stringify({ active: s.active === false }) });
      setError("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Update failed");
    }
  };

  const save = async () => {
    if (modal?.mode === "edit" && !form.name.trim()) return;
    if (modal?.mode === "create" && (!form.name.trim() || !form.email.trim() || !form.password)) return;
    setSaving(true);
    setError("");
    try {
      const payload: Record<string, any> = { name: form.name, role: form.role, scope: form.scope, branchId: form.branchId || null };
      if (modal?.mode === "create") {
        payload.email = form.email.trim().toLowerCase();
        payload.password = form.password;
        await api("/api/staff", { method: "POST", body: JSON.stringify(payload) });
      } else {
        if (resetPassword) payload.password = resetPassword;
        if (modal?.staff && modal.staff.active !== undefined) payload.active = modal.staff.active !== false;
        await api(`/api/staff?id=${modal!.staff!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      }
      setModal(null);
      setResetPassword("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingScreen label="Loading staff…" />;

  const roleOptions = branchScoped ? ROLE_OPTIONS.filter((r) => r !== "BRANCH_ADMIN") : ROLE_OPTIONS;

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Staff & Roles"
        subtitle="Create accounts and assign roles — registrar, accountant, librarian, front desk and branch admins"
        actions={canManage ? (
          <button
            className="btn btn-primary"
            onClick={() => {
              setForm({ ...emptyForm, scope: branchScoped ? "BRANCH" : "SCHOOL", branchId: branchScoped ? me?.user.branchId || "" : "" });
              setResetPassword("");
              setModal({ mode: "create" });
            }}
          >
            <Plus size={15} /> Add staff
          </button>
        ) : undefined}
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}
{staff.length === 0 ? (
        <Card>
          <EmptyState
            icon={UserCog}
            title="No staff accounts yet"
            description="Add staff under your admin — a registrar, accountant, librarian or front desk — each with their own role and (optionally) branch scope."
            action={canManage ? (
              <button className="btn btn-primary btn-sm" onClick={() => { setForm({ ...emptyForm, scope: branchScoped ? "BRANCH" : "SCHOOL", branchId: branchScoped ? me?.user.branchId || "" : "" }); setModal({ mode: "create" }); }}>
                <Plus size={14} /> Add your first staff member
              </button>
            ) : undefined}
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-widest text-slate-400">
                  <th className="px-5 py-3">Staff</th>
                  <th className="px-3 py-3">Role</th>
                  <th className="px-3 py-3">Scope</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-5 py-3">
                      <div className="text-[13px] font-bold text-slate-800">{s.name}</div>
                      <div className="text-xs text-slate-400">{s.email || "no email"}</div>
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone="indigo">{prettyStatus(s.role)}</Badge>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500">
                      {s.scope === "BRANCH" ? (
                        <span className="inline-flex items-center gap-1">
                          <ShieldCheck size={13} className="text-slate-400" /> {branchName(s.branchId)}
                        </span>
                      ) : (
                        <span className="text-slate-400">Whole school</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={s.active === false ? "red" : "green"}>
                        {s.active === false ? "Frozen" : "Active"}
                      </Badge>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setForm({ name: s.name, email: s.email || "", password: "", role: s.role, scope: s.scope === "BRANCH" ? "BRANCH" : "SCHOOL", branchId: s.branchId || "" });
                            setResetPassword("");
                            setModal({ mode: "edit", staff: s });
                          }}
                        >
                          <Pencil size={13} /> Edit
                        </button>
                        {canManage && (
                          <button className="btn btn-secondary btn-sm" onClick={() => toggleActive(s)}>
                            <Power size={13} /> {s.active === false ? "Reactivate" : "Freeze"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
<Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={modal?.mode === "edit" ? "Edit staff & role" : "Add staff"}
      >
        <div className="space-y-4">
          {modal?.mode === "create" && (
            <p className="rounded-xl bg-indigo-50 px-4 py-3 text-xs text-indigo-700">
              This account signs in to the School Admin app and is limited by its role and branch scope.
            </p>
          )}

          <Field label="Full name">
            <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Rahim Uddin" />
          </Field>

          {modal?.mode === "create" && (
            <Field label="Email" hint="Used to sign in">
              <TextInput value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="rahim@sunrise.edu" />
            </Field>
          )}

          {modal?.mode === "create" ? (
            <Field label="Temporary password" hint="At least 6 characters. Share it with the staff member once.">
              <TextInput type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••" />
            </Field>
          ) : (
            <Field label="Reset password" hint="Leave blank to keep the current password">
              <TextInput type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="New password (optional)" />
            </Field>
          )}

          <Field label="Role">
            <Select
              value={form.role}
              disabled={branchScoped}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {roleOptions.map((r) => <option key={r} value={r}>{prettyStatus(r)}</option>)}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Scope">
              <Select
                value={form.scope}
                disabled={branchScoped}
                onChange={(e) => setForm({ ...form, scope: e.target.value as "SCHOOL" | "BRANCH" })}
              >
                <option value="SCHOOL">Whole school</option>
                <option value="BRANCH">One branch</option>
              </Select>
            </Field>
            <Field label="Branch">
              <Select
                value={form.branchId}
                disabled={form.scope !== "BRANCH"}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
              >
                <option value="">— Select branch —</option>
                {branches.filter((b) => b.enabled !== false).map((b) => (
                  <option key={b.id} value={b.id}>{b.name}{b.code ? ` (${b.code})` : ""}</option>
                ))}
                {form.scope === "BRANCH" && branches.filter((b) => b.enabled === false).map((b) => (
                  <option key={b.id} value={b.id} disabled>{b.name} — ERP off</option>
                ))}
              </Select>
            </Field>
          </div>

          {modal?.mode === "edit" && (
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              <input
                type="checkbox"
                checked={modal.staff?.active !== false}
                onChange={(e) => setModal({ ...modal, staff: { ...modal!.staff!, active: e.target.checked } })}
                className="h-4 w-4 rounded border-slate-300"
              />
              Account active (can sign in)
            </label>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button className="btn btn-secondary" onClick={() => setModal(null)}><X size={14} /> Cancel</button>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={saving}
            >
              {saving ? null : <Save size={14} />} {saving ? "Saving…" : modal?.mode === "edit" ? "Save changes" : "Create staff"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}