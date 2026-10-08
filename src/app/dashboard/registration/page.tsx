"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ClipboardList, Plus, Search, X } from "lucide-react";
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
 * College support (Phase 4c) — course registration and approval.
 *
 * COLLEGE-ONLY, and it says so BEFORE it reads anything: the tenant shape comes
 * from the same source the Shell uses (`me.school.institutionType ??
 * me.institutionType`), and the read effect returns before issuing any request
 * when the tenant has no college — so a school admin who types the URL directly
 * gets the refusal and **no call to `/api/course-registrations`, `/api/courses`
 * or `/api/students`**. The same holds for a college tenant whose role has no
 * `registration` permission (Q3): the page refuses before the network.
 *
 * The API remains the real gate (`requireCollege()` + `can(role, "registration")`
 * in every handler); these checks are UX, fail-closed.
 *
 * A registration is a student's place in ONE mapped course of ONE term. The
 * server DERIVES the programme and term from the student and the programme's
 * programme→course mapping, so the create flow picks a student, loads only that
 * student's programme's mapped courses, and sends `{ studentId, courseId }` — the
 * term on the screen is the mapping's term, never an input.
 *
 * PENDING rows may be approved, rejected or withdrawn; APPROVED and REJECTED are
 * terminal (the server answers 409), so the row shows no action once decided.
 * Every server message (duplicate 409, "not mapped" 400, "already been decided"
 * 409, "only a pending registration can be withdrawn" 409) is shown verbatim —
 * the message, not the status, is what tells the user which guard fired.
 *
 * A row whose student or course no longer exists is still readable: the API
 * returns `studentName: null` and `courseAvailable: false`, and the row is shown
 * as unavailable with its actions disabled (never a crash).
 */

interface RegistrationRow {
  id: string;
  studentId: string;
  courseId: string;
  programId: string;
  termNumber: number;
  status: string;
  /** Joined by the API; `null` when the course is gone (dangling). */
  courseCode: string | null;
  courseTitle: string | null;
  creditHours: number | null;
  courseAvailable: boolean;
  /** Joined by the API; `null` when the student is gone (dangling). */
  studentName: string | null;
  studentAdmissionNo: string | null;
  programName: string | null;
}

/** Only the three fields the picker renders (Q2). */
interface StudentLite {
  id: string;
  name: string;
  admissionNo: string;
  programId?: string | null;
}

/** A programme→course mapping row (from `GET /api/programs/[id]/courses`). */
interface MappedCourse {
  id: string;
  courseId: string;
  termNumber: number;
  termLabel: string;
  requirement: string;
  courseCode: string | null;
  courseTitle: string | null;
}

const STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;

export default function RegistrationPage() {
  const { me, loading: meLoading, error: meError } = useMe();

  const institutionType = me?.school?.institutionType ?? me?.institutionType ?? null;
  const college = hasCollege(normalizeInstitutionType(institutionType));
  const role = me?.user?.role;
  const canView = can(role, "registration", "view");
  const canManage = can(role, "registration", "full");

  const [rows, setRows] = useState<RegistrationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  // Filters — all applied in memory over the (already tenant/branch-scoped) list.
  const [programFilter, setProgramFilter] = useState("");
  const [termFilter, setTermFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");

  // Create modal.
  const [modal, setModal] = useState(false);
  const [studentQuery, setStudentQuery] = useState("");
  const [students, setStudents] = useState<StudentLite[]>([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [picked, setPicked] = useState<StudentLite | null>(null);
  const [mapped, setMapped] = useState<MappedCourse[]>([]);
  const [mappedLoading, setMappedLoading] = useState(false);
  const [courseId, setCourseId] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => api<RegistrationRow[]>("/api/course-registrations").then(setRows), []);

  useEffect(() => {
    // NO read before the gate resolves: a still-loading session waits, a
    // non-college tenant never reaches the network, and a role without the
    // permission is refused with zero calls too.
    if (meLoading || !college || !canView) return;
    let alive = true;
    setLoading(true);
    load()
      .catch((e: any) => {
        if (alive) setError(e?.message || "Could not load registrations");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [meLoading, college, canView, load]);

  // Student picker — reuses `GET /api/students` (tenant + branch scoped). Only
  // fires while the modal is open, i.e. after the college gate has passed.
  useEffect(() => {
    if (!modal) return;
    let alive = true;
    setStudentsLoading(true);
    const t = setTimeout(() => {
      api<StudentLite[]>(`/api/students?q=${encodeURIComponent(studentQuery.trim())}`)
        .then((data) => {
          if (alive) setStudents(data.slice(0, 8));
        })
        .catch(() => {
          if (alive) setStudents([]);
        })
        .finally(() => {
          if (alive) setStudentsLoading(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [modal, studentQuery]);

  // When a student is picked, load ONLY their programme's mapped courses.
  useEffect(() => {
    if (!picked?.programId) {
      setMapped([]);
      setCourseId("");
      return;
    }
    let alive = true;
    setMappedLoading(true);
    api<MappedCourse[]>(`/api/programs/${picked.programId}/courses`)
      .then((data) => {
        if (alive) setMapped(data);
      })
      .catch((e: any) => {
        if (alive) setError(e?.message || "Could not load the programme's courses");
      })
      .finally(() => {
        if (alive) setMappedLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [picked]);

  const programs = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.programId) m.set(r.programId, r.programName || "—");
    return [...m].map(([id, name]) => ({ id, name }));
  }, [rows]);

  const terms = useMemo(
    () => [...new Set(rows.map((r) => r.termNumber).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b),
    [rows]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!programFilter || r.programId === programFilter) &&
        (!termFilter || String(r.termNumber) === termFilter) &&
        (!statusFilter || r.status === statusFilter) &&
        (!q ||
          (r.studentName || "").toLowerCase().includes(q) ||
          (r.studentAdmissionNo || "").toLowerCase().includes(q))
    );
  }, [rows, programFilter, termFilter, statusFilter, search]);

  const openCreate = () => {
    setError("");
    setStudentQuery("");
    setStudents([]);
    setPicked(null);
    setMapped([]);
    setCourseId("");
    setModal(true);
  };

  const submit = async () => {
    if (!picked || !courseId) return;
    setError("");
    setSaving(true);
    try {
      // programId and term are DERIVED server-side — the client sends neither.
      await api("/api/course-registrations", {
        method: "POST",
        body: JSON.stringify({ studentId: picked.id, courseId }),
      });
      setModal(false);
      await load();
    } catch (e: any) {
      // e.g. "This student is already registered for that course in that term."
      // or "This course is not mapped to the student's programme."
      setError(e?.message || "Could not create the registration");
    } finally {
      setSaving(false);
    }
  };

  const decide = async (row: RegistrationRow, status: "APPROVED" | "REJECTED") => {
    setError("");
    setBusyId(row.id);
    try {
      await api(`/api/course-registrations/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await load();
    } catch (e: any) {
      // e.g. "This registration has already been decided." (409)
      setError(e?.message || "Could not update the registration");
    } finally {
      setBusyId(null);
    }
  };

  const withdraw = async (row: RegistrationRow) => {
    if (!confirm(`Withdraw the registration for "${row.studentName ?? "this student"}"?`)) return;
    setError("");
    setBusyId(row.id);
    try {
      await api(`/api/course-registrations/${row.id}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      // e.g. "Only a pending registration can be withdrawn." (409)
      setError(e?.message || "Could not withdraw the registration");
    } finally {
      setBusyId(null);
    }
  };

  if (meLoading) return <LoadingScreen />;

  if (!college && !me) {
    return (
      <div>
        <PageHeader title="Registration" subtitle="Course registration and approval" />
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
        <PageHeader icon={ClipboardList} title="Registration" subtitle="Course registration and approval" />
        <Card>
          <EmptyState
            icon={ClipboardList}
            title="Available to college institutions only"
            description="This institution runs the school curriculum. Course registration is part of the college setup."
          />
        </Card>
      </div>
    );
  }

  if (!canView) {
    return (
      <div>
        <PageHeader icon={ClipboardList} title="Registration" subtitle="Course registration and approval" />
        <Card>
          <EmptyState
            icon={ClipboardList}
            title="Not available for your role"
            description="Course registration is handled by the school administration and the registrar."
          />
        </Card>
      </div>
    );
  }

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader
        icon={ClipboardList}
        title="Registration"
        subtitle={`${visible.length} registration${visible.length === 1 ? "" : "s"} · a student's place in a programme's mapped courses`}
        actions={
          canManage ? (
            <button className="btn btn-primary btn-sm" onClick={openCreate}>
              <Plus size={15} /> New Registration
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
        <Field label="Programme" className="w-full sm:w-56">
          <Select value={programFilter} onChange={(e) => setProgramFilter(e.target.value)}>
            <option value="">All programmes</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Term" className="w-full sm:w-40">
          <Select value={termFilter} onChange={(e) => setTermFilter(e.target.value)}>
            <option value="">All terms</option>
            {terms.map((t) => (
              <option key={t} value={String(t)}>
                Term {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" className="w-full sm:w-44">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {prettyStatus(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Student" className="w-full sm:w-64">
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or admission no"
          />
        </Field>
      </div>

      <Card>
        {visible.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No registrations"
            description="Create a registration to place a student in a course of their programme."
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {visible.map((r) => {
              const unavailable = !r.courseAvailable;
              return (
                <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-bold text-slate-800">
                        {r.studentName ?? "— (student deleted)"}
                      </span>
                      {r.studentAdmissionNo && (
                        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">
                          {r.studentAdmissionNo}
                        </span>
                      )}
                      {unavailable && <Badge tone="danger">Course unavailable</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                      <span>{r.courseTitle ?? r.courseCode ?? "—"}</span>
                      <span>Term {r.termNumber}</span>
                      <span>{r.programName ?? "—"}</span>
                    </div>
                  </div>

                  <Badge tone={statusTone(r.status)}>{prettyStatus(r.status)}</Badge>

                  {canManage && r.status === "PENDING" && !unavailable && (
                    <div className="flex items-center gap-1">
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busyId === r.id}
                        onClick={() => decide(r, "APPROVED")}
                      >
                        <Check size={13} /> Approve
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busyId === r.id}
                        onClick={() => decide(r, "REJECTED")}
                      >
                        <X size={13} /> Reject
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busyId === r.id}
                        onClick={() => withdraw(r)}
                      >
                        Withdraw
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal open={modal} onClose={() => setModal(false)} title="New registration">
        <div className="space-y-4">
          <Field label="Student" hint="Search the school roll; only the name, admission number and programme are used here.">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <TextInput
                className="pl-8"
                value={studentQuery}
                onChange={(e) => setStudentQuery(e.target.value)}
                placeholder="Type a name or admission number"
              />
            </div>
          </Field>

          {picked ? (
            <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-800">{picked.name}</div>
                <div className="font-mono text-[11px] text-slate-500">{picked.admissionNo}</div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setPicked(null)}>
                Change
              </button>
            </div>
          ) : (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
              {studentsLoading ? (
                <div className="px-3 py-4 text-center text-xs text-slate-400">Searching…</div>
              ) : students.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-slate-400">No students found</div>
              ) : (
                students.map((s) => (
                  <button
                    key={s.id}
                    className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50"
                    onClick={() => setPicked(s)}
                  >
                    <span className="truncate text-sm text-slate-700">{s.name}</span>
                    <span className="ml-3 shrink-0 font-mono text-[11px] text-slate-500">{s.admissionNo}</span>
                  </button>
                ))
              )}
            </div>
          )}

          {picked && !picked.programId && (
            <ErrorNote message="This student is not enrolled in a programme. Enrol them first, then register their courses." />
          )}

          {picked?.programId && (
            <Field label="Course" hint="Only courses mapped to the student's programme are listed; the term comes from the mapping.">
              {mappedLoading ? (
                <div className="px-3 py-2 text-xs text-slate-400">Loading courses…</div>
              ) : mapped.length === 0 ? (
                <div className="px-3 py-2 text-xs text-slate-400">
                  This programme has no mapped courses yet.
                </div>
              ) : (
                <Select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                  <option value="">— select a course —</option>
                  {mapped.map((m) => (
                    <option key={m.id} value={m.courseId}>
                      {m.courseCode ? `${m.courseCode} · ` : ""}
                      {m.courseTitle ?? "Course"} · Term {m.termNumber}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setModal(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={submit} disabled={saving || !picked?.programId || !courseId}>
              Create
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
