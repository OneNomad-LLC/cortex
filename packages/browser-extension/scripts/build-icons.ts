/**
 * Rasterize `src/assets/icon.svg` into PNGs at the sizes the MV3
 * manifest needs. Kept as a build-time step (not a vite plugin)
 * because sharp ships native binaries and we only want to touch it
 * when the SVG actually changes.
 *
 * Idempotent — safe to re-run. The PNGs are checked into git so a
 * fresh clone can build without installing sharp.
 */

import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(here, "..", "src", "assets");
const svgPath = path.join(assetsDir, "icon.svg");

const SIZES = [16, 48, 128] as const;

async function main(): Promise<void> {
  const svg = await fs.readFile(svgPath);
  await Promise.all(
    SIZES.map(async (size) => {
      const out = path.join(assetsDir, `icon-${size}.png`);
      const buf = await sharp(svg, { density: 384 })
        .resize(size, size, { fit: "contain" })
        .png({ compressionLevel: 9 })
        .toBuffer();
      await fs.writeFile(out, buf);
      console.log(`[build-icons] wrote ${path.relative(process.cwd(), out)}`);
    }),
  );
}

main().catch((err: unknown) => {
  console.error("[build-icons] failed:", err);
  process.exit(1);
});
