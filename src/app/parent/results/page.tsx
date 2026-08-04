"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileText, Download } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, PageHeader, LoadingScreen, EmptyState } from "@/components/ui";
import { useMe } from "@/components/Shell";

export default function ParentResultsPage() {
  const { me } = useMe();
  const [exams, setExams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!me?.student) return;
    Promise.all([api("/api/exams"), api(`/api/students/${me.student.id}`)])
      .then(([ex, st]: any) => {
        const published = ex.filter((e: any) => e.published && e.classId === st.classId);
        setExams(published);
      })
      .finally(() => setLoading(false));
  }, [me]);

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Exam Results" subtitle="Published results & report cards" />

      <div className="space-y-4">
        {exams.length ? exams.map((e) => (
          <Card key={e.id} className="flex flex-wrap items-center gap-4 p-5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><FileText size={19} /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-extrabold text-slate-800">{e.name}</span>
                <Badge tone="green">Published</Badge>
              </div>
              <div className="text-xs text-slate-400">{e.classRoom.name}{e.section ? ` · Section ${e.section.name}` : ""} · {e.year}</div>
            </div>
            <Link href={`/print/report-card/${e.id}/${me!.student!.id}`} className="btn btn-primary btn-sm">
              <Download size={14} /> Report card
            </Link>
          </Card>
        )) : (
          <Card><EmptyState icon={FileText} title="No published results yet" description="Results appear here once the school publishes them." /></Card>
        )}
      </div>
    </div>
  );
}
