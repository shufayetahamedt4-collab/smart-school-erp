"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink, Eye, FolderOpen } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen } from "@/components/ui";
import { EmptyState, ErrorState, ListCard, ListRow, SectionHeader } from "@/components/app-ui";
import { fmtDate } from "@/lib/utils";

/** PRD §6.2/§7.2 — Class materials for the guardian (auto-filtered by child's class). */
export default function ParentResourcesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<any[]>("/api/resources")
      .then(setItems)
      .catch((e: any) => setError(e?.message || "Couldn't load the materials."))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const track = (id: string, action: "view" | "download") => {
    api("/api/resources", { method: "PATCH", body: JSON.stringify({ id, action }) }).catch(() => null);
  };

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div>
      <SectionHeader title="Available materials" className="ss-flush-top" />
      {items.length ? (
        <ListCard>
          {items.map((r) => (
            <ListRow
              key={r.id}
              icon={FolderOpen}
              tone="violet"
              title={r.title}
              subtitle={`${r.subject?.name || "—"}${r.semester ? ` · ${r.semester}` : ""} · ${r.teacher?.name || "Teacher"} · ${fmtDate(r.createdAt)}`}
              trailing={
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone="slate">{r.kind}</Badge>
                  {r.linkUrl ? (
                    <a href={r.linkUrl} target="_blank" rel="noreferrer" onClick={() => track(r.id, "view")} className="btn btn-secondary btn-sm min-h-11">
                      <ExternalLink size={13} /> Watch
                    </a>
                  ) : r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer" onClick={() => track(r.id, "download")} className="btn btn-primary btn-sm min-h-11">
                      <Download size={13} /> Download
                    </a>
                  ) : null}
                  <span className="hidden items-center gap-1 text-[11px] text-slate-400 sm:flex">
                    <Eye size={11} /> {r.views || 0}
                  </span>
                </div>
              }
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState icon={FolderOpen} title="No materials yet" hint="Materials tagged to your child's class appear here automatically." />
      )}
    </div>
  );
}
