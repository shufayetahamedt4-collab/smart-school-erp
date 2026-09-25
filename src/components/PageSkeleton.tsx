/**
 * Route-level skeleton for the App Router `loading.tsx` files.
 *
 * Every page in this app is a client component that mounts and *then* fetches,
 * so without a loading boundary a click painted an empty panel until the data
 * arrived — the "why is it so slow?" feeling. This puts the page's shape on
 * screen on the first frame, so navigation feels immediate and the panel
 * settles into real content instead of appearing from nothing.
 *
 * Deliberately a server component (no "use client") with no dependencies, so
 * it costs nothing beyond a few divs.
 */
export function PageSkeleton({ stats = 4, rows = 6 }: { stats?: number; rows?: number }) {
  return (
    <div className="animate-pulse" aria-hidden>
      <div className="mb-1.5 h-6 w-52 rounded-lg bg-slate-200" />
      <div className="mb-6 h-3.5 w-72 max-w-full rounded bg-slate-100" />
      {stats > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: stats }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-slate-100 bg-white p-4">
              <div className="h-6 w-12 rounded bg-slate-200" />
              <div className="mt-2.5 h-3 w-20 rounded bg-slate-100" />
            </div>
          ))}
        </div>
      )}
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="mb-4 h-4 w-36 rounded bg-slate-200" />
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="h-9 rounded-lg bg-slate-100" />
          ))}
        </div>
      </div>
    </div>
  );
}
