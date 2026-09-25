import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import GuardianAppEntry from "@/components/GuardianAppEntry";

/**
 * A school's Parents App entry — `<parents-host>/s/<school-slug>`.
 *
 * This is what a school's printed invite QR opens: "Sunrise International
 * School — Parents App", branded with that school's logo and colour, with the
 * install prompt and both credential-free/conventional ways in. Scanning it
 * grants nothing; the guardian still authenticates.
 */

export const dynamic = "force-dynamic";

async function findSchool(slug: string) {
  const key = String(slug || "").trim().toLowerCase();
  if (!key) return null;
  return prisma.school.findUnique({
    where: { slug: key },
    select: { name: true, slug: true, logoUrl: true, tagline: true, themeColor: true },
  });
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const school = await findSchool(slug);
  if (!school) return { title: "School not found" };
  return {
    title: `${school.name} — Parents App`,
    description: `Attendance, homework, results, fees and notices from ${school.name}, in one app.`,
    // Per-school manifest so the installed icon carries the school's own name.
    manifest: `/s/${school.slug}/manifest.webmanifest`,
  };
}

export default async function SchoolGuardianAppPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  // The school's invite QR is encoded with ?install=1 — the guardian scanned it
  // to get the app, so install leads on the page they land on.
  const fromQr = sp?.install === "1";
  const school = await findSchool(slug);
  if (!school) notFound();

  // A guardian who already has a session goes straight into the app.
  // Detected on the server so the page never renders an "install the app" step
  // inside the app itself.
  const ua = (await headers()).get("user-agent") || "";
  const inApp = /AmarESchoolParents/i.test(ua);
  const isAndroid = /android/i.test(ua);

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    const session = await verifySession(token);
    if (session?.role === "GUARDIAN") redirect("/parent");
  }

  return (
    <GuardianAppEntry
      school={{
        name: school.name,
        slug: school.slug,
        logoUrl: school.logoUrl,
        tagline: school.tagline,
        themeColor: school.themeColor,
      }}
      fromQr={fromQr}
      inApp={inApp}
      isAndroid={isAndroid}
      playStoreUrl={process.env.PLAY_STORE_URL || null}
    />
  );
}
