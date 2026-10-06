"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, ShieldCheck, GraduationCap, QrCode, UserCheck, UserX, HelpCircle, UserRoundX, Printer, ClipboardList, Eye } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Badge, Select, TextInput, EmptyState, LoadingScreen, PageHeader, KpiCard, ErrorNote } from "@/components/ui";

/**
 * Guardian Onboarding Monitor (Phase 5).
 *
 * A READ-ONLY operations view: it shows how each student's guardian access
 * stands (credentials ready · linked · no contact · legacy/unknown) and lists
 * provisioned accounts left without a student after an import undo. Every action
 * is navigation or a print view — nothing here writes.
 *
 * A missing `guardianOnboarding` marker is LEGACY/UNKNOWN, never "no contact":
 * students created by New Admission / manually simply have no marker.
 */

interface Row {
  id: string; name: string | null; admissionNo: string | null;
  className: string | null; sectionName: string | null;
  guardianName: string | null; guardianEmail: string | null; guardianPhone: string | null;
  guardianUserId: string | null;
  status: "credentialsReady" | "linked" | "incomplete" | "legacy";
  batchId: string | null; canPrintSlip: boolean;
}
interface Options {
  classes: { id: string; name: string; order: number }[];
  sections: { id: string; name: string; classId: string }[];
  sessions: { id: string; name: string; isCurrent: boolean }[];
  branches: { id: string; name: string }[];
  batches: { id: string; fileName: string | null; branchId: string | null; createdAt: string | null }[];
}
interface Data {
  summary: { total: number; credentialsReady: number; linked: number; incomplete: number; legacy: number; orphanedAccounts: number };
  students: Row[];
  total: number;
  orphanedAccounts: { id: string; name: string | null; email: string | null; phone: string | null }[];
  options: Options;
}

const STATUS_META: Record<string, { label: string; tone: "green" | "blue" | "red" | "slate" }> = {
  credentialsReady: { label: "Access ready", tone: "blue" },
  linked: { label: "Guardian linked", tone: "green" },
  incomplete: { label: "No contact", tone: "red" },
  legacy: { label: "Legacy / unknown", tone: "slate" },
};

export default function OnboardingMonitorPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({ status: "", classId: "", sectionId: "", sessionId: "", batchId: "", branchId: "", q: "" });

  const load = (f = filters) =>
    api<Data>(`/api/onboarding${qs({
      status: f.status || undefined,
      classId: f.classId || undefined,
      sectionId: f.sectionId || undefined,
      sessionId: f.sessionId || undefined,
      batchId: f.batchId || undefined,
      branchId: f.branchId || undefined,
      q: f.q || undefined,
      limit: 300,
    })}`)
      .then((d) => { setData(d); setError(""); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const set = (patch: Partial<typeof filters>) => setFilters((f) => ({ ...f, ...patch }));
  const apply = () => { setLoading(true); load(filters); };
  const selectedClass = useMemo(() => data?.options.classes.find((c) => c.id === filters.classId), [data, filters.classId]);
  const sections = useMemo(
    () => (data?.options.sections || []).filter((s) => !filters.classId || s.classId === filters.classId),
    [data, filters.classId]
  );
  const branches = data?.options.branches || [];
  const s = data?.summary;

  if (loading && !data) return <LoadingScreen />;

  return (
    <div className="ss-onboardingpage">
      <PageHeader icon={ShieldCheck} title="Guardian Onboarding" subtitle="Guardian access status for every student — read-only" />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      {/* summary — six figures */}
      <section className="ss-surface mb-8">
        <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-3 xl:grid-cols-6">
          <div className="bg-white"><KpiCard bare icon={GraduationCap} label="Total students" value={s?.total ?? 0} sub="in this view" tone="slate" /></div>
          <div className="bg-white"><KpiCard bare icon={QrCode} label="Access ready" value={s?.credentialsReady ?? 0} sub="QR/PIN slip ready" tone="sky" /></div>
          <div className="bg-white"><KpiCard bare icon={UserCheck} label="Guardian linked" value={s?.linked ?? 0} sub="existing/reused" tone="emerald" /></div>
          <div className="bg-white"><KpiCard bare icon={UserX} label="No contact" value={s?.incomplete ?? 0} sub="no guardian account" tone="rose" /></div>
          <div className="bg-white"><KpiCard bare icon={HelpCircle} label="Legacy / unknown" value={s?.legacy ?? 0} sub="no onboarding marker" tone="slate" /></div>
          <div className="bg-white"><KpiCard bare icon={UserRoundX} label="Orphaned accounts" value={s?.orphanedAccounts ?? 0} sub="provisioned, no child" tone="amber" /></div>
        </div>
      </section>

      {/* filters */}
      <section className="ss-surface mb-8">
        <div className="ss-section">
          <div className="min-w-0">
            <h3 className="ss-section-title">Filters</h3>
            <p className="ss-section-sub">{data?.total ?? 0} matching student(s)</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <Select value={filters.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">All statuses</option>
            <option value="CREDENTIALS_READY">Access ready</option>
            <option value="LINKED">Guardian linked</option>
            <option value="INCOMPLETE">No contact</option>
            <option value="LEGACY">Legacy / unknown</option>
          </Select>
          <Select value={filters.classId} onChange={(e) => set({ classId: e.target.value, sectionId: "" })}>
            <option value="">All classes</option>
            {(data?.options.classes || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={filters.sectionId} onChange={(e) => set({ sectionId: e.target.value })}>
            <option value="">All sections</option>
            {sections.map((sec) => <option key={sec.id} value={sec.id}>{sec.name}</option>)}
          </Select>
          <Select value={filters.sessionId} onChange={(e) => set({ sessionId: e.target.value })}>
            <option value="">All sessions</option>
            {(data?.options.sessions || []).map((ses) => <option key={ses.id} value={ses.id}>{ses.name}{ses.isCurrent ? " (current)" : ""}</option>)}
          </Select>
          <Select value={filters.batchId} onChange={(e) => set({ batchId: e.target.value })}>
            <option value="">All import batches</option>
            {(data?.options.batches || []).map((b) => <option key={b.id} value={b.id}>{b.fileName || b.id}</option>)}
          </Select>
          {branches.length > 0 && (
            <Select value={filters.branchId} onChange={(e) => set({ branchId: e.target.value })}>
              <option value="">All branches (whole school)</option>
              {branches.map((br) => <option key={br.id} value={br.id}>{br.name}</option>)}
            </Select>
          )}
          <div className="relative sm:col-span-2 xl:col-span-2">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <TextInput className="!pl-9" placeholder="Search name, ID, guardian email or phone…" value={filters.q} onChange={(e) => set({ q: e.target.value })} onKeyDown={(e) => e.key === "Enter" && apply()} />
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={apply}>Apply</button>
            <button className="btn btn-secondary" onClick={() => { const cleared = { status: "", classId: "", sectionId: "", sessionId: "", batchId: "", branchId: "", q: "" }; setFilters(cleared); setLoading(true); load(cleared); }}>Clear</button>
          </div>
        </div>
        {selectedClass && sections.length === 0 && (
          <p className="px-4 pb-3 text-xs text-slate-400">This class has no sections.</p>
        )}
      </section>

      {/* students */}
      <section className="ss-surface mb-8">
        <div className="ss-section">
          <div className="min-w-0">
            <h3 className="ss-section-title">Students</h3>
            <p className="ss-section-sub">{data?.students.length ?? 0} shown{data && data.total > data.students.length ? ` of ${data.total}` : ""}</p>
          </div>
        </div>
        {(data?.students.length ?? 0) === 0 ? (
          <EmptyState icon={ShieldCheck} title="No students in this view" description="Adjust the filters above to see students." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-semibold">Student</th>
                  <th className="px-4 py-2 font-semibold">Class / Section</th>
                  <th className="px-4 py-2 font-semibold">Guardian</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data!.students.map((r) => {
                  const meta = STATUS_META[r.status];
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="px-4 py-2">
                        <div className="font-semibold text-slate-700">{r.name || "—"}</div>
                        <div className="text-slate-400">{r.admissionNo || "—"}</div>
                      </td>
                      <td className="px-4 py-2 text-slate-500">
                        {r.className || "—"}{r.sectionName ? ` / ${r.sectionName}` : ""}
                      </td>
                      <td className="px-4 py-2 text-slate-500">
                        <div>{r.guardianName || "—"}</div>
                        <div className="text-slate-400">{r.guardianEmail || r.guardianPhone || "no contact"}</div>
                      </td>
                      <td className="px-4 py-2"><Badge tone={meta.tone}>{meta.label}</Badge></td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/dashboard/students/${r.id}`} className="btn btn-secondary btn-sm"><Eye size={13} /> Student</Link>
                          {r.guardianUserId && (
                            <Link href="/dashboard/guardians" className="btn btn-secondary btn-sm"><UserCheck size={13} /> Guardian</Link>
                          )}
                          {r.canPrintSlip && r.batchId && (
                            <Link href={`/print/guardian-credentials/${r.batchId}`} className="btn btn-secondary btn-sm"><Printer size={13} /> Slips</Link>
                          )}
                          {r.batchId && (
                            <Link href={`/dashboard/students/import/${r.batchId}`} className="btn btn-secondary btn-sm"><ClipboardList size={13} /> Batch</Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* orphaned provisioned accounts */}
      {(data?.orphanedAccounts.length ?? 0) > 0 && (
        <section className="ss-surface">
          <div className="ss-section">
            <div className="min-w-0">
              <h3 className="ss-section-title">Orphaned guardian accounts</h3>
              <p className="ss-section-sub">Provisioned by an import but no longer linked to a student (e.g. after an undo). Kept, never deleted.</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-semibold">Guardian</th>
                  <th className="px-4 py-2 font-semibold">Email</th>
                  <th className="px-4 py-2 font-semibold">Phone</th>
                  <th className="px-4 py-2 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data!.orphanedAccounts.map((g) => (
                  <tr key={g.id} className="align-top">
                    <td className="px-4 py-2 font-semibold text-slate-700">{g.name || "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{g.email || "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{g.phone || "—"}</td>
                    <td className="px-4 py-2">
                      <Link href="/dashboard/guardians" className="btn btn-secondary btn-sm"><UserCheck size={13} /> Guardians</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
