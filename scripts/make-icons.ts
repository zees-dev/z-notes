/* ============================================================
   make-icons.ts — the home-screen icons, drawn from the mark in code.

   Run: `bun scripts/make-icons.ts` (only when the mark changes). It writes
   `app/icons/*.png` and they are COMMITTED — this is a generator, not a build
   step, and nothing at runtime depends on it. The repo's "no build step" rule
   is about serving `app/`, and a PNG in git is exactly as static as the SVG
   beside it.

   WHY PNGs AT ALL, when the mark is already an inline SVG in index.html?
   Because the two consumers that decide what an installed app looks like do
   not take one:

     · iOS reads `<link rel="apple-touch-icon">`, PNG only. Without it, a
       home-screen tile is a screenshot of the page, and the launch screen iOS
       generates from the icon + `background_color` has nothing to draw.
     · Chrome will install from an SVG, but the splash it generates wants a
       ≥192px raster and the maskable variant is a raster contract (a safe
       zone measured in pixels).

   The drawing is the favicon's, minus the text: there is no font here to
   rasterize, so the `z` is three strokes and a block cursor — the same shape
   the glyph makes, built from primitives this file can actually fill.
   Everything is drawn full-bleed on the mark's near-black, because a
   `maskable` icon is cropped to whatever shape the platform likes and a
   transparent corner would show the launcher through it.

   WHY THE PNG CONTAINER IS STILL HAND-ROLLED. `Bun.Image` (1.4.0) encodes only
   from an encoded image: every raw-pixel constructor spelling is rejected with
   ERR_IMAGE_UNKNOWN_FORMAT. This file starts from pixels it drew itself, so
   `node:zlib` and the chunk writer below stay.
   ============================================================ */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "app", "icons");

/* the two colours of the mark, and the only two in the file */
const BG: RGB = [0x12, 0x14, 0x12];
const FG: RGB = [0x8f, 0xbf, 0xa2];

type RGB = [number, number, number];

/* ---------- geometry, in a 0..1 square ----------
   The safe zone a maskable icon must survive is the centre 80% circle, so the
   whole mark lives inside the middle ~45% of the square. */
const STROKE = 0.062;
const Z_L = 0.275;
const Z_R = 0.51;
const Z_T = 0.345;
const Z_B = 0.64;
const CUR: [number, number, number, number] = [0.575, 0.3, 0.725, 0.7]; // x0,y0,x1,y1

/** distance from p to the segment ab — the whole rasteriser, twice over */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/** is (x, y) — in the 0..1 square — inside the mark? */
function inMark(x: number, y: number): boolean {
  const r = STROKE / 2;
  if (segDist(x, y, Z_L, Z_T, Z_R, Z_T) <= r) return true; // the top bar
  if (segDist(x, y, Z_R, Z_T, Z_L, Z_B) <= r) return true; // the diagonal
  if (segDist(x, y, Z_L, Z_B, Z_R, Z_B) <= r) return true; // the bottom bar
  return x >= CUR[0] && x <= CUR[2] && y >= CUR[1] && y <= CUR[3]; // the cursor
}

/** 3×3 supersampled RGB raster — no alpha anywhere, by design (see the header) */
function raster(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 3);
  const S = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          if (inMark((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size)) hits++;
        }
      }
      const a = hits / (S * S);
      const i = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(BG[c] + (FG[c] - BG[c]) * a);
    }
  }
  return px;
}

/* ---------- PNG container ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(body)])), 0);
  return Buffer.concat([head, Buffer.from(body), crc]);
}

function png(size: number): Buffer {
  const rgb = raster(size);
  /* filter byte 0 (None) per scanline: the images are tiny and flat, and a
     predictor would only make this file longer */
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * size * 3, size * 3).copy(raw, y * (size * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour, no alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [180, 192, 512]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size));
  process.stdout.write(`wrote ${file.slice(ROOT.length + 1)}\n`);
}
