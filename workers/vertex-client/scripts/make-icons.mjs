// Generates the PWA icons (dependency-free PNG writer). Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };

function png(size, { maskable }) {
  const bg = [0x11, 0x13, 0x18], fg = [0x7c, 0x9c, 0xff];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  // A "V" made of two thick strokes; maskable keeps it inside the 80% safe zone.
  const scale = maskable ? 0.5 : 0.7, cx = size / 2, top = size * (0.5 - scale / 2), h = size * scale, half = h * 0.55, thick = size * 0.085;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const t = (y - top) / h; // 0..1 down the V
      let on = false;
      if (t >= 0 && t <= 1) { const off = half * (1 - t); on = Math.abs(Math.abs(x - cx) - off) <= thick; }
      const px = on ? fg : bg, o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = px[0]; raw[o + 1] = px[1]; raw[o + 2] = px[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync("web/public/icons", { recursive: true });
writeFileSync("web/public/icons/icon-192.png", png(192, {}));
writeFileSync("web/public/icons/icon-512.png", png(512, {}));
writeFileSync("web/public/icons/icon-maskable-512.png", png(512, { maskable: true }));
writeFileSync("web/public/icons/apple-touch-icon.png", png(180, {}));
