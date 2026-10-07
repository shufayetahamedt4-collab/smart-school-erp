"use client";

import { useCallback, useEffect, useState } from "react";
import { Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { api, qs } from "@/lib/client";
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
 * College support (Phase 2f) — Programmes.
 *
 * COLLEGE-ONLY, and it says so before it reads anything: the tenant shape comes
 * from the same source the Shell uses (`me.school.institutionType ??
 * me.institutionType`), and the read effect returns BEFORE issuing any request
 * when the tenant has no college — so a school admin who types the URL directly
 * gets the refusal and **no call to `/api/programs`**.
 *
 * The API remains the real gate (`requireCollege()` in every handler); this
 * check is UX, fail-closed.
 *
 * A programme inherits its department's branch, so there is no branch control
 * here. Phase 2 has NO semesters or terms (that model is decided in Phase 3).
 */

interface ProgramRow {
  id: string;
  name: string;
  code: string;
  departmentId: string;
  /** Resolved by the API from the same tenant's departments. */
  departmentName: string | null;
  degreeLevel: string;
  durationYears: number;
  status: string;
}

interface DepartmentRow {
  id: string;
  name: string;
  code: string;
  status: string;
}

/** The degree levels Phase 2 supports (mirrors the API's enum). */
const DEGREE_LEVELS = ["HSC", "DEGREE_PASS", "HONOURS", "MASTERS", "DIPLOMA"] as const;

/**
 * Suggested length per level, applied when the level is chosen. The field stays
 * editable (1–6) — this is a convenience, never a validation rule.
 */
const SUGGESTED_YEARS: Record<string, number> = {
  HSC: 2,
  DEGREE_PASS: 3,
  HONOURS: 4,
  MASTERS: 1,
};

const emptyForm = {
  name: "",
  code: "",
  departmentId: "",
  degreeLevel: "HSC" as string,
  durationYears: SUGGESTED_YEARS.HSC,
  status: "ACTIVE",
};

export default function ProgramsPage() {
  const { me, loading: meLoading, error: meError } = useMe();

  const institutionType = me?.school?.institutionType ?? me?.institutionType ?? null;
  const college = hasCollege(normalizeInstitutionType(institutionType));
  const role = me?.user?.role;
  const canManage = can(role, "programs", "full");

  const [rows, setRows] = useState<ProgramRow[]>([]);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<{ mode: "create" | "edit"; row?: ProgramRow } | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () => api<ProgramRow[]>(`/api/programs${qs({ departmentId: filter || undefined })}`).then(setRows),
    [filter]
  );

  useEffect(() => {
    // NO read before the gate resolves: a still-loading session must wait, and a
    // tenant without a college must never reach the network at all.
    if (meLoading || !college) return;
    let alive = true;
    setLoading(true);
    Promise.all([
      api<ProgramRow[]>(`/api/programs${qs({ departmentId: filter || undefined })}`).then((data) => {
        if (alive) setRows(data);
      }),
      api<DepartmentRow[]>("/api/departments").then((data) => {
        if (alive) setDepartments(data);
      }),
    ])
      .catch((e: any) => {
        if (alive) setError(e?.message || "Could not load programmes");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [meLoading, college, filter]);

  // The modal may only offer ACTIVE departments — except the programme's own
  // department while editing it, which must stay selectable even once inactive,
  // or editing an older programme would silently move it.
  const activeDepartments = departments.filter((d) => d.status !== "INACTIVE");
  const editingDepartment =
    modal?.mode === "edit" ? departments.find((d) => d.id === form.departmentId) : undefined;
  const departmentOptions =
    editingDepartment && editingDepartment.status === "INACTIVE"
      ? [...activeDepartments, editingDepartment]
      : activeDepartments;

  const openCreate = () => {
    setError("");
    setForm({ ...emptyForm, departmentId: filter || departmentOptions[0]?.id || "" });
    setModal({ mode: "create" });
  };

  const openEdit = (row: ProgramRow) => {
    setError("");
    setForm({
      name: row.name,
      code: row.code,
      departmentId: row.departmentId,
      degreeLevel: row.degreeLevel,
      durationYears: row.durationYears,
      status: row.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    });
    setModal({ mode: "edit", row });
  };

  const save = async () => {
    if (!modal) return;
    setError("");
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        code: form.code.trim(),
        departmentId: form.departmentId,
        degreeLevel: form.degreeLevel,
        durationYears: form.durationYears,
      };
      if (modal.mode === "edit") {
        payload.status = form.status;
        await api(`/api/programs/${modal.row!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/programs", { method: "POST", body: JSON.stringify(payload) });
      }
      setModal(null);
      await load();
    } catch (e: any) {
      // Server message verbatim — e.g. a duplicate code (409) or a bad duration.
      setError(e?.message || "Could not save the programme");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: ProgramRow) => {
    if (!confirm(`Delete programme "${row.name}"?`)) return;
    setError("");
    try {
      await api(`/api/programs/${row.id}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not delete the programme");
    }
  };

  if (meLoading) return <LoadingScreen />;

  if (!college && !me) {
    return (
      <div>
        <PageHeader title="Programmes" subtitle="Degrees and diplomas offered by your college" />
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
        <PageHeader icon={Layers} title="Programmes" subtitle="Degrees and diplomas offered by your college" />
        <Card>
          <EmptyState
            icon={Layers}
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
        icon={Layers}
        title="Programmes"
        subtitle={`${rows.length} programme${rows.length === 1 ? "" : "s"} · degrees and diplomas offered by your college`}
        actions={
          canManage ? (
            <button className="btn btn-primary btn-sm" onClick={openCreate}>
              <Plus size={15} /> New Programme
            </button>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Department" className="w-full sm:w-72">
          <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.status === "INACTIVE" ? " (inactive)" : ""}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No programmes yet"
            description="Create a programme under a department to describe what your college offers."
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-bold text-slate-800">{p.name}</span>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">
                      {p.code}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                    <span>{p.departmentName || "—"}</span>
                    <span>
                      {prettyStatus(p.degreeLevel)} · {p.durationYears} year
                      {p.durationYears === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>

                <Badge tone={statusTone(p.status)}>{prettyStatus(p.status)}</Badge>

                {canManage && (
                  <div className="flex items-center gap-1">
                    <button className="btn btn-secondary btn-sm" onClick={() => openEdit(p)}>
                      <Pencil size={13} /> Edit
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => remove(p)}>
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
        title={modal?.mode === "edit" ? "Edit programme" : "New programme"}
      >
        <div className="space-y-4">
          <Field label="Programme name">
            <TextInput
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. BSc in Computer Science"
            />
          </Field>
          <Field label="Code" hint="Short unique code, e.g. BSC-CS. Unique within this institution.">
            <TextInput
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="e.g. BSC-CS"
            />
          </Field>

          <Field label="Department" hint="Only active departments can take a new programme.">
            <Select
              value={form.departmentId}
              onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
            >
              <option value="">— select a department —</option>
              {departmentOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.status === "INACTIVE" ? " (inactive)" : ""}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Degree level">
              <Select
                value={form.degreeLevel}
                onChange={(e) => {
                  const degreeLevel = e.target.value;
                  const suggested = SUGGESTED_YEARS[degreeLevel];
                  setForm((prev) => ({
                    ...prev,
                    degreeLevel,
                    // A suggestion, still editable afterwards.
                    durationYears: suggested ?? prev.durationYears,
                  }));
                }}
              >
                {DEGREE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {prettyStatus(level)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Duration (years)" hint="1–6">
              <TextInput
                type="number"
                min={1}
                max={6}
                value={form.durationYears}
                onChange={(e) => setForm({ ...form, durationYears: Number(e.target.value) })}
              />
            </Field>
          </div>

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
              disabled={
                saving ||
                !form.name.trim() ||
                !form.code.trim() ||
                !form.departmentId ||
                !(form.durationYears >= 1 && form.durationYears <= 6)
              }
            >
              {modal?.mode === "edit" ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
