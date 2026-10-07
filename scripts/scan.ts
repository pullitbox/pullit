// Local preview of the market scanner.
// Usage: JUP_API_KEY=... node scripts/scan.ts            (table)
//        JUP_API_KEY=... node scripts/scan.ts --json     (raw JSON)

import { mkdirSync, writeFileSync } from "node:fs";
import { fetchUniverse } from "../src/jupiter.ts";
import { scan, type Candidate } from "../src/scanner.ts";

const key = process.env.JUP_API_KEY;
if (!key) {
  console.error("Set JUP_API_KEY (free key from https://portal.jup.ag)");
  process.exit(1);
}

const usd = (v: number) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`;

function table(title: string, list: Candidate[]) {
  console.log(`\n${title} (${list.length})`);
  console.table(
    list.map((c) => ({
      score: c.score,
      symbol: c.symbol,
      age_h: c.ageHours,
      mcap: usd(c.mcap),
      liq: usd(c.liquidity),
      vol24h: usd(c.volume24h),
      "6h%": Math.round(c.priceChange6h),
      "24h%": Math.round(c.priceChange24h),
      holders: c.holders,
      organic: Math.round(c.organicScore),
    })),
  );
}

const universe = await fetchUniverse(key);
const result = scan(universe);

// Save raw data so it can be inspected and thresholds tuned
mkdirSync("out", { recursive: true });
writeFileSync("out/universe.json", JSON.stringify(universe, null, 2));
writeFileSync("out/last-scan.json", JSON.stringify(result, null, 2));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Scanned ${result.universe} tokens at ${result.at}`);
  table("ESTABLISHED RUNNERS", result.established);
  table("FRESH RUNNERS", result.fresh);
  console.log("\nRejected by rule:", result.rejected);
}
