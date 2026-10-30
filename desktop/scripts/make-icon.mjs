/**
 * Generates desktop/assets/icon.png (256x256): wine-red rounded square with a cream wine glass.
 * Pure Node (zlib) so the icon is reproducible without design tools.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png');

const BG_TOP = [150, 38, 56];
const BG_BOTTOM = [96, 20, 34];
const GLASS = [250, 236, 214];
const WINE = [196, 52, 74];

const clamp = v => Math.max(0, Math.min(1, v));
/** Coverage (0..1) from a signed distance, for anti-aliased edges. */
const cover = d => clamp(0.5 - d);

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
    const qx = Math.abs(x - cx) - hw + r;
    const qy = Math.abs(y - cy) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const sdBox = (x, y, cx, cy, hw, hh) => sdRoundRect(x, y, cx, cy, hw, hh, 0);

function pixel(x, y) {
    const bg = cover(sdRoundRect(x, y, 128, 128, 120, 120, 54));
    if (bg <= 0) return [0, 0, 0, 0];
    const t = y / SIZE;
    let c = BG_TOP.map((v, i) => v + (BG_BOTTOM[i] - v) * t);

    // Glass bowl: lower half of a circle (cut flat at the rim), stem and foot.
    const bowlD = Math.max(sdCircle(x, y, 128, 98, 52), 70 - y);
    const stemD = sdBox(x, y, 128, 170, 6, 22);
    const footD = sdRoundRect(x, y, 128, 196, 38, 7, 7);
    const glass = cover(Math.min(bowlD, stemD, footD));
    // Wine inside the bowl, below its "surface" line.
    const wineD = Math.max(sdCircle(x, y, 128, 98, 40), 104 - y);
    const wine = cover(wineD);

    const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    c = mix(c, GLASS, glass);
    c = mix(c, WINE, wine);
    return [...c.map(Math.round), Math.round(255 * bg)];
}

// Supersample 4x for smooth edges.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    for (let x = 0; x < SIZE; x++) {
        const acc = [0, 0, 0, 0];
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
            const p = pixel(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
            for (let i = 0; i < 3; i++) acc[i] += p[i] * p[3];
            acc[3] += p[3];
        }
        const o = y * (SIZE * 4 + 1) + 1 + x * 4;
        const a = acc[3] / 16;
        for (let i = 0; i < 3; i++) raw[o + i] = acc[3] ? Math.round(acc[i] / acc[3]) : 0;
        raw[o + 3] = Math.round(a);
    }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = buf => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
]);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
