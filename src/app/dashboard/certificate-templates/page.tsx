"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Award, Copy, FileDown, Plus, Star, Trash2 } from "lucide-react";
import { api, upload } from "@/lib/client";
import { Card, CardHeader, PageHeader, LoadingScreen, ErrorNote, EmptyState, Modal, Field, Select, TextInput, Textarea, Badge } from "@/components/ui";
import { CertificateDocument } from "@/components/CertificateDocument";
import {
  CERT_PLACEHOLDERS,
  type CertDesign,
  type CertTemplateDoc,
} from "@/lib/certificate";

/**
 * Settings → Certificate Templates (PRD §9.2 extension).
 * Schools design their own TC / Character certificates without code:
 * body text with safe placeholders, design options with school-scoped
 * image uploads, and a live preview that uses the exact print renderer.
 */

type CertType = "TC" | "CHARACTER";

interface Tpl extends Omit<CertTemplateDoc, "isDefault" | "design"> {
  isDefault: boolean;
  bodyEn: string | null;
  bodyBn: string | null;
  design: CertDesign | null;
}

const EMPTY_DESIGN: CertDesign = {
  borderStyle: "double",
  primaryColor: "#8b0000",
  fontFamily: "serif",
  orientation: "portrait",
  watermark: { kind: "none", text: "", opacity: 0.08, position: "center" },
};

const SAMPLE_VALUES = {
  studentName: "Sadia Islam",
  fatherName: "Mizanur Rahman",
  motherName: "Nusrat Hasan",
  class: "Class 1",
  section: "A",
  admissionNo: "SUN-2026-1A-001",
  admissionDate: "1 January 2026",
  leaveDate: "",
  serialNo: "CERT-TC-2026-PREVIEW",
  schoolName: "Sunrise International School",
  dateOfBirth: "15 March 2015",
  issueDate: "21 September 2026",
  conduct: "Good",
  academicYear: "2026",
  rollNo: "01",
};

const PLACEHOLDER_LABELS: Partial<Record<(typeof CERT_PLACEHOLDERS)[number], string>> = {
  studentName: "Student name",
  fatherName: "Father name",
  motherName: "Mother name",
  class: "Class",
  section: "Section",
  admissionNo: "Admission no.",
  admissionDate: "Admission date",
  leaveDate: "Leaving date",
  serialNo: "Serial no.",
  schoolName: "School name",
  dateOfBirth: "Date of birth",
  issueDate: "Issue date",
  conduct: "Conduct",
  academicYear: "Academic year",
  rollNo: "Roll no.",
};

function designOf(t: Tpl | null): CertDesign {
  const base = t?.design || {};
  const wm: NonNullable<CertDesign["watermark"]> = base.watermark ?? {
    kind: "none",
    text: "",
    imageUrl: null,
    opacity: 0.08,
    position: "center",
  };
  return {
    ...EMPTY_DESIGN,
    ...base,
    watermark: {
      kind: wm.kind ?? "none",
      text: wm.text ?? "",
      imageUrl: wm.imageUrl ?? null,
      opacity: wm.opacity ?? 0.08,
      position: wm.position ?? "center",
    },
  };
}

function ImageUpload({
  label,
  hint,
  url,
  onChange,
  onUploaded,
}: {
  label: string;
  hint?: string;
  url?: string | null;
  onChange: (v: string | null) => void;
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const pick = async (file: File) => {
    setBusy(true);
    setErr("");
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await upload("/api/uploads?kind=certificate", form);
      onChange(data.url);
      onUploaded();
    } catch (e: any) {
      setErr(e.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field label={label} hint={hint || "JPG/PNG/WebP · max 2MB · stored in your school's private certificates folder"}>
      <div className="flex items-center gap-2">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
            e.currentTarget.value = "";
          }}
          className="input py-1.5 text-xs"
        />
        {url ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="h-9 w-9 rounded border border-slate-200 object-contain" />
            <button type="button" className="btn btn-ghost btn-sm text-rose-600" onClick={() => onChange(null)}>
              <Trash2 size={13} />
            </button>
          </>
        ) : null}
      </div>
      {busy && <p className="mt-1 text-xs text-slate-400">Uploading…</p>}
      {err && <p className="mt-1 text-xs text-rose-600">{err}</p>}
    </Field>
  );
}

export default function CertificateTemplatesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<Tpl[]>([]);

  const [typeFilter, setTypeFilter] = useState<CertType>("TC");
  const [active, setActive] = useState<Tpl | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [flash, setFlash] = useState("");
  const [previewLang, setPreviewLang] = useState<"en" | "bn">("en");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ templates: Tpl[] }>("/api/certificate-templates");
      setTemplates(data.templates);
      setError("");
    } catch (e: any) {
      setError(e.message || "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => templates.filter((t) => t.type === typeFilter), [templates, typeFilter]);

  const newTemplate = (): Tpl => ({
    id: "",
    schoolId: "",
    type: typeFilter,
    name: typeFilter === "TC" ? "My Transfer Certificate" : "My Character Certificate",
    isDefault: visible.length === 0,
    bodyEn: "",
    bodyBn: "",
    design: null,
  });

  const patch = (p: Partial<Tpl>) => setActive((a) => (a ? { ...a, ...p } : a));
  const patchDesign = (p: Partial<CertDesign>) =>
    setActive((a) => (a ? { ...a, design: { ...designOf(a), ...p } } : a));

  const insertPlaceholder = (ph: string, target: "en" | "bn") => {
    if (!active) return;
    const token = `{{${ph}}}`;
    if (target === "en") patch({ bodyEn: `${(active.bodyEn || "").trimEnd()}${active.bodyEn ? " " : ""}${token}` });
    else patch({ bodyBn: `${(active.bodyBn || "").trimEnd()}${active.bodyBn ? " " : ""}${token}` });
  };

  const save = async () => {
    if (!active) return;
    setSaving(true);
    setSaveError("");
    try {
      const payload = {
        type: active.type,
        name: active.name,
        isDefault: active.isDefault,
        bodyEn: active.bodyEn?.trim() || null,
        bodyBn: active.bodyBn?.trim() || null,
        design: designOf(active),
      };
      if (active.id) {
        await api(`/api/certificate-templates/${active.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        const created = await api<Tpl>("/api/certificate-templates", { method: "POST", body: JSON.stringify(payload) });
        setActive(created);
      }
      setFlash("Template saved.");
      await load();
      setTimeout(() => setFlash(""), 2500);
    } catch (e: any) {
      setSaveError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const setDefault = async (t: Tpl) => {
    try {
      await api(`/api/certificate-templates/${t.id}`, { method: "PATCH", body: JSON.stringify({ isDefault: true }) });
      await load();
      if (active?.id === t.id) patch({ isDefault: true });
      setFlash(`"${t.name}" is now the default for ${t.type === "TC" ? "Transfer" : "Character"} certificates.`);
      setTimeout(() => setFlash(""), 2500);
    } catch (e: any) {
      setSaveError(e.message || "Failed to set default");
    }
  };

  const remove = async (t: Tpl) => {
    if (!confirm(`Delete template "${t.name}"? This cannot be undone.`)) return;
    try {
      await api(`/api/certificate-templates/${t.id}`, { method: "DELETE" });
      if (active?.id === t.id) setActive(null);
      await load();
      setFlash("Template deleted.");
      setTimeout(() => setFlash(""), 2500);
    } catch (e: any) {
      setSaveError(e.message || "Delete failed");
    }
  };

  const duplicate = async (t: Tpl) => {
    try {
      await api("/api/certificate-templates", {
        method: "POST",
        body: JSON.stringify({
          type: t.type,
          name: `${t.name} (copy)`,
          isDefault: false,
          bodyEn: t.bodyEn,
          bodyBn: t.bodyBn,
          design: t.design,
        }),
      });
      await load();
      setFlash("Template duplicated.");
      setTimeout(() => setFlash(""), 2500);
    } catch (e: any) {
      setSaveError(e.message || "Duplicate failed");
    }
  };

  if (loading) return <LoadingScreen />;
  if (error && !templates.length) return <ErrorNote message={error} />;

  const editing = active && (active.id ? templates.some((t) => t.id === active.id) : true) ? active : null;

  return (
    <div>
      <PageHeader
        title="Certificate Templates"
        subtitle="Design your Transfer & Character certificates — no code needed. Print output matches this preview exactly."
        actions={
          <button className="btn btn-primary" onClick={() => { setSaveError(""); setActive(newTemplate()); }}>
            <Plus size={15} /> New template
          </button>
        }
      />

      {flash && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">{flash}</div>
      )}
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="mb-5 flex gap-2">
        {(["TC", "CHARACTER"] as const).map((t) => (
          <button
            key={t}
            onClick={() => { setTypeFilter(t); setActive(null); }}
            className={`btn ${typeFilter === t ? "btn-primary" : "btn-secondary"}`}
          >
            <Award size={15} /> {t === "TC" ? "Transfer Certificates" : "Character Certificates"}
          </button>
        ))}
      </div>

      {editing ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {/* ------------------------- editor ------------------------- */}
          <div className="space-y-4">
            <Card>
              <CardHeader
                title={editing.id ? "Edit template" : "New template"}
                action={
                  <div className="flex items-center gap-2">
                    {editing.id ? (
                      <>
                        {!editing.isDefault && (
                          <button className="btn btn-ghost btn-sm" onClick={() => setDefault(editing)}>
                            <Star size={13} /> Set default
                          </button>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => duplicate(editing)}>
                          <Copy size={13} /> Duplicate
                        </button>
                        <button className="btn btn-ghost btn-sm text-rose-600" onClick={() => remove(editing)}>
                          <Trash2 size={13} />
                        </button>
                      </>
                    ) : null}
                    <button className="btn btn-ghost btn-sm" onClick={() => setActive(null)}>Close</button>
                  </div>
                }
              />
              <div className="space-y-4 px-5 py-4">
                {saveError && <ErrorNote message={saveError} />}

                <div className="flex items-end gap-3">
                  <Field label="Template name" className="flex-1">
                    <TextInput value={editing.name} onChange={(e) => patch({ name: e.target.value })} maxLength={80} />
                  </Field>
                  <Field label="Type">
                    <Select value={editing.type} disabled onChange={() => {}} className="w-40">
                      <option value="TC">Transfer Certificate</option>
                      <option value="CHARACTER">Character Certificate</option>
                    </Select>
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={editing.isDefault}
                    onChange={(e) => patch({ isDefault: e.target.checked })}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Default for {editing.type === "TC" ? "Transfer" : "Character"} certificates (used when printing)
                </label>
              </div>
            </Card>

            <Card>
              <CardHeader title="Certificate body" subtitle="Plain text only — **bold** supported, [[conditional text with {{placeholder}}]] hides itself when data is missing." />
              <div className="space-y-4 px-5 py-4">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="label mb-0">English body</label>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreviewLang("en")}>
                      <FileDown size={12} /> Preview English
                    </button>
                  </div>
                  <Textarea
                    value={editing.bodyEn || ""}
                    onChange={(e) => patch({ bodyEn: e.target.value })}
                    className="min-h-32 font-mono text-xs"
                    placeholder="Leave empty to keep the built-in English wording."
                  />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {CERT_PLACEHOLDERS.map((ph) => (
                      <button
                        key={ph}
                        type="button"
                        title={`Insert {{${ph}}} — ${PLACEHOLDER_LABELS[ph]}`}
                        onClick={() => insertPlaceholder(ph, "en")}
                        className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600 hover:bg-slate-200"
                      >
                        {`{{${ph}}}`}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="label mb-0">Bangla body (বাংলা)</label>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreviewLang("bn")}>
                      <FileDown size={12} /> প্রিভিউ বাংলা
                    </button>
                  </div>
                  <Textarea
                    value={editing.bodyBn || ""}
                    onChange={(e) => patch({ bodyBn: e.target.value })}
                    className="min-h-32 font-mono text-xs"
                    placeholder="খালি রাখলে ডিফল্ট বাংলা লেখা ব্যবহৃত হবে।"
                  />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {CERT_PLACEHOLDERS.map((ph) => (
                      <button
                        key={ph}
                        type="button"
                        onClick={() => insertPlaceholder(ph, "bn")}
                        className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600 hover:bg-slate-200"
                      >
                        {`{{${ph}}}`}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-slate-400">
                  Leaving a body empty falls back to the platform's built-in wording (English + Bangla).
                </p>
              </div>
            </Card>

            <Card>
              <CardHeader title="Design" subtitle="All images upload to your school's own storage folder — cross-school URLs are rejected." />
              <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
                <ImageUpload
                  label="Logo"
                  url={designOf(editing).logoUrl}
                  onChange={(v) => patchDesign({ logoUrl: v })}
                  onUploaded={() => {}}
                />
                <ImageUpload
                  label="School seal"
                  url={designOf(editing).sealImageUrl}
                  onChange={(v) => patchDesign({ sealImageUrl: v })}
                  onUploaded={() => {}}
                />
                <ImageUpload
                  label="Principal signature"
                  url={designOf(editing).principalSignatureUrl}
                  onChange={(v) => patchDesign({ principalSignatureUrl: v })}
                  onUploaded={() => {}}
                />
                <ImageUpload
                  label="Class teacher signature"
                  url={designOf(editing).classTeacherSignatureUrl}
                  onChange={(v) => patchDesign({ classTeacherSignatureUrl: v })}
                  onUploaded={() => {}}
                />

                <Field label="Border style">
                  <Select value={designOf(editing).borderStyle} onChange={(e) => patchDesign({ borderStyle: e.target.value as CertDesign["borderStyle"] })}>
                    <option value="double">Double rule (classic)</option>
                    <option value="simple">Simple line</option>
                    <option value="none">None</option>
                  </Select>
                </Field>
                <Field label="Primary color">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={designOf(editing).primaryColor || "#8b0000"}
                      onChange={(e) => patchDesign({ primaryColor: e.target.value })}
                      className="h-9 w-12 cursor-pointer rounded border border-slate-300"
                    />
                    <TextInput value={designOf(editing).primaryColor || ""} onChange={(e) => patchDesign({ primaryColor: e.target.value })} placeholder="#8b0000" />
                  </div>
                </Field>
                <Field label="Font">
                  <Select value={designOf(editing).fontFamily} onChange={(e) => patchDesign({ fontFamily: e.target.value as CertDesign["fontFamily"] })}>
                    <option value="serif">Serif (formal)</option>
                    <option value="sans">Sans (modern)</option>
                    <option value="bengali">Noto Sans Bengali</option>
                  </Select>
                </Field>
                <Field label="Paper (A4)">
                  <Select value={designOf(editing).orientation} onChange={(e) => patchDesign({ orientation: e.target.value as CertDesign["orientation"] })}>
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </Select>
                </Field>
                <Field label="Header text" className="sm:col-span-2" hint="Optional motto / EIIN line under the school name.">
                  <TextInput value={designOf(editing).headerText || ""} onChange={(e) => patchDesign({ headerText: e.target.value })} />
                </Field>
                <Field label="Footer text" className="sm:col-span-2" hint="Replaces the default 'Issued on …' line.">
                  <TextInput value={designOf(editing).footerText || ""} onChange={(e) => patchDesign({ footerText: e.target.value })} />
                </Field>
                <Field label="Left signatory label">
                  <TextInput value={designOf(editing).signatoryLeftLabel || ""} onChange={(e) => patchDesign({ signatoryLeftLabel: e.target.value })} placeholder="Class Teacher" />
                </Field>
                <Field label="Right signatory label">
                  <TextInput value={designOf(editing).signatoryRightLabel || ""} onChange={(e) => patchDesign({ signatoryRightLabel: e.target.value })} placeholder="Principal" />
                </Field>

                <div className="sm:col-span-2">
                  <label className="label">Watermark</label>
                  <div className="grid gap-3 sm:grid-cols-4">
                    <Select
                      value={designOf(editing).watermark?.kind || "none"}
                      onChange={(e) => patchDesign({ watermark: { ...designOf(editing).watermark!, kind: e.target.value as any } })}
                    >
                      <option value="none">None</option>
                      <option value="text">Text</option>
                      <option value="image">Image</option>
                    </Select>
                    {designOf(editing).watermark?.kind === "text" && (
                      <TextInput
                        placeholder="e.g. OFFICIAL"
                        value={designOf(editing).watermark?.text || ""}
                        onChange={(e) => patchDesign({ watermark: { ...designOf(editing).watermark!, text: e.target.value } })}
                      />
                    )}
                    {designOf(editing).watermark?.kind === "image" && (
                      <div className="sm:col-span-2">
                        <ImageUpload
                          label=""
                          url={designOf(editing).watermark?.imageUrl}
                          onChange={(v) => patchDesign({ watermark: { ...designOf(editing).watermark!, imageUrl: v } })}
                          onUploaded={() => {}}
                        />
                      </div>
                    )}
                    <Select
                      value={designOf(editing).watermark?.position || "center"}
                      onChange={(e) => patchDesign({ watermark: { ...designOf(editing).watermark!, position: e.target.value as any } })}
                    >
                      <option value="center">Center</option>
                      <option value="top-left">Top left</option>
                      <option value="top-right">Top right</option>
                      <option value="bottom-left">Bottom left</option>
                      <option value="bottom-right">Bottom right</option>
                    </Select>
                    <label className="flex items-center gap-2 text-xs text-slate-500">
                      Opacity
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round((designOf(editing).watermark?.opacity ?? 0.08) * 100)}
                        onChange={(e) => patchDesign({ watermark: { ...designOf(editing).watermark!, opacity: Number(e.target.value) / 100 } })}
                        className="w-full"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {/* ------------------------- preview ------------------------- */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-800">Live preview</h3>
                <div className="flex items-center gap-2">
                  <Badge tone={editing.isDefault ? "green" : "slate"}>{editing.isDefault ? "Default template" : "Draft"}</Badge>
                  <div className="flex overflow-hidden rounded-lg border border-slate-200 text-[11px]">
                    {(["en", "bn"] as const).map((l) => (
                      <button key={l} onClick={() => setPreviewLang(l)}
                        className={`px-2.5 py-1 font-bold ${previewLang === l ? "brand-bg text-white" : "bg-white text-slate-500"}`}>
                        {l === "en" ? "EN" : "বাং"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-100 p-3">
                <div className="mx-auto" style={{ maxWidth: 560 }}>
                  <CertificateDocument
                    type={editing.type}
                    serial="CERT-TC-2026-PREVIEW"
                    generatedAt={new Date().toISOString()}
                    bodyEn={editing.bodyEn || null}
                    bodyBn={editing.bodyBn || null}
                    design={designOf(editing)}
                    values={SAMPLE_VALUES as any}
                    school={{
                      name: SAMPLE_VALUES.schoolName,
                      address: "42 Sholakia Road, Kishoreganj",
                      phone: "+880 1711 000000",
                      email: "info@sunrise.edu",
                      logoUrl: null,
                    }}
                    lang={previewLang}
                  />
                </div>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                Preview uses sample data. Placeholders whose value is missing (like <code>leaveDate</code> here)
                drop the whole <code>[[…]]</code> sentence — exactly as missing data will behave on real certificates.
              </p>
              <div className="mt-3 flex justify-end">
                <button className="btn btn-primary" disabled={saving} onClick={save}>
                  {saving ? "Saving…" : editing.id ? "Save changes" : "Create template"}
                </button>
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <Card>
          <CardHeader title={`${typeFilter === "TC" ? "Transfer" : "Character"} certificate templates`} subtitle="The default template is used automatically when printing a certificate." />
          {visible.length === 0 ? (
            <EmptyState
              icon={Award}
              title="No custom templates yet"
              description="Certificates currently use the built-in design. Create a template to add your logo, seal, signatures, watermark and Bangla wording."
              action={
                <button className="btn btn-primary btn-sm" onClick={() => { setSaveError(""); setActive(newTemplate()); }}>
                  <Plus size={14} /> Create your first template
                </button>
              }
            />
          ) : (
            <div className="divide-y divide-slate-100">
              {visible.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-800">{t.name}</span>
                      {t.isDefault && <Badge tone="green">Default</Badge>}
                      {!t.bodyEn && !t.bodyBn && <Badge tone="slate">built-in wording</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {t.bodyEn ? "EN ✓ " : "EN — "}
                      {t.bodyBn ? "· BN ✓ " : "· BN — "}
                      {t.design?.sealImageUrl ? "· seal ✓" : ""}
                      {t.design?.principalSignatureUrl ? "· signature ✓" : ""}
                      {t.design?.watermark && t.design.watermark.kind !== "none" ? "· watermark ✓" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button className="btn btn-secondary btn-sm" onClick={() => { setSaveError(""); setActive(structuredClone(t)); }}>Edit</button>
                    {!t.isDefault && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setDefault(t)}>
                        <Star size={13} /> Make default
                      </button>
                    )}
                    <button className="btn btn-ghost btn-sm text-rose-600" onClick={() => remove(t)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
