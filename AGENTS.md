# AGENTS.md — non-negotiable rules for this project

These two rules override everything else. Re-read them before starting any task and
verify BOTH before declaring any task finished. They have been stated repeatedly by
the project owner and must never be forgotten or silently regressed.

---

## RULE 1 — The apps' logins stay SEPARATED by sector. Never merge them onto one page.

The product is "one platform, separate apps". Each app has its own host, its own
sign-in screen, and shows ONLY its own credentials:

| Host (dev)              | App            | Roles served                                   | Lands on    |
|-------------------------|----------------|------------------------------------------------|-------------|
| `admin.localhost`       | Platform Console | `SUPER_ADMIN`                                | `/admin`    |
| `school.localhost`      | School Admin   | `SCHOOL_ADMIN`, `BRANCH_ADMIN`, `REGISTRAR`, `ACCOUNTANT`, `LIBRARIAN`, `FRONT_DESK` | `/dashboard` |
| `teacher.localhost`     | Teacher App    | `TEACHER`                                      | `/teacher`  |
| `parents.localhost`     | Parents App    | `GUARDIAN`                                     | `/parent`   |
| bare domain / bare IP   | Hub            | every account (account decides the app)        | role home   |

Source of truth: `src/lib/sectors.ts` (the `SECTORS` registry) and
`src/components/LoginForm.tsx` (`const demos = hub ? DEMO : DEMO.filter(d => d.sector === sectorKey)`).

Rules:
- An **app host** must show ONLY that sector's sign-in and demo credentials, and only
  the entry points that belong to it (e.g. the QR/guardian login exists on the Parents
  App and the hub — never on the Super Admin console or the Teacher App).
- The **hub** (bare domain / bare IP / platform URL) is the ONLY place a single form
  offering every account is allowed. On a `<label>.localhost` / `APP_DOMAIN` deployment
  the hub shows the **PortalChooser** directory of the four apps, not a merged form.
- Do **NOT** collapse sector sign-in screens into one page. Do **NOT** widen
  `SHARED_PREFIXES` or `resolveSector` to make an app host serve another app's login.
- Server-side sector enforcement (`sectorMismatch` in `src/app/api/auth/login/route.ts`)
  must stay: a teacher account on `school.localhost` must be refused (403).

**When previewing/testing, use a SECTOR HOST, never a bare IP.**
- Correct: `http://school.localhost:3000/login`, `http://teacher.localhost:3000/login`, etc.
  (or `http://localhost:3000/login` for the hub directory).
- Wrong: `http://127.0.0.1:3000/login` — a bare IP is the host-agnostic HUB and will show
  the single all-roles form, which looks like a regression and is not one.

---

## RULE 2 — Every click loads instantly. No latency, anywhere, ever.

Target: click → content, "boom". A login must NOT take 20–30 s (or even 6–10 s). This
applies to every screen, every button, every option in the whole project — not just login.

How this project must achieve it (see the diagnosis in `_perf-remediation/`):
- The backend is Firestore via a hand-written shim (`src/lib/db.ts`). **Every query is a
  remote round trip (~0.65–1.0 s each here).** Latency = `(number of serial round trips) × RTT`.
  Cut BOTH factors.
- Push query filters DOWN (safe subset: scalar equality + single-field `in`); never pull a
  whole collection to filter in memory. `filterList` re-applies the full predicate, so a
  pushed subset is always safe.
- Serve **stale-while-revalidate** from cache and recompute in the background; collapse
  concurrent identical reads (single-flight). Cache must be keyed per user+school and
  invalidated on writes (narrowly, per school/model).
- Keep caches warm: warm-up prefetch on hover/navigation; never let the visible page's own
  reads queue behind a background batch.
- Do no avoidable work on the critical path (e.g. don't read 2FA status for roles that can
  never have 2FA; don't await audit writes that the user doesn't need before landing).

**Verify before finishing:** measure the actual click→useful-content time on the real
screen. A passing build is not proof. If it's not instant, it's not done.

---

## Checklist to run BEFORE declaring ANY task finished

1. [ ] Sector separation intact — app hosts show only their own login/credentials; hub is
       the only merged surface; `sectorMismatch` still enforced. Tested on a SECTOR HOST.
2. [ ] Every touched interaction is instant — no new round trips on the critical path, no
       whole-collection scans, caches warm; latency measured, not assumed.
