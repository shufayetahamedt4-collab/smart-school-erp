"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight, GraduationCap, Layers, Users } from "lucide-react";
import { api, qs } from "@/lib/client";
import { hasCollege, normalizeInstitutionType } from "@/lib/institution";
import { can } from "@/lib/permissions";
import { termLabel } from "@/lib/college-terms";
import { useMe } from "@/components/Shell";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Field,
  LoadingScreen,
  Modal,
  PageHeader,
  Select,
} from "@/components/ui";

/**
 * College support (Phase 5c) — the college promotion ladder UI
 * (docs/COLLEGE-DECISIONS.md §15–§18).
 *
 * The screen over the Phase 5b API: a college student's position is
 * `students.programId` + `students.termNumber`, and the programme's term count is
 * derived (`termCount = durationYears × termsPerYear`, `src/lib/college-terms.ts`).
 * The page only PICKS a position — it sends `{ programId, fromTermNumber }` and
 * nothing else. **Student ids and preview output are never sent to the server**:
 * the cohort is recomputed server-side on every call (D2/D3), which is also what
 * makes a re-run a structural no-op.
 *
 * COLLEGE-ONLY, and it says so BEFORE it reads anything: the tenant shape comes
 * from the same source the Shell uses (`me.school.institutionType ??
 * me.institutionType`), and the read effects return before issuing any request
 * when the tenant has no college — so a school admin who types the URL directly
 * gets the refusal and no call to `/api/programs` or `/api/college-promotion`.
 * The API remains the real gate (`requireCollege()` + `can(role, "registration",
 * "full")` in both handlers); these checks are UX, fail-closed. The nav item is
 * marked `requires: "COLLEGE"`, so this is only reachable in COLLEGE mode by the
 * three roles that already hold `registration` full (docs §16).
 *
 * What the preview shows, and why:
 *   - the programme and the position ("Term X of N"), the cohort rows, and the
 *     tallies the server computed (`counts.advance` / `counts.graduate`);
 *   - the destination: the next term, or "graduating run" on the programme's LAST
 *     term, where every row's action is `graduate` and the apply stamps ALUMNI
 *     (D5) — shown as its own banner and never mixed with an advance;
 *   - D4 — a row that ALSO holds a `classId` is flagged, because the unrelated
 *     SCHOOL ladder (`/api/students/promote`) may move that student too;
 *   - D6 — the pending figure is INFO ONLY. It is labelled "pending course
 *     requests" (never "pending students"): one request = one course, one student
 *     may have several, and it neither blocks nor follows a promotion.
 *
 * Apply is a deliberate two-step: an explicit confirmation dialog restates the
 * programme, the term, the number of students and whether it graduates them, and
 * only then is the POST issued. While it is in flight the button is disabled (no
 * double-submit), and the server's own report is shown before the preview is
 * re-fetched — which is now empty, because the cohort moved off the term.
 */

/** The programme fields the picker needs (from `GET /api/programs`). */
interface ProgramLite {
  id: string;
  name: string;
  termSystem?: string | null;
  termCount?: number | null;
}

/** The two fields the student list is joined on (`GET /api/students`). */
interface StudentLite {
  id: string;
  name: string;
  admissionNo: string;
}

/** One cohort row as the API returns it — an id and the move, never a name. */
interface PreviewRow {
  studentId: string;
  fromTermNumber: number;
  action: "advance" | "graduate";
  toTermNumber: number | null;
  graduating: boolean;
  /** D4 — the student also sits in a school class. */
  classIdWarning: boolean;
  /** D6 — informational, term-filtered, never a blocker. */
  pendingRegistrationCount: number;
}

/** `GET /api/college-promotion` — the preview for one position. */
interface Preview {
  program: { id: string; name: string };
  fromTermNumber: number;
  termCount: number;
  graduating: boolean;
  rows: PreviewRow[];
  count: number;
  counts: { advance: number; graduate: number; classIdWarnings: number; pendingRegistrations: number };
}

/** `POST /api/college-promotion` — the server's own report of what it wrote. */
interface ApplyResult {
  programId: string;
  fromTermNumber: number;
  toTermNumber: number | null;
  graduating: boolean;
  promoted: number;
  graduated: number;
  failed: number;
}

/** One step of the whole-programme plan (`GET /api/college-promotion/ladder`). */
interface LadderStep {
  fromTermNumber: number;
  toTermNumber: number | null;
  graduating: boolean;
  rows: PreviewRow[];
  count: number;
  counts: { advance: number; graduate: number; classIdWarnings: number; pendingRegistrations: number };
}

/** The whole-programme plan: every term's cohort and its one move, ASCENDING. */
interface LadderPlan {
  program: { id: string; name: string };
  termCount: number;
  steps: LadderStep[];
  count: number;
  counts: { advance: number; graduate: number; classIdWarnings: number; pendingRegistrations: number };
}

/** `POST /api/college-promotion/ladder` — the run's report, one entry per step. */
interface LadderRunResult {
  programId: string;
  termCount: number;
  promoted: number;
  graduated: number;
  failed: number;
  steps: {
    fromTermNumber: number;
    toTermNumber: number | null;
    graduating: boolean;
    count: number;
    promoted: number;
    graduated: number;
    failed: number;
  }[];
}

/** The exact wording D6 requires for the pending figure (never "pending students"). */
const PENDING_TOOLTIP =
  "Course-registration requests still PENDING at this term. One request = one course; one student may have several. This is not a student count, and it does not block or follow a promotion.";

export default function CollegePromotionPage() {
  const { me, loading: meLoading, error: meError } = useMe();

  const institutionType = me?.school?.institutionType ?? me?.institutionType ?? null;
  const college = hasCollege(normalizeInstitutionType(institutionType));
  const role = me?.user?.role;
  // Both handlers of the ladder require `registration` FULL (not view), so the
  // page gates on the same level it will be authorized at.
  const canManage = can(role, "registration", "full");
  const ready = !meLoading && college && canManage;

  const [programs, setPrograms] = useState<ProgramLite[]>([]);
  const [students, setStudents] = useState<Map<string, StudentLite>>(new Map());
  const [programId, setProgramId] = useState("");
  const [fromTermNumber, setFromTermNumber] = useState(1);
  const [preview, setPreview] = useState<Preview | null>(null);

  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [ladderOpen, setLadderOpen] = useState(false);
  const [ladderPlan, setLadderPlan] = useState<LadderPlan | null>(null);
  const [ladderLoading, setLadderLoading] = useState(false);

  // Programmes, once. NO read before the gate resolves.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setLoading(true);
    api<ProgramLite[]>("/api/programs")
      .then((ps) => {
        if (!alive) return;
        setPrograms(ps);
        if (ps.length) setProgramId(ps[0].id);
      })
      .catch((e: any) => {
        if (alive) setError(e?.message || "Could not load programmes");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ready]);

  // The student list, joined to a row by id so the cohort reads as names. It is
  // the tenant/branch-scoped list the rest of the app uses; no extra filtering.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    api<StudentLite[]>("/api/students")
      .then((rows) => {
        if (!alive) return;
        const map = new Map<string, StudentLite>();
        for (const s of rows) map.set(s.id, s);
        setStudents(map);
      })
      .catch(() => null);
    return () => {
      alive = false;
    };
  }, [ready]);

  /**
   * Load the preview for a position. Deliberately does NOT clear `result`, so the
   * server's report of the last apply stays on screen while the re-fetched (now
   * empty) preview renders beneath it.
   */
  const loadPreview = useCallback(async (pid: string, term: number, opts: { silent?: boolean } = {}) => {
    if (!pid) return;
    setPreviewLoading(true);
    // A SILENT refresh (the ladder's failure path) must not clear the run's error.
    if (!opts.silent) setError("");
    try {
      setPreview(await api<Preview>(`/api/college-promotion${qs({ programId: pid, fromTermNumber: term })}`));
    } catch (e: any) {
      setPreview(null);
      if (!opts.silent) setError(e?.message || "Could not load the preview");
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready || !programId) return;
    void loadPreview(programId, fromTermNumber);
  }, [ready, programId, fromTermNumber, loadPreview]);

  const selected = programs.find((p) => p.id === programId) || null;
  const termOptions = useMemo(() => {
    const n = selected?.termCount ?? 0;
    return Array.from({ length: n }, (_, i) => i + 1);
  }, [selected]);

  const apply = async () => {
    if (!preview || busy || preview.count === 0) return;
    setBusy(true);
    setError("");
    try {
      // Only the position is sent — never a student id, never preview output.
      const res = await api<ApplyResult>("/api/college-promotion", {
        method: "POST",
        body: JSON.stringify({ programId, fromTermNumber }),
      });
      setConfirmOpen(false);
      setResult(res);
      setMessage(
        res.graduating
          ? `Graduated ${res.graduated} student(s) as ALUMNI from ${selected?.name ?? "the programme"}.`
          : `Promoted ${res.promoted} student(s) to Term ${res.toTermNumber} of ${selected?.name ?? "the programme"}.`
      );
      // Re-fetch: the cohort has moved off the term, so this should now be empty.
      await loadPreview(programId, fromTermNumber);
    } catch (e: any) {
      setConfirmOpen(false);
      setError(e?.message || "The promotion could not be applied");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Fetch the whole-programme plan (`GET /api/college-promotion/ladder`) and store
   * it. It is read-only: it lists every term's original cohort and its single move,
   * so an operator can review every step before anything is written. A SILENT refresh
   * (the run's failure path) leaves the error the run just set on screen.
   */
  const loadLadderPlan = useCallback(async (pid: string, opts: { silent?: boolean } = {}) => {
    if (!pid) return;
    setLadderLoading(true);
    if (!opts.silent) setError("");
    try {
      setLadderPlan(await api<LadderPlan>(`/api/college-promotion/ladder${qs({ programId: pid })}`));
    } catch (e: any) {
      setLadderPlan(null);
      if (!opts.silent) setError(e?.message || "Could not build the ladder plan");
    } finally {
      setLadderLoading(false);
    }
  }, []);

  const openLadder = async () => {
    if (!programId) return;
    setLadderOpen(true);
    await loadLadderPlan(programId);
  };

  /**
   * Run the whole ladder (`POST /api/college-promotion/ladder`). As with the
   * single-position apply, only the programme is sent: the SERVER decides which
   * positions exist and in what order they are applied (descending), so nothing
   * here can reorder the ladder — the rule cannot drift into the UI.
   */
  const runLadder = async () => {
    if (!ladderPlan || busy || ladderPlan.count === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await api<LadderRunResult>("/api/college-promotion/ladder", {
        method: "POST",
        body: JSON.stringify({ programId }),
      });
      setLadderOpen(false);
      setResult(null);
      const name = ladderPlan.program.name;
      setLadderPlan(null);
      setMessage(`Ran the whole ladder for ${name}: ${res.promoted} advanced, ${res.graduated} graduated.`);
      // Re-fetch the position preview: every cohort has moved off its term.
      await loadPreview(programId, fromTermNumber);
    } catch (e: any) {
      // A partial run may have WRITTEN some steps, so the screen must never keep
      // showing pre-run state. Close the modal, show the server's structured report
      // (the applied steps, the failed step and the remaining terms) and re-fetch
      // BOTH the plan and the position preview. The refresh is SILENT so that report
      // stays on screen (§20).
      setLadderOpen(false);
      setError(e?.message || "The ladder could not be run");
      await Promise.all([
        loadLadderPlan(programId, { silent: true }),
        loadPreview(programId, fromTermNumber, { silent: true }),
      ]);
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (studentId: string) => students.get(studentId)?.name || "—";
  const admissionOf = (studentId: string) => students.get(studentId)?.admissionNo || "";

  /* -------------------------------------------------------------- gating UI */

  if (meLoading) return <LoadingScreen />;

  if (!college && !me) {
    return (
      <div>
        <PageHeader title="College Promotion" subtitle="Advance a programme's cohort one term" />
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
        <PageHeader icon={ArrowUpRight} title="College Promotion" subtitle="Advance a programme's cohort one term" />
        <Card>
          <EmptyState
            icon={Layers}
            title="Available to college institutions only"
            description="This institution runs the school curriculum. The term ladder is part of the college setup."
          />
        </Card>
      </div>
    );
  }

  if (!canManage) {
    return (
      <div>
        <PageHeader icon={ArrowUpRight} title="College Promotion" subtitle="Advance a programme's cohort one term" />
        <Card>
          <EmptyState
            icon={Layers}
            title="Not available for your role"
            description="Promotion is handled by the school administration and the registrar."
          />
        </Card>
      </div>
    );
  }

  if (loading) return <LoadingScreen />;

  if (!programs.length) {
    return (
      <div>
        <PageHeader icon={ArrowUpRight} title="College Promotion" subtitle="Advance a programme's cohort one term" />
        <Card>
          <EmptyState
            icon={Layers}
            title="No programmes yet"
            description="Add a programme and its courses before running a promotion."
          />
        </Card>
      </div>
    );
  }

  /* ------------------------------------------------------------------- view */

  const system = selected?.termSystem ?? null;
  const rows = preview?.rows ?? [];

  return (
    <div>
      <PageHeader
        icon={ArrowUpRight}
        title="College Promotion"
        subtitle="Advance a programme's cohort one term — or graduate the final term, as the API decides"
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

      <Card className="mb-4">
        <CardHeader
          title="Position"
          subtitle="Pick a programme and the term to advance FROM. The cohort is recomputed by the server."
        />
        <div className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4">
          <Field label="Programme" className="sm:col-span-2">
            <Select
              value={programId}
              onChange={(e) => {
                setProgramId(e.target.value);
                setFromTermNumber(1);
                setResult(null);
                setLadderPlan(null);
                setMessage("");
              }}
            >
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From term">
            <Select
              value={String(fromTermNumber)}
              onChange={(e) => {
                setFromTermNumber(Number(e.target.value));
                setResult(null);
                setLadderPlan(null);
                setMessage("");
              }}
            >
              {termOptions.map((n) => (
                <option key={n} value={String(n)}>
                  {termLabel(n, system)} ({n} of {termOptions.length})
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex sm:justify-end">
            <button
              className="btn btn-primary"
              disabled={!preview || preview.count === 0 || busy || previewLoading}
              onClick={() => setConfirmOpen(true)}
            >
              <ArrowUpRight size={15} /> Review &amp; apply
            </button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Preview"
          subtitle={
            preview
              ? `${preview.program.name} · term ${preview.fromTermNumber} of ${preview.termCount}`
              : "The cohort at the chosen position"
          }
        />

        {previewLoading ? (
          <div className="px-6 py-10 text-center text-sm text-slate-400">Loading the cohort…</div>
        ) : !preview ? (
          <EmptyState
            icon={Users}
            title="Nothing to preview"
            description="Choose a programme and a term to see who sits there."
          />
        ) : preview.count === 0 ? (
          <EmptyState
            icon={GraduationCap}
            title={`Nobody is at term ${preview.fromTermNumber} of ${preview.termCount}`}
            description="The cohort for this position is empty — after a promotion has run, it stays empty."
          />
        ) : (
          <>
            {preview.graduating && (
              <div className="flex items-start gap-2 border-b border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
                <GraduationCap size={16} className="mt-0.5 shrink-0" />
                <span>
                  <span className="font-bold">Graduating run</span> — this is the programme&apos;s final term
                  (term {preview.fromTermNumber} of {preview.termCount}). Every student below is archived as{" "}
                  <span className="font-semibold">ALUMNI</span>; there is no next term.
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-px border-b border-slate-100 bg-slate-100 sm:grid-cols-4">
              <Fact label="Advancing" value={preview.counts.advance} tone="text-emerald-600" />
              <Fact label="Graduating" value={preview.counts.graduate} tone="text-indigo-600" />
              <Fact label="In cohort" value={preview.count} tone="text-slate-800" />
              <div className="bg-white p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Pending</p>
                <p
                  className="mt-1 text-xl font-extrabold text-slate-800"
                  title={PENDING_TOOLTIP}
                >
                  {preview.counts.pendingRegistrations}
                </p>
                <p className="text-[11px] text-slate-400" title={PENDING_TOOLTIP}>
                  {preview.counts.pendingRegistrations} pending course requests in this cohort
                </p>
              </div>
            </div>

            {preview.counts.classIdWarnings > 0 && (
              <div className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  {preview.counts.classIdWarnings} student(s) below are also enrolled in a school class — school
                  promotion may advance this student too.
                </span>
              </div>
            )}

            {!preview.graduating && (
              <div className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
                Destination:{" "}
                <span className="font-semibold text-slate-700">
                  {termLabel(preview.fromTermNumber + 1, system)}
                </span>{" "}
                (term {preview.fromTermNumber + 1} of {preview.termCount})
              </div>
            )}

            <div className="max-h-96 overflow-y-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Student</th>
                    <th className="th">Admission No</th>
                    <th className="th">Action</th>
                    <th className="th text-right">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.studentId} className="tr-hover">
                      <td className="td text-sm font-semibold text-slate-700">{nameOf(r.studentId)}</td>
                      <td className="td text-xs text-slate-500">{admissionOf(r.studentId) || "—"}</td>
                      <td className="td text-xs">
                        {r.action === "graduate" ? (
                          <Badge tone="indigo">Graduate → ALUMNI</Badge>
                        ) : (
                          <Badge tone="green">Advance → term {r.toTermNumber}</Badge>
                        )}
                      </td>
                      <td className="td text-right text-xs">
                        {r.classIdWarning && (
                          <div className="flex items-center justify-end gap-1 text-amber-700">
                            <AlertTriangle size={12} />
                            also enrolled in a school class: school promotion may advance this student too
                          </div>
                        )}
                        {r.pendingRegistrationCount > 0 && (
                          <div className="text-slate-500" title={PENDING_TOOLTIP}>
                            {r.pendingRegistrationCount} pending course requests at this term
                          </div>
                        )}
                        {!r.classIdWarning && r.pendingRegistrationCount === 0 && (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card className="mt-4">
        <CardHeader
          title="Whole-programme ladder"
          subtitle="Advance every term's cohort by exactly one step in a single run; the final term graduates as ALUMNI."
        />
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="max-w-xl text-xs text-slate-500">
            The server walks the programme from its final term downwards, so each student moves exactly once. Open the
            plan to review every step before anything is written.
          </p>
          <button className="btn btn-secondary" onClick={openLadder} disabled={!programId || busy}>
            <Layers size={15} /> Preview full ladder
          </button>
        </div>
      </Card>

      {/* Explicit two-step apply: restate everything, then confirm. */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm this promotion">
        {preview && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              You are about to{" "}
              {preview.graduating ? (
                <>
                  <span className="font-bold">graduate</span> the cohort
                </>
              ) : (
                <>
                  <span className="font-bold">advance</span> the cohort to term {preview.fromTermNumber + 1}
                </>
              )}{" "}
              of:
            </p>
            <ul className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <li>
                Programme: <span className="font-semibold">{preview.program.name}</span>
              </li>
              <li>
                Term: <span className="font-semibold">{termLabel(preview.fromTermNumber, system)}</span> (term{" "}
                {preview.fromTermNumber} of {preview.termCount})
              </li>
              <li>
                Students: <span className="font-semibold">{preview.count}</span>{" "}
                {preview.graduating
                  ? "— all archived as ALUMNI"
                  : `— all advanced to term ${preview.fromTermNumber + 1}`}
              </li>
            </ul>
            <p className="text-xs text-slate-400">
              The server recomputes the cohort from the programme and the term; this cannot be undone from here.
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn btn-secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={apply} disabled={busy}>
                {busy ? "Applying…" : preview.graduating ? "Graduate the cohort" : "Advance the cohort"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={ladderOpen} onClose={() => setLadderOpen(false)} wide title="Run the whole programme ladder">
        {ladderLoading ? (
          <div className="py-10 text-center text-sm text-slate-400">Building the plan…</div>
        ) : !ladderPlan ? (
          <div className="py-6 text-center text-sm text-slate-400">No plan to show.</div>
        ) : (
          <div className="space-y-4">
            <ul className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <li>
                Programme: <span className="font-semibold">{ladderPlan.program.name}</span>
              </li>
              <li>
                Terms: <span className="font-semibold">{ladderPlan.termCount}</span>
              </li>
              <li>
                Students across the ladder: <span className="font-semibold">{ladderPlan.count}</span> —{" "}
                {ladderPlan.counts.graduate} will graduate
              </li>
              <li className="text-xs text-slate-500" title={PENDING_TOOLTIP}>
                {ladderPlan.counts.pendingRegistrations} pending course requests in this programme
              </li>
            </ul>

            <div className="max-h-72 space-y-2 overflow-y-auto">
              {ladderPlan.steps.map((s) => (
                <div key={s.fromTermNumber} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-bold text-slate-800">
                      Term {s.fromTermNumber} of {ladderPlan.termCount}
                    </span>
                    {s.graduating ? (
                      <Badge tone="indigo">Graduate → ALUMNI</Badge>
                    ) : (
                      <Badge tone="green">Advance → term {s.toTermNumber}</Badge>
                    )}
                  </div>
                  {s.count === 0 ? (
                    <p className="mt-1 text-xs text-slate-400">No students at this term — this step does nothing.</p>
                  ) : (
                    <>
                      <p className="mt-1 text-xs text-slate-600">
                        {s.count} student(s): {s.rows.map((r) => nameOf(r.studentId)).join(", ")}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {s.counts.classIdWarnings > 0 && `${s.counts.classIdWarnings} also in a school class · `}
                        {s.counts.pendingRegistrations} pending course requests
                      </p>
                    </>
                  )}
                </div>
              ))}
            </div>

            <p className="text-xs text-slate-400">
              Steps are applied from the final term backwards so each cohort moves exactly one step — the server decides
              that order. This cannot be undone from here.
            </p>
            <p className="text-[11px] font-semibold text-amber-600">
              Run this one at a time: two runs at once can advance the same cohort twice (there is no run lock).
            </p>

            <div className="flex justify-end gap-2">
              <button className="btn btn-secondary" onClick={() => setLadderOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={runLadder} disabled={busy || ladderPlan.count === 0}>
                {busy ? "Running…" : `Run the whole ladder (${ladderPlan.count})`}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="bg-white p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-extrabold ${tone || "text-slate-800"}`}>{value}</p>
    </div>
  );
}
