// Market scanner: splits the Jupiter universe into two buckets
// (established runners, fresh runners), applies hard safety filters,
// and ranks what is left. Pure functions, no network calls here.

import { HOT, SCANNER } from "./config.ts";
import type { JupToken } from "./jupiter.ts";

export type Bucket = "established" | "fresh";

export interface Candidate {
  mint: string;
  symbol: string;
  name: string;
  bucket: Bucket;
  score: number;
  ageHours: number;
  mcap: number;
  liquidity: number;
  volume24h: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  holders: number;
  holderChange24h: number;
  netBuyers24h: number;
  buySellRatio6h: number;
  organicScore: number;
  topHoldersPct: number | null;
  devBalancePct: number | null;
  twitter: string | null;
  website: string | null;
}

export interface ScanResult {
  at: string;
  universe: number;
  established: Candidate[];
  fresh: Candidate[];
  hot?: Candidate[]; // hand-picked coins of the week; when present the rare slot comes from here
  rejected: Record<string, number>; // reason -> count, for tuning
}

const n = (v: number | null | undefined) => (typeof v === "number" && isFinite(v) ? v : 0);

function ageHours(t: JupToken, now: number): number | null {
  const ts = t.firstPool?.createdAt ?? t.createdAt;
  if (!ts) return null;
  const ms = Date.parse(ts);
  return isFinite(ms) ? (now - ms) / 3_600_000 : null;
}

function volume24h(t: JupToken): number {
  return n(t.stats24h?.buyVolume) + n(t.stats24h?.sellVolume);
}

function buySellRatio(s: JupToken["stats6h"]): number {
  const b = n(s?.buyVolume);
  const sell = n(s?.sellVolume);
  if (sell === 0) return b > 0 ? 10 : 0;
  return b / sell;
}

/** Returns a rejection reason, or null when the token passes the shared safety rules. */
function safetyReject(t: JupToken): string | null {
  const sym = (t.symbol || "").toUpperCase();
  if (SCANNER.excludeSymbols.includes(sym)) return "excluded_symbol";
  if (SCANNER.excludeMints.includes(t.id)) return "excluded_mint";
  if (t.tags?.some((x) => x === "lst" || x === "stocks")) return "lst_or_stock";
  const a = t.audit;
  if (a?.isSus) return "sus";
  if (a?.mintAuthorityDisabled === false || (t.mintAuthority ?? null) !== null) return "mint_authority";
  if (a?.freezeAuthorityDisabled === false || (t.freezeAuthority ?? null) !== null) return "freeze_authority";
  if (n(a?.devBalancePercentage) > SCANNER.safety.maxDevBalancePct) return "dev_balance";
  if (n(t.organicScore) < SCANNER.safety.minOrganicScore) return "low_organic";
  return null;
}

function classify(t: JupToken, age: number): { bucket: Bucket } | { reject: string } {
  const mcap = n(t.mcap);
  const liq = n(t.liquidity);
  const vol = volume24h(t);
  const top = t.audit?.topHoldersPercentage ?? null;

  const E = SCANNER.established;
  if (age >= E.minAgeHours && age <= E.maxAgeHours) {
    if (mcap < E.minMcap) return { reject: "est_mcap" };
    if (liq < E.minLiquidity) return { reject: "est_liquidity" };
    if (vol < E.minVolume24h) return { reject: "est_volume" };
    if (top !== null && top > E.maxTopHoldersPct) return { reject: "est_top_holders" };
    return { bucket: "established" };
  }

  const F = SCANNER.fresh;
  if (age < F.maxAgeHours) {
    if (!t.graduatedAt && !t.graduatedPool && t.launchpad) return { reject: "fresh_not_graduated" };
    if (mcap < F.minMcap) return { reject: "fresh_mcap" };
    if (liq < F.minLiquidity) return { reject: "fresh_liquidity" };
    if (vol < F.minVolume24h) return { reject: "fresh_volume" };
    if (top !== null && top > F.maxTopHoldersPct) return { reject: "fresh_top_holders" };
    if (buySellRatio(t.stats6h) < F.minBuySellRatio6h) return { reject: "fresh_selling" };
    return { bucket: "fresh" };
  }

  return { reject: "too_old" };
}

function toCandidate(t: JupToken, bucket: Bucket, age: number): Candidate {
  const s24 = t.stats24h;
  return {
    mint: t.id,
    symbol: t.symbol,
    name: t.name,
    bucket,
    score: 0,
    ageHours: Math.round(age * 10) / 10,
    mcap: n(t.mcap),
    liquidity: n(t.liquidity),
    volume24h: volume24h(t),
    priceChange1h: n(t.stats1h?.priceChange),
    priceChange6h: n(t.stats6h?.priceChange),
    priceChange24h: n(s24?.priceChange),
    holders: n(t.holderCount),
    holderChange24h: n(s24?.holderChange),
    netBuyers24h: n(s24?.numNetBuyers),
    buySellRatio6h: Math.round(buySellRatio(t.stats6h) * 100) / 100,
    organicScore: n(t.organicScore),
    topHoldersPct: t.audit?.topHoldersPercentage ?? null,
    devBalancePct: t.audit?.devBalancePercentage ?? null,
    twitter: t.twitter ?? null,
    website: t.website ?? null,
  };
}

/**
 * Rank-based score inside a bucket so one crazy number cannot dominate.
 * Signals: turnover (volume / mcap), 6h momentum (capped), holder growth,
 * net buyers, organic score.
 */
function score(list: Candidate[]): Candidate[] {
  if (list.length === 0) return list;
  const signals: Array<[number, (c: Candidate) => number]> = [
    [0.3, (c) => c.volume24h / Math.max(c.mcap, 1)],
    [0.2, (c) => Math.max(-50, Math.min(c.priceChange6h, 150))],
    [0.2, (c) => c.holderChange24h / Math.max(c.holders, 1)],
    [0.15, (c) => c.netBuyers24h],
    [0.15, (c) => c.organicScore],
  ];
  const total = new Map<string, number>();
  for (const [w, f] of signals) {
    const sorted = [...list].sort((a, b) => f(a) - f(b));
    sorted.forEach((c, i) => {
      const pct = list.length === 1 ? 1 : i / (list.length - 1);
      total.set(c.mint, (total.get(c.mint) ?? 0) + w * pct);
    });
  }
  return list
    .map((c) => ({ ...c, score: Math.round((total.get(c.mint) ?? 0) * 1000) / 10 }))
    .sort((a, b) => b.score - a.score);
}

/**
 * The hot coins that are fit for a prize right now. They are hand-picked bridged or verified coins,
 * so mint authority is not checked (bridges keep one); liquidity, fake volume and Jupiter's sus flag are.
 */
export function hotCandidates(tokens: (JupToken | null)[], now = Date.now()): Candidate[] {
  const out: Candidate[] = [];
  for (const h of HOT.coins) {
    const t = tokens.find((x) => x?.id === h.mint);
    if (!t || t.audit?.isSus) continue;
    if (n(t.liquidity) < HOT.minLiquidity || n(t.organicScore) < HOT.minOrganicScore) continue;
    out.push(toCandidate({ ...t, symbol: h.symbol }, "established", ageHours(t, now) ?? 24 * 365));
  }
  return score(out);
}

export function scan(universe: JupToken[], now = Date.now()): ScanResult {
  const rejected: Record<string, number> = {};
  const bump = (r: string) => (rejected[r] = (rejected[r] ?? 0) + 1);
  const buckets: Record<Bucket, Candidate[]> = { established: [], fresh: [] };

  for (const t of universe) {
    const age = ageHours(t, now);
    if (age === null) {
      bump("no_age");
      continue;
    }
    const unsafe = safetyReject(t);
    if (unsafe) {
      bump(unsafe);
      continue;
    }
    const c = classify(t, age);
    if ("reject" in c) {
      bump(c.reject);
      continue;
    }
    buckets[c.bucket].push(toCandidate(t, c.bucket, age));
  }

  return {
    at: new Date(now).toISOString(),
    universe: universe.length,
    established: score(buckets.established).slice(0, SCANNER.topN.established),
    fresh: score(buckets.fresh).slice(0, SCANNER.topN.fresh),
    rejected,
  };
}
