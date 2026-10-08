"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
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
 * College support (Phase 3d) — the course catalogue.
 *
 * COLLEGE-ONLY, and it says so before it reads anything: the tenant shape comes
 * from the same source the Shell uses (`me.school.institutionType ??
 * me.institutionType`), and the read effect returns BEFORE issuing any request
 * when the tenant has no college — so a school admin who types the URL directly
 * gets the refusal and **no call to `/api/courses`**.
 *
 * The API remains the real gate (`requireCollege()` in every handler); this
 * check is UX, fail-closed.
 *
 * A course is a catalogue row under ONE department and inherits that
 * department's branch, so there is no branch control here — the same rule the
 * programmes page follows. `creditHours` is optional (honours/masters carry
 * credits, HSC usually none) and is sent as `null` when left blank.
 *
 * Deleting a course that is mapped to a programme is refused by the server with
 * 400; its message is shown verbatim so the user learns to remove the mapping
 * first (the message, not the status, is what tells them which guard fired).
 */

interface CourseRow {
  id: string;
  code: string;
  title: string;
  /** Optional: `null` when the course carries no credits. */
  creditHours: number | null;
  type: string;
  status: string;
  departmentId: string;
  /** Resolved by the API from the same tenant's departments. */
  departmentName: string | null;
}

interface DepartmentRow {
  id: string;
  name: string;
  code: string;
  status: string;
}

/** The course types the API accepts (mirrors its enum). */
const COURSE_TYPES = ["THEORY", "PRACTICAL"] as const;

const emptyForm = {
  code: "",
  title: "",
  /** Kept as a string so "blank" (no credits) is distinguishable from 0. */
  creditHours: "",
  type: "THEORY" as string,
  departmentId: "",
  status: "ACTIVE",
};

export default function CoursesPage() {
  const { me, loading: meLoading, error: meError } = useMe();

  const institutionType = me?.school?.institutionType ?? me?.institutionType ?? null;
  const college = hasCollege(normalizeInstitutionType(institutionType));
  const role = me?.user?.role;
  const canManage = can(role, "courses", "full");

  const [rows, setRows] = useState<CourseRow[]>([]);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<{ mode: "create" | "edit"; row?: CourseRow } | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () => api<CourseRow[]>(`/api/courses${qs({ departmentId: filter || undefined })}`).then(setRows),
    [filter]
  );

  useEffect(() => {
    // NO read before the gate resolves: a still-loading session must wait, and a
    // tenant without a college must never reach the network at all.
    if (meLoading || !college) return;
    let alive = true;
    setLoading(true);
    Promise.all([
      api<CourseRow[]>(`/api/courses${qs({ departmentId: filter || undefined })}`).then((data) => {
        if (alive) setRows(data);
      }),
      api<DepartmentRow[]>("/api/departments").then((data) => {
        if (alive) setDepartments(data);
      }),
    ])
      .catch((e: any) => {
        if (alive) setError(e?.message || "Could not load courses");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [meLoading, college, filter]);

  // The modal may only offer ACTIVE departments — except the course's own
  // department while editing it, which stays selectable even once inactive, or
  // editing an older course would silently move it.
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

  const openEdit = (row: CourseRow) => {
    setError("");
    setForm({
      code: row.code,
      title: row.title,
      creditHours: row.creditHours === null || row.creditHours === undefined ? "" : String(row.creditHours),
      type: row.type === "PRACTICAL" ? "PRACTICAL" : "THEORY",
      departmentId: row.departmentId,
      status: row.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    });
    setModal({ mode: "edit", row });
  };

  const save = async () => {
    if (!modal) return;
    setError("");
    setSaving(true);
    try {
      const credits = form.creditHours.trim();
      const payload: Record<string, unknown> = {
        code: form.code.trim(),
        title: form.title.trim(),
        // An empty field means "no credits" and must travel as null, not "" —
        // the API reads null as an explicit "none".
        creditHours: credits === "" ? null : Number(credits),
        type: form.type,
        departmentId: form.departmentId,
      };
      if (modal.mode === "edit") {
        payload.status = form.status;
        await api(`/api/courses/${modal.row!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/courses", { method: "POST", body: JSON.stringify(payload) });
      }
      setModal(null);
      await load();
    } catch (e: any) {
      // Server message verbatim — e.g. a duplicate code (409) or bad credits.
      setError(e?.message || "Could not save the course");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: CourseRow) => {
    if (!confirm(`Delete course "${row.title}"?`)) return;
    setError("");
    try {
      await api(`/api/courses/${row.id}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      // "Cannot delete a course that is mapped to a program." lands here.
      setError(e?.message || "Could not delete the course");
    }
  };

  if (meLoading) return <LoadingScreen />;

  if (!college && !me) {
    return (
      <div>
        <PageHeader title="Courses" subtitle="The course catalogue of your college" />
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
        <PageHeader icon={BookOpen} title="Courses" subtitle="The course catalogue of your college" />
        <Card>
          <EmptyState
            icon={BookOpen}
            title="Available to college institutions only"
            description="This institution runs the school curriculum. The course catalogue is part of the college setup."
          />
        </Card>
      </div>
    );
  }

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader
        icon={BookOpen}
        title="Courses"
        subtitle={`${rows.length} course${rows.length === 1 ? "" : "s"} · the catalogue your programmes map into terms`}
        actions={
          canManage ? (
            <button className="btn btn-primary btn-sm" onClick={openCreate}>
              <Plus size={15} /> New Course
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
            icon={BookOpen}
            title="No courses yet"
            description="Create a course under a department, then map it into a programme's terms."
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-bold text-slate-800">{c.title}</span>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">
                      {c.code}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                    <span>{c.departmentName || "—"}</span>
                    <span>{prettyStatus(c.type)}</span>
                    <span>
                      {c.creditHours === null || c.creditHours === undefined
                        ? "No credits"
                        : `${c.creditHours} credit${c.creditHours === 1 ? "" : "s"}`}
                    </span>
                  </div>
                </div>

                <Badge tone={statusTone(c.status)}>{prettyStatus(c.status)}</Badge>

                {canManage && (
                  <div className="flex items-center gap-1">
                    <button className="btn btn-secondary btn-sm" onClick={() => openEdit(c)}>
                      <Pencil size={13} /> Edit
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => remove(c)}>
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
        title={modal?.mode === "edit" ? "Edit course" : "New course"}
      >
        <div className="space-y-4">
          <Field label="Course title">
            <TextInput
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. Introduction to Programming"
            />
          </Field>
          <Field label="Code" hint="Short unique code, e.g. CSE-101. Unique within this institution.">
            <TextInput
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="e.g. CSE-101"
            />
          </Field>

          <Field label="Department" hint="Only active departments can take a new course.">
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
            <Field label="Type">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {COURSE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {prettyStatus(t)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Credit hours" hint="Optional — leave blank for none.">
              <TextInput
                type="number"
                min={0}
                step="0.5"
                value={form.creditHours}
                onChange={(e) => setForm({ ...form, creditHours: e.target.value })}
                placeholder="e.g. 3"
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
              disabled={saving || !form.title.trim() || !form.code.trim() || !form.departmentId}
            >
              {modal?.mode === "edit" ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
