"use client";

import { useEffect, useState } from "react";
import { Images, ExternalLink } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, PageHeader, LoadingScreen, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §7.1 — Photo/Video Gallery (guardian view — the emotional-connect feature). */
export default function ParentGalleryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<any[]>("/api/gallery").then(setItems).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Gallery" subtitle="School events and class activities (PRD §7.1)" />
      <Card>
        <CardHeader title="Latest moments" subtitle={`${items.length} items`} />
        {items.length ? (
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((g) => (
              <div key={g.id} className="overflow-hidden rounded-xl border border-slate-200 fade-up">
                {g.kind === "PHOTO" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={g.url} alt={g.title} className="h-44 w-full object-cover" />
                ) : (
                  <a href={g.url} target="_blank" rel="noreferrer" className="flex h-44 items-center justify-center bg-slate-900 text-white">
                    <ExternalLink size={26} />
                  </a>
                )}
                <div className="px-3 py-2">
                  <p className="text-xs font-bold text-slate-800">{g.title}</p>
                  <p className="text-[10px] text-slate-400">{g.classRoom?.name || "Whole school"} · {fmtDate(g.date)}</p>
                  {g.caption && <p className="mt-0.5 text-[11px] text-slate-500">{g.caption}</p>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={Images} title="No photos yet" description="Event photos and class activities will appear here." />
        )}
      </Card>
    </div>
  );
}
