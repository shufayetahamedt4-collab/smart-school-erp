"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, ClipboardList, Save } from "lucide-react";
import { api, qs } from "@/lib/client";
import { hasCollege, normalizeInstitutionType } from "@/lib/institution";
import { can } from "@/lib/permissions";
import { canReadCollegeAttendance, canWriteCollegeAttendance } from "@/lib/college-attendance-access";
import { useMe } from "@/components/Shell";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Field,
  LoadingScreen,
  PageHeader,
  Select,
  TextInput,
  prettyStatus,
  statusTone,
} from "@/components/ui";
import { todayISO } from "@/lib/utils";
import {
  ATTENDANCE_ENDPOINT,
  NO_COLLEGE_NOTE,
  PAGE_ERRORS,
  PICK_COURSE_NOTE,
  READ_ONLY_NOTE,
  REFUSED_NOTE,
  SLOT_HINT,
  courseLabel,
  editableRows,
  markTone,
  markedCountText,
  noRosterNote,
  pageError,
  rosterCountText,
  rowsToSave,
  saveButtonLabel,
  saveMessage,
  slotFromInput,
  statusLabel,
  statusOptions,
  summaryCells,
  withRemark,
  withStatus,
  type EditableRow,
  type RegisterRow,
  type RegisterSummary,
} from "@/lib/college-attendance-view";

/**
 * College support (Phase 8 ca-4) — the COURSE REGISTER screen
 * (docs/COLLEGE-DECISIONS.md §24.8, D-CA-1…D-CA-4, §29's API, §30).
 *
 * The screen over the ca-3 API: one course × one date × one slot, its APPROVED
 * roster, the four statuses, and one save. It reads and writes nothing else.
 *
 * COLLEGE-ONLY, and it says so BEFORE it reads anything: the tenant shape comes
 * from the same source the Shell uses (`me.school.institutionType ??
 * me.institutionType`), and every read effect returns before issuing a request
 * when the tenant has no college — so a school admin who types the URL gets the
 * refusal and no call to `/api/courses` or `/api/course-attendance`. The API
 * remains the real gate (`requireCollege()` + ca-0's allow-list in every handler);
 * these checks are UX, fail-closed.
 *
 * **The roster is the SERVER's** (D-CA-2). The grid renders what
 * `GET /api/course-attendance` served — a student with no APPROVED registration
 * for the course cannot appear, and the save payload is built by `rowsToSave`,
 * which can only return rows it was handed. Nothing on this screen invents,
 * filters or widens a student list.
 *
 * **The vocabulary is ca-1's** (D-CA-3): the four statuses come from
 * `src/lib/college-attendance.ts` through `college-attendance-view.ts`, so this
 * file carries no status literal at all — a fifth value is not expressible here.
 *
 * **v1 is staff-only** (D-CA-4, Q8, and ca-0's rule): the roles that may READ are
 * the admin-level ones plus the REGISTRAR, and only the admin-level ones may mark.
 * A REGISTRAR therefore sees the register read-only (`canWriteCollegeAttendance`),
 * and a TEACHER — linked to the course by 8-pre but refused by ca-0 in v1 (§29) —
 * sees the refusal and issues no request. The nav entry exists for exactly the
 * READ roles that own a dashboard nav.
 *
 * **Saving notifies only a NEW absence** (D-CA-3), decided by the SERVER: this
 * screen reports what the save says it did (`saveMessage`) and never decides who
 * to notify.
 */

/** One course, as `GET /api/courses` serves it (only the fields used here). */
interface CourseLite {
  id: string;
  code: string;
  title: string;
  creditHours?: number | null;
}

/** The register read's payload, as `GET /api/course-attendance` serves it. */
interface RegisterPayload {
  course: CourseLite | null;
  dateKey: string;
  slot: number;
  rows: RegisterRow[];
  summary: RegisterSummary;
}

/** The save's payload, as `POST /api/course-attendance` answers. */
interface SavePayload {
  written: number;
  skipped: number;
  newlyAbsent: string[];
  slot: number;
}

export default function CourseAttendancePage() {
  const { me, loading: meLoading } = useMe();

  const institutionType = me?.school?.institutionType ?? me?.institutionType ?? null;
  const college = hasCollege(normalizeInstitutionType(institutionType));
  const role = me?.user?.role;
  // The READ rule is ca-0's own, through the same pure helper the API wraps, so
  // the sidebar, this screen and the route cannot disagree (6d-fix's precedent).
  const canView = can(role, "attendanceMarks", "view") && canReadCollegeAttendance(role);
  // MARKING is narrower: the REGISTRAR reads and may never save (ca-0's WRITE list).
  const canMark = canWriteCollegeAttendance(role);
  const ready = !meLoading && college && canView;

  const [courses, setCourses] = useState<CourseLite[]>([]);
  const [courseId, setCourseId] = useState("");
  const [date, setDate] = useState(todayISO());
  const [slotInput, setSlotInput] = useState("1");
  const slot = slotFromInput(slotInput);

  const [course, setCourse] = useState<CourseLite | null>(null);
  const [dateKey, setDateKey] = useState("");
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [summary, setSummary] = useState<RegisterSummary | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  /** The session the grid currently shows, so a stale save cannot re-label it. */
  const [loadedKey, setLoadedKey] = useState("");

  // The courses this caller may mark — the API's own list, never a client filter.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    api<CourseLite[]>("/api/courses")
      .then((cs) => {
        if (!alive) return;
        const list = cs || [];
        setCourses(list);
        setCourseId((current) => current || (list[0]?.id ?? ""));
      })
      .catch((e: unknown) => {
        if (alive) setError(pageError(e, PAGE_ERRORS.courses));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ready]);

  const loadRegister = useCallback(async () => {
    if (!ready || !courseId || slot === null) return;
    setLoading(true);
    setError("");
    const key = `${courseId}|${date}|${slot}`;
    try {
      const data = await api<RegisterPayload>(`${ATTENDANCE_ENDPOINT}${qs({ courseId, date, slot })}`);
      setCourse(data?.course ?? null);
      setDateKey(typeof data?.dateKey === "string" ? data.dateKey : date);
      setRows(editableRows(data?.rows));
      setSummary(data?.summary ?? null);
      setLoadedKey(key);
    } catch (e: unknown) {
      setRows([]);
      setSummary(null);
      setCourse(null);
      setLoadedKey("");
      setError(pageError(e, PAGE_ERRORS.roster));
    } finally {
      setLoading(false);
    }
  }, [ready, courseId, date, slot]);

  useEffect(() => {
    if (!ready) return;
    if (!courseId || slot === null) {
      setRows([]);
      setSummary(null);
      return;
    }
    void loadRegister();
  }, [ready, courseId, date, slot, loadRegister]);

  const save = async () => {
    const payload = rowsToSave(rows);
    if (!payload.rows.length || slot === null) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await api<SavePayload>(ATTENDANCE_ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ courseId, date, slot, rows: payload.rows }),
      });
      setMessage(saveMessage(res));
      await loadRegister();
    } catch (e: unknown) {
      setError(pageError(e, PAGE_ERRORS.save));
    } finally {
      setBusy(false);
    }
  };

  const roster = rowsToSave(rows);
  const changes = roster.rows.length;
  const selectedCourse = courses.find((c) => c.id === courseId) || null;
  const registerCourse = course || selectedCourse;
  const registerLabel = courseLabel(registerCourse);
  const showing = loadedKey === `${courseId}|${date}|${slot === null ? "" : slot}`;

  if (meLoading) return <LoadingScreen label="Loading your session…" />;

  if (!college) {
    return (
      <div>
        <PageHeader
          title="Course Attendance"
          subtitle="A course register: one course, one date, one session"
          icon={CalendarCheck}
        />
        <Card>
          <EmptyState icon={ClipboardList} title="College mode only" description={NO_COLLEGE_NOTE} />
        </Card>
      </div>
    );
  }

  if (!canView) {
    return (
      <div>
        <PageHeader
          title="Course Attendance"
          subtitle="A course register: one course, one date, one session"
          icon={CalendarCheck}
        />
        <Card>
          <EmptyState icon={ClipboardList} title="Not available for your role" description={REFUSED_NOTE} />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Course Attendance"
        subtitle="One course, one date, one session — the register lists the course's APPROVED registrations only"
        icon={CalendarCheck}
      />

      {message && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          {message}
        </div>
      )}
      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      {!canMark && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-500">
          {READ_ONLY_NOTE}
        </div>
      )}

      <Card className="mb-4">
        <CardHeader
          title="Session"
          subtitle={SLOT_HINT}
          action={
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void loadRegister()}
              disabled={loading || !courseId || slot === null}
            >
              <ClipboardList size={14} /> Load register
            </button>
          }
        />
        <div className="grid grid-cols-1 items-end gap-3 p-5 sm:grid-cols-4">
          <Field label="Course" className="sm:col-span-2">
            <Select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              <option value="">Select…</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {courseLabel(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Session (slot)" hint={slot === null ? "A whole number from 1." : undefined}>
            <TextInput
              type="number"
              min={1}
              step="1"
              value={slotInput}
              onChange={(e) => setSlotInput(e.target.value)}
            />
          </Field>
        </div>
        {registerCourse && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-slate-100 px-5 py-3">
            <p className="text-xs font-semibold text-slate-500">
              {registerLabel}
              {dateKey ? ` · ${dateKey}` : ""}
              {showing ? ` · session ${slot}` : ""}
            </p>
            {summaryCells(summary).map((cell) => (
              <p key={cell.label} className="text-xs text-slate-400">
                {cell.label} <span className="font-bold text-slate-600">{cell.value}</span>
              </p>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Register"
          subtitle={rows.length ? `${rosterCountText(rows)} · ${markedCountText(rows)}` : PICK_COURSE_NOTE}
          action={
            canMark ? (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void save()}
                disabled={busy || !changes || !showing || slot === null}
              >
                <Save size={15} /> {saveButtonLabel(busy)}
              </button>
            ) : undefined
          }
        />
        {loading && !rows.length ? (
          <LoadingScreen label="Loading the register…" />
        ) : rows.length ? (
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => (
              <li key={row.studentId} className="px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-bold leading-snug text-slate-800">{row.name}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">{row.admissionNo || "—"}</p>
                  </div>
                  <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
                </div>
                {canMark && (
                  <>
                    <div
                      className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4"
                      role="group"
                      aria-label={`Attendance for ${row.name}`}
                    >
                      {statusOptions().map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setRows((current) => withStatus(current, row.studentId, option.value))}
                          aria-pressed={row.status === option.value}
                          className={`min-h-11 rounded-xl border-2 text-[11px] font-bold transition ${
                            row.status === option.value
                              ? markTone(option.value)
                              : "border-slate-200 text-slate-400 hover:border-slate-300"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2">
                      <TextInput
                        value={row.remark}
                        maxLength={200}
                        placeholder="Remark (optional)"
                        aria-label={`Remark for ${row.name}`}
                        onChange={(e) => setRows((current) => withRemark(current, row.studentId, e.target.value))}
                      />
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={ClipboardList}
            title="No approved registrations"
            description={courseId ? noRosterNote(registerLabel) : PICK_COURSE_NOTE}
          />
        )}
        {rows.length > 0 && (
          <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
            {canMark
              ? "A row left Not marked keeps its stored status. Only a newly recorded absence notifies the family."
              : `This register belongs to ${prettyStatus(String(role ?? ""))} as a read-only view.`}
          </div>
        )}
      </Card>
    </div>
  );
}
