/**
 * The School Admin panel loading shell.
 *
 * It draws the command-center's shape — a page header, one "Today" surface
 * (pulse strip over a divided KPI row), the attendance/attention surface, the
 * feed surface, then the three quieter supporting panels — so the frame is on
 * screen and stable while the reads resolve, instead of generic tiles that then
 * jump into place. Shared by every /dashboard/* route (there is no
 * per-subfolder loading file), and it renders inside the Shell, so it is
 * inherently scoped to the School Admin sector.
 *
 * Deliberately a server component with no dependencies.
 */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-hidden>
      <div className="mb-1.5 h-6 w-52 rounded-lg bg-slate-200" />
      <div className="mb-8 h-3.5 w-72 max-w-full rounded bg-slate-100" />

      <div className="space-y-8">
        {/* the "Today" surface: pulse strip over the KPI row */}
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <div className="border-b border-slate-100 px-4 py-3">
            <div className="h-3.5 w-14 rounded bg-slate-200" />
            <div className="mt-1.5 h-2.5 w-40 rounded bg-slate-100" />
          </div>
          <div className="grid grid-cols-2 gap-px border-b border-slate-200 bg-slate-200 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-slate-50 px-4 py-2.5">
                <div className="h-3 w-28 rounded bg-slate-200/80" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-px bg-slate-100 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="bg-white px-4 py-3.5">
                <div className="h-2.5 w-20 rounded bg-slate-100" />
                <div className="mt-2.5 h-6 w-16 rounded bg-slate-200" />
                <div className="mt-2 h-2.5 w-24 rounded bg-slate-100" />
              </div>
            ))}
            <div className="bg-white lg:hidden" />
          </div>
        </div>

        {/* attendance trend | needs your attention */}
        <div className="grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-100 lg:grid-cols-5">
          <div className="bg-white lg:col-span-3">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="h-3.5 w-36 rounded bg-slate-200" />
              <div className="mt-1.5 h-2.5 w-44 rounded bg-slate-100" />
            </div>
            <div className="p-3">
              <div className="h-52 rounded-lg bg-slate-100" />
            </div>
          </div>
          <div className="bg-white lg:col-span-2">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="h-3.5 w-32 rounded bg-slate-200" />
              <div className="mt-1.5 h-2.5 w-20 rounded bg-slate-100" />
            </div>
            <div className="space-y-3 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-5 rounded bg-slate-100" />
              ))}
            </div>
          </div>
        </div>

        {/* today's schedule | recent activity */}
        <div className="grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-100 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="bg-white">
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="h-3.5 w-32 rounded bg-slate-200" />
                <div className="mt-1.5 h-2.5 w-24 rounded bg-slate-100" />
              </div>
              <div className="space-y-3 p-4">
                {Array.from({ length: 3 }).map((__, j) => (
                  <div key={j} className="h-6 rounded bg-slate-100" />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* supporting information — quieter proportions */}
        <div className="grid gap-5 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-slate-200">
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="h-3 w-24 rounded bg-slate-200" />
              </div>
              <div className="space-y-3 p-4">
                {Array.from({ length: 2 }).map((__, j) => (
                  <div key={j} className="h-9 rounded bg-slate-100" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
