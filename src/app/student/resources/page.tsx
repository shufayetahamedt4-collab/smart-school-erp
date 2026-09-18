"use client";

import { useEffect, useState } from "react";
import { FolderOpen, Download, FileText, Video, BookOpen } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, EmptyState, LoadingScreen } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/**
 * PRD §7.2 — Digital Library access for students: materials uploaded by
 * teachers, auto-filtered to the student's own class (§6.2 tagging rule).
 */

interface ResourceRow {
  id: string; title: string; kind: string; url: string; description: string | null; createdAt: string;
  subject?: { name: string } | null;
  teacher?: { user?: { name: string } | null } | null;
}

const KIND_ICONS: Record<string, any> = { PDF: FileText, EBOOK: BookOpen, VIDEO: Video, COMIC: BookOpen, SLIDES: FileText, WORKSHEET: FileText, LINK: Download };
const KIND_LABEL: Record<string, string> = { PDF: "PDF", EBOOK: "E-book", VIDEO: "Video", COMIC: "Comic", SLIDES: "Slides", WORKSHEET: "Worksheet", LINK: "Link" };

export default function StudentResourcesPage() {
  const [resources, setResources] = useState<ResourceRow[] | null>(null);

  useEffect(() => {
    api<{ resources: ResourceRow[] }>("/api/student/me")
      .then((d) => setResources(d.resources || []))
      .catch(() => setResources([]));
  }, []);

  if (!resources) return <LoadingScreen label="Loading library…" />;

  return (
    <div>
      <PageHeader title="Digital Library" subtitle="Notes, e-books and worksheets for my class (PRD §6.2/§7.2)" />

      <Card>
        <CardHeader title="My class materials" subtitle={`${resources.length} item(s) available`} />
        {resources.length ? (
          <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
            {resources.map((r) => {
              const Icon = KIND_ICONS[r.kind] || FileText;
              return (
                <div key={r.id} className="flex items-center gap-3 rounded-2xl border border-slate-200 p-4 transition hover:border-indigo-300">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                    <Icon size={19} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold text-slate-800">{r.title}</div>
                    <div className="text-xs text-slate-400">
                      {r.subject?.name || "General"} · {KIND_LABEL[r.kind] || r.kind} · {fmtDate(r.createdAt)}
                      {r.teacher?.user?.name ? ` · ${r.teacher.user.name}` : ""}
                    </div>
                  </div>
                  <a href={r.url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
                    <Download size={12} /> Open
                  </a>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={FolderOpen} title="No materials yet" description="Resources your teachers upload for your class appear here." />
        )}
      </Card>
    </div>
  );
}
