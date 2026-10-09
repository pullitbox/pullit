// All tunable thresholds for the market scanner live here.
// Money values are USD. Ages are hours.

export const SCANNER = {
  // Established runners of the current meta (not DOGE/PEPE dinosaurs)
  established: {
    minMcap: 1_500_000,
    minLiquidity: 100_000,
    minVolume24h: 300_000,
    minAgeHours: 72, // 3 days
    maxAgeHours: 24 * 60, // 60 days
    maxTopHoldersPct: 40,
  },

  // Fresh runners: graduated, young, gaining
  fresh: {
    minMcap: 100_000,
    minLiquidity: 25_000,
    minVolume24h: 80_000,
    maxAgeHours: 72,
    maxTopHoldersPct: 30,
    // buys must keep up with sells over the last 6h
    minBuySellRatio6h: 0.9,
  },

  // Applies to every candidate
  safety: {
    maxDevBalancePct: 10,
    minOrganicScore: 25, // Jupiter organic score 0..100, filters wash-traded tokens
  },

  // Never put these in a box (old dinosaurs, majors, stables). Symbols, upper case.
  excludeSymbols: [
    "SOL",
    "WSOL",
    "USDC",
    "USDT",
    "USD1",
    "PYUSD",
    "JUP",
    "BONK",
    "WIF",
    "POPCAT",
    "DOGE",
    "PEPE",
    "SHIB",
    "TRUMP",
    "MELANIA",
    "FARTCOIN",
    "PENGU",
    "BTC",
    "WBTC",
    "CBBTC",
    "ETH",
    "WETH",
    "JTO",
    "RAY",
    "PYTH",
  ],
  // Mints we never want, whatever their symbol (fill in as we go)
  excludeMints: [] as string[],

  // How many candidates per bucket the agent gets to choose from
  topN: { established: 20, fresh: 20 },
};

// Big liquid coins that are hot this week. They join the meta runners as extra options for the
// rare slot, so the agent has more to pick from. Not forced, not announced. Mints checked on Jupiter
// (verified) on 9 Oct 2026. Add or swap coins when the meta moves.
export const HOT = {
  minLiquidity: 100_000,
  minOrganicScore: 40,
  coins: [
    {
      symbol: "ZEC",
      mint: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
      why: "zcash, privacy coin of the quantum scare",
    },
    { symbol: "DARK", mint: "7KEPApdbBMByrmqihz3bht2uMhFQcatjfSFQCKq66kH3", why: "darkswap, private swaps on solana" },
    { symbol: "WLD", mint: "WLDTE73PPdfFFjhpBz8Yuhvx5N45gvgEgyMXqwa3rFn", why: "worldcoin, now on solana" },
  ],
};

export const JUPITER = {
  base: "https://api.jup.ag/tokens/v2",
  categories: ["toptrending", "toptraded", "toporganicscore"] as const,
  intervals: ["5m", "1h", "6h", "24h"] as const,
  limit: 100,
};
