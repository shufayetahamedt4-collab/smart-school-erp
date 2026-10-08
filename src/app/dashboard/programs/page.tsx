"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Layers, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, qs } from "@/lib/client";
import { hasCollege, normalizeInstitutionType } from "@/lib/institution";
import { can } from "@/lib/permissions";
import { termCount, termLabels } from "@/lib/college-terms";
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
  Spinner,
  TextInput,
  prettyStatus,
  statusTone,
} from "@/components/ui";

/**
 * College support (Phase 2f, extended by 3d) — Programmes.
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
 * here.
 *
 * Phase 3d adds the term model to this page:
 *   - `termSystem` (YEARLY | SEMESTER, default YEARLY) on create/edit, with the
 *     DERIVED term count shown live from `@/lib/college-terms` — the same helper
 *     the API uses, so the page can never offer a term the API rejects;
 *   - a curriculum panel per programme: the term-by-term list of its mapped
 *     courses (`/api/programs/[id]/courses`), with add/remove for a manager.
 *
 * The term system of a programme that already has mappings is frozen by the
 * server (409). Rather than guess, this page lets the request fail and disables
 * the control with the server's own explanation — the mapping list is the source
 * of truth, and the page never has to keep a second copy of it.
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
  /** YEARLY | SEMESTER — the API normalises a missing value to YEARLY. */
  termSystem: string;
  /** Derived by the API: durationYears × (YEARLY 1, SEMESTER 2). */
  termCount: number;
  status: string;
}

interface DepartmentRow {
  id: string;
  name: string;
  code: string;
  status: string;
}

interface CourseRow {
  id: string;
  code: string;
  title: string;
  creditHours: number | null;
  type: string;
  status: string;
}

/** One programme→course mapping, as the curriculum route returns it. */
interface MappingRow {
  id: string;
  courseId: string;
  termNumber: number;
  termLabel: string;
  requirement: string;
  courseCode: string | null;
  courseTitle: string | null;
  creditHours: number | null;
  type: string | null;
}

/** The degree levels Phase 2 supports (mirrors the API's enum). */
const DEGREE_LEVELS = ["HSC", "DEGREE_PASS", "HONOURS", "MASTERS", "DIPLOMA"] as const;

/** The term systems the API accepts (mirrors `@/lib/college-terms`). */
const TERM_SYSTEMS = ["YEARLY", "SEMESTER"] as const;

/** How a mapped course counts towards its programme. */
const REQUIREMENTS = ["REQUIRED", "ELECTIVE"] as const;

/**
 * Suggested length per level, applied when the level is chosen. The field stays
 * editable (1–6) — this is a convenience, never a validation rule. DIPLOMA is a
 * 2-year ladder (docs/COLLEGE-DECISIONS.md §10).
 */
const SUGGESTED_YEARS: Record<string, number> = {
  HSC: 2,
  DEGREE_PASS: 3,
  HONOURS: 4,
  MASTERS: 1,
  DIPLOMA: 2,
};

const emptyForm = {
  name: "",
  code: "",
  departmentId: "",
  degreeLevel: "HSC" as string,
  durationYears: SUGGESTED_YEARS.HSC,
  termSystem: "YEARLY" as string,
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
  /**
   * Set when the SERVER refused a term-system change (409: the programme already
   * has mappings). The control is then disabled with the server's explanation —
   * the page trusts the API instead of trying to mirror the mapping table.
   */
  const [termLocked, setTermLocked] = useState<string>("");

  /** The one curriculum panel that can be open at a time. */
  const [cur, setCur] = useState<{
    id: string;
    loading: boolean;
    rows: MappingRow[];
    error: string;
  } | null>(null);
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [add, setAdd] = useState({ courseId: "", termNumber: 1, requirement: "REQUIRED" });
  const [mappingBusy, setMappingBusy] = useState(false);

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

  const loadCurriculum = useCallback(async (programId: string) => {
    setCur({ id: programId, loading: true, rows: [], error: "" });
    try {
      const mappings = await api<MappingRow[]>(`/api/programs/${programId}/courses`);
      setCur({ id: programId, loading: false, rows: mappings, error: "" });
    } catch (e: any) {
      setCur({ id: programId, loading: false, rows: [], error: e?.message || "Could not load the curriculum" });
    }
  }, []);

  const openCurriculum = async (program: ProgramRow) => {
    if (cur?.id === program.id) {
      setCur(null);
      return;
    }
    setError("");
    setAdd({ courseId: "", termNumber: 1, requirement: "REQUIRED" });
    await loadCurriculum(program.id);
    // Only a manager can add, so only a manager needs the course list.
    if (canManage && courses.length === 0) {
      try {
        setCourses(await api<CourseRow[]>("/api/courses"));
      } catch {
        /* the panel still shows the existing mappings */
      }
    }
  };

  const addMapping = async (program: ProgramRow) => {
    if (!add.courseId) return;
    setCur((c) => (c ? { ...c, error: "" } : c));
    setMappingBusy(true);
    try {
      await api(`/api/programs/${program.id}/courses`, {
        method: "POST",
        body: JSON.stringify({
          courseId: add.courseId,
          termNumber: add.termNumber,
          requirement: add.requirement,
        }),
      });
      setAdd({ courseId: "", termNumber: 1, requirement: "REQUIRED" });
      await loadCurriculum(program.id);
    } catch (e: any) {
      setCur((c) => (c ? { ...c, error: e?.message || "Could not add the course" } : c));
    } finally {
      setMappingBusy(false);
    }
  };

  const removeMapping = async (program: ProgramRow, mappingId: string) => {
    setCur((c) => (c ? { ...c, error: "" } : c));
    setMappingBusy(true);
    try {
      await api(`/api/programs/${program.id}/courses?mappingId=${encodeURIComponent(mappingId)}`, {
        method: "DELETE",
      });
      await loadCurriculum(program.id);
    } catch (e: any) {
      setCur((c) => (c ? { ...c, error: e?.message || "Could not remove the course" } : c));
    } finally {
      setMappingBusy(false);
    }
  };

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
    setTermLocked("");
    setForm({ ...emptyForm, departmentId: filter || departmentOptions[0]?.id || "" });
    setModal({ mode: "create" });
  };

  const openEdit = (row: ProgramRow) => {
    setError("");
    setTermLocked("");
    setForm({
      name: row.name,
      code: row.code,
      departmentId: row.departmentId,
      degreeLevel: row.degreeLevel,
      durationYears: row.durationYears,
      termSystem: row.termSystem === "SEMESTER" ? "SEMESTER" : "YEARLY",
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
        termSystem: form.termSystem,
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
      // Server message verbatim — e.g. a duplicate code (409), a bad duration, or
      // the 409 that freezes the term system while courses are mapped. Only the
      // last one disables the control, and it does so with the server's words.
      const message = e?.message || "Could not save the programme";
      setError(message);
      if (e?.status === 409 && /term system/i.test(message)) setTermLocked(message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: ProgramRow) => {
    if (!confirm(`Delete programme "${row.name}"?`)) return;
    setError("");
    try {
      await api(`/api/programs/${row.id}`, { method: "DELETE" });
      if (cur?.id === row.id) setCur(null);
      await load();
    } catch (e: any) {
      // "Cannot delete a program that still has courses mapped to it." lands here.
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

  const formTermCount = termCount(form.durationYears, form.termSystem);

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
              <div key={p.id}>
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
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
                      <span>
                        {prettyStatus(p.termSystem)} · {p.termCount} term{p.termCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>

                  <Badge tone={statusTone(p.status)}>{prettyStatus(p.status)}</Badge>

                  <button className="btn btn-secondary btn-sm" onClick={() => openCurriculum(p)}>
                    {cur?.id === p.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />} Curriculum
                  </button>

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

                {cur?.id === p.id && (
                  <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        Curriculum · {p.termCount} term{p.termCount === 1 ? "" : "s"}
                      </span>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setCur(null)}
                        aria-label="Close curriculum"
                      >
                        <X size={13} />
                      </button>
                    </div>

                    {cur.error && (
                      <div className="mb-3">
                        <ErrorNote message={cur.error} />
                      </div>
                    )}

                    {cur.loading ? (
                      <div className="py-3">
                        <Spinner />
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {termLabels(p.durationYears, p.termSystem).map((label, i) => {
                          const termNumber = i + 1;
                          const inTerm = cur.rows
                            .filter((m) => m.termNumber === termNumber)
                            .sort((a, b) => String(a.courseCode).localeCompare(String(b.courseCode)));
                          return (
                            <div key={termNumber}>
                              <div className="mb-1 text-[11px] font-semibold text-slate-600">{label}</div>
                              {inTerm.length === 0 ? (
                                <div className="text-[11px] italic text-slate-400">No courses mapped.</div>
                              ) : (
                                <div className="space-y-1">
                                  {inTerm.map((m) => (
                                    <div
                                      key={m.id}
                                      className="flex flex-wrap items-center gap-2 rounded-md bg-white px-2.5 py-1.5"
                                    >
                                      <span className="font-mono text-[11px] font-semibold text-slate-600">
                                        {m.courseCode || "—"}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate text-xs text-slate-700">
                                        {m.courseTitle || m.courseId}
                                      </span>
                                      <span className="text-[11px] text-slate-500">
                                        {m.creditHours === null || m.creditHours === undefined
                                          ? "No credits"
                                          : `${m.creditHours} cr`}
                                      </span>
                                      <Badge tone={m.requirement === "ELECTIVE" ? "amber" : "indigo"}>
                                        {prettyStatus(m.requirement)}
                                      </Badge>
                                      {canManage && (
                                        <button
                                          className="btn btn-secondary btn-sm"
                                          disabled={mappingBusy}
                                          onClick={() => removeMapping(p, m.id)}
                                        >
                                          <Trash2 size={12} /> Remove
                                        </button>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {canManage && (
                      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3">
                        <Field label="Course" className="w-full sm:w-64">
                          <Select
                            value={add.courseId}
                            onChange={(e) => setAdd({ ...add, courseId: e.target.value })}
                          >
                            <option value="">— select a course —</option>
                            {courses
                              .filter((c) => c.status !== "INACTIVE")
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.code} · {c.title}
                                </option>
                              ))}
                          </Select>
                        </Field>
                        <Field label="Term" className="w-full sm:w-40">
                          <Select
                            value={String(add.termNumber)}
                            onChange={(e) => setAdd({ ...add, termNumber: Number(e.target.value) })}
                          >
                            {termLabels(p.durationYears, p.termSystem).map((label, i) => (
                              <option key={i + 1} value={i + 1}>
                                {label}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Requirement" className="w-full sm:w-40">
                          <Select
                            value={add.requirement}
                            onChange={(e) => setAdd({ ...add, requirement: e.target.value })}
                          >
                            {REQUIREMENTS.map((r) => (
                              <option key={r} value={r}>
                                {prettyStatus(r)}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={mappingBusy || !add.courseId}
                          onClick={() => addMapping(p)}
                        >
                          <Plus size={13} /> Add to term
                        </button>
                      </div>
                    )}

                    {!canManage && (
                      <div className="mt-3 text-[11px] italic text-slate-400">
                        You have read-only access to this curriculum.
                      </div>
                    )}
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

          <Field
            label="Term system"
            hint={
              termLocked
                ? undefined
                : `Derived: ${formTermCount} term${formTermCount === 1 ? "" : "s"} · ${termLabels(
                    form.durationYears,
                    form.termSystem
                  ).join(", ") || "—"}`
            }
          >
            <Select
              value={form.termSystem}
              disabled={!!termLocked}
              onChange={(e) => setForm({ ...form, termSystem: e.target.value })}
            >
              {TERM_SYSTEMS.map((t) => (
                <option key={t} value={t}>
                  {t === "YEARLY" ? "Yearly (1 term per year)" : "Semester (2 terms per year)"}
                </option>
              ))}
            </Select>
          </Field>
          {termLocked && <p className="text-[11px] text-amber-600">{termLocked}</p>}

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
