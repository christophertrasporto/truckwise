import { mkdirSync } from "node:fs";
import sharp from "sharp";

// One-off generator for the PWA icons: a white truck on the brand blue. Run: node scripts/make-icons.mjs
const svg = (size, pad) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#0f2a5c"/>
  <g transform="translate(${pad} ${pad}) scale(${(100 - pad * 2) / 100})" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 30h42v36H14zM56 40h16l12 12v14H56"/>
    <circle cx="30" cy="70" r="7" fill="#0f2a5c"/>
    <circle cx="70" cy="70" r="7" fill="#0f2a5c"/>
  </g>
</svg>`;

mkdirSync("public/icons", { recursive: true });
for (const [file, size, pad] of [
  ["icon-192.png", 192, 8],
  ["icon-512.png", 512, 8],
  ["icon-maskable-512.png", 512, 20], // extra safe-zone padding for maskable icons
]) {
  await sharp(Buffer.from(svg(size, pad))).png().toFile(`public/icons/${file}`);
}
console.log("icons written");
