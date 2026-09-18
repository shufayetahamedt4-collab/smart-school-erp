"use client";

import { useEffect, useState } from "react";
import { FolderOpen, Eye, Download, ExternalLink } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §6.2 — Digital Teaching Material Library (admin overview). */
export default function ResourcesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<any[]>("/api/resources").then(setItems).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Teaching Materials" subtitle="All uploaded resources with analytics (PRD §6.2)" />
      <Card>
        <CardHeader title="All materials" subtitle={`${items.length} resources · most viewed first is available in the teacher panel`} />
        {items.length ? (
          <div className="divide-y divide-slate-100">
            {items.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div>
                  <p className="text-sm font-bold text-slate-800">{r.title} <span className="ml-1 text-[10px] font-normal text-slate-400">v{r.version}</span></p>
                  <p className="text-xs text-slate-500">
                    {r.classRoom?.name || "—"} · {r.subject?.name || "—"}{r.section ? ` · ${r.section.name}` : ""} · {r.teacher?.name || "Staff"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone="slate">{r.kind}</Badge>
                  <span className="flex items-center gap-1 text-xs text-slate-500"><Eye size={12} /> {r.views || 0}</span>
                  <span className="flex items-center gap-1 text-xs text-slate-500"><Download size={12} /> {r.downloads || 0}</span>
                  {r.linkUrl && <a href={r.linkUrl} target="_blank" rel="noreferrer" className="text-indigo-600"><ExternalLink size={14} /></a>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={FolderOpen} title="No materials yet" description="Teachers upload tagged resources from their panel." />
        )}
      </Card>
    </div>
  );
}
