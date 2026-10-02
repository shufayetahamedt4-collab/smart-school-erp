"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Images } from "lucide-react";
import { api } from "@/lib/client";
import { LoadingScreen } from "@/components/ui";
import { EmptyState, ErrorState, SectionHeader } from "@/components/app-ui";
import { fmtDate } from "@/lib/utils";

/** PRD §7.1 — Photo/Video Gallery (guardian view — the emotional-connect feature). */
export default function ParentGalleryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<any[]>("/api/gallery")
      .then(setItems)
      .catch((e: any) => setError(e?.message || "Couldn't load the gallery."))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div>
      <SectionHeader title="Latest moments" className="ss-flush-top" />
      {items.length ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((g) => (
            <div key={g.id} className="overflow-hidden rounded-2xl bg-white ring-1 ring-slate-900/5 fade-up">
              {g.kind === "PHOTO" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={g.url} alt={g.title} className="h-40 w-full object-cover" />
              ) : (
                <a href={g.url} target="_blank" rel="noreferrer" className="flex h-40 items-center justify-center bg-slate-900 text-white">
                  <ExternalLink size={26} />
                </a>
              )}
              <div className="px-3 py-2.5">
                <p className="text-[13px] font-bold text-slate-800">{g.title}</p>
                <p className="text-[11px] text-slate-400">
                  {g.classRoom?.name || "Whole school"} · {fmtDate(g.date)}
                </p>
                {g.caption && <p className="mt-0.5 text-[11px] text-slate-500">{g.caption}</p>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={Images} title="No photos yet" hint="Event photos and class activities will appear here." />
      )}
    </div>
  );
}
