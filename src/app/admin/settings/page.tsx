"use client";

import { useEffect, useState } from "react";
import { Save, Globe } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Field, TextInput, PageHeader, LoadingScreen, ErrorNote } from "@/components/ui";

export default function AdminSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Record<string, string>>("/api/settings").then(setSettings).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingScreen />;

  const save = async () => {
    setSaving(true);
    setError("");
    setDone(false);
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify(settings) });
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const set = (k: string, v: string) => setSettings((s) => ({ ...s, [k]: v }));

  return (
    <div className="max-w-2xl">
      <PageHeader title="Global Settings" subtitle="Platform-wide configuration" />
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}
      <Card>
        <CardHeader title="Platform" subtitle="Applied across all schools" />
        <div className="space-y-4 p-5">
          <Field label="Platform name">
            <TextInput value={settings.site_name || ""} onChange={(e) => set("site_name", e.target.value)} />
          </Field>
          <Field label="Support email">
            <TextInput value={settings.support_email || ""} onChange={(e) => set("support_email", e.target.value)} placeholder="support@platform.com" />
          </Field>
          <Field label="Default guardian password">
            <TextInput value={settings.default_guardian_password || ""} onChange={(e) => set("default_guardian_password", e.target.value)} placeholder="Guardian@123" />
          </Field>
          <div className="flex items-center justify-between rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
            <span className="flex items-center gap-2 font-semibold"><Globe size={15} /> Multi-tenant SaaS is enabled</span>
          </div>
          <div className="flex justify-end">
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              <Save size={15} /> {saving ? "Saving…" : done ? "Saved ✓" : "Save settings"}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
