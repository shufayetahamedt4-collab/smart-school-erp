"use client";

import { useEffect, useMemo, useState } from "react";
import { Award, Check, Info, Plus, RotateCcw, Save, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen, ErrorNote } from "@/components/ui";
import {
  bandLabel,
  gradeForScheme,
  round2,
  validateScheme,
  type GradeBand,
  type GradingScheme,
} from "@/lib/grading";

interface Preset {
  key: string;
  label: string;
  hint: string;
  scheme: GradingScheme;
}

/**
 * The grading & GPA editor (PRD §2.1 attendanceMarks).
 *
 * Shared by the School Admin console and the Teacher app: both render this one
 * component, so a school's marking policy is edited in exactly one place and
 * both screen types can never drift apart. The server decides who may actually
 * write (admins and teachers; guardians are read-only).
 */
export default function GradingSchemeEditor() {
  const [scheme, setScheme] = useState<GradingScheme | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [trial, setTrial] = useState("75");

  const load = () =>
    api<{ scheme: GradingScheme; presets: Preset[] }>("/api/grading-scheme")
      .then((d) => {
        setScheme(d.scheme);
        setPresets(d.presets || []);
        setDirty(false);
      })
      .catch((e: any) => setError(e?.message || "Could not load the grading scheme"))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Live client-side verdict so Save is never offered for an unusable scale. */
  const check = useMemo(() => (scheme ? validateScheme(scheme) : null), [scheme]);
  const problem = check && !check.ok ? check.error : "";

  const patch = (p: Partial<GradingScheme>) => {
    setScheme((s) => (s ? { ...s, ...p } : s));
    setDirty(true);
    setSaved(false);
  };

  const patchBand = (index: number, p: Partial<GradeBand>) => {
    setScheme((s) => (s ? { ...s, bands: s.bands.map((b, i) => (i === index ? { ...b, ...p } : b)) } : s));
    setDirty(true);
    setSaved(false);
  };

  /** Insert a band in the widest gap of the scale so its minimum is unique. */
  const addBand = () => {
    setScheme((s) => {
      if (!s) return s;
      const mins = [...new Set(s.bands.map((b) => b.minPercent))].sort((a, b) => a - b);
      let prev = 0;
      let best = 50;
      let bestGap = -1;
      for (const m of [...mins, 100]) {
        const gap = m - prev;
        if (gap > bestGap) {
          bestGap = gap;
          best = prev + gap / 2;
        }
        prev = m;
      }
      const next = round2(best);
      const bands = [...s.bands, { grade: "", minPercent: next, gpa: 0, remark: "" }].sort(
        (a, b) => b.minPercent - a.minPercent
      );
      return { ...s, bands };
    });
    setDirty(true);
    setSaved(false);
  };

  const removeBand = (index: number) => {
    setScheme((s) => (s && s.bands.length > 2 ? { ...s, bands: s.bands.filter((_, i) => i !== index) } : s));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    if (!scheme || problem) return;
    setSaving(true);
    setError("");
    try {
      const res = await api<{ scheme: GradingScheme }>("/api/grading-scheme", {
        method: "PUT",
        body: JSON.stringify({ scheme }),
      });
      setScheme(res.scheme);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e?.message || "Could not save the grading scheme");
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = async () => {
    if (!confirm("Go back to the built-in Bangladesh National scale? Your custom bands will be lost.")) return;
    setSaving(true);
    setError("");
    try {
      const res = await api<{ scheme: GradingScheme }>("/api/grading-scheme", { method: "DELETE" });
      setScheme(res.scheme);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e?.message || "Could not reset the grading scheme");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingScreen label="Loading grading scheme…" />;
  if (!scheme) return <ErrorNote message={error || "Grading scheme unavailable"} />;

  const preview = [95, 85, 75, 65, 55, 45, 35, 25].map((pct) => ({
    pct,
    ...gradeForScheme(scheme, pct, 100),
  }));

  const trialNum = Number(trial);
  const trialValid = trial !== "" && Number.isFinite(trialNum);
  const trialResult = trialValid ? gradeForScheme(scheme, trialNum, 100) : null;

  return (
    <div>
      <PageHeader
        title="Grading & GPA"
        subtitle="Set how marks become grades and grade points — every exam sheet, result and report card follows this scale"
        actions={
          <>
            <button className="btn btn-secondary btn-sm" onClick={resetToDefault} disabled={saving}>
              <RotateCcw size={14} /> Reset to default
            </button>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !!problem || !dirty}>
              {saved ? <Check size={14} /> : <Save size={14} />} {saved ? "Saved!" : saving ? "Saving…" : "Save scheme"}
            </button>
          </>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      {/* scale settings */}
      <Card className="mb-4">
        <CardHeader
          title="Scale"
          subtitle="The GPA ceiling, the pass mark, and how a failure affects the average"
          action={<Badge tone={dirty ? "amber" : "green"}>{dirty ? "Unsaved changes" : "Saved"}</Badge>}
        />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label className="label">Name of this scale</label>
            <input
              className="input"
              value={scheme.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="e.g. Bangladesh National"
            />
          </div>
          <div>
            <label className="label">Highest GPA</label>
            <input
              className="input"
              type="number"
              step="0.01"
              min={0.1}
              max={10}
              value={scheme.gpaScale}
              onChange={(e) => patch({ gpaScale: e.target.value === "" ? 0 : Number(e.target.value) })}
            />
            <p className="mt-1 text-xs text-slate-400">5.00 or 4.00 are the usual scales.</p>
          </div>
          <div>
            <label className="label">Pass mark (%)</label>
            <input
              className="input"
              type="number"
              step="1"
              min={0}
              max={100}
              value={scheme.passPercent}
              onChange={(e) => patch({ passPercent: e.target.value === "" ? 0 : Number(e.target.value) })}
            />
            <p className="mt-1 text-xs text-slate-400">A subject below this fails.</p>
          </div>
        </div>
        <label className="flex cursor-pointer items-start gap-3 border-t border-slate-100 px-5 py-4">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={scheme.failCapsGpa}
            onChange={(e) => patch({ failCapsGpa: e.target.checked })}
          />
          <span className="text-sm text-slate-600">
            <span className="font-semibold text-slate-800">A failed subject makes the GPA 0.</span>{" "}
            Off means the GPA is the plain average of the subject points, even with a failure.
          </span>
        </label>
      </Card>

      {/* presets */}
      {presets.length > 0 && (
        <Card className="mb-4">
          <CardHeader title="Start from a preset" subtitle="Load a common scale, then adjust any number below" />
          <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-3">
            {presets.map((p) => (
              <button
                key={p.key}
                onClick={() => {
                  setScheme({ ...p.scheme, bands: p.scheme.bands.map((b) => ({ ...b })) });
                  setDirty(true);
                  setSaved(false);
                }}
                className="rounded-xl border border-slate-200 p-3 text-left transition hover:border-indigo-300 hover:bg-indigo-50"
              >
                <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
                  <Sparkles size={14} className="text-indigo-500" /> {p.label}
                </div>
                <p className="mt-1 text-xs text-slate-500">{p.hint}</p>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* bands */}
      <Card className="mb-4">
        <CardHeader
          title="Grade bands"
          subtitle={`${scheme.bands.length} bands · add or remove rows, then set each minimum and GPA`}
          action={
            <button className="btn btn-secondary btn-sm" onClick={addBand}>
              <Plus size={14} /> Add band
            </button>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50">
                <th className="th min-w-28">Grade</th>
                <th className="th min-w-32 text-center">From (%)</th>
                <th className="th min-w-28 text-center">GPA</th>
                <th className="th min-w-56">Remark (report card)</th>
                <th className="th w-16 text-center" />
              </tr>
            </thead>
            <tbody>
              {scheme.bands.map((band, i) => (
                <tr key={`${band.minPercent}-${i}`} className="tr-hover">
                  <td className="td">
                    <input
                      className={`input !w-24 !px-2 text-center font-bold ${band.grade ? "" : "border-amber-300 bg-amber-50"}`}
                      value={band.grade}
                      maxLength={6}
                      placeholder="A+"
                      onChange={(e) => patchBand(i, { grade: e.target.value })}
                    />
                  </td>
                  <td className="td text-center">
                    <input
                      className="input !w-24 !px-2 text-center"
                      type="number"
                      step="1"
                      min={0}
                      max={100}
                      value={band.minPercent}
                      onChange={(e) => patchBand(i, { minPercent: e.target.value === "" ? 0 : Number(e.target.value) })}
                    />
                  </td>
                  <td className="td text-center">
                    <input
                      className="input !w-24 !px-2 text-center"
                      type="number"
                      step="0.01"
                      min={0}
                      max={scheme.gpaScale}
                      value={band.gpa}
                      onChange={(e) => patchBand(i, { gpa: e.target.value === "" ? 0 : Number(e.target.value) })}
                    />
                  </td>
                  <td className="td">
                    <input
                      className="input"
                      value={band.remark || ""}
                      placeholder="e.g. Excellent"
                      maxLength={120}
                      onChange={(e) => patchBand(i, { remark: e.target.value })}
                    />
                  </td>
                  <td className="td text-center">
                    <button
                      onClick={() => removeBand(i)}
                      disabled={scheme.bands.length <= 2}
                      title={scheme.bands.length <= 2 ? "A scheme needs at least two bands" : "Remove this band"}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {problem && (
          <div className="flex items-start gap-2 border-t border-amber-100 bg-amber-50 px-5 py-3 text-xs text-amber-800">
            <TriangleAlert size={15} className="mt-0.5 shrink-0" /> {problem}
          </div>
        )}
        <p className="flex items-start gap-2 border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          <Info size={14} className="mt-0.5 shrink-0 text-slate-400" />
          Bands are matched from the top down, so a percentage earns the first band whose “from” value it reaches. One
          band must start at 0% so that no mark is left without a grade.
        </p>
      </Card>

      {/* preview */}
      <Card>
        <CardHeader
          title="How this scale reads"
          subtitle="The strip below is exactly what a report card prints"
          action={<Badge tone="indigo">{scheme.gpaScale.toFixed(2)} scale</Badge>}
        />
        <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
          {scheme.bands.map((band, i) => (
            <div key={`${band.grade}-${i}`} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3 text-center">
              <div className="text-lg font-black text-slate-800">{band.grade}</div>
              <div className="text-[11px] font-semibold text-slate-500">{bandLabel(band)}</div>
              <div className="mt-1 text-xs font-bold text-indigo-600">{band.gpa.toFixed(2)} GPA</div>
              {band.remark && <div className="mt-0.5 text-[10px] text-slate-400">{band.remark}</div>}
            </div>
          ))}
        </div>

        <div className="border-t border-slate-100 p-5">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-40">
              <label className="label">Try a score (%)</label>
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                value={trial}
                onChange={(e) => setTrial(e.target.value)}
              />
            </div>
            {trialResult && (
              <div className="flex items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-2">
                <Award size={18} className="text-indigo-600" />
                <div className="text-sm">
                  <span className="font-black text-indigo-700">{trialResult.grade}</span>
                  <span className="ml-2 text-slate-600">{trialResult.gpa.toFixed(2)} GPA</span>
                  <span className={`ml-3 font-semibold ${trialResult.pass ? "text-emerald-600" : "text-rose-600"}`}>
                    {trialResult.pass ? "Pass" : "Fail"}
                  </span>
                </div>
              </div>
            )}
          </div>

          <p className="mt-4 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-400">
            Every percentage, one band
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {preview.map((p) => (
              <span
                key={p.pct}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
                  p.pass ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" : "bg-rose-50 text-rose-700 ring-rose-600/20"
                }`}
              >
                {p.pct}% → {p.grade} · {p.gpa.toFixed(2)}
              </span>
            ))}
          </div>
          <p className="mt-4 flex items-start gap-2 text-xs text-slate-500">
            <Info size={14} className="mt-0.5 shrink-0 text-slate-400" />
            The overall GPA is the average of the subject grade points
            {scheme.failCapsGpa ? ", unless any subject fails — then it is 0" : ""}, shown to two decimals and capped at{" "}
            {scheme.gpaScale.toFixed(2)}. Changing a band re-grades every existing exam sheet immediately — nothing
            needs re-entering.
          </p>
        </div>
      </Card>
    </div>
  );
}
