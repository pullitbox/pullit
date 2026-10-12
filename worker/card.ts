// The share card of an opened box: a 1200x630 PNG, drawn pixel by pixel with no libraries
// (palette PNG, zlib through CompressionStream). X and Telegram show it as the link preview of /box/N.
import { glyph } from "./font.ts";

export interface CardData {
  boxId: number;
  tier: "common" | "rare" | "epic" | "secret";
  sol: string; // prize in SOL, already formatted ("3.89")
  symbol: string; // prize coin
  winner: string; // shortened wallet ("4iSy…kVvZ")
  eligible: number; // wallets in the draw
  slot: number; // block that picked the winner
}

const W = 1200;
const H = 630;
const TIER: Record<CardData["tier"], string> = {
  common: "#c9c2d6",
  rare: "#8ec5ff",
  epic: "#cfa8ff",
  secret: "#ffc94d",
};

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mix = (a: string, b: string, t: number): string => {
  const x = hex(a);
  const y = hex(b);
  return (
    "#" +
    x
      .map((v, i) =>
        Math.round(v + (y[i]! - v) * t)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
};

/** An indexed image: one byte per pixel, colors added to the palette on first use. */
class Img {
  px = new Uint8Array(W * H);
  pal: string[] = [];
  idx(c: string): number {
    let i = this.pal.indexOf(c);
    if (i < 0) {
      i = this.pal.length;
      this.pal.push(c);
    }
    return i;
  }
  rect(x: number, y: number, w: number, h: number, c: string) {
    const v = this.idx(c);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(W, Math.round(x + w));
    const y1 = Math.min(H, Math.round(y + h));
    for (let j = y0; j < y1; j++) this.px.fill(v, j * W + x0, j * W + x1);
  }
  /** Text in the pixel font; returns the width drawn. */
  text(s: string, x: number, y: number, k: number, c: string): number {
    let cx = x;
    for (const ch of s) {
      const g = glyph(ch);
      for (let r = 0; r < 8; r++)
        for (let b = 0; b < 5; b++) if ((g[r]! >> (4 - b)) & 1) this.rect(cx + b * k, y + r * k, k, k, c);
      cx += 6 * k;
    }
    return cx - x - k;
  }
}
const textW = (s: string, k: number) => [...s].length * 6 * k - k;

/** Rects of the box sprite (18x16 cells) from assets/box.svg. */
export function spriteRects(svg: string) {
  const out: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  for (const m of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(#[0-9a-fA-F]{6})"/g))
    out.push({ x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]!, fill: m[5]!.toLowerCase() });
  return out;
}

// colors of the site
const BG = "#0b0a0d";
const DOT = "#231720";
const TEXT = "#f4eef2";
const MUTED = "#9a8f99";
const PINK = "#ff8dc0";
const INK = "#1a0f17";
const SHADOW = "#5a2440";

export function drawCard(d: CardData, sprite: ReturnType<typeof spriteRects>): Img {
  const im = new Img();
  const tier = TIER[d.tier];
  im.rect(0, 0, W, H, BG);
  for (let y = 4; y < H; y += 9) for (let x = 4; x < W; x += 9) im.rect(x, y, 1, 1, DOT);

  // rays behind the box: solid near the middle, dithered further out
  const cx = 228;
  const cy = 280;
  const near = im.idx(mix(BG, tier, 0.34));
  for (let y = 40; y < 530; y++)
    for (let x = 0; x < 456; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (r > 230) continue;
      const a = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 22;
      if (a >= 7) continue;
      if (r < 150 || (r < 230 && (x + y) % 2 === 0 && r < 150 + 80 * (1 - ((x * 7 + y * 13) % 5) / 10)))
        im.px[y * W + x] = near;
    }
  // sparks
  for (const [x, y, s] of [
    [70, 104, 16],
    [392, 168, 12],
    [104, 414, 11],
    [362, 372, 16],
  ] as const)
    im.rect(x, y, s, s, tier);

  // the box: shadow silhouette first, then the sprite, 16 px per cell
  const k = 16;
  const ox = cx - 9 * k;
  const oy = cy - 8 * k;
  for (const r of sprite) im.rect(ox + r.x * k + 12, oy + r.y * k + 12, r.w * k, r.h * k, SHADOW);
  for (const r of sprite) im.rect(ox + r.x * k, oy + r.y * k, r.w * k, r.h * k, r.fill);

  // the text column
  const left = 476;
  const maxW = W - left - 48;
  const amt = d.sol;
  let ak = 17;
  while (ak > 8 && textW(amt, ak) + 32 + textW("SOL", Math.round(ak / 2)) > maxW) ak--;
  const sk = Math.max(4, Math.round(ak / 2));
  const coin = `of $${d.symbol}`;
  let ck = 7;
  while (ck > 3 && textW(coin, ck) > maxW) ck--;
  const coinTxt = textW(coin, ck) > maxW ? [...coin].slice(0, Math.floor(maxW / (6 * ck)) - 1).join("") + "…" : coin;

  const blocks = [21, 73, 7 * ak, 7 * ck, 21];
  const gaps = [16, 22, 30, 26];
  const total = blocks.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  let y = Math.round((544 - total) / 2);

  im.text(`BOX #${d.boxId} · OPENED`, left, y, 3, MUTED);
  y += 21 + gaps[0]!;

  const label = `${d.tier.toUpperCase()} PULL`;
  const lw = textW(label, 7) + 40;
  im.rect(left + 7, y + 7, lw, 73, d.tier === "common" ? "#3b3442" : SHADOW);
  im.rect(left, y, lw, 73, tier);
  im.text(label, left + 20, y + 12, 7, INK);
  y += 73 + gaps[1]!;

  const aw = im.text(amt, left, y, ak, TEXT);
  im.text("SOL", left + aw + 32, y + 7 * ak - 7 * sk, sk, MUTED);
  y += 7 * ak + gaps[2]!;

  im.text(coinTxt, left, y, ck, PINK);
  y += 7 * ck + gaps[3]!;

  let x = left;
  const of = `1 of ${d.eligible.toLocaleString("en-US")}`;
  const tail = textW(`winner ${d.winner}`, 3) + 27 + textW(`${of} in the draw`, 3) <= maxW ? " in the draw" : "";
  x += im.text("winner ", x, y, 3, MUTED) + 3;
  x += im.text(d.winner, x, y, 3, TEXT) + 3 + 24;
  x += im.text(of, x, y, 3, TEXT) + 3;
  if (tail) im.text(tail, x, y, 3, MUTED);

  // the pink strip
  im.rect(0, 544, W, H - 544, PINK);
  im.text("pullit.fun", 36, 544 + (86 - 7 * 5) / 2, 5, INK);
  const blk = `block ${d.slot.toLocaleString("en-US")} picked it`;
  im.text(blk, W - 36 - textW(blk, 3), 544 + (86 - 21) / 2, 3, INK);
  return im;
}

// ---- png ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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
async function zlib(raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const s = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function png(im: Img): Promise<Uint8Array<ArrayBuffer>> {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, W);
  v.setUint32(4, H);
  ihdr.set([8, 3, 0, 0, 0], 8); // 8 bit, palette
  const plte = new Uint8Array(im.pal.length * 3);
  im.pal.forEach((c, i) => plte.set(hex(c), i * 3));
  const raw = new Uint8Array(H * (W + 1));
  for (let y = 0; y < H; y++) raw.set(im.px.subarray(y * W, (y + 1) * W), y * (W + 1) + 1); // filter 0
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function renderCard(d: CardData, svg: string): Promise<Uint8Array<ArrayBuffer>> {
  return png(drawCard(d, spriteRects(svg)));
}
