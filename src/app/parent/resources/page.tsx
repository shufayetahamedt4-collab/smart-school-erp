"use client";

import { useEffect, useState } from "react";
import { FolderOpen, Eye, Download, ExternalLink } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §6.2/§7.2 — Class materials for the guardian (auto-filtered by child's class). */
export default function ParentResourcesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<any[]>("/api/resources").then(setItems).finally(() => setLoading(false));
  }, []);

  const track = (id: string, action: "view" | "download") => {
    api("/api/resources", { method: "PATCH", body: JSON.stringify({ id, action }) }).catch(() => null);
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Class Materials" subtitle="Notes, e-books and video lectures shared by teachers (PRD §6.2)" />
      <Card>
        <CardHeader title="Available materials" subtitle={`${items.length} resources for your child's class`} />
        {items.length ? (
          <div className="divide-y divide-slate-100">
            {items.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div>
                  <p className="text-sm font-bold text-slate-800">{r.title}</p>
                  <p className="text-xs text-slate-500">{r.subject?.name || "—"}{r.semester ? ` · ${r.semester}` : ""} · {r.teacher?.name || "Teacher"} · {fmtDate(r.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="slate">{r.kind}</Badge>
                  {r.linkUrl ? (
                    <a href={r.linkUrl} target="_blank" rel="noreferrer" onClick={() => track(r.id, "view")} className="btn btn-secondary btn-sm">
                      <ExternalLink size={13} /> Watch
                    </a>
                  ) : r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer" onClick={() => track(r.id, "download")} className="btn btn-primary btn-sm">
                      <Download size={13} /> Download
                    </a>
                  ) : null}
                  <span className="flex items-center gap-1 text-[11px] text-slate-400"><Eye size={11} /> {r.views || 0}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={FolderOpen} title="No materials yet" description="Materials tagged to your child's class appear here automatically." />
        )}
      </Card>
    </div>
  );
}
