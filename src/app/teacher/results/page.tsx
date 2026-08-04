"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BarChart3, Send, Eye } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, Select, PageHeader, LoadingScreen, statusTone, prettyStatus } from "@/components/ui";

interface Exam { id: string; name: string; published: boolean; year: number; classRoom: { name: string }; section: { name: string } | null; _count: { marks: number } }

export default function TeacherResultsPage() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Exam[]>("/api/exams").then(setExams).finally(() => setLoading(false));
  }, []);

  const togglePublish = async (e: Exam) => {
    await api(`/api/exams/${e.id}`, { method: "PATCH", body: JSON.stringify({ published: !e.published }) });
    setExams((xs) => xs.map((x) => (x.id === e.id ? { ...x, published: !x.published } : x)));
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Results" subtitle="Publish exam results so guardians can see them" />

      <div className="space-y-4">
        {exams.map((e) => (
          <Card key={e.id} className="flex flex-wrap items-center gap-4 p-5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><BarChart3 size={19} /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-extrabold text-slate-800">{e.name}</span>
                <Badge tone={e.published ? "green" : "amber"}>{e.published ? "Published" : "Draft"}</Badge>
              </div>
              <div className="text-xs text-slate-400">{e.classRoom.name}{e.section ? ` · Section ${e.section.name}` : ""} · {e._count.marks} marks entered</div>
            </div>
            <div className="flex gap-2">
              <Link href={`/dashboard/exams/${e.id}`} className="btn btn-secondary btn-sm"><Eye size={14} /> View</Link>
              <button
                onClick={() => togglePublish(e)}
                disabled={e._count.marks === 0}
                className={`btn btn-sm ${e.published ? "btn-secondary" : "btn-primary"}`}
              >
                <Send size={14} /> {e.published ? "Unpublish" : "Publish"}
              </button>
            </div>
          </Card>
        ))}
        {!exams.length && <Card className="p-10 text-center text-sm text-slate-400">No exams yet.</Card>}
      </div>
    </div>
  );
}
