// Renders src-tauri/icons/source/notepadly-icon.svg into every icon file the app uses:
//   src-tauri/icons/icon.ico          15 sizes (16-256) for the exe, taskbar and Explorer
//   src-tauri/icons/*.png             bundle icons listed in tauri.conf.json
//   src/assets/app-icon-{16,24,32}.png  the title-bar icon inside the app
// Run with `npm run icons` after changing the SVG.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "src-tauri", "icons");
const svg = readFileSync(join(icons, "source", "notepadly-icon.svg"), "utf8");
const render = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

const ICO_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256];
const pngs = ICO_SIZES.map(render);
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach((png, i) => {
  const size = ICO_SIZES[i];
  const e = 6 + 16 * i;
  header.writeUInt8(size % 256, e); // 0 means 256
  header.writeUInt8(size % 256, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(png.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
writeFileSync(join(icons, "icon.ico"), Buffer.concat([header, ...pngs]));

writeFileSync(join(icons, "32x32.png"), render(32));
writeFileSync(join(icons, "128x128.png"), render(128));
writeFileSync(join(icons, "128x128@2x.png"), render(256));
writeFileSync(join(icons, "source", "notepadly-icon-1024.png"), render(1024));

const assets = join(root, "src", "assets");
mkdirSync(assets, { recursive: true });
for (const s of [16, 24, 32]) writeFileSync(join(assets, `app-icon-${s}.png`), render(s));

console.log(`icon.ico (${ICO_SIZES.join(", ")}), bundle PNGs and src/assets/app-icon-*.png written`);
