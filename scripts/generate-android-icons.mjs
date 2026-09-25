// Generates Android launcher icons for every app module → android/<module>/src/main/res/mipmap-*/
// Run:  node scripts/generate-android-icons.mjs
//
// One icon per app, in its own brand colour, at the density Android actually
// expects. (Density is not cosmetic: a 192px file dropped into mipmap-xxhdpi is
// scaled down by the launcher on every draw, and a list of identically-sized
// files is how two apps end up with the same-looking icon.)
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Android's density buckets, in real pixels for a 48dp launcher icon. */
const DENSITIES = [
  { dir: "mipmap-mdpi", size: 48 },
  { dir: "mipmap-hdpi", size: 72 },
  { dir: "mipmap-xhdpi", size: 96 },
  { dir: "mipmap-xxhdpi", size: 144 },
  { dir: "mipmap-xxxhdpi", size: 192 },
];

/**
 * Each app's identity: its tile gradient and the glyph drawn in white on top.
 * The glyph box is a 24×24 Lucide-style viewBox, scaled to ~50% of the tile.
 */
const APPS = [
  {
    module: "app",
    name: "Parents App",
    from: "#4f46e5",
    to: "#7c3aed",
    glyph: `
      <g fill="#ffffff">
        <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/>
        <path d="M22 10v6"/>
        <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>
      </g>`,
  },
  {
    module: "teacher",
    name: "Teacher App",
    // Matches the Teacher App accent in src/lib/sectors.ts.
    from: "#0d9488",
    to: "#14b8a6",
    // A board with writing on it, on a stand — deliberately a different shape
    // from the Parents App's graduation cap.
    glyph: `
      <g>
        <rect x="1.5" y="2.5" width="21" height="14" rx="2" fill="#ffffff"/>
        <rect x="4.6" y="5.8" width="9" height="1.8" rx="0.9" fill="{tile}"/>
        <rect x="4.6" y="9.4" width="14" height="1.8" rx="0.9" fill="{tile}" opacity="0.55"/>
        <rect x="4.6" y="13" width="6" height="1.8" rx="0.9" fill="{tile}" opacity="0.35"/>
        <path d="M5.5 21.5 12 16.8l6.5 4.7" fill="none" stroke="#ffffff" stroke-width="1.9"
              stroke-linecap="round" stroke-linejoin="round"/>
      </g>`,
  },
];

/** Rounded tile + glyph, centred, at the requested pixel size. */
function svgFor(app, size) {
  const radius = Math.round(size * 0.225); // ~ Android launcher squircle
  const scale = (size * 0.5) / 24; // glyph occupies half the tile
  const tile = app.from; // used for the "writing" so it shows through the board
  const glyph = app.glyph.replace(/\{tile\}/g, tile);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${app.from}"/>
      <stop offset="100%" stop-color="${app.to}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#bg)"/>
  <g transform="translate(${size / 2},${size / 2}) scale(${scale}) translate(-12,-12)">
    ${glyph}
  </g>
</svg>`;
}

let written = 0;
for (const app of APPS) {
  for (const { dir, size } of DENSITIES) {
    const outDir = join(root, "android", app.module, "src", "main", "res", dir);
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, "ic_launcher.png");
    await sharp(Buffer.from(svgFor(app, size))).png().toFile(out);
    written++;
  }
  console.log(`✓ ${app.name} — ${DENSITIES.length} densities (48…192px)`);
}
console.log(`Icons written: ${written} files`);
