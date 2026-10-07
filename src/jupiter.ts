// Minimal Jupiter Tokens API v2 client (fetch only, runs in Node and Cloudflare Workers).

import { JUPITER } from "./config.ts";

export interface SwapStats {
  priceChange?: number | null;
  holderChange?: number | null;
  liquidityChange?: number | null;
  volumeChange?: number | null;
  buyVolume?: number | null;
  sellVolume?: number | null;
  buyOrganicVolume?: number | null;
  sellOrganicVolume?: number | null;
  numBuys?: number | null;
  numSells?: number | null;
  numTraders?: number | null;
  numOrganicBuyers?: number | null;
  numNetBuyers?: number | null;
}

export interface JupToken {
  id: string;
  name: string;
  symbol: string;
  icon?: string | null;
  decimals: number;
  createdAt?: string;
  twitter?: string | null;
  website?: string | null;
  dev?: string | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  launchpad?: string | null;
  graduatedPool?: string | null;
  graduatedAt?: string | null;
  holderCount?: number | null;
  totalSupply?: number | null;
  circSupply?: number | null;
  fdv?: number | null;
  mcap?: number | null;
  usdPrice?: number | null;
  liquidity?: number | null;
  stats5m?: SwapStats | null;
  stats1h?: SwapStats | null;
  stats6h?: SwapStats | null;
  stats24h?: SwapStats | null;
  firstPool?: { id: string; createdAt: string } | null;
  audit?: {
    isSus?: boolean | null;
    mintAuthorityDisabled?: boolean | null;
    freezeAuthorityDisabled?: boolean | null;
    topHoldersPercentage?: number | null;
    devBalancePercentage?: number | null;
    devMints?: number | null;
  } | null;
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean | null;
  tags?: string[] | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(path: string, apiKey: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${JUPITER.base}${path}`, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
    });
    if (res.status === 429 && attempt < 4) {
      await sleep(1500 * 2 ** attempt); // free tier rate limit: back off and retry
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jupiter ${path} -> ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}

/** Pull every category x interval list plus recent tokens and dedupe by mint. */
export async function fetchUniverse(apiKey: string): Promise<JupToken[]> {
  const paths: string[] = [];
  for (const c of JUPITER.categories) {
    for (const i of JUPITER.intervals) paths.push(`/${c}/${i}?limit=${JUPITER.limit}`);
  }
  paths.push(`/recent?limit=${JUPITER.limit}`);

  // one request at a time with a small gap, the free tier rate-limits bursts
  const results: PromiseSettledResult<JupToken[]>[] = [];
  for (const p of paths) {
    try { results.push({ status: "fulfilled", value: await get<JupToken[]>(p, apiKey) }); }
    catch (reason) { results.push({ status: "rejected", reason }); }
    await sleep(350);
  }
  const byId = new Map<string, JupToken>();
  const errors: string[] = [];
  results.forEach((r, idx) => {
    if (r.status === "fulfilled") {
      for (const t of r.value) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
    } else {
      errors.push(`${paths[idx]}: ${r.reason}`);
    }
  });
  if (byId.size === 0) throw new Error(`Jupiter returned nothing. ${errors.join(" | ")}`);
  if (errors.length) console.warn(`[jupiter] ${errors.length} lists failed:`, errors);
  return [...byId.values()];
}

/** One token by mint (price, decimals, supply). */
export async function fetchToken(apiKey: string, mint: string): Promise<JupToken | null> {
  const list = await get<JupToken[]>(`/search?query=${mint}`, apiKey);
  return list.find((t) => t.id === mint) ?? null;
}

/** Tokenized stocks (xStocks etc.) for the Rare tier. */
export async function fetchStocks(apiKey: string): Promise<JupToken[]> {
  return get<JupToken[]>(`/tag?query=stocks`, apiKey);
}
