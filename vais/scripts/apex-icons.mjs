// The official ApeX mark is the black-hole artwork (v3 PNGs in public/icons).
// This old stylized-A generator must not overwrite those files.
console.log('Skipped: v3 icons are the official ApeX mark, not generated here.');
process.exit(0);

// Legacy generator kept below for reference (stilisierter Gipfel / A).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LEFT = [[32, 6], [8, 58], [20, 58]];
const RIGHT = [[32, 6], [56, 58], [44, 58]];
const BAR = [[22.77, 46], [41.23, 46], [38.92, 36], [25.08, 36]];

function inTri(x, y, a, b, c) {
  const v0x = c[0] - a[0], v0y = c[1] - a[1];
  const v1x = b[0] - a[0], v1y = b[1] - a[1];
  const v2x = x - a[0], v2y = y - a[1];
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const inv = 1 / (dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= -0.001 && v >= -0.001 && u + v <= 1.001;
}
function inMark(x, y) {
  return inTri(x, y, ...LEFT) || inTri(x, y, ...RIGHT) || inTri(x, y, BAR[0], BAR[1], BAR[2]) || inTri(x, y, BAR[0], BAR[2], BAR[3]);
}
function inRound(nx, ny, r) {
  if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return false;
  const cx = nx < r ? r : nx > 1 - r ? 1 - r : nx;
  const cy = ny < r ? r : ny > 1 - r ? 1 - r : ny;
  if (cx === nx && cy === ny) return true;
  const dx = nx - cx, dy = ny - cy;
  return dx * dx + dy * dy <= r * r;
}

const FG = [244, 244, 245];
const BG = [0, 0, 0];

function raster({ size, pad, rounded = false, radius = 0.22 }) {
  const rgba = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cover = 0;
      let inside = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const nx = (px + (sx + 0.5) / n) / size;
          const ny = (py + (sy + 0.5) / n) / size;
          const on = !rounded || inRound(nx, ny, radius);
          if (!on) continue;
          inside++;
          const x = ((nx - pad) / (1 - 2 * pad)) * 64;
          const y = ((ny - pad) / (1 - 2 * pad)) * 64;
          if (x >= 0 && y >= 0 && x <= 64 && y <= 64 && inMark(x, y)) cover++;
        }
      }
      const i = (py * size + px) * 4;
      if (!inside) continue;
      const a = inside / (n * n);
      const m = cover / (n * n);
      const blend = m / a;
      rgba[i] = Math.round(FG[0] * blend + BG[0] * (1 - blend));
      rgba[i + 1] = Math.round(FG[1] * blend + BG[1] * (1 - blend));
      rgba[i + 2] = Math.round(FG[2] * blend + BG[2] * (1 - blend));
      rgba[i + 3] = Math.round(255 * a);
    }
  }
  return rgba;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function write(path, size, opts) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png(size, raster({ size, ...opts })));
}

const root = new URL('../public/', import.meta.url).pathname;
write(`${root}favicon-32-v3.png`, 32, { pad: 0.12, rounded: true, radius: 0.22 });
write(`${root}icons/apple-touch-icon-v3.png`, 180, { pad: 0.18 });
write(`${root}icons/apex-192-v3.png`, 192, { pad: 0.16 });
write(`${root}icons/apex-512-v3.png`, 512, { pad: 0.16 });
write(`${root}icons/apex-maskable-192-v3.png`, 192, { pad: 0.18 });
write(`${root}icons/apex-maskable-512-v3.png`, 512, { pad: 0.18 });
write(`${root}icons/apple-touch-icon.png`, 180, { pad: 0.18 });
write(`${root}icons/app-192.png`, 192, { pad: 0.16 });
write(`${root}icons/app-512.png`, 512, { pad: 0.16 });
write(`${root}icons/app-maskable-512.png`, 512, { pad: 0.18 });
write('/tmp/apex-preview.png', 640, { pad: 0.18 });
console.log('icons ok');
