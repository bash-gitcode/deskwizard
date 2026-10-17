#!/usr/bin/env node
// Generates the three bundled wallpapers (2560x1440 PNG) from code.
// No third-party images are used, so there are no license questions.
// Run: node scripts/make-wallpapers.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const W = 2560;
const H = 1440;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// Dusk: vertical gradient with a soft sun.
function dusk(x, y) {
  const base = mix(hex('#1b1033'), hex('#e76f51'), y / H);
  const dx = x - 1900;
  const dy = y - 1000;
  const d = Math.sqrt(dx * dx + dy * dy);
  const sun = Math.max(0, Math.min(1, (360 - d) / 4 + 0.5));
  return mix(base, hex('#ffd166'), sun * 0.9);
}

// Ridge: teal gradient with diagonal bands.
function ridge(x, y) {
  const band = Math.floor((x + y) / 140) % 2;
  const base = mix(hex('#0b3d2e'), hex('#1b5e4a'), y / H);
  return band ? mix(base, hex('#000000'), 0.12) : base;
}

// Mono: dark diamond grid.
function mono(x, y) {
  const cx = (x % 160) - 80;
  const cy = (y % 160) - 80;
  const inside = Math.abs(cx) + Math.abs(cy) < 60;
  return inside ? hex('#2a2f3a') : hex('#15171c');
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(pixelFn) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const [r, g, b] = pixelFn(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outputs = [
  ['01', dusk],
  ['02', ridge],
  ['03', mono],
];
for (const [num, fn] of outputs) {
  const dir = join(root, 'catalog/tools/swaybg/variants', num);
  const file = join(dir, 'wallpaper.png');
  writeFileSync(file, png(fn));
  console.log(`wrote ${file}`);
}
