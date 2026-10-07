// Local preview of the holder tracker on any existing coin.
// Usage: MINT=<mint> npm run holders
// Run it a few times: out/holder-state-<mint>.json remembers hold timers between runs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { computeTickets, fetchHolders, pickWinner, type HolderState } from "../../src/holders.ts";
import { fetchToken } from "../../src/jupiter.ts";

const { HELIUS_API_KEY, JUP_API_KEY, MINT } = process.env;
if (!HELIUS_API_KEY || !JUP_API_KEY || !MINT) {
  console.error("Need HELIUS_API_KEY and JUP_API_KEY in .env, and MINT=<mint> on the command line");
  process.exit(1);
}

const token = await fetchToken(JUP_API_KEY, MINT);
if (!token?.usdPrice) throw new Error("No price for this mint on Jupiter");

const t0 = Date.now();
const balances = await fetchHolders(HELIUS_API_KEY, MINT, token.decimals);
const fetchMs = Date.now() - t0;

mkdirSync("out", { recursive: true });
const statePath = `out/holder-state-${MINT}.json`;
const prev: HolderState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

// Biggest holder is usually the pool; exclude it for the preview.
const biggest = [...balances].sort((a, b) => b.amount - a.amount)[0]?.owner;
const snap = computeTickets(balances, prev, {
  priceUsd: token.usdPrice,
  totalSupply: token.totalSupply ?? 1_000_000_000,
  exclude: biggest ? [biggest] : [],
});
writeFileSync(statePath, JSON.stringify(snap.state));
writeFileSync(`out/tickets-${MINT}.json`, JSON.stringify(snap, null, 2));

console.log(`${token.symbol}: ${snap.holdersTotal} holders fetched in ${fetchMs} ms, price $${token.usdPrice}`);
console.log(`Excluded as pool: ${biggest}`);
console.log(`Eligible now (>= $20, held >= 7 min): ${snap.eligible}`);
if (snap.eligible === 0) {
  console.log("First run only starts the timers. Run again in 15+ minutes to see tickets.");
} else {
  console.table(
    snap.rows.slice(0, 15).map((r) => ({
      owner: r.owner.slice(0, 4) + "…" + r.owner.slice(-4),
      usd: r.usd,
      held_min: r.heldMinutes,
      mult: r.multiplier,
      share: `${r.sharePct}%`,
    })),
  );
  const w = await pickWinner(snap.rows, `demo-${Date.now()}`, 0);
  console.log(`Demo draw winner: ${w?.owner}`);
}
