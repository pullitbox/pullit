// The picture of a box coin: the pullit box and its number, 512x512 truecolor PNG, no libraries.
import { glyph } from "./font.ts";
import { spriteRects } from "./card.ts";

const S = 512;
const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function crc32(parts: Uint8Array[]): number {
  let c = ~0;
  for (const p of parts)
    for (let i = 0; i < p.length; i++) {
      c ^= p[i]!;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(t, 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32([t, data]));
  return out;
}

export async function coinImage(boxId: number, boxSvg: string): Promise<Uint8Array> {
  const px = new Uint8Array(S * S * 3);
  const rect = (x: number, y: number, w: number, h: number, c: string) => {
    const [r, g, b] = hex(c);
    for (let yy = Math.max(0, y); yy < Math.min(S, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(S, x + w); xx++) {
        const i = (yy * S + xx) * 3;
        px[i] = r; px[i + 1] = g; px[i + 2] = b;
      }
  };
  rect(0, 0, S, S, "#0b0a0d");
  for (let y = 6; y < S; y += 16) for (let x = 6; x < S; x += 16) rect(x, y, 2, 2, "#231720");
  const k = 20; // 18x16 sprite -> 360x320
  const ox = (S - 18 * k) / 2, oy = 40;
  for (const r of spriteRects(boxSvg)) rect(ox + r.x * k, oy + r.y * k, r.w * k, r.h * k, r.fill);
  const label = `#${boxId}`;
  const g = 11;
  const w = label.length * 6 * g - g;
  let x = Math.round((S - w) / 2);
  for (const ch of label) {
    const rows = glyph(ch);
    rows.forEach((bits, ry) => {
      for (let rx = 0; rx < 5; rx++) if (bits & (1 << (4 - rx))) rect(x + rx * g, 392 + ry * g, g, g, "#ff8dc0");
    });
    x += 6 * g;
  }
  const raw = new Uint8Array(S * (S * 3 + 1));
  for (let y = 0; y < S; y++) raw.set(px.subarray(y * S * 3, (y + 1) * S * 3), y * (S * 3 + 1) + 1);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, S);
  v.setUint32(4, S);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bit rgb
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
