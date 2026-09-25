import { prisma } from "@/lib/db";

/**
 * Per-school web app manifest.
 *
 * This is what makes the installed app belong to the school: when a guardian
 * installs from `/s/<slug>`, the home-screen icon is named after the school and
 * opens that school's entry point — not the generic platform app.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const key = String(slug || "").trim().toLowerCase();

  const school = key
    ? await prisma.school.findUnique({
        where: { slug: key },
        select: { name: true, slug: true, logoUrl: true, themeColor: true },
      })
    : null;

  if (!school) return new Response("Not found", { status: 404 });

  const icons: { src: string; sizes: string; type: string; purpose: string }[] = [];
  // The school's own logo, when it has one, so the icon is recognisably theirs.
  if (school.logoUrl) icons.push({ src: school.logoUrl, sizes: "any", type: "image/png", purpose: "any" });
  // Platform icons guarantee the manifest still meets installability rules.
  icons.push(
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  );

  const manifest = {
    name: `${school.name} — Parents`,
    short_name: school.name.length > 12 ? `${school.name.slice(0, 11)}…` : school.name,
    description: `Parents app for ${school.name}: attendance, homework, results, fees and notices.`,
    id: `/s/${school.slug}`,
    start_url: `/s/${school.slug}`,
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#f8fafc",
    theme_color: school.themeColor || "#0ea5e9",
    lang: "en",
    categories: ["education"],
    icons,
  };

  return Response.json(manifest, {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" },
  });
}
