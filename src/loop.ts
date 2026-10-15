// The main loop as a state machine. tick() is called once a minute (Node setInterval or a
// Cloudflare cron). Every step is idempotent and the whole state is one JSON object, so a
// crash or restart just continues from the saved state.

import { Rpc, keypairFromSecret, LAMPORTS, type Keypair } from "./solana.ts";
import {
  fetchHolders,
  fetchNetSolIn,
  computeTickets,
  entryUsd,
  type BagMemo,
  type HolderState,
  type TicketRow,
  HOLDERS,
  type Rush,
} from "./holders.ts";
import { fetchToken, fetchUniverse, type JupToken } from "./jupiter.ts";
import { hotCandidates, scan, type Candidate } from "./scanner.ts";
import { HOT } from "./config.ts";
import { say, remember } from "./voice.ts";
import { TEASERS, TEASE_TOPICS } from "./teasers.ts";
import { quip, similar, fillQuip, type BoxPlan } from "./agent.ts";
import { fetchNewBuys, luckyRoll, mustHold, GAMES, type Buy } from "./games.ts";
import { buildSplit, claimedBy, claimPumpCreatorFees, shouldRunFinalBox, FEES, type FeeLedgerEntry } from "./fees.ts";
import {
  blockhashAt,
  draw,
  payout,
  prizeBudget,
  prizeMint,
  prizeSplit,
  sealOf,
  newSalt,
  buyInto,
  buyViaPumpPortal,
  burnAll,
  sendSol,
  MINTS,
  EXEC,
  type Draw,
} from "./executor.ts";
import { BOOST, frenzyLevel, oddsAt, newMilestones, usdShort, volume1h } from "./boost.ts";
import { findXAccount, zernioPost } from "./zernio.ts";
import { SPAWN, skipReason, launchCoin, coinSymbol, type SpawnState } from "./spawn.ts";

export const LOOP = {
  prepackAtPct: 60, // pick the coins once the box is this full
  prepackFreshMin: 8, // older picks are redone, the market moves
  claimEverySec: 15, // the worker runs claim passes at 15s, 30s and 45s into every cron minute
  holdersEveryMin: 5,
  topHoldersToInspect: 40, // pools and curves are always among the biggest holders
  vaultPct: 0, // the vault is no longer filled: everything goes into the box. what is in it stays for a secret pull or the final box
  // dry run runs fast so a full cycle can be watched in minutes
  dry: { solPerMin: 0.05, claimEverySec: 60, holdersEveryMin: 1, minHoldMinutes: 1 },
  boxCapX: 3, // one box pays out at most 3x its size, the rest waits for the next boxes
  // dry run: fake volume swings between quiet and busy every 40 minutes, so both moods show up
  quietMin: { live: 6, dry: 2 }, // minutes of silence before the box says something on its own
  xEveryMin: { live: [480, 720], dry: [8, 12] }, // a standalone shitpost on x every so often (dry: printed, not posted)
  scanEveryMin: { live: 10, dry: 3 }, // the agent re-reads the market while the box fills
  priceMovePct: { live: 10, dry: 6 }, // $PULLIT move between snapshots worth a comment
  fillCallouts: [25, 50, 75, 90], // box fill % the agent calls out
};

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** pump.fun curve: 1B supply, 793.1M sold on the curve, the rest goes to the pool at the bond */
const CURVE = { supply: 1_000_000_000, sellable: 793_100_000, decimals: 6, marks: [50, 75, 90] };

export interface BoxRecord {
  boxId: number;
  plan: BoxPlan;
  budgetLamports: string; // what was in the box (without the vault) when it was packed
  seal: string; // sha256("<common mint>|<rare mint>|<salt>"), public while sealed
  salt?: string; // secret until the box opens
  targetSlot: number;
  eligible: number;
  draw?: Draw;
  prize?: {
    sig: string;
    mint: string;
    amount: string;
    symbol: string;
    lamports: string;
    fromVault: string;
  };
  odds?: number[]; // common/rare/epic/secret %, locked when the box was sealed (frenzy)
  frenzy?: number; // frenzy level when sealed
  milestone?: number; // market cap in USD this box celebrates: epic or better, plus vault
  bond?: boolean; // the bond box: epic or better
  epic?: boolean; // one of an epic run: epic or better
  burnLamports?: string; // part of the box spent on buyback and burn
  burn?: { buySig: string; burnSig: string; amount: string; lamports: string; fromVault?: string };
  // progress, so a retry never pays twice: signed (inflight), landed (coin), buyback bought, burn done
  paid?: {
    inflight?: { sig: string; at: number };
    coin?: { sig: string; amount: string; inSol?: boolean };
    tries?: number;
    burnBuy?: { sig: string; amount: string };
    burnInflight?: { sig: string; at: number }; // buyback signed, not confirmed
    burn?: boolean;
  };
  posts: string[];
  final?: boolean;
  at: string;
}

export interface State {
  v: 1;
  launchedAt: number;
  nextBoxId: number;
  phase: "filling" | "drawing" | "done";
  pending?: BoxRecord & { rows: Pick<TicketRow, "owner" | "tickets">[] };
  /** coins picked ahead while the box fills, so a full box seals in seconds */
  prepack?: { boxId: number; at: number } & Awaited<ReturnType<Bot["pack"]>>;
  holderState: HolderState;
  bagMemo?: BagMemo; // last amounts and last buys, for the buy boost and the sell reset
  redCache?: Record<string, { at: number; amount: number; netSol: number }>; // net SOL each holder put in, for the red bonus
  lastHoldersAt: number;
  lastClaimAt: number;
  misses?: Record<string, number>; // wallet -> boxes in a row it was in the draw and did not win
  pendingFees?: string; // claimed fees not split yet (lamports)
  claimSigs?: string[]; // claim txs whose amount is not counted yet
  splitInflight?: { sig: string; at: number; total: string; box: string; team: string }; // a split sent, not confirmed
  lastClaimOkAt?: number; // last time a claim went through (even with no fees), for the final box rule
  resumed?: string; // id of the last RESUME applied, so a closed box reopens once
  feeLedger: FeeLedgerEntry[];
  excluded: string[]; // pools, curves, our own wallets
  history: BoxRecord[];
  log: string[];
  feed: { at: string; tag: string; m: string; tx?: string }[]; // human readable, shown on the site
  vaultLamports: string; // part of the box wallet set aside for secret pulls
  boxTarget?: string; // size of the box that is filling now, picked from recent volume when the last one opened
  bags?: Record<string, number>; // owner -> % of supply, bags of 0.1%+, to notice whales and full exits
  crowned?: string[]; // holders already congratulated for 24h
  dryBalance?: string; // dry run: simulated box wallet balance
  nextXAt?: number; // when the next standalone x shitpost goes out
  xRecent?: string[]; // last x posts, so it does not repeat itself
  talk?: {
    entry?: number;
    box: number;
    milestone: number;
    price?: number;
    priceAt?: number;
    eligible?: number;
    holders?: number;
  }; // what the agent already commented on
  mintSeen?: string;
  spawn?: SpawnState; // the flywheel: coins launched by opened boxes
  market?: { mcap: number; volume1h: number; at: string }; // $PULLIT, from the last holder snapshot
  graduated?: string; // the pool jupiter says $PULLIT graduated to
  frenzy?: number; // current frenzy level, 0 = normal odds
  milestonesHit?: number[]; // market caps already celebrated
  milestoneQueue?: number[]; // market caps waiting for their milestone box, one box each
  burned?: { lamports: string; tokens: string }; // totals of all buybacks and burns
  burnPending?: boolean; // the box holds bought $PULLIT that still has to be burned
  // $PULLIT bought into the box at launch. the bot never sells it: 10% is burned at 50K, 125K, 200K and 350K cap
  reserve?: { initial: string; left: string; burns: { at: string; sig: string; amount: string; milestone: number }[] };
  nextTeaseAt?: number; // before launch: when the next teaser goes out on x
  priceUsd?: number; // last $PULLIT price seen
  burnPendingIds?: number[]; // boxes whose burn is waiting for the leftover burn
  games?: {
    cursor?: string; // newest tx of the mint already read
    clockPot: string;
    luckyPot: string;
    readAt?: number; // last read of new buys (helius history costs credits)
    bondPot?: string; // the bond race: grows until the bond, then the last $50+ curve buyer who still holds takes it
    bondLast?: Buy[]; // the last $50+ buyers on the curve, newest first
    bondDone?: boolean; // the bond race was paid out (or rolled into the box)
    bondSeed?: string; // lamports the dev added to the bond pot (BOND_SEED_SOL), counted once
    clock?: { endsAt: number; last: Buy[] }; // last qualifying buyers, newest first
    queue: Buy[]; // buys waiting for their lucky roll
    recent?: Buy[]; // the last qualifying buys, shown live on the site
    luckyLast: Record<string, number>; // last lucky win per wallet
    paying?: {
      kind: "clock" | "lucky" | "bond";
      to: string;
      lamports: string;
      at: number;
      buySig: string;
      seed?: string;
      sig?: string;
    };
    wins: {
      kind: "clock" | "lucky" | "bond";
      to: string;
      lamports: string;
      at: string;
      sig: string;
      buySig: string;
      seed?: string;
    }[];
  };
  xFeed?: { at: string; text: string; url?: string }[]; // the latest posts on x, shown on the site
  xPostedAt?: number[]; // times of the x posts of the last 24 hours, for the daily cap
  dexPaid?: { posted?: boolean; checkedAt?: number };
  /** community votes the bot carried out: what won, what it did, the transactions */
  votes?: Record<
    string,
    { choice: string; status: "started" | "done" | "failed"; at: number; sigs?: string[]; note?: string }
  >;
  /** after a vote for boxes: the next `left` boxes are `lamports` (VOTE_BOX_LAMPORTS if unset) and pay out exactly that */
  voteBoost?: { left: number; lamports?: string };
  /** a run of boxes that are all epic or better, once per EPIC_RUN id */
  epicRun?: { id: string; left: number };
  /** the vault paid out over the next boxes: each takes `per` on top of its size */
  vaultDrip?: { id: string; left: number; per: string };
  bond?: { at?: number; queued?: boolean; checkedAt?: number };
  /** the pump bonding curve: its owner account, how far it is (0-100) and the bond-progress posts already made */
  curve?: { owner?: string; pct?: number; at?: number; marks?: number[]; lookedAt?: number }; // migration to pumpswap: the next box is epic or better // the one "dex paid" post, once dexscreener confirms it
  recapPosted?: boolean; // the first-hour recap went out
  teaseUsed?: number[]; // hand-written teasers already posted this round
  teaseTopics?: string[]; // topics of the last pre-launch posts, oldest first
  journal?: JournalEntry[]; // what changed in the project, in the box's words
  watch?: { at: number; fresh: string[]; meta: string[] }; // the agent's current shortlist (mints), never public
  // handed to the host (worker) after a tick and removed from state, so state stays small
  lastSnap?: {
    at: string;
    totalTickets: number;
    priceUsd?: number;
    rows: [string, number, number, number, number?][]; // owner, tickets, heldMin, mult, boosted (1)
  };
  outbox?: { boxId: number; rows: Pick<TicketRow, "owner" | "tickets">[] }[];
  pub?: {
    updatedAt: string;
    box: string;
    team: string;
    dev?: string;
    mint?: string;
    boxLamports: string;
    thresholdLamports: string;
    vaultLamports?: string;
    holders: number;
    eligible: number;
    frenzy?: number;
    odds?: number[];
    mcap?: number;
    nextMilestone?: number;
    entryUsd?: number; // bag needed to be in the draw for this box
    milestoneBox?: number; // the box that is filling is a milestone box for this market cap
    bondBox?: boolean; // the box that is filling is the bond box
    epicLeft?: number; // boxes left in the epic run, the one filling included
    buyBoostPct?: number; // extra tickets for a buy in the last hour
    rush?: { from: number; to: number; x: number }; // a rush window: buys inside it get x tickets
    vaultSlice?: string; // lamports from the vault on top of the box that is filling
    vaultDripLeft?: number; // boxes left that take a slice of the vault
    curvePct?: number; // bonding curve progress, 0-100, until the bond
    hints?: {
      vol1h: number; // usd traded in the last hour
      frenzyNextAt?: number; // usd per hour for the next frenzy level
      frenzyNextEpic?: number; // epic % at that level
      boxNow: number; // sol, the next box at this pace
      boxNext?: number; // sol, the size after that
      boxNextVol?: number; // usd per hour that would get it, at the current fee rate
    };
    reserve?: { initial: string; left: string }; // launch reserve, raw $PULLIT
    burned?: { lamports: string; tokens: string };
  };
}

export interface JournalEntry {
  at: string;
  kind: "ship" | "rule" | "fix" | "burn";
  text: string;
  commit?: string; // short hash; the site links it once the repo is public (REPO_URL)
}

/** Sorts a commit into a journal kind by its message. */
export function journalKind(msg: string): JournalEntry["kind"] {
  const m = msg.toLowerCase();
  if (/\bburn|buyback/.test(m)) return "burn";
  if (/^fix|\bfix|bug|broke/.test(m)) return "fix";
  if (/odds|entry|ticket|rule|boost|frenzy|milestone|hold|tier|vault|fee/.test(m)) return "rule";
  return "ship";
}

export function newState(now = Date.now()): State {
  return {
    v: 1,
    launchedAt: now,
    nextBoxId: 1,
    phase: "filling",
    holderState: {},
    lastHoldersAt: 0,
    lastClaimAt: 0,
    feeLedger: [],
    excluded: [],
    history: [],
    log: [],
    feed: [],
    vaultLamports: "0",
  };
}

export interface Env {
  MINT?: string;
  HELIUS_API_KEY: string;
  RPC_URL?: string; // optional plain solana rpc for balances, claims and payouts; helius stays for holders and history
  JUP_API_KEY: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  ZERNIO_API_KEY?: string;
  DEV_SECRET?: string; // only needed to claim fees
  BOX_SECRET: string;
  TEAM_WALLET: string;
  DRY_RUN?: string; // "1": no claims, no payouts, no posts (prints instead), simulated fees
  MAX_BOX_SOL?: string; // optional hard cap for one box, in SOL
  BONDED?: string; // "1": treat $PULLIT as bonded now, when the automatic checks miss the migration
  BOND_SEED_SOL?: string; // SOL the dev sent to the box wallet for the bond race pot, added to it once
  DRY_SOL_PER_MIN?: string; // dry run: average fake fees per minute (default 0.05)
  X_PRELAUNCH?: string; // "1": before launch the box posts teasers on x by itself (test boxes are never posted)
  X_PRELAUNCH_EVERY_MIN?: string; // minutes between teasers, default 480
  X_MAX_PER_DAY?: string; // most posts on x in any 24 hours, default 3
  RUSH_AT?: string; // ISO time: buys in the next RUSH.minutes get RUSH.x tickets for RUSH.hours (until they sell)
  BUILD_COMMITS?: string; // set by `npm run deploy`: base64 JSON of recent commits, for the journal
  SPAWN?: string; // "1": every opened box launches its own coin from the dev wallet (the flywheel)
  SPAWN_DEV_BUY_SOL?: string; // dev buy on each box coin, default 0
}

/** Why a coin was picked, in words that do not give away which coin it is. */
export function criteria(c: Candidate | undefined, kind: "fresh" | "meta"): string {
  if (!c) return kind === "fresh" ? "a fresh runner" : "a runner of the meta";
  const age =
    c.ageHours < 24
      ? "under a day old"
      : c.ageHours < 72
        ? "a couple of days old"
        : c.ageHours < 24 * 7
          ? "about a week old"
          : "a few weeks old";
  const why = [age];
  if (c.buySellRatio6h > 1.05) why.push("more buyers than sellers");
  if (c.holderChange24h > 0) why.push("holders growing");
  if (c.organicScore >= 60) why.push("real volume");
  if (c.devBalancePct != null && c.devBalancePct < 2) why.push("dev barely holds");
  return `${kind === "fresh" ? "a fresh runner" : "a runner of the meta"}: ${why.slice(0, 4).join(", ")}`;
}

/** The sizes a box can have, in SOL. The first box is always 0.15 so the launch sees one open fast. */
export const BOX_SIZES = [0.15, 0.2, 0.25, 0.3, 0.5, 0.75, 1, 1.5, 2, 2.75, 3.5, 4];
export const FIRST_BOX = 0.15;
/** Box size while a community vote's extra SOL is being paid out over the next boxes. */
export const VOTE_BOX_LAMPORTS = 300_000_000n;
/** Opens the vault once per id: what is in it is split evenly over the next `boxes` boxes. */
/** A rush: buys in a short window get x times the tickets for a while (set with RUSH_AT). */
export const RUSH = { minutes: 15, x: 3, hours: 24 };
/** Reopens the box once after a final box (bump the id to reopen again). */
export const RESUME = {
  id: "r1",
  text: "false alarm. a quiet night tripped the final box rule. that rule is gone now. box is back, 0.05 sol per box until volume comes back",
};
export const VAULT_DRIP = { id: "d1", boxes: 3 };
/** Once per id: the next `boxes` boxes are epic or better. */
export const EPIC_RUN = { id: "e1", boxes: 3 };
/** While set, every box is this size no matter the volume. null turns the volume sizing back on. */
export const FIXED_BOX: number | null = 0.05;
const FILL_MINUTES = 40; // a box should fill in about this long at the current volume

/**
 * Picks the next box size from how fast fees came in over the last hour: the biggest size that
 * fills in about 40 minutes at that pace. Hot volume, big box. Dead volume, small box.
 */
export function nextBoxSize(
  ledger: FeeLedgerEntry[],
  now = Date.now(),
  boxPct = 80,
): { lamports: bigint; perHour: bigint } {
  const hour = ledger.filter((e) => e.at >= now - 3_600_000).reduce((a, e) => a + BigInt(e.lamports), 0n);
  // what reaches the box: its share of the fees (boxPct), minus the vault's cut
  const perHour = (hour * BigInt(boxPct) * BigInt(100 - LOOP.vaultPct)) / 10_000n;
  const fillable = (Number(perHour) / 1e9) * (FILL_MINUTES / 60);
  const sol = FIXED_BOX ?? [...BOX_SIZES].reverse().find((x) => x <= fillable) ?? BOX_SIZES[0];
  return { lamports: BigInt(Math.round(sol * 1e9)), perHour };
}

export function boxSize(opened: number, target?: string): bigint {
  if (opened === 0) return BigInt(Math.round(FIRST_BOX * 1e9));
  if (FIXED_BOX) return BigInt(Math.round(FIXED_BOX * 1e9));
  return target ? BigInt(target) : BigInt(Math.round(BOX_SIZES[0] * 1e9));
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const sol = (l: bigint) => (Number(l) / Number(LAMPORTS)).toFixed(3);

export class Bot {
  rpc: Rpc;
  dry: boolean;
  private box!: Keypair;
  private dev?: Keypair;
  private xAccountId?: string;
  coinImage?: (boxId: number) => Promise<Uint8Array>; // set by the worker: the picture of a box coin
  env: Env;
  state: State;
  constructor(env: Env, state: State) {
    this.env = env;
    this.state = state;
    this.rpc = new Rpc(env.RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`);
    this.dry = env.DRY_RUN === "1";
  }

  /** A line for the public log on the site. */
  feed(
    tag: "fee" | "scan" | "pick" | "box" | "draw" | "win" | "sent" | "info" | "roast" | "hold" | "x" | "boost" | "burn",
    m: string,
    tx?: string,
  ) {
    const feed = this.state.feed ?? [];
    // nothing on the log is said twice, whatever the tag. wins and draws always go through
    if (!m || (tag !== "win" && tag !== "draw" && tag !== "burn" && feed.some((f) => similar(f.m, m)))) return;
    this.state.feed = [...feed, { at: new Date().toISOString(), tag, m, ...(tx ? { tx } : {}) }].slice(-60);
    remember(this.state.feed.map((f) => f.m));
  }

  private quips = 0; // model calls this tick, capped so a tick stays fast

  /** A log line written by the agent about an event, or the template line if the model is unavailable. */
  async line(
    tag: Parameters<Bot["feed"]>[0],
    facts: string,
    must: string[],
    fallback: string,
    wallet?: string,
    tx?: string,
    ban: string[] = [], // words that must never show up, e.g. the sealed coins
  ) {
    let m: string | null = null;
    if (this.quips < 14) {
      this.quips++;
      m = await quip(
        this.env.OPENROUTER_API_KEY,
        facts,
        must,
        (this.state.feed ?? []).map((f) => f.m),
        this.env.OPENROUTER_MODEL,
        wallet,
      );
    }
    if (m && ban.some((w) => w && m!.toLowerCase().includes(w.toLowerCase()))) m = null;
    // a win or a draw is never skipped: if every template was used already, say the plain fact
    if (!m && !fallback && (tag === "win" || tag === "draw" || tag === "burn")) m = fillQuip(facts, wallet);
    this.feed(tag, m ?? fallback, tx);
  }

  /** A post for x written by the agent, or the fallback. Remembered so the next one is different. */
  async xLine(facts: string, must: string[], fallback: string, wallet?: string) {
    const recent = [...(this.state.xRecent ?? []), ...(this.state.feed ?? []).map((f) => f.m)];
    const m =
      (await quip(this.env.OPENROUTER_API_KEY, facts, must, recent, this.env.OPENROUTER_MODEL, wallet, true)) ??
      (fallback && !recent.some((r) => similar(r, fallback)) ? fallback : "");
    if (!m) return "";
    this.state.xRecent = [...(this.state.xRecent ?? []), m].slice(-20);
    return m;
  }

  log(msg: string) {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    this.state.log = [...this.state.log.slice(-199), line];
  }

  async init() {
    this.box = await keypairFromSecret(this.env.BOX_SECRET);
    if (this.env.DEV_SECRET) this.dev = await keypairFromSecret(this.env.DEV_SECRET);
    const own = [this.box.publicKey, this.env.TEAM_WALLET, this.dev?.publicKey].filter(Boolean) as string[];
    this.state.excluded = [...new Set([...this.state.excluded, ...own])];
    this.state.pub = {
      ...(this.state.pub ?? { boxLamports: "0", thresholdLamports: "0", holders: 0, eligible: 0, updatedAt: "" }),
      // the host decides whether the public can see this (the site is hidden before launch)
      box: this.box.publicKey,
      team: this.env.TEAM_WALLET,
      dev: this.dev?.publicKey,
      mint: this.env.MINT,
    };
  }

  /**
   * Posts on x, at most X_MAX_PER_DAY (default 3) in any 24 hours. `important` posts (big wins,
   * milestones) may use the last slot of the day; shitposts and teasers leave it free.
   */
  async post(
    text: string,
    replies: string[] = [],
    evenInDryRun = false,
    important: boolean | "always" = false,
  ): Promise<boolean> {
    if (!text.trim()) return false;
    const now = Date.now();
    const cap = Number(this.env.X_MAX_PER_DAY) || 3;
    const today = (this.state.xPostedAt ?? []).filter((t) => now - t < 86_400_000);
    if (important !== "always" && (today.length >= cap || (!important && today.length >= cap - 1))) {
      this.log(`[x cap ${cap}/day, skipped] ${text}`);
      return false;
    }
    if ((this.dry && !evenInDryRun) || !this.env.ZERNIO_API_KEY) {
      this.log(`[post] ${[text, ...replies].join(" // ")}`);
      return false;
    }
    try {
      this.xAccountId ??= (await findXAccount(this.env.ZERNIO_API_KEY))._id;
      const r = await zernioPost(this.env.ZERNIO_API_KEY, this.xAccountId, text, replies);
      this.state.xFeed = [...(this.state.xFeed ?? []), { at: new Date(now).toISOString(), text, url: r.url }].slice(
        -12,
      );
      this.state.xPostedAt = [...today, now];
      this.log(`posted: ${text}`);
      return true;
    } catch (e) {
      this.log(`post failed: ${(e as Error).message}`);
      return false;
    } // x being down never stops a box
  }

  /** A standalone shitpost on x every couple of hours, also shown on the site log. */
  async shitpost(now = Date.now()) {
    const [lo, hi] = this.dry ? LOOP.xEveryMin.dry : LOOP.xEveryMin.live;
    if (!this.state.nextXAt) {
      this.state.nextXAt = now + lo * 60_000;
      return;
    }
    if (now < this.state.nextXAt) return;
    this.state.nextXAt = now + (lo + Math.random() * (hi - lo)) * 60_000;
    const p = this.state.pub;
    const pct =
      p && BigInt(p.thresholdLamports || "0") > 0n
        ? Math.round((Number(p.boxLamports) / Number(p.thresholdLamports)) * 100)
        : 0;
    const w = this.state.history.at(-1);
    const topics = [
      `box #${this.state.nextBoxId} is ${pct}% full. it opens at ${p ? Number(p.thresholdLamports) / 1e9 : "?"} sol and a random holder pulls it`,
      `the vault holds ${sol(BigInt(this.state.vaultLamports ?? "0"))} sol and nobody knows what opens it`,
      p
        ? `${p.eligible} wallets are in the draw for the next box. $${this.entry()} held for 7 minutes is all it takes. bigger boxes ask for bigger bags`
        : `nobody is in the draw yet`,
      w ? `${this.state.history.length} boxes opened so far. last one was a ${w.draw!.tier} pull` : `no box opened yet`,
      `fees that went into the box in the last hour: ${sol(this.feesLastHour(now))} sol. more trading, bigger and faster boxes`,
      this.frenzyFacts(),
      `you are the only dev on solana who cannot dump on his holders: no sell function in your code, you only buy $PULLIT and burn it. ${sol(BigInt(this.state.burned?.lamports ?? "0"))} sol burned so far`,
    ];
    const facts = `write a standalone x post. topic: ${topics[Math.floor(Math.random() * topics.length)]}`;
    const text = await this.xLine(facts, [], say.xpost(pct));
    if (!text) return;
    await this.post(text);
    this.feed("x", text.replace(/\n+/g, " / "));
  }

  /** Marks big holders that are program accounts (bonding curve, AMM pools) as excluded. */
  async refreshExclusions(rows: { owner: string; amount: number }[]) {
    const top = [...rows]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, LOOP.topHoldersToInspect)
      .map((r) => r.owner)
      .filter((o) => !this.state.excluded.includes(o));
    if (!top.length) return;
    const res = await this.rpc.call<{ value: ({ owner: string } | null)[] }>("getMultipleAccounts", [
      top,
      { encoding: "base64", dataSlice: { offset: 0, length: 0 } },
    ]);
    res.value.forEach((acc, i) => {
      if (acc && acc.owner !== SYSTEM_PROGRAM) {
        this.state.excluded.push(top[i]);
        this.log(`excluded program-owned holder ${short(top[i])} (owner ${short(acc.owner)})`);
      }
    });
  }

  /** Holders whose bag is worth less than the SOL they put in (from the cache, refreshed in refreshRed). */
  async redSet(balances: { owner: string; amount: number }[], priceUsd: number): Promise<Set<string>> {
    const cache = this.state.redCache ?? {};
    const out = new Set<string>();
    if (!Object.keys(cache).length) return out;
    const sol = await fetchToken(this.env.JUP_API_KEY, MINTS.SOL).catch(() => null);
    if (!sol?.usdPrice) return out;
    for (const b of balances) {
      const c = cache[b.owner];
      if (!c || Math.abs(b.amount - c.amount) > c.amount * 0.005) continue; // bag changed since: wait for a refresh
      if ((c.netSol / 1e9) * sol.usdPrice > b.amount * priceUsd) out.add(b.owner);
    }
    return out;
  }

  /** Looks up what each holder in the draw paid, a few wallets per snapshot. */
  async refreshRed(rows: { owner: string; amount: number }[], now = Date.now()) {
    if (this.dry || !this.env.MINT) return;
    const cache = (this.state.redCache ??= {});
    const due = rows.filter((r) => {
      const c = cache[r.owner];
      return !c || Math.abs(r.amount - c.amount) > c.amount * 0.05 || now - c.at > 6 * 3_600_000;
    });
    // history reads are the most expensive helius calls: a few per snapshot is enough
    for (const r of due.slice(0, 3)) {
      try {
        cache[r.owner] = {
          at: now,
          amount: r.amount,
          netSol: await fetchNetSolIn(this.env.HELIUS_API_KEY, r.owner, this.env.MINT),
        };
      } catch (e) {
        this.log(`red check failed for ${short(r.owner)}: ${(e as Error).message}`);
        break;
      }
    }
    const live = new Set(rows.map((r) => r.owner));
    for (const k of Object.keys(cache)) if (!live.has(k) && now - cache[k].at > 6 * 3_600_000) delete cache[k];
  }

  /** The rush window from RUSH_AT, if one is set. */
  rush(): Rush | undefined {
    const from = Date.parse(this.env.RUSH_AT ?? "");
    if (!Number.isFinite(from)) return undefined;
    return { from, to: from + RUSH.minutes * 60_000, x: RUSH.x, hours: RUSH.hours };
  }

  async tickets() {
    const mint = this.env.MINT!;
    const token = await fetchToken(this.env.JUP_API_KEY, mint);
    if (!token?.usdPrice) throw new Error("no price for our mint yet");
    this.state.priceUsd = token.usdPrice;
    const balances = await fetchHolders(this.env.HELIUS_API_KEY, mint, token.decimals);
    await this.refreshExclusions(balances);
    const red = await this.redSet(balances, token.usdPrice);
    const snap = computeTickets(balances, this.state.holderState, {
      priceUsd: token.usdPrice,
      totalSupply: token.totalSupply ?? 1e9,
      exclude: this.state.excluded,
      minHoldMinutes: this.dry ? LOOP.dry.minHoldMinutes : undefined,
      memo: this.state.bagMemo ?? {},
      minUsd: this.entry(),
      red,
      rush: this.rush(),
    });
    this.state.bagMemo = snap.memo;
    await this.react(balances, token.totalSupply ?? 1e9, snap.state);
    this.state.holderState = snap.state;
    this.state.lastSnap = {
      at: snap.at,
      totalTickets: snap.totalTickets,
      priceUsd: token.usdPrice,
      rows: snap.rows.map((r) => [
        r.owner,
        Math.round(r.tickets * 100) / 100,
        r.heldMinutes,
        r.multiplier,
        r.boosted ? 1 : 0,
      ]),
    };
    this.state.lastHoldersAt = Date.now();
    if (this.state.pub) {
      this.state.pub.holders = snap.holdersTotal;
      this.state.pub.eligible = snap.eligible;
    }
    if (this.state.phase === "filling") await this.pulse(token.usdPrice, snap.holdersTotal, snap.eligible);
    await this.market(token);
    return snap;
  }

  /** Frenzy level from the last hour of volume, and market cap milestones. */
  async market(token: JupToken) {
    await this.firstHourRecap(token);
    const mcap = token.mcap ?? (token.usdPrice ?? 0) * (token.circSupply ?? token.totalSupply ?? 1e9);
    const vol = volume1h(token);
    this.state.market = { mcap, volume1h: vol, at: new Date().toISOString() };
    if (token.graduatedPool && !this.state.graduated) {
      this.state.graduated = token.graduatedPool;
      this.log(`jupiter: graduated to ${token.graduatedPool}`);
    }
    const prev = this.state.frenzy ?? 0;
    const level = frenzyLevel(vol);
    this.state.frenzy = level;
    const o = oddsAt(level);
    if (level !== prev) {
      const k = `$${usdShort(vol)}`;
      await this.line(
        "boost",
        level > prev
          ? `frenzy level ${level} of 3: ${k} traded in the last hour, so the next box has better odds: epic ${o[2]}%, secret ${o[3]}%. more volume, better odds`
          : `frenzy cooled down to level ${level}: only ${k} traded in the last hour. odds for the next box are epic ${o[2]}%, secret ${o[3]}% now`,
        [`${o[2]}%`],
        level > prev
          ? `frenzy ${level}/3. ${k} in an hour. epic ${o[2]}%, secret ${o[3]}%. keep it going`
          : `frenzy down to ${level}. epic back to ${o[2]}%. you got tired fast`,
      );
    }
    const hit = newMilestones(mcap, this.state.milestonesHit ?? []);
    if (hit.length) {
      this.state.milestonesHit = [...(this.state.milestonesHit ?? []), ...hit];
      const top = hit[hit.length - 1];
      this.state.milestoneQueue = [...(this.state.milestoneQueue ?? []), top];
      const cap = usdShort(top);
      await this.line(
        "boost",
        `$PULLIT just crossed ${cap} market cap. the next box is a milestone box: epic or better guaranteed`,
        [cap],
        `${cap} cap. next box is a milestone box: epic or better`,
      );
      const text = await this.xLine(
        `$PULLIT just crossed ${cap} market cap. the next box is a milestone box: epic or better guaranteed for whoever pulls it. write the post`,
        [cap],
        `$PULLIT at ${cap}. next box is a milestone box. epic or better, plus a chunk of the vault`,
      );
      if (text) await this.post(text, [], false, true); // a milestone is worth a post
    }
    // the launch reserve burns at its own caps, whether or not a box is opening
    for (const cap of BOOST.reserveBurnAtUsd) if (mcap >= cap) await this.burnReserve(cap);
    if (this.state.pub) {
      this.state.pub.frenzy = level;
      this.state.pub.odds = o;
      this.state.pub.mcap = Math.round(mcap);
      this.state.pub.nextMilestone = BOOST.milestonesUsd.find((m) => !(this.state.milestonesHit ?? []).includes(m));
      this.state.pub.hints = this.hints(vol, level);
    }
  }

  /** What the next frenzy level and the next box size would take, for the site. */
  hints(vol: number, level: number, now = Date.now()): NonNullable<NonNullable<State["pub"]>["hints"]> {
    const nb = nextBoxSize(this.state.feeLedger, now, this.boxPct());
    const boxNow = Number(nb.lamports) / 1e9;
    const i = BOX_SIZES.indexOf(boxNow);
    const boxNext = i >= 0 && i < BOX_SIZES.length - 1 ? BOX_SIZES[i + 1] : undefined;
    const perHour = Number(nb.perHour) / 1e9; // box share of the fees, sol per hour
    // the volume that would bring in enough fees for the next size, at the fee rate of the last hour
    const boxNextVol =
      boxNext && perHour > 0 && vol > 0 ? Math.round((vol * (boxNext / (FILL_MINUTES / 60))) / perHour) : undefined;
    const nf = BOOST.frenzy[level + 1];
    return {
      vol1h: Math.round(vol),
      frenzyNextAt: nf?.minVolume1h,
      frenzyNextEpic: nf?.odds[2],
      boxNow,
      boxNext,
      boxNextVol,
    };
  }

  /** Once per EPIC_RUN id: the next boxes are epic or better. */
  async openEpicRun() {
    if (this.state.epicRun?.id === EPIC_RUN.id) return;
    this.state.epicRun = { id: EPIC_RUN.id, left: EPIC_RUN.boxes };
    const n = EPIC_RUN.boxes;
    this.feed("boost", `the next ${n} boxes are epic or better. every one of them`);
    await this.post(
      `the next ${n} $PULLIT boxes are epic or better.\n\nevery one of them.\nhold $${this.entry()}+ for 7 min to be in the draw.`,
      ["pullit.fun"],
      false,
      "always",
    );
  }

  /** Once per VAULT_DRIP id: what is in the vault is split over the next boxes. */
  async openVault() {
    if (this.state.vaultDrip?.id === VAULT_DRIP.id || this.state.pending) return;
    const v = BigInt(this.state.vaultLamports ?? "0");
    if (v <= 0n) return;
    const per = v / BigInt(VAULT_DRIP.boxes);
    this.state.vaultDrip = { id: VAULT_DRIP.id, left: VAULT_DRIP.boxes, per: per.toString() };
    const n = VAULT_DRIP.boxes;
    this.feed(
      "boost",
      `the vault opens: ${sol(v)} sol, split over the next ${n} boxes. each one gets +${sol(per)} sol on top`,
    );
    await this.post(
      `the vault opens.\n\n${sol(v)} sol, split over the next ${n} boxes.\neach one gets +${sol(per)} sol on top.\n\nhold $${this.entry()}+ to be in the draw.`,
      ["pullit.fun"],
      false,
      "always",
    );
  }

  /** Bonding curve progress, read from the curve's own $PULLIT balance. Posts at 50, 75 and 90%. */
  async curveTick(now = Date.now()) {
    const c = (this.state.curve ??= {});
    if (this.dry || !this.env.MINT || this.state.bond?.at) return;
    // SOL the dev sent to the box wallet for the bond race: set aside in the pot, once
    const seed = BigInt(Math.round(Number(this.env.BOND_SEED_SOL || 0) * 1e9));
    const g = this.gamesState();
    // the race is off and nobody seeded it: whatever the pot caught goes back into the box
    if (GAMES.bondPct === 0 && !g.bondSeed && BigInt(g.bondPot ?? "0") > 0n) g.bondPot = "0";
    if (seed > 0n && !g.bondSeed) {
      g.bondSeed = seed.toString();
      g.bondPot = (BigInt(g.bondPot ?? "0") + seed).toString();
      this.feed(
        "boost",
        `the dev put ${sol(seed)} sol into the bond pot. last $50+ buy before the bond takes ${sol(BigInt(g.bondPot))} sol`,
      );
    }
    if (c.at && now - c.at < 60_000) return;
    c.at = now;
    try {
      if (!c.owner) {
        // the curve is one of the program-owned holders the holder snapshot already set aside
        if (c.lookedAt && now - c.lookedAt < 10 * 60_000) return;
        c.lookedAt = now;
        const ex = this.state.excluded.slice(0, 100);
        if (!ex.length) return;
        const res = await this.rpc.call<{ value: ({ owner: string } | null)[] }>("getMultipleAccounts", [
          ex,
          { encoding: "base64", dataSlice: { offset: 0, length: 0 } },
        ]);
        const i = res.value.findIndex((a) => a?.owner === PUMP_PROGRAM);
        if (i < 0) return;
        c.owner = ex[i];
        this.log(`bonding curve found: ${c.owner}`);
      }
      const acc = await this.rpc.tokenAccount(c.owner, this.env.MINT);
      const left = acc ? Number(acc.amount) / 10 ** CURVE.decimals : 0;
      const pct = Math.max(0, Math.min(100, ((CURVE.supply - left) / CURVE.sellable) * 100));
      c.pct = Math.round(pct * 10) / 10;
      if (this.state.pub) this.state.pub.curvePct = c.pct;
      const potL = BigInt(this.gamesState().bondPot ?? "0");
      const pot = sol(potL);
      const crossed = CURVE.marks.filter((m) => pct >= m && !(c.marks ?? []).includes(m));
      // several at once (first read, or a fast pump): only the highest is called out
      if (crossed.length) c.marks = [...(c.marks ?? []), ...crossed];
      for (const m of crossed.slice(-1)) {
        const potLine = potL > 0n ? ` and the last $50+ buy before the bond takes the bond pot, ${pot} sol now` : "";
        await this.line(
          "boost",
          `the bonding curve of $PULLIT is ${m}% done. at 100% it bonds: the next box is the bond box (epic or better)${potLine}`,
          [`${m}%`],
          potL > 0n ? `curve ${m}%. last $50+ buy before the bond takes ${pot} sol` : `curve ${m}%. bond box is close`,
        );
        await this.post(
          `$PULLIT bonding curve: ${m}%\n\n${potL > 0n ? `the last $50+ buy before the bond takes the bond pot (${pot} sol now).\n` : ""}then the bond box: epic or better.`,
          ["pullit.fun"],
          false,
          m >= 90 ? "always" : true,
        );
      }
    } catch (e) {
      this.log(`curve read failed: ${(e as Error).message}`);
    }
  }

  /**
   * One plain post an hour after launch: what happened, in numbers, with nothing to sell.
   * Posted once, only between 60 and 80 minutes after the mint was set (later the 1h stats are not the first hour).
   */
  async firstHourRecap(token: JupToken, now = Date.now()) {
    if (this.state.recapPosted || this.dry || !this.env.MINT) return;
    const age = (now - this.state.launchedAt) / 60_000;
    if (age < 60) return;
    this.state.recapPosted = true;
    if (age > 80) return;
    const st = token.stats1h;
    const buys = Math.round(st?.numBuys ?? 0);
    const traders = Math.round(st?.numTraders ?? 0);
    const vol = (st?.buyVolume ?? 0) + (st?.sellVolume ?? 0);
    const fees = this.state.feeLedger.reduce((a, e) => a + BigInt(e.lamports), 0n);
    const toBox = (fees * BigInt(FEES.boxSharePct)) / 100n;
    const opened = this.state.history.length;
    const given = this.state.history.reduce((a, b) => a + BigInt(b.prize?.lamports ?? "0"), 0n);
    const lines = [
      `first hour of $PULLIT:`,
      ``,
      ...(buys ? [`${buys.toLocaleString("en-US")} buys from ${traders.toLocaleString("en-US")} wallets`] : []),
      ...(vol ? [`$${usdShort(vol)} volume, ${(token.holderCount ?? 0).toLocaleString("en-US")} holders`] : []),
      `${sol(fees)} sol of fees claimed, ${sol(toBox)} went in the box`,
      opened
        ? `${opened} ${opened === 1 ? "box" : "boxes"} opened, ${sol(given)} sol paid out to holders`
        : `box #1 is still filling`,
      ``,
      `every claim, payout and burn has a tx on pullit.fun`,
    ];
    await this.post(lines.join("\n"), [], false, true);
    await this.line(
      "info",
      `first hour done: ${buys} buys, ${traders} wallets, ${sol(fees)} sol in fees, ${opened} boxes opened`,
      [],
      `first hour: ${buys} buys, ${opened} boxes opened, ${sol(given)} sol paid out`,
    );
  }

  /** Share of claimed fees that goes to the box: after the bond FEES.boxSharePct; before it FEES.lowCapBoxPct under FEES.lowCapUsd, FEES.midCapBoxPct under FEES.midCapUsd, else FEES.preBondBoxPct. */
  boxPct() {
    const mcap = this.state.market?.mcap;
    if (this.state.bond?.at) return (mcap ?? 0) >= FEES.highCapUsd ? FEES.highCapBoxPct : FEES.boxSharePct;
    if (mcap == null || mcap <= 0) return FEES.preBondBoxPct;
    if (mcap < FEES.lowCapUsd) return FEES.lowCapBoxPct;
    if (mcap < FEES.midCapUsd) return FEES.midCapBoxPct;
    return FEES.preBondBoxPct;
  }

  /** The clock and lucky pots take their share of what goes into the box. Returns the total set aside. */
  private addToPots(boxLamports: bigint) {
    const g = this.gamesState();
    const c = (boxLamports * BigInt(GAMES.clockPct)) / 100n;
    const l = (boxLamports * BigInt(GAMES.luckyPct)) / 100n;
    g.clockPot = (BigInt(g.clockPot) + c).toString();
    g.luckyPot = (BigInt(g.luckyPot) + l).toString();
    // the bond race pot fills only until the bond
    const b = this.state.bond?.at ? 0n : (boxLamports * BigInt(GAMES.bondPct)) / 100n;
    g.bondPot = (BigInt(g.bondPot ?? "0") + b).toString();
    return c + l + b;
  }

  gamesState() {
    return (this.state.games ??= { clockPot: "0", luckyPot: "0", queue: [], luckyLast: {}, wins: [] });
  }

  private addToVault(boxLamports: bigint) {
    const v = (boxLamports * BigInt(LOOP.vaultPct)) / 100n;
    this.state.vaultLamports = (BigInt(this.state.vaultLamports ?? "0") + v).toString();
    return v;
  }

  private lastTopic = -1;

  /** USD a wallet needs to hold to be in the draw for the box that is filling now. */
  entry(): number {
    const lamports = this.state.pending
      ? BigInt(this.state.pending.budgetLamports)
      : boxSize(this.state.history.length, this.state.boxTarget);
    return entryUsd(Number(lamports) / 1e9);
  }

  /** Where the frenzy is and how much volume the next level needs: the one number that makes people trade. */
  frenzyFacts(): string {
    const level = this.state.frenzy ?? 0;
    const vol = this.state.market?.volume1h ?? 0;
    const next = BOOST.frenzy[level + 1];
    const o = oddsAt(level);
    const mcap = this.state.market?.mcap;
    const nextCap = BOOST.milestonesUsd.find((m) => !(this.state.milestonesHit ?? []).includes(m));
    return [
      `frenzy is at level ${level} of 3 ($${usdShort(vol)} traded in the last hour), next box odds: epic ${o[2]}%, secret ${o[3]}%`,
      next
        ? `$${usdShort(Math.max(0, next.minVolume1h - vol))} more volume this hour unlocks level ${level + 1}: epic ${next.odds[2]}%, secret ${next.odds[3]}%`
        : "max frenzy, best odds there are",
      mcap && nextCap
        ? `market cap is $${usdShort(mcap)}, at $${usdShort(nextCap)} the next box becomes a milestone box`
        : "",
    ]
      .filter(Boolean)
      .join(". ");
  }

  /** Box share of the fees of the last hour (after team cut and vault). */
  feesLastHour(now = Date.now()) {
    const total = this.state.feeLedger
      .filter((e) => now - e.at < 3_600_000)
      .reduce((a, e) => a + BigInt(e.lamports), 0n);
    return (total * BigInt(this.boxPct()) * BigInt(100 - LOOP.vaultPct)) / 10_000n;
  }

  /** Minutes until the current box is full at the last hour's pace, "?" if nothing came in. */
  etaMin(now = Date.now()) {
    const perHour = this.feesLastHour(now),
      p = this.state.pub;
    if (!p || perHour <= 0n) return "?";
    const left = BigInt(p.thresholdLamports || "0") - BigInt(p.boxLamports || "0");
    return left <= 0n ? "0" : String(Math.max(1, Math.round(Number((left * 60n) / perHour))));
  }

  /** When nothing happened for a while, the box says something on its own. */
  async chatter(now = Date.now()) {
    const last = (this.state.feed ?? []).at(-1);
    const quiet = (this.dry ? LOOP.quietMin.dry : LOOP.quietMin.live) * 60_000;
    if (last && now - Date.parse(last.at) < quiet) return;
    const p = this.state.pub;
    const pct =
      p && BigInt(p.thresholdLamports || "0") > 0n
        ? Math.round((Number(p.boxLamports) / Number(p.thresholdLamports)) * 100)
        : 0;
    const w = this.state.history.at(-1);
    // one topic per line so the box does not read the same status report every time
    const topics: [string, string][] = [
      [
        `box #${this.state.nextBoxId} is ${pct}% full. ${p ? String(Number(p.thresholdLamports) / 1e9) : "?"} sol makes it open`,
        pct < 50 ? say.idle(pct) : `${pct}% full. i can feel it`,
      ],
      [
        `the vault holds ${sol(BigInt(this.state.vaultLamports ?? "0"))} sol. it only grows. something opens it, nobody knows when`,
        say.vault(sol(BigInt(this.state.vaultLamports ?? "0"))),
      ],
      [
        p
          ? `${p.eligible} of ${p.holders} holders are in the draw. the rest hold less than $${this.entry()} (the entry for this box size) or got in less than 7 minutes ago`
          : "nobody is in the draw yet",
        say.info(String(p?.holders ?? 0), String(p?.eligible ?? 0), this.entry()),
      ],
      [
        w
          ? `the last box went to {w}, ${w.draw!.tier} pull, ${Math.round((now - Date.parse(w.at)) / 60_000)} min ago. talk about whether they still hold the prize`
          : "no box opened yet. the first one is close",
        w ? say.lastWinner(short(w.draw!.winner)) : say.idle(pct),
      ],
      [
        `the log has been quiet for a few minutes, no trades worth mentioning. roast the holders for being this quiet while box #${this.state.nextBoxId} sits at ${pct}%`,
        say.idle(pct),
      ],
      [
        `fees into the box in the last hour: ${sol(this.feesLastHour(now))} sol. at this pace box #${this.state.nextBoxId} fills in about ${this.etaMin(now)} min`,
        say.pace(sol(this.feesLastHour(now)), this.etaMin(now)),
      ],
      [this.frenzyFacts(), say.frenzyNudge(this.state.frenzy ?? 0)],
      [
        `remind them you cannot sell: your code only buys $PULLIT and burns it, there is no sell function. ${sol(BigInt(this.state.burned?.lamports ?? "0"))} sol of $PULLIT burned so far. joke like a dev who wanted to rug everyone and found out he can't`,
        say.cantSell(),
      ],
    ];
    // never the same topic twice in a row
    const idx = (this.lastTopic =
      (this.lastTopic + 1 + Math.floor(Math.random() * (topics.length - 1))) % topics.length);
    const [facts, fallback] = topics[idx];
    await this.line("info", facts, [], fallback, facts.includes("{w}") && w ? short(w.draw!.winner) : undefined);
  }

  /** Box fill milestones: 25, 50, 75, 90%. One line per milestone per box. */
  async milestone(budget: bigint, threshold: bigint) {
    if (threshold <= 0n) return;
    const id = this.state.nextBoxId;
    const t = (this.state.talk ??= { box: id, milestone: 0 });
    if (t.box !== id) {
      t.box = id;
      t.milestone = 0;
    }
    const pct = Number((budget * 100n) / threshold);
    const hit = [...LOOP.fillCallouts].reverse().find((m) => pct >= m);
    if (!hit || hit <= t.milestone || pct >= 100) return;
    const first = t.milestone === 0 && hit > LOOP.fillCallouts[0];
    t.milestone = hit;
    if (first && hit < 75) return; // started mid-box (deploy, restart): stay quiet unless its close
    await this.line(
      "box",
      `box #${id} is ${pct}% full (${sol(budget)} of ${sol(threshold)} sol)${hit >= 75 ? `. it opens soon, make sure you hold $${this.entry()} for 7 minutes` : ""}`,
      [`${pct}%`],
      say.milestone(id, pct, this.entry()),
    );
  }

  /** $PULLIT price moves and draw count jumps between snapshots. */
  async pulse(price: number, holders: number, eligible: number) {
    const t = (this.state.talk ??= { box: this.state.nextBoxId, milestone: 0 });
    const out: [string, string[], string][] = [];
    if (t.price) {
      const move = ((price - t.price) / t.price) * 100;
      if (Math.abs(move) >= (this.dry ? LOOP.priceMovePct.dry : LOOP.priceMovePct.live)) {
        const up = move > 0;
        out.push([
          `$PULLIT ${up ? "pumped" : "dumped"} ${Math.abs(move).toFixed(0)}% in the last few minutes. ${up ? "more volume means more fees and a bigger box" : "fewer trades means the box fills slower"}`,
          [`${Math.abs(move).toFixed(0)}%`],
          up ? say.pump(Math.abs(move).toFixed(0)) : say.dump(Math.abs(move).toFixed(0)),
        ]);
        t.price = price;
      }
    } else t.price = price;
    // a new box size changes the entry, so the draw count jumps without anyone buying or selling
    const entry = this.entry();
    if (t.entry !== entry) {
      const before = t.entry;
      t.entry = entry;
      t.eligible = eligible;
      if (before)
        await this.line(
          "info",
          `box #${this.state.nextBoxId} is ${entry > before ? "bigger" : "smaller"}, so the entry changed from $${before} to $${entry}: that is the bag you need for 7 minutes to be in this draw. ${eligible} wallets are in`,
          [`$${entry}`],
          entry > before
            ? `bigger box, bigger entry. $${entry} to be in now. ${eligible} of you made the cut`
            : `smaller box, entry back down to $${entry}. ${eligible} of you are in. no excuses`,
        );
    }
    if (t.eligible != null && t.holders != null) {
      const d = eligible - t.eligible;
      const step = Math.max(8, Math.round(t.eligible * 0.15));
      if (d >= step) {
        out.push([
          `${d} more wallets joined the draw since the last check. ${eligible} are in now`,
          [String(eligible)],
          say.joined(d, eligible),
        ]);
        t.eligible = eligible;
      } else if (-d >= step) {
        out.push([
          `${-d} wallets fell out of the draw since the last check. ${eligible} are left in it`,
          [String(eligible)],
          say.left(-d, eligible),
        ]);
        t.eligible = eligible;
      }
    } else t.eligible = eligible;
    t.holders = holders;
    for (const [facts, must, fallback] of out.slice(0, 1)) await this.line("info", facts, must, fallback);
  }

  /** Notices whales, full exits and 24h holders between snapshots and makes fun of them on the log. */
  async react(balances: { owner: string; amount: number }[], supply: number, holding: HolderState, now = Date.now()) {
    const excluded = new Set(this.state.excluded);
    const bags: Record<string, number> = {};
    for (const b of balances) {
      const pct = (b.amount / supply) * 100;
      if (pct >= 0.1 && !excluded.has(b.owner)) bags[b.owner] = Math.round(pct * 100) / 100;
    }
    const prev = this.state.bags;
    this.state.bags = bags;
    if (!prev) return; // first snapshot: nothing to compare with
    const lines: ["roast" | "hold", string, string, string][] = []; // tag, facts, wallet, fallback
    for (const [o, pct] of Object.entries(bags)) {
      const grew = pct - (prev[o] ?? 0);
      if (grew >= 1)
        lines.push([
          "roast",
          `{w} just bought ${grew.toFixed(1)}% of the whole supply in one go. tickets only count a bag up to 1% of supply anyway`,
          short(o),
          say.whale(short(o), grew.toFixed(1)),
        ]);
      else if (!prev[o] && pct >= 0.3)
        lines.push([
          "roast",
          `a new wallet {w} walked in with ${pct.toFixed(1)}% of supply`,
          short(o),
          say.newbag(short(o), pct.toFixed(1)),
        ]);
      else if (prev[o] >= 0.3 && pct <= prev[o] / 2)
        lines.push([
          "roast",
          `{w} sold more than half of their bag, ${prev[o].toFixed(1)}% down to ${pct.toFixed(1)}%. still in the draw, with fewer tickets`,
          short(o),
          say.paper(short(o)),
        ]);
    }
    const t = BigInt(this.state.pub?.thresholdLamports || "0");
    const nearOpen = !!this.state.pending || (t > 0n && BigInt(this.state.pub?.boxLamports || "0") * 100n >= t * 85n);
    for (const [o, pct] of Object.entries(prev)) {
      if (pct >= 0.3 && !bags[o] && !holding[o] && !excluded.has(o))
        lines.push([
          "roast",
          `{w} sold their whole ${pct.toFixed(1)}% bag${nearOpen ? " right before the box opens, so they are out of the draw" : ""}`,
          short(o),
          say.dumped(short(o), pct.toFixed(1), nearOpen),
        ]);
    }
    const crowned = new Set(this.state.crowned ?? []);
    for (const [o, since] of Object.entries(holding)) {
      if (now - since >= 24 * 3_600_000 && !crowned.has(o) && bags[o]) {
        crowned.add(o);
        lines.push([
          "hold",
          `{w} has held for 24 hours straight and now gets 3x tickets`,
          short(o),
          say.diamond(short(o)),
        ]);
      }
    }
    this.state.crowned = [...crowned].slice(-500);
    // at most two per snapshot, so the log stays readable
    for (const [tag, facts, who, fallback] of lines.sort(() => Math.random() - 0.5).slice(0, 2))
      await this.line(tag, facts, [], fallback, who);
  }

  async claimAndSplit() {
    const now = Date.now();
    const since = this.state.lastClaimAt || this.state.launchedAt;
    this.state.lastClaimAt = now;
    if (this.dry) {
      // simulated fees, same accounting as a real split
      const base = Number(this.env.DRY_SOL_PER_MIN) || LOOP.dry.solPerMin;
      const t = (now - this.state.launchedAt) / 60_000 / 40; // starts busy, quiet 20 min later, busy again at 40
      const wave = 0.3 + 1.7 * (0.5 + 0.5 * Math.cos(t * 2 * Math.PI)); // 0.3x .. 2x
      const total = BigInt(Math.floor(((now - since) / 60_000) * base * wave * 1e9));
      const box = (total * 80n) / 100n;
      this.state.dryBalance = (BigInt(this.state.dryBalance ?? "0") + box).toString();
      this.state.feeLedger.push({ at: now, lamports: total.toString() });
      this.state.feeLedger = this.state.feeLedger.slice(-500);
      const v = this.addToVault(box) + this.addToPots(box);
      const lastFee = [...(this.state.feed ?? [])].reverse().find((f) => f.tag === "fee");
      const quiet = lastFee && now - Date.parse(lastFee.at) < 5 * 60_000; // fast test mode claims every minute, log one fee line per 5 min
      if (total > 0n && !quiet)
        await this.line(
          "fee",
          `claimed ${sol(total)} sol of trading fees (test mode, fake fees). ${sol(box - v)} went in the box, ${sol(v)} set aside for the vault, the clock and lucky buys`,
          [sol(total)],
          say.fee(sol(total), sol(box - v), sol(v)) + " (test)",
        );
      return;
    }
    if (!this.dev) return;
    const st = this.state;
    // a split sent earlier whose fate was unknown: count it once it landed, never send it twice
    if (st.splitInflight) {
      const s = await this.rpc.signatureStatus(st.splitInflight.sig);
      if (s === "unknown" && Date.now() - st.splitInflight.at < 120_000) return;
      if (s === "landed") await this.splitDone(st.splitInflight);
      else this.log(`split ${st.splitInflight.sig} did not land, the fees stay pending`);
      st.splitInflight = undefined;
    }
    try {
      const sig = await claimPumpCreatorFees(this.rpc, this.dev);
      if (sig) {
        st.claimSigs = [...(st.claimSigs ?? []), sig];
        this.log(`claimed creator fees ${sig}`);
      }
      st.lastClaimOkAt = Date.now();
    } catch (e) {
      this.log(`claim failed: ${(e as Error).message}`);
    }
    // only what the claims brought in is split, never other SOL in the dev wallet
    const waiting: string[] = [];
    for (const sig of st.claimSigs ?? []) {
      const got = await claimedBy(this.rpc, sig, this.dev.publicKey).catch(() => null);
      if (got === null) waiting.push(sig);
      else if (got > 0n) st.pendingFees = (BigInt(st.pendingFees ?? "0") + got).toString();
    }
    st.claimSigs = waiting.slice(-20);
    const split = await buildSplit(
      this.rpc,
      this.dev,
      this.box.publicKey,
      this.env.TEAM_WALLET,
      BigInt(st.pendingFees ?? "0"),
      this.boxPct(),
    );
    if (!split) return;
    const inflight = {
      sig: split.sig,
      at: Date.now(),
      total: split.totalLamports.toString(),
      box: split.boxLamports.toString(),
      team: split.teamLamports.toString(),
    };
    st.splitInflight = inflight;
    await this.checkpoint?.(); // saved before it is sent, so a retry checks it instead of sending again
    try {
      await this.rpc.sendAndConfirm(split.tx);
    } catch (e) {
      this.log(`split not confirmed yet, checking next tick: ${(e as Error).message}`);
      return;
    }
    await this.splitDone(inflight);
    st.splitInflight = undefined;
  }

  /**
   * A tx signed by the box since `sinceMs` that touches the winner (or the winner's account of the prize
   * coin): proof the prize already went out. Throws when the chain cannot be asked, so nothing is paid blind.
   */
  async paidOnChain(winner: string, mint: string, sinceMs: number): Promise<string | null> {
    const where = [winner];
    if (mint !== MINTS.SOL) {
      const acc = await this.rpc.tokenAccount(winner, mint);
      if (acc) where.push(acc.address);
    }
    for (const addr of where) {
      const sigs = await this.rpc.call<{ signature: string; blockTime: number | null; err: unknown }[]>(
        "getSignaturesForAddress",
        [addr, { limit: 20, commitment: "confirmed" }],
      );
      for (const x of sigs) {
        if (x.blockTime && x.blockTime * 1000 < sinceMs - 60_000) break;
        if (x.err) continue;
        type Tx = { transaction: { message: { accountKeys: (string | { pubkey: string })[] } } } | null;
        let t: Tx;
        try {
          t = await this.rpc.call<Tx>("getTransaction", [
            x.signature,
            { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
          ]);
        } catch (e) {
          // a newer tx version in the winner's history: the box only ever sends legacy or v0, so it is not ours
          if (/version|not supported/i.test((e as Error).message)) continue;
          throw e;
        }
        const k = t?.transaction.message.accountKeys[0];
        if ((typeof k === "string" ? k : k?.pubkey) === this.box.publicKey) return x.signature;
      }
    }
    return null;
  }

  /** Books a split that landed: fees leave the pending pile, the box share goes into the box and the vault. */
  async splitDone(s: NonNullable<State["splitInflight"]>) {
    const total = BigInt(s.total);
    const box = BigInt(s.box);
    const pending = BigInt(this.state.pendingFees ?? "0") - total;
    this.state.pendingFees = (pending > 0n ? pending : 0n).toString();
    this.state.feeLedger.push({ at: Date.now(), lamports: s.total, splitSig: s.sig });
    const v = this.addToVault(box) + this.addToPots(box);
    this.log(`split ${sol(total)} SOL: box ${sol(box)} (vault and pots ${sol(v)}), team ${sol(BigInt(s.team))}`);
    await this.line(
      "fee",
      `claimed ${sol(total)} sol of trading fees. ${sol(box - v)} went in the box, ${sol(v)} set aside for the vault, the clock and lucky buys`,
      [sol(total)],
      say.fee(sol(total), sol(box - v), sol(v)),
    );
  }

  async openBox(final: boolean) {
    const available = this.dry ? BigInt(this.state.dryBalance ?? "0") : await prizeBudget(this.rpc, this.box);
    let vault = BigInt(this.state.vaultLamports ?? "0");
    if (vault > available) {
      vault = available;
      this.state.vaultLamports = vault.toString();
    }
    const boost = !final && (this.state.voteBoost?.left ?? 0) > 0;
    // the vault drip: this box takes its slice of the vault on top of its own size
    const dripPer = !final && (this.state.vaultDrip?.left ?? 0) > 0 ? BigInt(this.state.vaultDrip!.per) : 0n;
    const slice = dripPer > vault ? vault : dripPer;
    vault -= slice;
    const threshold =
      (boost
        ? BigInt(this.state.voteBoost!.lamports ?? VOTE_BOX_LAMPORTS)
        : boxSize(this.state.history.length, this.state.boxTarget)) + slice;
    // one open never takes more than a few box sizes: SOL that lands in the box wallet by mistake
    // (or any other surprise) goes out slowly over many boxes, never in one pull
    const capMax = this.env.MAX_BOX_SOL ? BigInt(Math.round(Number(this.env.MAX_BOX_SOL) * 1e9)) : 0n;
    let cap = threshold * BigInt(LOOP.boxCapX);
    if (capMax > 0n && capMax < cap) cap = capMax;
    const g = this.gamesState();
    const pots = BigInt(g.clockPot) + BigInt(g.luckyPot) + BigInt(g.bondPot ?? "0");
    let budget = available - vault - pots; // the box itself; the vault and the game pots are set aside
    if (budget < 0n) budget = 0n;
    if (!final && budget > cap) budget = cap;
    // the 5 voted boxes pay exactly their size, so the extra SOL spreads over all five
    if (boost && budget > threshold) budget = threshold;
    if (this.state.pub) {
      this.state.pub.boxLamports = budget.toString();
      this.state.pub.thresholdLamports = threshold.toString();
      this.state.pub.vaultLamports = vault.toString();
      this.state.pub.entryUsd = this.entry();
      this.state.pub.milestoneBox = this.state.milestoneQueue?.[0];
      this.state.pub.bondBox = !!this.state.bond?.queued || undefined;
      this.state.pub.epicLeft = this.state.epicRun?.left || undefined;
      this.state.pub.buyBoostPct = HOLDERS.buyBoostPct || undefined;
      const rush = this.rush();
      this.state.pub.rush = rush && Date.now() < rush.to ? { from: rush.from, to: rush.to, x: rush.x } : undefined;
      this.state.pub.vaultSlice = slice > 0n ? slice.toString() : undefined;
      this.state.pub.vaultDripLeft = slice > 0n ? this.state.vaultDrip!.left : undefined;
      this.state.pub.updatedAt = new Date().toISOString();
    }
    if (!final && budget < threshold) {
      await this.milestone(budget, threshold);
      return;
    }
    if (boost) this.state.voteBoost!.left--;
    if (slice > 0n) {
      // the slice leaves the vault with this box
      this.state.vaultLamports = vault.toString();
      this.state.vaultDrip!.left--;
    }
    if (available <= 0n) {
      this.state.phase = "done";
      this.log("final box: bank empty, done");
      return;
    }

    const snap = await this.tickets();
    if (snap.eligible === 0) {
      this.log("box ready but nobody eligible yet");
      return;
    }
    const boxId = this.state.nextBoxId;
    const pre = this.state.prepack;
    const picked =
      pre && pre.boxId === boxId && Date.now() - pre.at < LOOP.prepackFreshMin * 60_000 ? pre : await this.pack(boxId);
    const plan = picked.plan;
    this.state.prepack = undefined;

    const { slot } = await this.rpc.latestBlockhash();
    const targetSlot = slot + EXEC.drawDelaySlots;
    const rows = snap.rows.map((r) => ({ owner: r.owner, tickets: r.tickets }));
    const salt = newSalt();
    const seal = await sealOf(plan, salt);
    const packedPost = final
      ? `last box. #${boxId} has everything that was left in me. ${plan.post}`.slice(0, 270)
      : plan.post;
    // locked now, before the draw block exists: odds from the frenzy level, milestone, buyback size
    const frenzy = this.state.frenzy ?? 0;
    // the bond box goes first; a milestone waiting at the same time takes the box after it
    const bond = !final && !!this.state.bond?.queued;
    if (bond) this.state.bond!.queued = false;
    const milestone = final || bond ? undefined : this.state.milestoneQueue?.[0];
    if (milestone) this.state.milestoneQueue = this.state.milestoneQueue!.slice(1);
    // the epic run waits behind the bond box and any milestone
    const epic = !final && !bond && !milestone && (this.state.epicRun?.left ?? 0) > 0;
    if (epic) this.state.epicRun!.left--;
    const burnLamports = final ? 0n : (budget * BigInt(BOOST.burnPct)) / 100n;
    this.state.pending = {
      boxId,
      plan,
      odds: oddsAt(frenzy),
      frenzy,
      milestone,
      ...(bond ? { bond: true } : {}),
      ...(epic ? { epic: true } : {}),
      burnLamports: burnLamports.toString(),
      budgetLamports: budget.toString(),
      seal,
      salt,
      targetSlot,
      eligible: snap.eligible,
      rows,
      posts: [packedPost],
      final,
      at: new Date().toISOString(),
    };
    this.state.phase = "drawing";
    this.log(
      `box #${boxId} packed (${sol(budget)} SOL, ${snap.eligible} eligible), common $${plan.common.symbol}, rare $${plan.rare.symbol}, seal ${seal}, draw at slot ${targetSlot}`,
    );
    const recentLines = (this.state.feed ?? []).map((f) => f.m);
    // a teaser per pick: what kind of coin it is, never which one
    const secret = [plan.common.symbol, plan.common.mint, plan.rare.symbol, plan.rare.mint];
    for (const [kind, c, h] of [
      ["fresh", picked.common, plan.hints?.common],
      ["meta", picked.rare, plan.hints?.rare],
    ] as const) {
      const fresh =
        h &&
        h.length <= 130 && // long rambling hints read badly on the log: the short line writer takes over
        !recentLines.some((r) => similar(r, h)) &&
        !secret.some((w) => h.toLowerCase().includes(w.toLowerCase()));
      if (fresh) this.feed("pick", h);
      else
        await this.line(
          "pick",
          `you just put a coin in box #${boxId}: ${criteria(c, kind)}. tease it so people want to win it. never name it, no ticker, no numbers, no hints that give it away`,
          [],
          say.pick(kind),
          undefined,
          undefined,
          secret,
        );
    }
    await this.line(
      "box",
      `box #${boxId} is sealed. seal ${seal.slice(0, 4)}…${seal.slice(-4)} is a hash of what is inside, published now so nobody can swap the contents later`,
      [`#${boxId}`, `${seal.slice(0, 4)}…${seal.slice(-4)}`],
      say.sealed(boxId, `${seal.slice(0, 4)}…${seal.slice(-4)}`),
    );
    await this.line(
      "box",
      `box #${boxId} is packed with ${sol(budget)} sol, ${snap.eligible} holders are in the draw`,
      [`#${boxId}`],
      say.packed(boxId, sol(budget), snap.eligible),
    );
    await this.line(
      "draw",
      `the winner is locked to solana block ${targetSlot.toLocaleString("en-US")}, about 20 seconds from now. nobody can know its hash yet`,
      [targetSlot.toLocaleString("en-US")],
      say.locked(targetSlot.toLocaleString("en-US")),
    );
    // sealed boxes are not posted on x: the daily posts are kept for wins that matter
  }

  /** The hot coins that pass the checks right now. A failed lookup just means no hot coin this box. */
  async hotCoins(): Promise<Candidate[]> {
    try {
      const tokens = await Promise.all(
        HOT.coins.map((h) => fetchToken(this.env.JUP_API_KEY, h.mint).catch(() => null)),
      );
      const hot = hotCandidates(tokens);
      if (hot.length < HOT.coins.length) this.log(`hot coins ok: ${hot.map((c) => c.symbol).join(", ") || "none"}`);
      return hot;
    } catch (e) {
      this.log(`hot coins lookup failed: ${(e as Error).message}`);
      return [];
    }
  }

  reserveLeft(): bigint {
    return BigInt(this.state.reserve?.left ?? "0");
  }

  /**
   * The launch reserve is whatever $PULLIT the box holds before the first box opens (bought at launch).
   * Recorded once, then only ever burned: 10% of it at each cap in BOOST.reserveBurnAtUsd.
   */
  async recordReserve() {
    if (this.dry || this.state.history.length > 0 || this.state.phase !== "filling") return;
    const acc = await this.rpc.tokenAccount(this.box.publicKey, this.env.MINT!);
    const amount = acc?.amount ?? 0n;
    // once a slice is burned the reserve is fixed: re-recording it would forget the burns and burn again
    if (this.state.reserve?.burns.length) return;
    if (amount > 0n && amount.toString() !== this.state.reserve?.initial) {
      this.state.reserve = { initial: amount.toString(), left: amount.toString(), burns: [] };
      this.log(`launch reserve recorded: ${amount} raw $PULLIT in the box`);
    }
  }

  /** When the market cap crosses one of the reserve caps: burns the next slice of the launch reserve. */
  async burnReserve(milestone: number) {
    const r = this.state.reserve;
    if (!r || this.dry || BigInt(r.left) <= 0n || r.burns.some((b) => b.milestone === milestone)) return;
    const slice = (BigInt(r.initial) * BigInt(BOOST.reserveBurnPct)) / 100n;
    const amount = slice < BigInt(r.left) ? slice : BigInt(r.left);
    try {
      await this.guard?.();
      const b = await burnAll(this.rpc, this.box, this.env.MINT!, 0n, amount);
      if (!b) return;
      r.left = (BigInt(r.left) - amount).toString();
      r.burns.push({ at: new Date().toISOString(), sig: b.sig, amount: amount.toString(), milestone });
      await this.checkpoint?.();
      const leftPct = Number((BigInt(r.left) * 100n) / BigInt(r.initial));
      await this.line(
        "burn",
        `$PULLIT crossed ${usdShort(milestone)} cap, so ${BOOST.reserveBurnPct}% of the launch reserve just got burned. ${leftPct}% of it left. the box bought it at launch and can only burn it, never sell`,
        [`${BOOST.reserveBurnPct}%`],
        `${usdShort(milestone)} cap. burned ${BOOST.reserveBurnPct}% of my launch bag. ${leftPct}% left. i told you i cant sell`,
        undefined,
        b.sig,
      );
    } catch (e) {
      this.log(`reserve burn failed, will retry on the next milestone box: ${(e as Error).message}`);
    }
  }

  /** Throws if this tick no longer owns the lock (another tick took over). Checked before anything is paid. */
  guard?: () => Promise<void>;

  /** Saves the state mid-tick. The host sets it, so a sealed box is public before its block exists. */
  checkpoint?: () => Promise<void>;

  /** After sealing, waits for the draw block in the same tick instead of the next one, so a box opens in ~30s. */
  /** Every box is $PULLIT now: half the box buys $PULLIT and burns it, the prize is $PULLIT bought from the market. */
  async pack(boxId: number) {
    const coin = { mint: this.env.MINT!, symbol: "PULLIT", why: "every box buys $PULLIT" };
    const plan: BoxPlan = {
      boxId,
      common: coin,
      rare: coin,
      post: `box #${boxId} is packed. what's inside? $PULLIT. it's always $PULLIT now`,
      reveal: "$PULLIT bought off the market. half of the box burned, the winner got the rest",
      hints: { common: "you already know what's inside", rare: "same coin. bigger bag" },
      source: "fallback",
    };
    return { plan, common: undefined, rare: undefined };
  }

  /** While the box fills, pick its coins ahead of time so a full box seals right away. */
  async prepackSoon(now = Date.now()) {
    const p = this.state.pub;
    if (this.state.phase !== "filling" || !p) return;
    const t = BigInt(p.thresholdLamports || "0");
    if (t <= 0n || BigInt(p.boxLamports || "0") * 100n < t * BigInt(LOOP.prepackAtPct)) return;
    const pre = this.state.prepack;
    const id = this.state.nextBoxId;
    if (pre && pre.boxId === id && now - pre.at < (LOOP.prepackFreshMin - 2) * 60_000) return;
    try {
      this.state.prepack = { boxId: id, at: now, ...(await this.pack(id)) };
    } catch (e) {
      this.log(`prepack failed: ${(e as Error).message}`);
    }
  }

  async drawSoon(maxWaitMs = 45_000) {
    const p = this.state.pending;
    if (!p || !this.checkpoint) return;
    await this.checkpoint();
    const until = Date.now() + maxWaitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1_500));
      const tip = await this.rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
      if (tip >= p.targetSlot + 2) return this.finishBox();
    }
  }

  async finishBox() {
    const p = this.state.pending!;
    const save = async () => {
      await this.checkpoint?.();
    };
    // the draw is computed once and saved: a retry can never land on a different winner
    if (!p.draw) {
      const tip = await this.rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
      if (tip < p.targetSlot + 2) return; // block not there yet, next tick
      const bh = await blockhashAt(this.rpc, p.targetSlot);
      p.draw = await draw(p.rows, p.boxId, bh.slot, bh.blockhash, p.odds, !!p.milestone || !!p.bond || !!p.epic);
      await save();
    }
    const d = p.draw;
    const vault = BigInt(this.state.vaultLamports ?? "0");
    const burnLamports = BigInt(p.burnLamports ?? "0");
    const gas = this.dry ? 0n : EXEC.gasPerBoxLamports; // tx fees and token account rent come from the box, never the vault
    let bank = BigInt(p.budgetLamports) - burnLamports - gas;
    if (bank < 0n) bank = 0n;
    const { fromBank, fromVault } = prizeSplit(
      d.tier,
      bank,
      vault,
      !!p.final,
      p.milestone ? BOOST.milestoneVaultPct : 0, // the vault opens only on a secret pull
    );
    const lamports = fromBank + fromVault;
    // a milestone box also burns a slice of what is left in the vault, on top of the usual 10% of the box
    const vaultBurn = p.milestone && !p.final ? ((vault - fromVault) * BigInt(BOOST.milestoneBurnVaultPct)) / 100n : 0n;
    const burnTotal = burnLamports + vaultBurn;

    // every payment is saved the moment it is signed and again when it lands, so a retry never pays twice
    const paid = (p.paid ??= {});
    if (this.dry) {
      if (!paid.coin) {
        paid.coin = { sig: "dry-run", amount: "0" };
        this.state.dryBalance = (BigInt(this.state.dryBalance ?? "0") - lamports - burnTotal).toString();
        await save();
      }
    } else if (!paid.coin) {
      if (paid.inflight) {
        const st = await this.rpc.signatureStatus(paid.inflight.sig);
        if (st === "landed") paid.coin = { sig: paid.inflight.sig, amount: "?" };
        else if (st === "unknown" && Date.now() - paid.inflight.at < 120_000) return; // may still land, check next tick
        paid.inflight = undefined;
        await save();
      }
      // last check on chain: did the box already pay this winner since the box was sealed (a tick that lost track)?
      if (!paid.coin) {
        const inSolNext = (paid.tries ?? 0) >= 5;
        const dup = await this.paidOnChain(
          d.winner,
          inSolNext ? MINTS.SOL : prizeMint(d.tier, p.plan),
          Date.parse(p.at),
        );
        if (dup) {
          paid.coin = { sig: dup, amount: "?" };
          this.log(`box #${p.boxId}: found a payout to ${short(d.winner)} on chain (${dup}), not paying again`);
          await save();
        }
      }
      if (!paid.coin) {
        await this.guard?.();
        // a coin that can no longer be bought should not block the box forever: after 5 tries, pay in SOL
        const inSol = (paid.tries ?? 0) >= 5;
        paid.tries = (paid.tries ?? 0) + 1;
        try {
          const r = await payout(
            this.rpc,
            this.env.JUP_API_KEY,
            this.box,
            d,
            p.plan,
            lamports,
            async (sig) => {
              paid.inflight = { sig, at: Date.now() };
              await save();
            },
            inSol,
          );
          paid.coin = { sig: r.sig, amount: r.amount, ...(inSol ? { inSol: true } : {}) };
          paid.inflight = undefined;
          await save();
        } catch (e) {
          await save();
          throw e;
        }
      }
    }

    // buyback and burn: buy first (saved), then burn. a burn that fails is retried on later ticks
    let vaultBurned = BigInt(p.burn?.fromVault ?? "0");
    if (burnTotal > 0n && !paid.burn) {
      if (this.dry) paid.burnBuy = { sig: "dry-run", amount: "0" };
      else if (!paid.burnBuy) {
        // a buyback signed on an earlier tick: wait for it or drop it, never buy twice
        if (paid.burnInflight) {
          const st = await this.rpc.signatureStatus(paid.burnInflight.sig);
          if (st === "landed") paid.burnBuy = { sig: paid.burnInflight.sig, amount: "?" };
          if (st !== "unknown" || Date.now() - paid.burnInflight.at >= 120_000) paid.burnInflight = undefined;
          await save();
        }
      }
      if (!this.dry && !paid.burnBuy && !paid.burnInflight) {
        try {
          await this.guard?.();
          const signed = async (sig: string) => {
            paid.burnInflight = { sig, at: Date.now() };
            await save();
          };
          let r: { sig: string; outAmount: string };
          try {
            r = await buyInto(this.env.JUP_API_KEY, this.box, this.env.MINT!, burnTotal, this.box.publicKey, signed);
          } catch (e) {
            // a jupiter buy that was already sent may still land: then no second buy
            if (paid.burnInflight) throw e;
            // no jupiter route yet (bonding curve, fresh pool): buy straight from pump
            this.log(`buyback via jupiter failed, trying pumpportal: ${(e as Error).message}`);
            r = await buyViaPumpPortal(this.rpc, this.box, this.env.MINT!, burnTotal, signed);
          }
          paid.burnInflight = undefined;
          paid.burnBuy = { sig: r.sig, amount: r.outAmount };
          await save();
        } catch (e) {
          // if a buy landed anyway, the next box burns those tokens with its own (burnAll takes everything above the reserve)
          this.log(`buyback failed, the SOL stays in the box: ${(e as Error).message}`);
        }
      }
      // a buyback that was sent but not confirmed: check it next tick before finishing the box
      if (!this.dry && !paid.burnBuy && paid.burnInflight) return;
      if (paid.burnBuy) {
        let burnSig = "dry-run";
        if (!this.dry) {
          try {
            burnSig = (await burnAll(this.rpc, this.box, this.env.MINT!, this.reserveLeft()))?.sig ?? "pending";
          } catch (e) {
            this.log(`burn failed, will retry: ${(e as Error).message}`);
            burnSig = "pending";
          }
          if (burnSig === "pending") {
            this.state.burnPending = true;
            this.state.burnPendingIds = [...(this.state.burnPendingIds ?? []), p.boxId];
          }
        }
        p.burn = {
          buySig: paid.burnBuy.sig,
          burnSig,
          amount: paid.burnBuy.amount,
          lamports: burnTotal.toString(),
          ...(vaultBurn > 0n ? { fromVault: vaultBurn.toString() } : {}),
        };
        vaultBurned = vaultBurn;
        const t = this.state.burned ?? { lamports: "0", tokens: "0" };
        const tokens = /^\d+$/.test(paid.burnBuy.amount) ? BigInt(paid.burnBuy.amount) : 0n;
        this.state.burned = {
          lamports: (BigInt(t.lamports) + burnTotal).toString(),
          tokens: (BigInt(t.tokens) + tokens).toString(),
        };
      }
      paid.burn = true;
      await save();
    }
    const symbol = paid.coin!.inSol ? "SOL" : d.tier === "common" ? p.plan.common.symbol : p.plan.rare.symbol;
    const mint = paid.coin!.inSol ? MINTS.SOL : prizeMint(d.tier, p.plan);
    if (paid.coin!.inSol) this.log(`box #${p.boxId}: the sealed coin could not be bought, prize paid in SOL`);
    const prize = {
      sig: paid.coin!.sig,
      mint,
      amount: paid.coin!.amount,
      symbol,
      lamports: lamports.toString(),
      fromVault: fromVault.toString(),
    };
    this.state.vaultLamports = (vault - fromVault - vaultBurned).toString();

    const extra = fromVault > 0n ? ` (${sol(fromVault)} from the vault)` : "";
    const both = `${sol(lamports)} sol of $${symbol}`;
    const tx = prize.sig;
    const ms = p.bond
      ? " the bond box."
      : p.epic
        ? " an epic-run box."
        : p.milestone
          ? ` milestone box for ${usdShort(p.milestone)} cap.`
          : "";
    const winPlain = `box #${p.boxId} opened. ${short(d.winner)} pulled ${d.tier}: ${both}${extra}. block ${d.slot} decided it`;
    const winText =
      (await this.xLine(
        `box #${p.boxId} just opened.${ms} {w} pulled ${d.tier}: ${both}${extra}, already in their wallet. solana block ${d.slot} picked them. write the win post`,
        [`#${p.boxId}`, `$${symbol}`],
        winPlain,
        short(d.winner),
      )) || winPlain; // a win always gets its post, even if every joke was used
    // the box page unfurls as the winner card; it links the tx, the burn and the seal check
    const proof = `${p.plan.reveal ? [...p.plan.reveal].slice(0, 120).join("") + "\n\n" : ""}https://pullit.fun/box/${p.boxId}`;
    const resultPost = winText;
    // on x only the wins worth a post: epic, secret, milestone and the final box (x posts are capped per day)
    if (d.tier === "epic" || d.tier === "secret" || p.milestone || p.bond || p.epic || p.final)
      await this.post(winText, [proof], false, true);
    await this.line(
      "win",
      `{w} won ${d.tier === "epic" ? "an" : "a"} ${d.tier} pull${ms}: ${both}${extra}`,
      [`$${symbol}`],
      say.win(short(d.winner), d.tier, sol(lamports), symbol, extra),
      short(d.winner),
      tx,
    );
    if (p.burn)
      await this.line(
        "burn",
        `bought ${sol(burnTotal)} sol of $PULLIT from the market and burned all of it${vaultBurned > 0n ? `, ${sol(vaultBurned)} of it straight from the vault for the ${usdShort(p.milestone!)} milestone` : ""}. ${sol(BigInt(this.state.burned?.lamports ?? "0"))} sol burned in total. you cannot sell, you can only buy and burn`,
        [sol(burnTotal)],
        say.burn(sol(burnTotal)),
        undefined,
        p.burn.burnSig,
      );
    await this.line(
      "box",
      `box #${p.boxId} unsealed: the revealed coins hash to the exact seal posted before the draw. nothing was swapped`,
      [`#${p.boxId}`],
      say.unsealed(p.boxId),
    );
    // what rolls over: the rest of the bank, plus a buyback that did not happen
    const left = bank - fromBank + (p.burn ? 0n : burnLamports);
    if (left > 0n && !p.final)
      await this.line(
        "box",
        `${sol(left)} sol stays in the box and goes to box #${p.boxId + 1}`,
        [sol(left)],
        say.rollover(sol(left), p.boxId + 1),
      );
    // unlucky streaks: everyone in this draw who did not win goes up by one, the winner and anyone who left start over
    const missed = this.state.misses ?? {};
    const misses: Record<string, number> = {};
    for (const r of p.rows) if (r.tickets > 0 && r.owner !== d.winner) misses[r.owner] = (missed[r.owner] ?? 0) + 1;
    this.state.misses = misses;
    const rec: BoxRecord = { ...p, draw: d, prize, posts: [...p.posts, resultPost] };
    delete (rec as Partial<typeof p>).rows;
    delete rec.paid;
    this.state.outbox = [...(this.state.outbox ?? []), { boxId: p.boxId, rows: p.rows }];
    this.state.history.push(rec);
    this.state.pending = undefined;
    this.state.watch = undefined; // new box, new shortlist
    this.state.nextBoxId++;
    this.state.phase = p.final ? "done" : "filling";
    if (!p.final) {
      // compare box sizes, not what was inside: leftovers from the last pull would make every box look "smaller"
      const prevSize = boxSize(this.state.history.length - 1, this.state.boxTarget);
      const { lamports: size, perHour } = nextBoxSize(this.state.feeLedger, Date.now(), this.boxPct());
      this.state.boxTarget = size.toString();
      const mood =
        size > prevSize
          ? "volume is hot, the box goes up. hype it like a degen who just saw green candles"
          : size < prevSize
            ? "volume is dead, the box shrinks. roast the holders for being so dead and quiet"
            : "volume is flat, same size box. be unimpressed";
      const n = (l: bigint) => String(Number(l) / 1e9); // 3.5, not 3.500
      await this.line(
        "box",
        `${mood}. fees into the box in the last hour: ${sol(perHour)} sol. next box #${p.boxId + 1} is ${n(size)} sol, the last one was ${n(prevSize)} sol`,
        [n(size)],
        size > prevSize
          ? `volume is cooking. next box is ${n(size)} sol. send it`
          : size < prevSize
            ? `you guys are dead quiet. here, have a ${n(size)} sol box. cope`
            : `next box ${n(size)} sol. same as your conviction, flat`,
      );
    }
    // show the next box right away instead of the old numbers until the next tick
    if (this.state.pub) {
      this.state.pub.boxLamports = (left > 0n && !p.final ? left : 0n).toString();
      this.state.pub.burned = this.state.burned;
      this.state.pub.reserve = this.state.reserve && {
        initial: this.state.reserve.initial,
        left: this.state.reserve.left,
      };
      this.state.pub.thresholdLamports = boxSize(this.state.history.length, this.state.boxTarget).toString();
      this.state.pub.vaultLamports = this.state.vaultLamports;
    }
    this.log(`box #${p.boxId}: ${short(d.winner)} won ${d.tier} $${symbol} (${prize.sig})`);
  }

  /**
   * After a deploy, the box writes a journal entry for each new commit: what changed, in its voice.
   * Only commits from the last 48 hours, at most 3 per tick, each once.
   */
  async journal(now = Date.now()) {
    if (!this.env.BUILD_COMMITS) return;
    let commits: [string, number, string][] = [];
    try {
      commits = JSON.parse(atob(this.env.BUILD_COMMITS));
    } catch {
      return;
    }
    // a commit that was rewritten (amended) is gone from git: its old entry goes too.
    // only checked inside the 48h window the deploy sends, and only when that window is complete
    if (commits.length < 15) {
      const live = new Set(commits.map(([hash]) => hash));
      this.state.journal = (this.state.journal ?? []).filter(
        (j) => !j.commit || live.has(j.commit) || now - Date.parse(j.at) >= 48 * 3_600_000,
      );
    }
    const done = new Set((this.state.journal ?? []).map((j) => j.commit));
    const todo = commits
      .filter(([hash, at]) => !done.has(hash) && now - at < 48 * 3_600_000)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3);
    for (const [hash, at, msg] of todo) {
      const kind = journalKind(msg);
      const text =
        (await quip(
          this.env.OPENROUTER_API_KEY,
          `you just shipped a change to your own code. the commit message: "${msg}". write one journal entry: what changed and what it means for holders, first person, plain words, one or two short sentences. a small joke is fine. no hype words, no hashtags`,
          [],
          (this.state.journal ?? []).map((j) => j.text),
          this.env.OPENROUTER_MODEL,
          undefined,
          true,
        )) ?? msg;
      this.state.journal = [
        ...(this.state.journal ?? []),
        { at: new Date(at).toISOString(), kind, text, commit: hash },
      ].slice(-100);
    }
  }

  /**
   * Before launch: the box posts teasers on x by itself, a few times a day. No coin address, no links,
   * nothing from the test run. Turned on with X_PRELAUNCH=1, turned off at launch.
   */
  async tease(now = Date.now()) {
    if (this.env.X_PRELAUNCH !== "1" || !this.env.ZERNIO_API_KEY) return;
    const every = (Number(this.env.X_PRELAUNCH_EVERY_MIN) || 480) * 60_000;
    if (this.state.nextTeaseAt && now < this.state.nextTeaseAt) return;
    this.state.nextTeaseAt = now + every * (0.8 + Math.random() * 0.4);
    // a fresh topic every time; the hand-written bank is only the fallback when the model is down
    const usedTopics = this.state.teaseTopics ?? [];
    const open = TEASE_TOPICS.filter((t) => !usedTopics.includes(t.id));
    const topic = (open.length ? open : TEASE_TOPICS)[Math.floor(Math.random() * (open.length || TEASE_TOPICS.length))];
    this.state.teaseTopics = [...(open.length ? usedTopics : []), topic.id].slice(-TEASE_TOPICS.length);

    const used = this.state.teaseUsed ?? [];
    const fresh = TEASERS.map((_, i) => i).filter((i) => !used.includes(i));
    const pickOne = fresh[Math.floor(Math.random() * fresh.length)];
    const fallback = TEASERS[pickOne];

    let facts = "";
    if (topic.facts) {
      try {
        const universe = await fetchUniverse(this.env.JUP_API_KEY);
        const r = scan(universe, now);
        const thrown = Object.values(r.rejected).reduce((a, b) => a + b, 0);
        const hour = Number(
          new Date(now).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }),
        );
        facts = `\nlive facts you may use (exact numbers only): scanned ${universe.length} coins just now, threw out ${thrown}, ${r.fresh.length} fresh runners and ${r.established.length} meta runners passed. it is ${hour}:00 in new york.`;
      } catch {
        /* no facts this time */
      }
    }
    const style = [...TEASERS].sort(() => Math.random() - 0.5).slice(0, 4);
    const text =
      (await this.xLine(
        `write one new post for x before launch. topic: ${topic.angle}.${facts}
voice examples (match the rhythm, not the content):
${style.join("\n---\n")}
---
rules: one idea only. do NOT talk about the sell button, the dev pressing it, rugging, the block or the box being sealed unless the topic is exactly that. no date, no coin address, no link, never say you are live, never explain the whole mechanic.
who you are, only for context: a pink pixel gift box on solana, not live yet. trading fees will fill you, an ai packs two coins inside, a future solana block picks the holder who opens you, you can only buy and burn your own token.`,
        [],
        "",
      )) || fallback;
    if (text === fallback) this.state.teaseUsed = fresh.length > 1 ? [...used, pickOne] : [];
    if (text) await this.post(text, [], true);
  }

  // 5s slack: cron and the 30s pass don't land on the exact second
  claimDue(now = Date.now()) {
    return now - this.state.lastClaimAt >= ((this.dry ? LOOP.dry.claimEverySec : LOOP.claimEverySec) - 5) * 1000;
  }

  // the extra passes between cron ticks: claim, split and open the box when it is full
  /**
   * Carries out a finished community vote with $usd from the dev wallet: "boxes" sends it to the box
   * wallet and spreads it over the next `boxes` boxes, "buyback" buys $PULLIT and burns exactly what it bought.
   * Runs once per vote id; a crash after "started" never repeats the payment.
   */
  async settleVote(id: string, choice: string, usd: number, boxes = 5) {
    if (this.state.votes?.[id] || !this.dev || !this.env.MINT || this.dry) return;
    this.state.votes = { ...this.state.votes, [id]: { choice, status: "started", at: Date.now() } };
    await this.checkpoint?.();
    const v = this.state.votes[id];
    try {
      const px = (await fetchToken(this.env.JUP_API_KEY, MINTS.SOL))?.usdPrice;
      if (!px || px < 20 || px > 2000) throw new Error(`bad sol price ${px}`);
      let lamports = BigInt(Math.round((usd / px) * 1e9));
      const bal = await this.rpc.balance(this.dev.publicKey);
      // the price moved a little since the vote opened: use what is there, if it is most of it
      if (bal < lamports + 20_000_000n && bal - 30_000_000n >= (lamports * 8n) / 10n) lamports = bal - 30_000_000n;
      if (bal < lamports + 20_000_000n) throw new Error(`dev wallet has ${sol(bal)} sol, needs ${sol(lamports)}`);
      await this.guard?.();
      if (choice === "keep") {
        // nothing moves: the dev keeps it, as voted (or because too few voted)
        v.note = `the dev keeps $${usd}`;
        this.feed("info", `the vote is in: the dev keeps the $${usd}. it stays in the dev wallet`);
        await this.post(
          `the vote is in: the dev keeps the $${usd} as a gift.\n\nthanks for voting.`,
          [],
          false,
          "always",
        );
      } else if (choice === "boxes") {
        const sig = await sendSol(this.rpc, this.dev, this.box.publicKey, lamports);
        v.sigs = [sig];
        // each of the next boxes: its normal first size plus an equal slice of the vote money
        const per = lamports / BigInt(boxes) + BigInt(Math.round(FIRST_BOX * 1e9));
        this.state.voteBoost = { left: boxes, lamports: per.toString() };
        const each = sol(per);
        v.note = `${sol(lamports)} sol into the box wallet, next ${boxes} boxes are ${each} sol`;
        this.feed(
          "info",
          `the vote is in: boxes. $${usd} (${sol(lamports)} sol) from the dev wallet just went into the box. the next ${boxes} boxes are ${each} sol each`,
          sig,
        );
        await this.post(
          `the vote is in: boxes.\n\n$${usd} from the dev wallet just went into the box. the next ${boxes} boxes are ${each} sol each.\n\nhttps://solscan.io/tx/${sig}`,
          [],
          false,
          "always",
        );
      } else {
        const mint = this.env.MINT;
        const before = (await this.rpc.tokenAccount(this.dev.publicKey, mint))?.amount ?? 0n;
        let buy: string;
        try {
          buy = (await buyInto(this.env.JUP_API_KEY, this.dev, mint, lamports, this.dev.publicKey)).sig;
        } catch {
          buy = (await buyViaPumpPortal(this.rpc, this.dev, mint, lamports)).sig;
        }
        v.sigs = [buy];
        await this.checkpoint?.();
        // burns only what this buy added, never the rest of the dev wallet
        const b = await burnAll(this.rpc, this.dev, mint, before);
        if (!b) throw new Error(`bought (${buy}) but nothing new to burn yet`);
        v.sigs.push(b.sig);
        const tokens = Math.round(Number(b.amount) / 1e6).toLocaleString("en-US");
        v.note = `bought and burned ${tokens} $PULLIT for ${sol(lamports)} sol`;
        this.feed("info", `the vote is in: buyback. $${usd} bought ${tokens} $pullit and burned all of it`, b.sig);
        await this.post(
          `the vote is in: buyback.\n\n$${usd} from the dev wallet bought ${tokens} $pullit and burned all of it.\n\nbuy https://solscan.io/tx/${buy}\nburn https://solscan.io/tx/${b.sig}`,
          [],
          false,
          "always",
        );
      }
      v.status = "done";
      this.log(`vote ${id} (${choice}) done: ${v.note}`);
    } catch (e) {
      v.status = "failed";
      v.note = (e as Error).message;
      this.log(`vote ${id} (${choice}) failed: ${v.note}`);
    }
    await this.checkpoint?.();
  }

  async claimTick(now = Date.now()) {
    if (!this.env.MINT || this.state.mintSeen !== this.env.MINT) return;
    if (this.state.phase === "done") return;
    await this.gamesTick(now).catch((e) => this.log(`games: ${(e as Error).message}`));
    // a draw waiting on its block finishes here, not on the next cron minute
    if (this.state.phase === "drawing") return this.drawSoon(12_000);
    if (this.claimDue(now)) await this.claimAndSplit();
    // fees just landed: show them and open the box right away, not on the next cron minute
    await this.openBox(false);
    if ((this.state.phase as State["phase"]) === "drawing") return this.drawSoon();
  }

  /** Watches for the migration to pumpswap. Once it happens, the next box is the bond box. */
  async bondWatch(now = Date.now()) {
    const b = (this.state.bond ??= {});
    if (b.at || this.dry || !this.env.MINT) return;
    // a full curve, jupiter's graduated pool, or the BONDED switch all count without waiting for dexscreener
    const full = (this.state.curve?.pct ?? 0) >= 100 || !!this.state.graduated || this.env.BONDED === "1";
    if (!full) {
      if (b.checkedAt && now - b.checkedAt < 60_000) return;
      b.checkedAt = now;
      try {
        const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${this.env.MINT}`);
        const pairs = (await r.json()) as { dexId?: string }[];
        if (!Array.isArray(pairs) || !pairs.some((p) => p.dexId === "pumpswap")) return;
      } catch {
        return;
      }
    }
    b.at = now;
    b.queued = true;
    if (this.state.pub) this.state.pub.curvePct = 100;
    const vault = sol(BigInt(this.state.vaultLamports ?? "0"));
    this.log(`bonded: the next box is the bond box (vault ${vault} sol)`);
    await this.line(
      "box",
      `$PULLIT just bonded. the next box is the bond box: whoever pulls it gets epic or better. the vault (${vault} sol) still only opens on a secret pull`,
      [vault],
      `bonded. next box is epic or better guaranteed`,
    );
    await this.post(
      `$PULLIT bonded.\n\nthe next box is the bond box: epic or better guaranteed.\n${BigInt(this.gamesState().bondPot ?? "0") > 0n ? `the last $50+ buy before the bond takes the bond pot (${sol(BigInt(this.gamesState().bondPot ?? "0"))} sol) in 7 min, if they still hold.\n` : ""}hold $${this.entry()}+ to be in the draw.`,
      ["pullit.fun"],
      false,
      "always",
    );
  }

  /** The clock and lucky buys: read new buys, pay the clock when it runs out, roll buys that held. */
  async gamesTick(now = Date.now()) {
    if (this.dry || !this.env.MINT || this.state.mintSeen !== this.env.MINT) return;
    const g = this.gamesState();
    if (g.paying) {
      await this.gamesResolve(now);
      if (g.paying) return; // still not sure where that payment is: nothing else moves
    }
    // read every 2 min, but every pass while the clock is about to run out, so its last buyer is right
    const clockEnding = !!g.clock && now > g.clock.endsAt - 30_000;
    if (this.state.priceUsd && (clockEnding || now - (g.readAt ?? 0) >= GAMES.readEveryMs)) {
      g.readAt = now;
      try {
        const own = [this.box.publicKey, this.env.TEAM_WALLET, this.dev?.publicKey, ...(this.state.excluded ?? [])];
        const r = await fetchNewBuys(
          this.env.HELIUS_API_KEY,
          this.env.MINT,
          g.cursor,
          this.state.priceUsd,
          new Set(own.filter(Boolean) as string[]),
        );
        g.cursor = r.cursor;
        for (const b of r.buys) {
          if (b.usd < GAMES.minBuyUsd) continue;
          const last = [b, ...(g.clock?.last ?? []).filter((x) => x.buyer !== b.buyer)].slice(0, 5);
          g.clock = { endsAt: b.at + GAMES.clockMinutes * 60_000, last };
          g.queue = [...g.queue, b].slice(-GAMES.queueMax);
          g.recent = [...(g.recent ?? []), b].slice(-8);
          // the bond race: only buys on the curve count, so only until the bond
          if (!this.state.bond?.at)
            g.bondLast = [b, ...(g.bondLast ?? []).filter((x) => x.buyer !== b.buyer)].slice(0, 5);
        }
      } catch (e) {
        this.log(`buys read failed: ${(e as Error).message}`);
      }
    }
    // the bond race: once bonded and 7 minutes passed, the last $50+ curve buyer who still holds takes the pot
    const bondAt = this.state.bond?.at;
    if (bondAt && !g.bondDone && now - bondAt >= GAMES.holdMinutes * 60_000) {
      const bpot = BigInt(g.bondPot ?? "0");
      if (bpot <= 0n) g.bondDone = true;
      else {
        for (const c of (g.bondLast ?? []).filter((x) => x.at <= bondAt + 60_000))
          if (await this.stillHolds(c)) return this.gamesPay("bond", c, bpot);
        // nobody held: the pot goes back into the box
        g.bondPot = "0";
        g.bondDone = true;
        this.feed(
          "win",
          `bonded, but every last buyer before the bond already sold. the bond pot (${sol(bpot)} sol) goes into the box`,
        );
      }
    }
    // the clock ran out: the last buyer who still holds takes the pot
    const pot = BigInt(g.clockPot);
    if (g.clock && now > g.clock.endsAt) {
      if (pot < GAMES.minClockPotLamports) {
        // too small to pay: the round ends and the pot keeps growing for the next one
        g.clock = undefined;
      } else {
        for (const c of g.clock.last) if (await this.stillHolds(c)) return this.gamesPay("clock", c, pot);
        this.feed("win", `the clock ran out but every last buyer already sold. the pot (${sol(pot)} sol) rolls over`);
        g.clock = undefined;
      }
    }
    // lucky buys: rolled once they held long enough, a few per tick
    const due = g.queue.filter((b) => now - b.at >= GAMES.holdMinutes * 60_000).slice(0, 5);
    for (const b of due) {
      g.queue = g.queue.filter((x) => x.sig !== b.sig);
      if (now - (g.luckyLast[b.buyer] ?? 0) < GAMES.luckyCooldownMinutes * 60_000) continue;
      const prize = (BigInt(g.luckyPot) * BigInt(GAMES.luckyPotPct)) / 100n;
      if (prize < GAMES.luckyPrizeLamports) continue;
      const bh = await blockhashAt(this.rpc, b.slot + GAMES.rollDelaySlots, 20_000);
      const roll = await luckyRoll(b.sig, bh.blockhash);
      if (!roll.win) continue;
      if (!(await this.stillHolds(b))) {
        this.feed("win", `${short(b.buyer)} hit a lucky buy and sold before it paid. 7 minutes was too long for you`);
        continue;
      }
      return this.gamesPay("lucky", b, prize, roll.seed);
    }
  }

  async stillHolds(b: Buy) {
    const acc = await this.rpc.tokenAccount(b.buyer, this.env.MINT!);
    return !!acc && acc.amount >= mustHold(b.tokens);
  }

  /** Pays a clock or lucky win in SOL. Saved before signing and again with the signature. */
  async gamesPay(kind: "clock" | "lucky" | "bond", b: Buy, lamports: bigint, seed?: string) {
    const g = this.gamesState();
    await this.guard?.();
    g.paying = { kind, to: b.buyer, lamports: lamports.toString(), at: Date.now(), buySig: b.sig, seed };
    await this.checkpoint?.();
    try {
      const sig = await sendSol(this.rpc, this.box, b.buyer, lamports, async (s) => {
        g.paying!.sig = s;
        await this.checkpoint?.();
      });
      g.paying.sig = sig;
      await this.gamesBook();
    } catch (e) {
      this.log(`${kind} payout not confirmed yet: ${(e as Error).message}`); // checked again next tick
    }
  }

  async gamesResolve(now = Date.now()) {
    const p = this.gamesState().paying!;
    if (!p.sig) {
      this.gamesState().paying = undefined; // never signed, nothing went out
      return;
    }
    const s = await this.rpc.signatureStatus(p.sig);
    if (s === "landed") return this.gamesBook();
    // failed, or never seen long after its blockhash expired: nothing went out
    if (s === "failed" || now - p.at > 150_000) this.gamesState().paying = undefined;
  }

  async gamesBook() {
    const g = this.gamesState();
    const p = g.paying!;
    const lam = BigInt(p.lamports);
    if (p.kind === "bond") {
      g.bondPot = (BigInt(g.bondPot ?? "0") - lam > 0n ? BigInt(g.bondPot ?? "0") - lam : 0n).toString();
      g.bondDone = true;
    } else if (p.kind === "clock") {
      g.clockPot = (BigInt(g.clockPot) - lam > 0n ? BigInt(g.clockPot) - lam : 0n).toString();
      g.clock = undefined;
    } else {
      g.luckyPot = (BigInt(g.luckyPot) - lam > 0n ? BigInt(g.luckyPot) - lam : 0n).toString();
      g.luckyLast[p.to] = Date.now();
    }
    g.wins = [
      ...g.wins,
      {
        kind: p.kind,
        to: p.to,
        lamports: p.lamports,
        at: new Date().toISOString(),
        sig: p.sig!,
        buySig: p.buySig,
        seed: p.seed,
      },
    ].slice(-30);
    g.paying = undefined;
    this.log(`${p.kind} paid ${sol(lam)} SOL to ${p.to} (${p.sig})`);
    if (p.kind === "bond") {
      this.feed(
        "win",
        `bond race: ${short(p.to)} made the last buy before the bond and took the pot: ${sol(lam)} sol`,
        p.sig,
      );
      await this.post(
        `bond race won.\n\n${short(p.to)} made the last $PULLIT buy before the bond and took the pot: ${sol(lam)} sol.`,
        ["pullit.fun"],
        false,
        "always",
      );
    } else if (p.kind === "clock") {
      this.feed(
        "win",
        `the clock hit zero. ${short(p.to)} was the last buyer and took the pot: ${sol(lam)} sol`,
        p.sig,
      );
      await this.post(
        `the clock hit zero.\n\n${short(p.to)} was the last $PULLIT buyer and took the pot: ${sol(lam)} sol.\nnew round starts with the next buy.`,
        ["pullit.fun"],
        false,
        true,
      );
    } else
      this.feed(
        "win",
        `lucky buy: ${short(p.to)} bought, held 7 minutes and the block said yes. ${sol(lam)} sol sent`,
        p.sig,
      );
  }

  /** Posts "dex paid" once, and only after dexscreener itself shows the paid token profile. */
  async dexPaid(now = Date.now()) {
    const d = (this.state.dexPaid ??= {});
    if (d.posted || this.dry || !this.env.MINT) return;
    if (d.checkedAt && now - d.checkedAt < 2 * 60_000) return;
    d.checkedAt = now;
    try {
      const r = await fetch(`https://api.dexscreener.com/orders/v1/solana/${this.env.MINT}`);
      const j = (await r.json()) as { orders?: { type?: string; status?: string }[] };
      const paid = (j.orders ?? []).some(
        (o) => o.type === "tokenProfile" && o.status !== "rejected" && o.status !== "cancelled",
      );
      if (!paid) return;
    } catch {
      return;
    }
    const n = this.state.history.length;
    const text = `dex paid for $PULLIT\n\n${n} boxes opened, ${n} holders paid in random coins.\nthe box keeps filling from every trade.\n\nhold, wait, maybe it's yours.`;
    const replies = [`ca: ${this.env.MINT}\ndexscreener.com/solana/${this.env.MINT}\npullit.fun`];
    // a one-time announcement: it skips the daily cap
    if (await this.post(text, replies, false, "always")) {
      d.posted = true;
      this.feed("info", "dex paid. i have a profile picture now, unlike your burner");
    }
  }

  async tick(now = Date.now()) {
    await this.journal(now);
    await this.tease(now);
    if (!this.env.MINT) {
      if (this.state.pub) this.state.pub.updatedAt = new Date(now).toISOString();
      return;
    }
    // checked before "done": a finished test mint must still reset when the real one is set
    if (this.state.mintSeen !== this.env.MINT) {
      if (this.state.mintSeen) {
        // a different coin (e.g. a dry run on a test mint, then the real launch): start clean
        const { log, pub, journal, mintSeen: old } = this.state;
        const own = [this.box.publicKey, this.env.TEAM_WALLET, this.dev?.publicKey].filter(Boolean) as string[];
        for (const k of Object.keys(this.state)) delete (this.state as unknown as Record<string, unknown>)[k];
        Object.assign(this.state, newState(now), {
          log,
          journal,
          excluded: own,
          pub: pub && {
            ...pub,
            boxLamports: "0",
            vaultLamports: "0",
            // nothing from the test coin may show on the real one, not even for a minute
            thresholdLamports: boxSize(0).toString(),
            entryUsd: entryUsd(FIRST_BOX),
            holders: 0,
            eligible: 0,
            milestoneBox: undefined,
            reserve: undefined,
            burned: undefined,
            frenzy: 0,
            odds: undefined,
            mcap: undefined,
          },
        });
        this.log(`mint changed from ${old}, state reset`);
      }
      this.state.mintSeen = this.env.MINT;
      this.state.launchedAt = now; // grace period for the Final Box counts from launch
      this.log(`mint set: ${this.env.MINT}`);
    }
    if (this.state.phase === "done" && this.state.resumed !== RESUME.id) {
      // the final box fired on a quiet night: open the box again, fees that came in since are claimed as usual
      this.state.resumed = RESUME.id;
      this.state.phase = "filling";
      this.state.pending = undefined;
      this.state.prepack = undefined;
      this.log(`resume ${RESUME.id}: the box is filling again`);
      this.feed("info", RESUME.text);
    }
    if (this.state.phase === "done") return;
    await this.recordReserve();
    // a burn that failed earlier: whatever $PULLIT the box holds is burned now
    if (this.state.burnPending && !this.dry) {
      try {
        const r = await burnAll(this.rpc, this.box, this.env.MINT, this.reserveLeft());
        this.state.burnPending = false;
        if (r) {
          this.log(`burned leftover $PULLIT: ${r.amount} (${r.sig})`);
          // the boxes whose own burn did not confirm were burned by this one: link it on their cards
          const ids = this.state.burnPendingIds ?? [];
          for (const b of this.state.history)
            if (ids.includes(b.boxId) && b.burn?.burnSig === "pending") b.burn.burnSig = r.sig;
          this.state.burnPendingIds = [];
        }
      } catch (e) {
        this.log(`leftover burn failed again: ${(e as Error).message}`);
      }
    }
    await this.dexPaid(now);
    await this.openVault();
    await this.openEpicRun();
    await this.curveTick(now);
    await this.bondWatch(now);
    await this.gamesTick(now).catch((e) => this.log(`games: ${(e as Error).message}`));
    if (this.state.phase === "drawing") return this.finishBox();
    if (this.claimDue(now)) await this.claimAndSplit();
    if (now - this.state.lastHoldersAt >= (this.dry ? LOOP.dry.holdersEveryMin : LOOP.holdersEveryMin) * 60_000) {
      const s = await this.tickets();
      this.log(`holders: ${s.holdersTotal}, eligible ${s.eligible}, in the red ${s.rows.filter((r) => r.red).length}`);
      await this.refreshRed(s.rows);
      const lastInfo = [...(this.state.feed ?? [])].reverse().find((f) => f.tag === "info");
      if (s.eligible > 0 && (!lastInfo || now - Date.parse(lastInfo.at) > 30 * 60_000))
        await this.line(
          "info",
          `${s.holdersTotal.toLocaleString("en-US")} holders, ${s.eligible.toLocaleString("en-US")} of them are in the draw (you need $${this.entry()} held for 7 minutes for this box)`,
          [s.eligible.toLocaleString("en-US")],
          say.info(s.holdersTotal.toLocaleString("en-US"), s.eligible.toLocaleString("en-US"), this.entry()),
        );
    }
    // the final box only when claims work and fees really dried up, never because a claim was failing
    const claimsWork = !!this.dev && now - (this.state.lastClaimOkAt ?? 0) < 30 * 60_000;
    const final = !this.dry && claimsWork && shouldRunFinalBox(this.state.feeLedger, this.state.launchedAt, now);
    await this.openBox(final);
    if ((this.state.phase as State["phase"]) === "drawing") return this.drawSoon();
    if (this.state.phase === "filling") {
      await this.spawnTick(now).catch((e) => this.log(`spawn: ${(e as Error).message}`));
      await this.prepackSoon(now);
      await this.watch(now);
      await this.shitpost(now);
      await this.chatter(now);
    }
  }


  /**
   * The flywheel: right after a box opens it launches its own coin ($BOX38 for box #38) from the dev wallet.
   * Its creator fees are claimed with everything else and fill the next boxes, and every box buys $PULLIT.
   * Each box is looked at once. Gap, daily cap and the volume of the last coin decide if it launches.
   */
  async spawnTick(now = Date.now()) {
    if (this.env.SPAWN !== "1" || this.dry || !this.dev || !this.coinImage) return;
    const last = this.state.history.at(-1);
    if (!last || last.final) return;
    const s = (this.state.spawn ??= { coins: [] });
    if (s.triedBox === last.boxId || s.coins.some((c) => c.boxId === last.boxId)) return;
    const id = last.boxId;
    // only a box that just opened, never an old one right after a deploy
    if (now - Date.parse(last.at) > 30 * 60_000) {
      s.triedBox = id;
      return;
    }
    const prev = s.coins.at(-1);
    let vol: number | null = null;
    if (prev) {
      const t = await fetchToken(this.env.JUP_API_KEY, prev.mint); // throws on a network error: try again next tick
      vol = t ? (t.stats24h?.buyVolume ?? 0) + (t.stats24h?.sellVolume ?? 0) : 0;
    }
    const why = skipReason(s, id, now, vol);
    if (why) {
      s.triedBox = id;
      this.log(`spawn: box #${id} launches no coin: ${why}`);
      return;
    }
    const devBuy = Math.max(0, Number(this.env.SPAWN_DEV_BUY_SOL) || 0);
    const bal = await this.rpc.balance(this.dev.publicKey);
    const need = SPAWN.minDevLamports + SPAWN.maxOutLamports + BigInt(Math.round(devBuy * 1e9));
    s.triedBox = id; // decided: a crash after this never launches a second coin for the same box
    if (bal < need) {
      this.log(`spawn: box #${id} launches no coin: dev wallet has ${sol(bal)} sol, needs ${sol(need)}`);
      return;
    }
    await this.checkpoint?.();
    const img = await this.coinImage(id);
    const { mint, sig } = await launchCoin(this.rpc, this.dev, id, img, devBuy);
    const symbol = coinSymbol(id);
    s.coins = [...s.coins, { boxId: id, mint, symbol, at: now, sig }].slice(-50);
    this.log(`spawn: box #${id} launched $${symbol} ${mint} (${sig})`);
    this.feed("box", `box #${id} opened, so $${symbol} is live. every fee it makes fills the next boxes, and every box buys $PULLIT`, sig);
    await this.post(`box #${id} opened. $${symbol} is live\n\nevery fee it makes goes back into the box, and every box buys $PULLIT\n\n${mint}`);
  }

  /**
   * Every 10 minutes while the box fills, the agent re-scans the market and updates its shortlist,
   * so the box is packed from what is running right now. The log says what changed, never which coins.
   */
  async watch(now = Date.now()) {
    const every = (this.dry ? LOOP.scanEveryMin.dry : LOOP.scanEveryMin.live) * 60_000;
    if (this.state.watch && now - this.state.watch.at < every) return;
    const universe = await fetchUniverse(this.env.JUP_API_KEY);
    const r = scan(universe);
    const top = 5;
    const fresh = r.fresh.slice(0, top).map((c) => c.mint);
    const meta = r.established.slice(0, top).map((c) => c.mint);
    const prev = this.state.watch;
    this.state.watch = { at: now, fresh, meta };
    if (!prev) return;
    const was = new Set([...prev.fresh, ...prev.meta]);
    const is = new Set([...fresh, ...meta]);
    const added = [...is].filter((m) => !was.has(m)).length;
    const dropped = [...was].filter((m) => !is.has(m)).length;
    const lead = r.fresh[0];
    const leadChanged = prev.fresh[0] !== fresh[0];
    const secret = [...r.fresh.slice(0, top), ...r.established.slice(0, top)].flatMap((c) => [c.symbol, c.mint]);
    await this.line(
      "scan",
      `you re-scanned ${universe.length.toLocaleString("en-US")} coins for box #${this.state.nextBoxId}. your shortlist changed: ${added} new runners in, ${dropped} dropped out (dumped or failed the filters).${leadChanged && lead ? ` new favourite for the fresh slot: ${criteria(lead, "fresh")}.` : ""} tell the chat the box gets packed from whatever is running when it fills. never name a coin`,
      [],
      say.watch(added, dropped),
      undefined,
      undefined,
      secret,
    );
  }
}
