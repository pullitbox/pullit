// The main loop as a state machine. tick() is called once a minute (Node setInterval or a
// Cloudflare cron). Every step is idempotent and the whole state is one JSON object, so a
// crash or restart just continues from the saved state.

import { Rpc, keypairFromSecret, LAMPORTS, type Keypair } from "./solana.ts";
import { fetchHolders, computeTickets, entryUsd, type BagMemo, type HolderState, type TicketRow } from "./holders.ts";
import { fetchToken, fetchUniverse, type JupToken } from "./jupiter.ts";
import { hotCandidates, scan, type Candidate } from "./scanner.ts";
import { HOT } from "./config.ts";
import { say, remember } from "./voice.ts";
import { TEASERS, TEASE_TOPICS } from "./teasers.ts";
import { packBox, quip, similar, fillQuip, type BoxPlan } from "./agent.ts";
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
  MINTS,
  EXEC,
  type Draw,
} from "./executor.ts";
import { BOOST, frenzyLevel, oddsAt, newMilestones, usdShort, volume1h } from "./boost.ts";
import { findXAccount, zernioPost } from "./zernio.ts";

export const LOOP = {
  claimEveryMin: 10,
  holdersEveryMin: 5,
  topHoldersToInspect: 40, // pools and curves are always among the biggest holders
  vaultPct: 10, // of everything that goes into the box, this share is set aside in the vault
  // dry run runs fast so a full cycle can be watched in minutes
  dry: { solPerMin: 0.05, claimEveryMin: 1, holdersEveryMin: 1, minHoldMinutes: 1 },
  boxCapX: 3, // one box pays out at most 3x its size, the rest waits for the next boxes
  // dry run: fake volume swings between quiet and busy every 40 minutes, so both moods show up
  quietMin: { live: 6, dry: 2 }, // minutes of silence before the box says something on its own
  xEveryMin: { live: [480, 720], dry: [8, 12] }, // a standalone shitpost on x every so often (dry: printed, not posted)
  scanEveryMin: { live: 10, dry: 3 }, // the agent re-reads the market while the box fills
  priceMovePct: { live: 10, dry: 6 }, // $PULLIT move between snapshots worth a comment
  fillCallouts: [25, 50, 75, 90], // box fill % the agent calls out
};

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

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
  holderState: HolderState;
  bagMemo?: BagMemo; // last amounts and last buys, for the buy boost and the sell reset
  lastHoldersAt: number;
  lastClaimAt: number;
  misses?: Record<string, number>; // wallet -> boxes in a row it was in the draw and did not win
  pendingFees?: string; // claimed fees not split yet (lamports)
  claimSigs?: string[]; // claim txs whose amount is not counted yet
  splitInflight?: { sig: string; at: number; total: string; box: string; team: string }; // a split sent, not confirmed
  lastClaimOkAt?: number; // last time a claim went through (even with no fees), for the final box rule
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
  market?: { mcap: number; volume1h: number; at: string }; // $PULLIT, from the last holder snapshot
  frenzy?: number; // current frenzy level, 0 = normal odds
  milestonesHit?: number[]; // market caps already celebrated
  milestoneQueue?: number[]; // market caps waiting for their milestone box, one box each
  burned?: { lamports: string; tokens: string }; // totals of all buybacks and burns
  burnPending?: boolean; // the box holds bought $PULLIT that still has to be burned
  // $PULLIT bought into the box at launch. the bot never sells it: 10% is burned at 50K, 125K, 200K and 350K cap
  reserve?: { initial: string; left: string; burns: { at: string; sig: string; amount: string; milestone: number }[] };
  nextTeaseAt?: number; // before launch: when the next teaser goes out on x
  xPostedAt?: number[]; // times of the x posts of the last 24 hours, for the daily cap
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
  JUP_API_KEY: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  ZERNIO_API_KEY?: string;
  DEV_SECRET?: string; // only needed to claim fees
  BOX_SECRET: string;
  TEAM_WALLET: string;
  DRY_RUN?: string; // "1": no claims, no payouts, no posts (prints instead), simulated fees
  MAX_BOX_SOL?: string; // optional hard cap for one box, in SOL
  DRY_SOL_PER_MIN?: string; // dry run: average fake fees per minute (default 0.05)
  X_PRELAUNCH?: string; // "1": before launch the box posts teasers on x by itself (test boxes are never posted)
  X_PRELAUNCH_EVERY_MIN?: string; // minutes between teasers, default 480
  X_MAX_PER_DAY?: string; // most posts on x in any 24 hours, default 3
  BUILD_COMMITS?: string; // set by `npm run deploy`: base64 JSON of recent commits, for the journal
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
export const BOX_SIZES = [0.3, 0.5, 0.75, 1, 1.5, 2, 2.75, 3.5, 4];
export const FIRST_BOX = 0.15;
const FILL_MINUTES = 25; // a box should fill in about this long at the current volume

/**
 * Picks the next box size from how fast fees came in over the last hour: the biggest size that
 * fills in about 25 minutes at that pace. Hot volume, big box. Dead volume, small box.
 */
export function nextBoxSize(ledger: FeeLedgerEntry[], now = Date.now()): { lamports: bigint; perHour: bigint } {
  const hour = ledger.filter((e) => e.at >= now - 3_600_000).reduce((a, e) => a + BigInt(e.lamports), 0n);
  // what reaches the box: 80% of fees, minus the vault's tenth
  const perHour = (hour * 80n * BigInt(100 - LOOP.vaultPct)) / 10_000n;
  const fillable = (Number(perHour) / 1e9) * (FILL_MINUTES / 60);
  const sol = [...BOX_SIZES].reverse().find((x) => x <= fillable) ?? BOX_SIZES[0];
  return { lamports: BigInt(Math.round(sol * 1e9)), perHour };
}

export function boxSize(opened: number, target?: string): bigint {
  if (opened === 0) return BigInt(Math.round(FIRST_BOX * 1e9));
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
  env: Env;
  state: State;
  constructor(env: Env, state: State) {
    this.env = env;
    this.state = state;
    this.rpc = new Rpc(`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`);
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
  async post(text: string, replies: string[] = [], evenInDryRun = false, important = false) {
    if (!text.trim()) return;
    const now = Date.now();
    const cap = Number(this.env.X_MAX_PER_DAY) || 3;
    const today = (this.state.xPostedAt ?? []).filter((t) => now - t < 86_400_000);
    if (today.length >= cap || (!important && today.length >= cap - 1)) {
      this.log(`[x cap ${cap}/day, skipped] ${text}`);
      return;
    }
    if ((this.dry && !evenInDryRun) || !this.env.ZERNIO_API_KEY) {
      this.log(`[post] ${[text, ...replies].join(" // ")}`);
      return;
    }
    try {
      this.xAccountId ??= (await findXAccount(this.env.ZERNIO_API_KEY))._id;
      await zernioPost(this.env.ZERNIO_API_KEY, this.xAccountId, text, replies);
      this.state.xPostedAt = [...today, now];
      this.log(`posted: ${text}`);
    } catch (e) {
      this.log(`post failed: ${(e as Error).message}`);
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

  async tickets() {
    const mint = this.env.MINT!;
    const token = await fetchToken(this.env.JUP_API_KEY, mint);
    if (!token?.usdPrice) throw new Error("no price for our mint yet");
    const balances = await fetchHolders(this.env.HELIUS_API_KEY, mint, token.decimals);
    await this.refreshExclusions(balances);
    const snap = computeTickets(balances, this.state.holderState, {
      priceUsd: token.usdPrice,
      totalSupply: token.totalSupply ?? 1e9,
      exclude: this.state.excluded,
      minHoldMinutes: this.dry ? LOOP.dry.minHoldMinutes : undefined,
      memo: this.state.bagMemo ?? {},
      minUsd: this.entry(),
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
        `$PULLIT just crossed ${cap} market cap. the next box is a milestone box: epic or better guaranteed, plus ${BOOST.milestoneVaultPct}% of the vault, and ${BOOST.milestoneBurnVaultPct}% of the vault gets bought back and burned`,
        [cap],
        `${cap} cap. next box is a milestone box: epic or better plus ${BOOST.milestoneVaultPct}% of the vault`,
      );
      const text = await this.xLine(
        `$PULLIT just crossed ${cap} market cap. the next box is a milestone box: epic or better guaranteed for whoever pulls it, plus ${BOOST.milestoneVaultPct}% of the vault. and ${BOOST.milestoneBurnVaultPct}% of the vault buys $PULLIT and burns it. write the post`,
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
    return (total * 80n * BigInt(100 - LOOP.vaultPct)) / 10_000n;
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
      const v = this.addToVault(box);
      const lastFee = [...(this.state.feed ?? [])].reverse().find((f) => f.tag === "fee");
      const quiet = lastFee && now - Date.parse(lastFee.at) < 5 * 60_000; // fast test mode claims every minute, log one fee line per 5 min
      if (total > 0n && !quiet)
        await this.line(
          "fee",
          `claimed ${sol(total)} sol of trading fees (test mode, fake fees). ${sol(box - v)} went in the box, ${sol(v)} into the vault`,
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
        const t = await this.rpc.call<{
          transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
        } | null>("getTransaction", [
          x.signature,
          { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
        ]);
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
    const v = this.addToVault(box);
    this.log(`split ${sol(total)} SOL: box ${sol(box)} (vault ${sol(v)}), team ${sol(BigInt(s.team))}`);
    await this.line(
      "fee",
      `claimed ${sol(total)} sol of trading fees. ${sol(box - v)} went in the box, ${sol(v)} into the vault`,
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
    const threshold = boxSize(this.state.history.length, this.state.boxTarget);
    // one open never takes more than a few box sizes: SOL that lands in the box wallet by mistake
    // (or any other surprise) goes out slowly over many boxes, never in one pull
    const capMax = this.env.MAX_BOX_SOL ? BigInt(Math.round(Number(this.env.MAX_BOX_SOL) * 1e9)) : 0n;
    let cap = threshold * BigInt(LOOP.boxCapX);
    if (capMax > 0n && capMax < cap) cap = capMax;
    let budget = available - vault; // the box itself; the vault is set aside
    if (!final && budget > cap) budget = cap;
    if (this.state.pub) {
      this.state.pub.boxLamports = budget.toString();
      this.state.pub.thresholdLamports = threshold.toString();
      this.state.pub.vaultLamports = vault.toString();
      this.state.pub.entryUsd = this.entry();
      this.state.pub.milestoneBox = this.state.milestoneQueue?.[0];
      this.state.pub.updatedAt = new Date().toISOString();
    }
    if (!final && budget < threshold) {
      await this.milestone(budget, threshold);
      return;
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
    const universe = await fetchUniverse(this.env.JUP_API_KEY);
    const result = scan(universe);
    result.hot = await this.hotCoins();
    const thrown = Object.values(result.rejected).reduce((a, b) => a + b, 0);
    await this.line(
      "scan",
      `scanned ${universe.length.toLocaleString("en-US")} coins for the box and threw out ${thrown}: devs holding too much, top holders too heavy, fake volume, mint not revoked`,
      [String(thrown)],
      say.scan(universe.length.toLocaleString("en-US"), thrown),
    );
    const recent = this.state.history.slice(-8).flatMap((b) => [b.plan.common.symbol, b.plan.rare.symbol]);
    const boxId = this.state.nextBoxId;
    const { plan, problems } = await packBox(
      this.env.OPENROUTER_API_KEY,
      result,
      boxId,
      recent,
      this.env.OPENROUTER_MODEL,
    );
    if (problems.length) this.log(`agent problems: ${problems.join("; ")}`);

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
    const milestone = final ? undefined : this.state.milestoneQueue?.[0];
    if (milestone) this.state.milestoneQueue = this.state.milestoneQueue!.slice(1);
    const burnLamports = final ? 0n : (budget * BigInt(BOOST.burnPct)) / 100n;
    this.state.pending = {
      boxId,
      plan,
      odds: oddsAt(frenzy),
      frenzy,
      milestone,
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
      ["fresh", result.fresh.find((x) => x.mint === plan.common.mint), plan.hints?.common],
      ["meta", [...result.established, ...(result.hot ?? [])].find((x) => x.mint === plan.rare.mint), plan.hints?.rare],
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
  async drawSoon(maxWaitMs = 45_000) {
    const p = this.state.pending;
    if (!p || !this.checkpoint) return;
    await this.checkpoint();
    const until = Date.now() + maxWaitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 4_000));
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
      p.draw = await draw(p.rows, p.boxId, bh.slot, bh.blockhash, p.odds, !!p.milestone);
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
      p.milestone ? BOOST.milestoneVaultPct : 0,
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
          if (burnSig === "pending") this.state.burnPending = true;
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
    const ms = p.milestone ? ` milestone box for ${usdShort(p.milestone)} cap.` : "";
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
    if (d.tier === "epic" || d.tier === "secret" || p.milestone || p.final)
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
      const { lamports: size, perHour } = nextBoxSize(this.state.feeLedger);
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
    if (this.state.phase === "done") return;
    await this.recordReserve();
    // a burn that failed earlier: whatever $PULLIT the box holds is burned now
    if (this.state.burnPending && !this.dry) {
      try {
        const r = await burnAll(this.rpc, this.box, this.env.MINT, this.reserveLeft());
        this.state.burnPending = false;
        if (r) this.log(`burned leftover $PULLIT: ${r.amount} (${r.sig})`);
      } catch (e) {
        this.log(`leftover burn failed again: ${(e as Error).message}`);
      }
    }
    if (this.state.phase === "drawing") return this.finishBox();
    if (now - this.state.lastClaimAt >= (this.dry ? LOOP.dry.claimEveryMin : LOOP.claimEveryMin) * 60_000)
      await this.claimAndSplit();
    if (now - this.state.lastHoldersAt >= (this.dry ? LOOP.dry.holdersEveryMin : LOOP.holdersEveryMin) * 60_000) {
      const s = await this.tickets();
      this.log(`holders: ${s.holdersTotal}, eligible ${s.eligible}`);
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
      await this.watch(now);
      await this.shitpost(now);
      await this.chatter(now);
    }
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
