import { test } from "node:test";
import assert from "node:assert/strict";
import { scan } from "../src/scanner.ts";
import type { JupToken } from "../src/jupiter.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function tok(p: Partial<JupToken> & { id: string; symbol: string; age: number }): JupToken {
  const { age, ...rest } = p;
  return {
    name: p.symbol,
    decimals: 6,
    firstPool: { id: "pool", createdAt: hoursAgo(age) },
    graduatedAt: hoursAgo(Math.max(age - 1, 0)),
    mintAuthority: null,
    freezeAuthority: null,
    audit: { isSus: false, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20, devBalancePercentage: 1 },
    organicScore: 70,
    holderCount: 5000,
    mcap: 3_000_000,
    liquidity: 200_000,
    stats6h: { buyVolume: 300_000, sellVolume: 250_000, priceChange: 20 },
    stats24h: { buyVolume: 600_000, sellVolume: 500_000, holderChange: 400, numNetBuyers: 300, priceChange: 50 },
    ...rest,
  } as JupToken;
}

test("splits into established and fresh buckets", () => {
  const r = scan([
    tok({ id: "A", symbol: "OLDRUN", age: 24 * 7 }),
    tok({ id: "B", symbol: "NEWRUN", age: 20, mcap: 400_000, liquidity: 60_000 }),
  ], NOW);
  assert.equal(r.established.map((c) => c.symbol).join(), "OLDRUN");
  assert.equal(r.fresh.map((c) => c.symbol).join(), "NEWRUN");
});

test("hard safety filters reject bad tokens", () => {
  const r = scan([
    tok({ id: "1", symbol: "BONK", age: 24 * 7 }),
    tok({ id: "2", symbol: "MINTY", age: 24 * 7, mintAuthority: "someone" }),
    tok({ id: "3", symbol: "SUS", age: 24 * 7, audit: { isSus: true } }),
    tok({ id: "4", symbol: "WASH", age: 24 * 7, organicScore: 5 }),
    tok({ id: "5", symbol: "DEVBAG", age: 24 * 7, audit: { devBalancePercentage: 25 } }),
  ], NOW);
  assert.equal(r.established.length + r.fresh.length, 0);
  assert.equal(r.rejected.excluded_symbol, 1);
  assert.equal(r.rejected.mint_authority, 1);
  assert.equal(r.rejected.sus, 1);
  assert.equal(r.rejected.low_organic, 1);
  assert.equal(r.rejected.dev_balance, 1);
});

test("bucket thresholds apply", () => {
  const r = scan([
    tok({ id: "a", symbol: "SMALLEST", age: 24 * 5, mcap: 900_000 }),
    tok({ id: "b", symbol: "DUMPING", age: 10, mcap: 300_000, liquidity: 50_000, stats6h: { buyVolume: 100, sellVolume: 1000 } }),
    tok({ id: "c", symbol: "ANCIENT", age: 24 * 90 }),
  ], NOW);
  assert.equal(r.rejected.est_mcap, 1);
  assert.equal(r.rejected.fresh_selling, 1);
  assert.equal(r.rejected.too_old, 1);
});

test("ranking prefers higher turnover and momentum", () => {
  const r = scan([
    tok({ id: "x", symbol: "HOT", age: 24 * 5, stats6h: { buyVolume: 900_000, sellVolume: 500_000, priceChange: 80 } }),
    tok({ id: "y", symbol: "MEH", age: 24 * 5, stats6h: { buyVolume: 200_000, sellVolume: 190_000, priceChange: -10 }, stats24h: { buyVolume: 160_000, sellVolume: 150_000, holderChange: 10, numNetBuyers: 5 } }),
  ], NOW);
  assert.equal(r.established[0].symbol, "HOT");
});
