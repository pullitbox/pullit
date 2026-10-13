// Two side games paid from small pots next to the box:
// - the clock: every buy of $50+ resets a 3 minute timer. when it runs out, the last buyer
//   (if they still hold what they bought) takes the clock pot.
// - lucky buys: every buy of $50+ is rolled against a block that did not exist yet when they bought.
//   1 in 15 wins half the lucky pot, paid 7 minutes later if they still hold.
// Pure helpers live here; the bot in loop.ts does the network and the payments.

export const GAMES = {
  clockPct: 20, // of what goes into the box, this share feeds the clock pot
  luckyPct: 10, // and this share the lucky pot
  bondPct: 5, // before the bond, this share feeds the bond race pot: the last $50+ buy before the bond takes it
  clockMinutes: 3,
  minBuyUsd: 50,
  luckyOdds: 15, // 1 in this many qualifying buys
  luckyPotPct: 50, // a lucky buy takes half the lucky pot
  luckyPrizeLamports: 10_000_000n, // ...and never less than 0.01 SOL: below that the pot keeps growing first
  luckyCooldownMinutes: 60, // one lucky win per wallet per hour
  holdMinutes: 7, // a win only pays if the buyer still holds this long after the buy
  keepRatio: 0.9, // ...and still has at least 90% of what they bought
  minClockPotLamports: 10_000_000n, // the clock only pays out once the pot is worth it
  rollDelaySlots: 10, // the lucky roll uses a block this far after the buy
  queueMax: 60,
};

export interface Buy {
  sig: string;
  buyer: string;
  tokens: number; // ui amount
  at: number; // ms
  slot: number;
  usd: number;
}

interface HeliusTx {
  signature: string;
  slot: number;
  timestamp: number;
  feePayer: string;
  transactionError?: unknown;
  tokenTransfers?: { mint: string; fromUserAccount?: string; toUserAccount?: string; tokenAmount: number }[];
}

/** Buys of `mint` in a page of Helius parsed history: the fee payer received the token. */
export function parseBuys(txs: HeliusTx[], mint: string, priceUsd: number, exclude: Set<string>): Buy[] {
  const out: Buy[] = [];
  for (const t of txs) {
    if (t.transactionError || exclude.has(t.feePayer)) continue;
    const got = (t.tokenTransfers ?? [])
      .filter((x) => x.mint === mint && x.toUserAccount === t.feePayer && x.fromUserAccount !== t.feePayer)
      .reduce((a, x) => a + x.tokenAmount, 0);
    if (got <= 0) continue;
    out.push({
      sig: t.signature,
      buyer: t.feePayer,
      tokens: got,
      at: t.timestamp * 1000,
      slot: t.slot,
      usd: got * priceUsd,
    });
  }
  return out;
}

/** New buys since `cursor` (newest first from Helius, returned oldest first). Without a cursor, only sets one. */
export async function fetchNewBuys(
  heliusKey: string,
  mint: string,
  cursor: string | undefined,
  priceUsd: number,
  exclude: Set<string>,
): Promise<{ buys: Buy[]; cursor?: string }> {
  const seen: HeliusTx[] = [];
  let before: string | undefined;
  let newest: string | undefined;
  for (let page = 0; page < 3; page++) {
    const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${heliusKey}&limit=100${before ? `&before=${before}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Helius history ${res.status}`);
    const txs = (await res.json()) as HeliusTx[];
    if (!txs.length) break;
    newest ??= txs[0].signature;
    if (!cursor) return { buys: [], cursor: newest }; // first run: start from now, no backfill
    const stop = txs.findIndex((t) => t.signature === cursor);
    seen.push(...(stop >= 0 ? txs.slice(0, stop) : txs));
    if (stop >= 0 || txs.length < 100) break;
    before = txs[txs.length - 1].signature;
  }
  return { buys: parseBuys(seen, mint, priceUsd, exclude).reverse(), cursor: newest ?? cursor };
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The lucky roll: sha256(buy signature + blockhash of a later block). Public and checkable. */
export async function luckyRoll(sig: string, blockhash: string): Promise<{ seed: string; win: boolean }> {
  const seed = await sha256Hex(`${sig}:${blockhash}`);
  return { seed, win: parseInt(seed.slice(0, 8), 16) % GAMES.luckyOdds === 0 };
}

/** Raw token amount a buyer must still hold: keepRatio of what they bought. */
export function mustHold(tokens: number, decimals = 6): bigint {
  return BigInt(Math.floor(tokens * GAMES.keepRatio * 10 ** decimals));
}
