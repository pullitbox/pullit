// Holder tracker: snapshots $PULL holders via Helius DAS, remembers when each
// wallet first became eligible, and turns bags into draw tickets.
// Network code is only in fetchHolders(); everything else is pure.

export const HOLDERS = {
  minHoldUsd: 20, // the smallest bag that keeps a hold timer running; bigger boxes ask for more (entryUsd)
  minHoldMinutes: 7, // anti-snipe: must hold this long before a draw counts you
  // hold-time multiplier ramps from 1x to maxMultiplier over rampHours
  rampHours: 24,
  maxMultiplier: 3,
  // anti-whale: a wallet's bag counts up to this share of supply...
  bagCapPctOfSupply: 1,
  // ...and no wallet may hold more than this share of all tickets
  maxTicketSharePct: 10,
  // a fresh buy gets no extra tickets: timing the draw should not pay (kept at 0 on purpose)
  buyBoostPct: 0,
  buyBoostMinutes: 15,
  // any sell puts the hold multiplier back to 1x (you stay in the draw)
  sellResetsHold: true,
};

/** The bag a wallet needs to be in the draw for a box of this size (SOL). Bigger box, bigger entry. */
export function entryUsd(boxSol: number): number {
  if (boxSol >= 5) return 250;
  if (boxSol >= 2.5) return 100;
  if (boxSol > 1.5) return 75;
  if (boxSol > 0.5) return 50;
  return HOLDERS.minHoldUsd;
}

/** Between snapshots: owner -> [amount at the last snapshot, time of the last buy (ms)]. */
export type BagMemo = Record<string, [number, number]>;

export interface HolderBalance {
  owner: string;
  amount: number; // UI amount (decimals applied)
}

/** Persistent state between snapshots: owner -> first time they became eligible (ms). */
export type HolderState = Record<string, number>;

export interface TicketRow {
  owner: string;
  amount: number;
  usd: number;
  heldMinutes: number;
  multiplier: number;
  boosted: boolean; // bought in the last hour
  tickets: number;
  sharePct: number;
}

export interface TicketSnapshot {
  at: string;
  priceUsd: number;
  holdersTotal: number;
  eligible: number;
  totalTickets: number;
  rows: TicketRow[]; // sorted by tickets desc
  state: HolderState; // updated state to persist
  memo: BagMemo; // updated amounts and last buys to persist
  sold: string[]; // eligible wallets whose hold multiplier was reset by a sell
}

// ---------- network ----------

interface DasTokenAccount {
  owner: string;
  amount: number | string;
}

export async function fetchHolders(heliusKey: string, mint: string, decimals = 6): Promise<HolderBalance[]> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  const byOwner = new Map<string, number>();
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "pull",
        method: "getTokenAccounts",
        params: { mint, limit: 1000, ...(cursor ? { cursor } : {}) },
      }),
    });
    if (!res.ok) throw new Error(`Helius ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as {
      result?: { token_accounts?: DasTokenAccount[]; cursor?: string };
      error?: { message: string };
    };
    if (json.error) throw new Error(`Helius error: ${json.error.message}`);
    const accounts = json.result?.token_accounts ?? [];
    for (const a of accounts) {
      const amt = Number(a.amount) / 10 ** decimals;
      if (amt > 0) byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0) + amt);
    }
    cursor = json.result?.cursor;
    if (!cursor || accounts.length === 0) break;
  }
  return [...byOwner.entries()].map(([owner, amount]) => ({ owner, amount }));
}

// ---------- tickets ----------

export function holdMultiplier(heldMinutes: number): number {
  const h = heldMinutes / 60;
  const t = Math.min(h / HOLDERS.rampHours, 1);
  return 1 + t * (HOLDERS.maxMultiplier - 1);
}

/** Cap any single wallet at maxTicketSharePct of the total (iterative water-filling). */
function capShares(rows: { owner: string; raw: number }[], maxShare: number): Map<string, number> {
  const out = new Map(rows.map((r) => [r.owner, r.raw]));
  for (let i = 0; i < 20; i++) {
    const total = [...out.values()].reduce((a, b) => a + b, 0);
    const cap = total * maxShare;
    let changed = false;
    for (const [k, v] of out)
      if (v > cap + 1e-9) {
        out.set(k, cap);
        changed = true;
      }
    if (!changed) break;
  }
  return out;
}

export function computeTickets(
  balances: HolderBalance[],
  prev: HolderState,
  opts: {
    priceUsd: number;
    totalSupply: number;
    exclude: string[];
    now?: number;
    minHoldMinutes?: number;
    minUsd?: number; // entry for the box being filled (entryUsd); the hold timer only needs HOLDERS.minHoldUsd
    memo?: BagMemo; // without it, buys and sells are not tracked
  },
): TicketSnapshot {
  const now = opts.now ?? Date.now();
  const exclude = new Set(opts.exclude);
  const bagCap = opts.totalSupply * (HOLDERS.bagCapPctOfSupply / 100);
  const minHold = opts.minHoldMinutes ?? HOLDERS.minHoldMinutes;
  const state: HolderState = {};
  const memo: BagMemo = {};
  const sold: string[] = [];
  const pre: {
    owner: string;
    amount: number;
    usd: number;
    heldMinutes: number;
    multiplier: number;
    boosted: boolean;
    raw: number;
  }[] = [];

  for (const b of balances) {
    if (exclude.has(b.owner)) continue;
    const usd = b.amount * opts.priceUsd;
    if (usd < HOLDERS.minHoldUsd) continue; // dropping below the minimum resets your timer
    let since = prev[b.owner] ?? now;
    const last = opts.memo?.[b.owner];
    let lastBuy = last?.[1] ?? 0;
    if (opts.memo) {
      // half a percent of slack, so dust moves do not count as a buy or a sell
      if (!last || b.amount > last[0] * 1.005) lastBuy = now;
      else if (b.amount < last[0] * 0.995 && HOLDERS.sellResetsHold && now - since >= minHold * 60_000) {
        since = now - minHold * 60_000; // still in the draw, back to 1x
        sold.push(b.owner);
      }
      memo[b.owner] = [b.amount, lastBuy];
    }
    state[b.owner] = since;
    const heldMinutes = (now - since) / 60_000;
    if (heldMinutes < minHold) continue;
    if (usd < (opts.minUsd ?? HOLDERS.minHoldUsd)) continue; // timer keeps running, but this box needs a bigger bag
    const multiplier = holdMultiplier(heldMinutes);
    const boosted = now - lastBuy < HOLDERS.buyBoostMinutes * 60_000;
    pre.push({
      owner: b.owner,
      amount: b.amount,
      usd,
      heldMinutes,
      multiplier,
      boosted,
      raw: Math.min(b.amount, bagCap) * multiplier * (boosted ? 1 + HOLDERS.buyBoostPct / 100 : 1),
    });
  }

  const capped = capShares(pre, HOLDERS.maxTicketSharePct / 100);
  const totalTickets = [...capped.values()].reduce((a, b) => a + b, 0);
  const rows: TicketRow[] = pre
    .map((p) => {
      const tickets = capped.get(p.owner) ?? 0;
      return {
        owner: p.owner,
        amount: p.amount,
        usd: Math.round(p.usd * 100) / 100,
        heldMinutes: Math.round(p.heldMinutes),
        multiplier: Math.round(p.multiplier * 100) / 100,
        boosted: p.boosted,
        tickets,
        sharePct: totalTickets ? Math.round((tickets / totalTickets) * 10000) / 100 : 0,
      };
    })
    .sort((a, b) => b.tickets - a.tickets);

  return {
    at: new Date(now).toISOString(),
    priceUsd: opts.priceUsd,
    holdersTotal: balances.length,
    eligible: rows.length,
    totalTickets,
    rows,
    state,
    memo,
    sold,
  };
}

// ---------- draw ----------

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic, publicly verifiable pick: seed = sha256(blockhash + boxId).
 * Anyone with the published ticket list and the blockhash can recompute the winner.
 */
export async function pickWinner(
  rows: Pick<TicketRow, "owner" | "tickets">[],
  blockhash: string,
  boxId: number,
): Promise<{ owner: string; seed: string; roll: number } | null> {
  const list = rows.filter((r) => r.tickets > 0).sort((a, b) => (a.owner < b.owner ? -1 : 1));
  const total = list.reduce((a, r) => a + r.tickets, 0);
  if (total <= 0) return null;
  const seed = await sha256Hex(`${blockhash}:${boxId}`);
  const roll = (parseInt(seed.slice(0, 13), 16) / 2 ** 52) * total; // 52 bits of entropy
  let acc = 0;
  for (const r of list) {
    acc += r.tickets;
    if (roll < acc) return { owner: r.owner, seed, roll };
  }
  return { owner: list[list.length - 1].owner, seed, roll };
}
