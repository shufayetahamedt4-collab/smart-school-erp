// Generates PWA icons for Smart School ERP → public/icons/
// Run:  node scripts/generate-icons.mjs
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "icons");
mkdirSync(outDir, { recursive: true });

// Lucide "graduation-cap" paths (24×24 viewBox, white fill) centered on the tile.
const cap = `
  <g fill="#ffffff" transform="translate(256,256) scale(10.5) translate(-12,-12)">
    <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/>
    <path d="M22 10v6"/>
    <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>
  </g>`;

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4f46e5"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>`;

// "any" icons: rounded tile (squircle) with the cap at ~55% of the canvas.
function tileSvg(size, radius) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    ${defs}
    <rect width="${size}" height="${size}" rx="${radius}" fill="url(#bg)"/>
    ${cap}
  </svg>`;
}

// maskable icon: full-bleed gradient, cap kept inside the 80% safe zone.
function maskableSvg(size) {
  const capScale = 7.5; // smaller so it stays inside the safe circle
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    ${defs}
    <rect width="${size}" height="${size}" fill="url(#bg)"/>
    <g fill="#ffffff" transform="translate(${size / 2},${size / 2}) scale(${capScale}) translate(-12,-12)">
      <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/>
      <path d="M22 10v6"/>
      <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>
    </g>
  </svg>`;
}

const jobs = [
  { name: "icon-192.png", svg: tileSvg(192, 44) },
  { name: "icon-512.png", svg: tileSvg(512, 116) },
  { name: "maskable-512.png", svg: maskableSvg(512) },
  { name: "apple-touch-icon.png", svg: tileSvg(180, 41) },
];

for (const job of jobs) {
  await sharp(Buffer.from(job.svg)).png().toFile(join(outDir, job.name));
  console.log("✓", job.name);
}
console.log("Icons written to", outDir);
