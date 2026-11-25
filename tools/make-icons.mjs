#!/usr/bin/env node
/**
 * Generates icons/icon{16,32,48,128}.png from code — no image dependencies.
 *
 * The mark: a rounded square with an indigo→cyan gradient and a white bolt,
 * matching the popup's accent colours. Run with `node tools/make-icons.mjs`.
 */
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');

/* --------------------------------------------------------------- PNG -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- drawing -- */

const BOLT = [
  [0.558, 0.104],
  [0.208, 0.55],
  [0.421, 0.55],
  [0.358, 0.896],
  [0.717, 0.438],
  [0.5, 0.438],
  [0.558, 0.104],
];

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function roundedRectAlpha(x, y, size, radius) {
  // x/y in [0, size]; returns 1 inside, 0 outside (sharp mask, supersampled later).
  const r = radius;
  const nearLeft = x < r;
  const nearRight = x > size - r;
  const nearTop = y < r;
  const nearBottom = y > size - r;
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const cx = nearLeft ? r : size - r;
    const cy = nearTop ? r : size - r;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r ? 1 : 0;
  }
  return 1;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function renderIcon(size) {
  const SS = size <= 48 ? 4 : 3; // supersampling factor
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.235;
  const boltInset = size * 0.055;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          const inside = roundedRectAlpha(px, py, size, radius);
          if (!inside) continue;

          // Diagonal gradient: indigo → blue → cyan.
          const t = Math.min(1, Math.max(0, (px / size) * 0.55 + (py / size) * 0.45));
          let r;
          let g;
          let b;
          if (t < 0.55) {
            const k = t / 0.55;
            r = lerp(0x7c, 0x5b, k);
            g = lerp(0x5c, 0x8c, k);
            b = lerp(0xff, 0xff, k);
          } else {
            const k = (t - 0.55) / 0.45;
            r = lerp(0x5b, 0x37, k);
            g = lerp(0x8c, 0xc2, k);
            b = lerp(0xff, 0xff, k);
          }

          // Soft top-left sheen.
          const sheen = Math.max(0, 1 - (px / size) * 1.4 - (py / size) * 0.9);
          r = Math.min(255, r + sheen * 26);
          g = Math.min(255, g + sheen * 26);
          b = Math.min(255, b + sheen * 20);

          const bx = (px - boltInset) / (size - boltInset * 2);
          const by = (py - boltInset) / (size - boltInset * 2);
          if (pointInPolygon(bx, by, BOLT)) {
            r = 255;
            g = 255;
            b = 255;
          }

          rSum += r;
          gSum += g;
          bSum += b;
          aSum += 255;
        }
      }

      const samples = SS * SS;
      const index = (y * size + x) * 4;
      const coverage = aSum / (samples * 255);
      if (coverage > 0) {
        pixels[index] = Math.round(rSum / (samples * coverage));
        pixels[index + 1] = Math.round(gSum / (samples * coverage));
        pixels[index + 2] = Math.round(bSum / (samples * coverage));
        pixels[index + 3] = Math.round(coverage * 255);
      }
    }
  }
  return pixels;
}

/* ---------------------------------------------------------------- main -- */

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, renderIcon(size));
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
