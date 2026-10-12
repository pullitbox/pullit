// Things that make trading $PULLIT worth it: frenzy odds, market cap milestones,
// and a buyback and burn on every box.
// The bot only ever buys $PULLIT with SOL, and only to burn it. There is no code path that sells it.

import type { JupToken } from "./jupiter.ts";

export const BOOST = {
  burnPct: 10, // of every box, spent on $PULLIT that is burned right away
  // frenzy: more volume in the last hour, better odds for the next box. odds are common/rare/epic/secret
  frenzy: [
    { minVolume1h: 0, odds: [50, 30, 19, 1] },
    { minVolume1h: 20_000, odds: [45, 30, 24, 1] },
    { minVolume1h: 60_000, odds: [40, 30, 29, 1] },
    { minVolume1h: 150_000, odds: [35, 30, 34, 1] },
  ],
  // the first box after the market cap crosses one of these is a milestone box: epic or better, plus vault
  milestonesUsd: [50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000],
  milestoneVaultPct: 0, // to the winner of a milestone box
  // the launch reserve (bought at launch into the box) loses this share of its original size at each of these caps
  reserveBurnPct: 10,
  reserveBurnAtUsd: [50_000, 125_000, 200_000, 350_000],
  milestoneBurnVaultPct: 0, // of what is left in the vault, bought back and burned on a milestone box
};

export type Odds = [number, number, number, number];

/** USD traded in the last hour, buys plus sells. */
export const volume1h = (t: Pick<JupToken, "stats1h">) => (t.stats1h?.buyVolume ?? 0) + (t.stats1h?.sellVolume ?? 0);

export function frenzyLevel(volumeUsd1h: number): number {
  let level = 0;
  BOOST.frenzy.forEach((f, i) => {
    if (volumeUsd1h >= f.minVolume1h) level = i;
  });
  return level;
}

export const oddsAt = (level: number): Odds => [...BOOST.frenzy[level].odds] as Odds;

/** Milestones the market cap has crossed that were not celebrated yet, lowest first. */
export function newMilestones(mcapUsd: number, hit: number[]): number[] {
  return BOOST.milestonesUsd.filter((m) => mcapUsd >= m && !hit.includes(m));
}

/** "100K", "2.5M" */
export function usdShort(n: number): string {
  return n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`;
}
