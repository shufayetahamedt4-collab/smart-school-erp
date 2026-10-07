"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, Network, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/client";
import { hasCollege, normalizeInstitutionType } from "@/lib/institution";
import { can } from "@/lib/permissions";
import { useMe } from "@/components/Shell";
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  LoadingScreen,
  Modal,
  PageHeader,
  Select,
  TextInput,
  prettyStatus,
  statusTone,
} from "@/components/ui";

/**
 * College support (Phase 2f) — Departments.
 *
 * This page is COLLEGE-ONLY and says so before it reads anything. The tenant
 * shape comes from the same source the Shell uses
 * (`me.school.institutionType ?? me.institutionType`), and the read effect below
 * returns BEFORE issuing any request when the tenant has no college, so a school
 * admin who types the URL directly gets the refusal and **no call to
 * `/api/departments`** at all.
 *
 * The API remains the real gate: every handler re-checks the tenant shape
 * server-side with `requireCollege()`. This page's check is UX, not security —
 * it is fail-closed, and it hides the college UI from a tenant that cannot run
 * it.
 *
 * Manage rights come from the permission matrix (`can(role, "departments", …)`),
 * the same function the routes enforce, so a REGISTRAR (view only) sees the list
 * with no create/edit/delete control and no drift between the two halves.
 */

interface DepartmentRow {
  id: string;
  name: string;
  code: string;
  branchId: string | null;
  headStaffId: string | null;
  /** Resolved by the API from the same tenant's users. */
  headName: string | null;
  status: string;
  _count: { programs: number };
}

interface Branch {
  id: string;
  name: string;
  code?: string | null;
}

interface StaffUser {
  id: string;
  name: string;
  role: string;
  branchId?: string | null;
}

const emptyForm = { name: "", code: "", headStaffId: "", branchId: "", status: "ACTIVE" };

export default function DepartmentsPage() {
  const { me, loading: meLoading, error: meError } = useMe();

  const institutionType = me?.school?.institutionType ?? me?.institutionType ?? null;
  const college = hasCollege(normalizeInstitutionType(institutionType));
  const role = me?.user?.role;
  const canManage = can(role, "departments", "full");

  const [rows, setRows] = useState<DepartmentRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<{ mode: "create" | "edit"; row?: DepartmentRow } | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  // A branch column and a branch picker are shown only when the tenant actually
  // has more than one branch.
  const multi = branches.length > 1;

  const load = useCallback(() => api<DepartmentRow[]>("/api/departments").then(setRows), []);

  useEffect(() => {
    // NO read before the gate resolves: a still-loading session must wait, and a
    // tenant without a college must never reach the network at all.
    if (meLoading || !college) return;
    let alive = true;
    setLoading(true);
    const reads: Promise<unknown>[] = [
      api<DepartmentRow[]>("/api/departments").then((data) => {
        if (alive) setRows(data);
      }),
    ];
    // Branch names are only rendered for a multi-branch tenant, and the picker is
    // only offered there. Tolerated if this role cannot read branches at all.
    reads.push(
      api<Branch[]>("/api/branches")
        .then((data) => {
          if (alive) setBranches(data);
        })
        .catch(() => {})
    );
    // The head picker needs the staff list, which only a manager may read.
    if (canManage) {
      reads.push(
        api<StaffUser[]>("/api/staff")
          .then((data) => {
            if (alive) setStaff(data);
          })
          .catch(() => {})
      );
    }
    Promise.all(reads)
      .catch((e: any) => {
        if (alive) setError(e?.message || "Could not load departments");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [meLoading, college, canManage]);

  const branchName = (id: string | null) => branches.find((b) => b.id === id)?.name || "—";

  const openCreate = () => {
    setError("");
    setForm(emptyForm);
    setModal({ mode: "create" });
  };

  const openEdit = (row: DepartmentRow) => {
    setError("");
    setForm({
      name: row.name,
      code: row.code,
      headStaffId: row.headStaffId || "",
      branchId: row.branchId || "",
      status: row.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    });
    setModal({ mode: "edit", row });
  };

  const save = async () => {
    if (!modal) return;
    setError("");
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { name: form.name.trim(), code: form.code.trim() };
      payload.headStaffId = form.headStaffId || null;
      if (multi) payload.branchId = form.branchId || null;
      if (modal.mode === "edit") {
        payload.status = form.status;
        await api(`/api/departments/${modal.row!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/departments", { method: "POST", body: JSON.stringify(payload) });
      }
      setModal(null);
      await load();
    } catch (e: any) {
      // Server message verbatim — e.g. a duplicate code (409).
      setError(e?.message || "Could not save the department");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: DepartmentRow) => {
    if (!confirm(`Delete department "${row.name}"?`)) return;
    setError("");
    try {
      await api(`/api/departments/${row.id}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      // Server message verbatim — e.g. "Cannot delete a department that has programs."
      setError(e?.message || "Could not delete the department");
    }
  };

  if (meLoading) return <LoadingScreen />;

  // No college on this tenant: a plain refusal, and nothing was fetched.
  if (!college && !me) {
    return (
      <div>
        <PageHeader title="Departments" subtitle="Academic structure of your college" />
        <Card>
          <div className="px-6 py-8">
            <ErrorNote message={meError || "Could not load your session."} />
          </div>
        </Card>
      </div>
    );
  }

  if (!college) {
    return (
      <div>
        <PageHeader icon={Network} title="Departments" subtitle="Academic structure of your college" />
        <Card>
          <EmptyState
            icon={Network}
            title="Available to college institutions only"
            description="This institution runs the school curriculum. Departments and programmes are part of the college setup."
          />
        </Card>
      </div>
    );
  }

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader
        icon={Network}
        title="Departments"
        subtitle={`${rows.length} department${rows.length === 1 ? "" : "s"} · academic structure of your college`}
        actions={
          canManage ? (
            <button className="btn btn-primary btn-sm" onClick={openCreate}>
              <Plus size={15} /> New Department
            </button>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={Network}
            title="No departments yet"
            description="Create your first department to start building the college structure."
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-bold text-slate-800">{d.name}</span>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">
                      {d.code}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                    <span>Head: {d.headName || "—"}</span>
                    <span>
                      {d._count.programs} programme{d._count.programs === 1 ? "" : "s"}
                    </span>
                    {multi && (
                      <span className="inline-flex items-center gap-1">
                        <Building2 size={11} /> {branchName(d.branchId)}
                      </span>
                    )}
                  </div>
                </div>

                <Badge tone={statusTone(d.status)}>{prettyStatus(d.status)}</Badge>

                {canManage && (
                  <div className="flex items-center gap-1">
                    <button className="btn btn-secondary btn-sm" onClick={() => openEdit(d)}>
                      <Pencil size={13} /> Edit
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => remove(d)}>
                      <Trash2 size={13} /> Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={modal?.mode === "edit" ? "Edit department" : "New department"}
      >
        <div className="space-y-4">
          <Field label="Department name">
            <TextInput
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Department of Science"
            />
          </Field>
          <Field label="Code" hint="Short unique code, e.g. SCI. Unique within this institution.">
            <TextInput
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="e.g. SCI"
            />
          </Field>

          <Field label="Head of department" hint="Only staff of this institution can be selected.">
            <Select
              value={form.headStaffId}
              onChange={(e) => setForm({ ...form, headStaffId: e.target.value })}
            >
              <option value="">— none —</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({prettyStatus(s.role)})
                </option>
              ))}
            </Select>
          </Field>

          {multi && (
            <Field label="Branch">
              <Select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                <option value="">— none —</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.code ? ` (${b.code})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {modal?.mode === "edit" && (
            <Field label="Status">
              <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </Field>
          )}

          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={saving || !form.name.trim() || !form.code.trim()}
            >
              {modal?.mode === "edit" ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
