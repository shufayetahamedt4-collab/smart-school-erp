import type { SectorKey } from "@/lib/sectors";

/**
 * What each screen reads — the map that lets a click happen *before* it happens.
 *
 * Every page in this app is a client component that mounts and then fetches, so
 * a click costs an RSC round trip and then a data round trip. A Firestore read
 * on the owner's network costs 0.5–1.2s cold, so that second round trip is the
 * whole "why is it slow?" complaint. Warming the reads a screen is *about* to
 * need — on hover, and for the whole sector right after sign-in — turns the
 * click into a memo hit and the fetch into a cache hit.
 *
 * Keep this list honest: it is safe (and useful) to name an endpoint the user
 * may not be allowed to read, because a prefetch never surfaces its error, but
 * a missing entry just means that screen is not pre-warmed. Detail pages are
 * intentionally absent: they take an id, and the collection pull they need is
 * already warmed by their list endpoint.
 */
const ROUTE_DATA: Record<string, string[]> = {
  // ---- dashboard (school admin / branch admin / back-office staff) ----
  "/dashboard": ["/api/stats", "/api/notices?limit=5"],
  "/dashboard/admissions": ["/api/admissions", "/api/classes", "/api/sections", "/api/books", "/api/branches"],
  "/dashboard/admissions/new": ["/api/classes", "/api/admissions/intake"],
  "/dashboard/students": ["/api/students", "/api/classes", "/api/branches"],
  "/dashboard/students/new": ["/api/classes"],
  "/dashboard/teachers": ["/api/teachers", "/api/classes", "/api/subjects", "/api/branches"],
  "/dashboard/classes": ["/api/classes"],
  "/dashboard/subjects": ["/api/subjects"],
  "/dashboard/routine": ["/api/classes", "/api/subjects"],
  "/dashboard/exams": ["/api/exams", "/api/classes", "/api/subjects"],
  "/dashboard/grades": ["/api/grading-scheme", "/api/subjects"],
  "/dashboard/notices": ["/api/notices"],
  "/dashboard/fees": ["/api/fees", "/api/branches"],
  "/dashboard/ledger": ["/api/ledger"],
  "/dashboard/leaves": ["/api/leave-requests"],
  "/dashboard/meetings": ["/api/meetings", "/api/teachers"],
  "/dashboard/gallery": ["/api/gallery", "/api/classes"],
  "/dashboard/complaints": ["/api/complaints"],
  "/dashboard/promotion": ["/api/students/alumni", "/api/classes"],
  "/dashboard/library": ["/api/books", "/api/books/issues"],
  "/dashboard/resources": ["/api/resources", "/api/classes", "/api/subjects", "/api/sections"],
  "/dashboard/guardians": ["/api/guardians", "/api/students"],
  "/dashboard/id-cards": ["/api/classes"],
  "/dashboard/reports": ["/api/classes", "/api/exams"],
  "/dashboard/messages": ["/api/messages", "/api/chat"],
  "/dashboard/branches": ["/api/branches", "/api/staff"],
  "/dashboard/staff": ["/api/staff", "/api/branches"],
  "/dashboard/settings": ["/api/settings"],

  // ---- teacher ----
  "/teacher": ["/api/stats"],
  "/teacher/attendance": ["/api/classes", "/api/attendance"],
  "/teacher/remarks": ["/api/classes", "/api/remarks"],
  "/teacher/homework": ["/api/homework?mine=1", "/api/classes", "/api/subjects"],
  "/teacher/marks": ["/api/exams", "/api/subjects"],
  "/teacher/results": ["/api/exams"],
  "/teacher/grades": ["/api/grading-scheme", "/api/subjects"],
  "/teacher/resources": ["/api/resources", "/api/classes", "/api/subjects", "/api/sections"],
  "/teacher/quizzes": ["/api/quizzes?mine=1", "/api/classes", "/api/subjects"],
  "/teacher/leaves": ["/api/leave-requests"],
  "/teacher/meetings": ["/api/meetings"],
  "/teacher/messages": ["/api/chat", "/api/messages"],

  // ---- parents app ----
  "/parent": ["/api/stats", "/api/notices?limit=3"],
  "/parent/attendance": ["/api/stats"],
  "/parent/homework": ["/api/homework"],
  "/parent/quizzes": ["/api/quizzes/available"],
  "/parent/remarks": ["/api/stats"],
  "/parent/results": ["/api/exams", "/api/stats"],
  "/parent/fees": ["/api/fees"],
  "/parent/books": ["/api/books/issues"],
  "/parent/resources": ["/api/resources"],
  "/parent/gallery": ["/api/gallery"],
  "/parent/meetings": ["/api/meetings"],
  "/parent/leave": ["/api/leave-requests"],
  "/parent/feedback": ["/api/complaints"],
  "/parent/notices": ["/api/notices"],
  "/parent/messages": ["/api/chat", "/api/messages"],
  "/parent/profile": ["/api/parent/siblings"],

  // ---- platform console ----
  "/admin": ["/api/schools", "/api/subscriptions"],
  "/admin/schools": ["/api/schools", "/api/plans"],
  "/admin/billing": ["/api/plans", "/api/subscriptions", "/api/schools"],
  "/admin/settings": ["/api/settings"],
};

/**
 * The reads worth warming for a whole sector at sign-in, in rough order of how
 * soon they are likely to be needed. Reference data (classes/sections/subjects)
 * is shared by nearly every screen, so warming it once makes the first click on
 * any of them fast. Endpoints the role may not be allowed to read are harmless
 * here: the prefetch swallows the 403.
 */
const SECTOR_WARM: Record<SectorKey, string[]> = {
  super: ["/api/schools", "/api/subscriptions", "/api/plans", "/api/settings"],
  school: [
    "/api/stats",
    "/api/notifications?countOnly=1",
    "/api/classes",
    "/api/sections",
    "/api/subjects",
    "/api/students",
    "/api/teachers",
    "/api/notices?limit=5",
    "/api/exams",
    "/api/grading-scheme",
    "/api/fees",
    "/api/admissions",
    "/api/ledger",
    "/api/leave-requests",
    "/api/routines",
    "/api/meetings",
    "/api/resources",
    "/api/gallery",
    "/api/complaints",
    "/api/books",
    "/api/branches",
  ],
  teacher: [
    "/api/stats",
    "/api/notifications?countOnly=1",
    "/api/classes",
    "/api/subjects",
    "/api/sections",
    "/api/students",
    "/api/homework?mine=1",
    "/api/exams",
    "/api/grading-scheme",
    "/api/remarks",
    "/api/leave-requests",
    "/api/meetings",
    "/api/resources",
    "/api/quizzes?mine=1",
  ],
  guardian: [
    "/api/stats",
    "/api/notifications?countOnly=1",
    "/api/fees",
    "/api/homework",
    "/api/notices?limit=3",
    "/api/exams",
    "/api/meetings",
    "/api/resources",
    "/api/gallery",
    "/api/complaints",
    "/api/leave-requests",
    "/api/books/issues",
    "/api/quizzes/available",
  ],
};

/** Longest matching prefix wins, so "/parent" never swallows "/parent/profile". */
export function dataForRoute(href: string): string[] {
  if (ROUTE_DATA[href]) return ROUTE_DATA[href];
  const matches = Object.keys(ROUTE_DATA)
    .filter((key) => href === key || href.startsWith(key + "/"))
    .sort((a, b) => b.length - a.length);
  return matches.length ? ROUTE_DATA[matches[0]] : [];
}

/** The warm list for a sector — see SECTOR_WARM. */
export function warmListForSector(sector: SectorKey): string[] {
  return SECTOR_WARM[sector] || [];
}
