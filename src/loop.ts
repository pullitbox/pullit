// The main loop as a state machine. tick() is called once a minute (Node setInterval or a
// Cloudflare cron). Every step is idempotent and the whole state is one JSON object, so a
// crash or restart just continues from the saved state.

import { Rpc, keypairFromSecret, LAMPORTS, type Keypair } from "./solana.ts";
import { fetchHolders, computeTickets, type HolderState, type TicketRow } from "./holders.ts";
import { fetchToken, fetchUniverse } from "./jupiter.ts";
import { scan, type Candidate } from "./scanner.ts";
import { say, remember } from "./voice.ts";
import { packBox, quip, similar, fillQuip, type BoxPlan } from "./agent.ts";
import { claimPumpCreatorFees, splitFees, shouldRunFinalBox, type FeeLedgerEntry } from "./fees.ts";
import {
  blockhashAt,
  draw,
  payout,
  prizeBudget,
  prizeMint,
  prizeSplit,
  sealOf,
  newSalt,
  EXEC,
  type Draw,
} from "./executor.ts";
import { findXAccount, zernioPost } from "./zernio.ts";

export const LOOP = {
  boxThresholdLamports: 300_000_000n, // open a box once 0.3 SOL is ready for prizes
  firstBoxThresholdLamports: 150_000_000n, // first box opens sooner, to show it works
  claimEveryMin: 10,
  holdersEveryMin: 5,
  topHoldersToInspect: 40, // pools and curves are always among the biggest holders
  vaultPct: 10, // of everything that goes into the box, this share is set aside in the vault
  // dry run runs fast so a full cycle can be watched in minutes
  dry: { solPerMin: 0.05, claimEveryMin: 1, holdersEveryMin: 1, minHoldMinutes: 1 },
  quietMin: { live: 6, dry: 2 },
  xEveryMin: { live: [100, 180], dry: [8, 12] }, // a standalone shitpost on x every so often (dry: printed, not posted) // minutes of silence before the box says something on its own
  priceMovePct: { live: 10, dry: 6 }, // $PULLIT move between snapshots worth a comment
  milestones: [25, 50, 75, 90], // box fill % the agent calls out
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
  prize?: { sig: string; mint: string; amount: string; symbol: string; lamports: string; fromVault: string };
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
  lastHoldersAt: number;
  lastClaimAt: number;
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
  talk?: { box: number; milestone: number; price?: number; priceAt?: number; eligible?: number; holders?: number }; // what the agent already commented on
  mintSeen?: string;
  // handed to the host (worker) after a tick and removed from state, so state stays small
  lastSnap?: { at: string; totalTickets: number; rows: [string, number, number, number][] }; // owner, tickets, heldMin, mult
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
  };
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
    tag: "fee" | "scan" | "pick" | "box" | "draw" | "win" | "sent" | "info" | "roast" | "hold" | "x",
    m: string,
    tx?: string,
  ) {
    const feed = this.state.feed ?? [];
    // nothing on the log is said twice, whatever the tag. wins and draws always go through
    if (!m || (tag !== "win" && tag !== "draw" && feed.some((f) => similar(f.m, m)))) return;
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
  ) {
    let m: string | null = null;
    if (this.quips < 6) {
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
    // a win or a draw is never skipped: if every template was used already, say the plain fact
    if (!m && !fallback && (tag === "win" || tag === "draw")) m = fillQuip(facts, wallet);
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

  async post(text: string, replies: string[] = []) {
    if (this.dry || !this.env.ZERNIO_API_KEY) {
      this.log(`[post] ${[text, ...replies].join(" // ")}`);
      return;
    }
    try {
      this.xAccountId ??= (await findXAccount(this.env.ZERNIO_API_KEY))._id;
      await zernioPost(this.env.ZERNIO_API_KEY, this.xAccountId, text, replies);
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
        ? `${p.eligible} wallets are in the draw for the next box. $20 held for 15 minutes is all it takes`
        : `nobody is in the draw yet`,
      w ? `${this.state.history.length} boxes opened so far. last one was a ${w.draw!.tier} pull` : `no box opened yet`,
      `fees that went into the box in the last hour: ${sol(this.feesLastHour(now))} sol. more trading, bigger and faster boxes`,
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
    });
    await this.react(balances, token.totalSupply ?? 1e9, snap.state);
    this.state.holderState = snap.state;
    this.state.lastSnap = {
      at: snap.at,
      totalTickets: snap.totalTickets,
      rows: snap.rows.map((r) => [r.owner, Math.round(r.tickets * 100) / 100, r.heldMinutes, r.multiplier]),
    };
    this.state.lastHoldersAt = Date.now();
    if (this.state.pub) {
      this.state.pub.holders = snap.holdersTotal;
      this.state.pub.eligible = snap.eligible;
    }
    if (this.state.phase === "filling") await this.pulse(token.usdPrice, snap.holdersTotal, snap.eligible);
    return snap;
  }

  private addToVault(boxLamports: bigint) {
    const v = (boxLamports * BigInt(LOOP.vaultPct)) / 100n;
    this.state.vaultLamports = (BigInt(this.state.vaultLamports ?? "0") + v).toString();
    return v;
  }

  private lastTopic = -1;

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
          ? `${p.eligible} of ${p.holders} holders are in the draw. the rest hold less than $20 or got in less than 15 minutes ago`
          : "nobody is in the draw yet",
        say.info(String(p?.holders ?? 0), String(p?.eligible ?? 0)),
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
    const hit = [...LOOP.milestones].reverse().find((m) => pct >= m);
    if (!hit || hit <= t.milestone || pct >= 100) return;
    const first = t.milestone === 0 && hit > LOOP.milestones[0];
    t.milestone = hit;
    if (first && hit < 75) return; // started mid-box (deploy, restart): stay quiet unless its close
    await this.line(
      "box",
      `box #${id} just passed ${hit}% full (${sol(budget)} of ${sol(threshold)} sol)${hit >= 75 ? ". it opens soon, make sure you hold $20 for 15 minutes" : ""}`,
      [`${hit}%`],
      say.milestone(id, hit),
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
      const total = BigInt(Math.floor(((now - since) / 60_000) * LOOP.dry.solPerMin * 1e9));
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
    try {
      const sig = await claimPumpCreatorFees(this.rpc, this.dev);
      if (sig) this.log(`claimed creator fees ${sig}`);
    } catch (e) {
      this.log(`claim failed: ${(e as Error).message}`);
    }
    const split = await splitFees(this.rpc, this.dev, this.box.publicKey, this.env.TEAM_WALLET);
    if (split) {
      this.state.feeLedger.push({ at: Date.now(), lamports: split.totalLamports.toString(), splitSig: split.sig });
      const v = this.addToVault(split.boxLamports);
      this.log(
        `split ${sol(split.totalLamports)} SOL: box ${sol(split.boxLamports)} (vault ${sol(v)}), team ${sol(split.teamLamports)}`,
      );
      await this.line(
        "fee",
        `claimed ${sol(split.totalLamports)} sol of trading fees. ${sol(split.boxLamports - v)} went in the box, ${sol(v)} into the vault`,
        [sol(split.totalLamports)],
        say.fee(sol(split.totalLamports), sol(split.boxLamports - v), sol(v)),
      );
    }
  }

  async openBox(final: boolean) {
    const available = this.dry ? BigInt(this.state.dryBalance ?? "0") : await prizeBudget(this.rpc, this.box);
    let vault = BigInt(this.state.vaultLamports ?? "0");
    if (vault > available) {
      vault = available;
      this.state.vaultLamports = vault.toString();
    }
    const budget = available - vault; // the box itself; the vault is set aside
    const threshold = boxSize(this.state.history.length, this.state.boxTarget);
    if (this.state.pub) {
      this.state.pub.boxLamports = budget.toString();
      this.state.pub.thresholdLamports = threshold.toString();
      this.state.pub.vaultLamports = vault.toString();
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
    this.state.pending = {
      boxId,
      plan,
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
    const hint = (h: string | undefined, alt: string) => (h && !recentLines.some((r) => similar(r, h)) ? h : alt);
    this.feed(
      "pick",
      hint(
        plan.hints?.common,
        `picked ${criteria(
          result.fresh.find((c) => c.mint === plan.common.mint),
          "fresh",
        )}`,
      ),
    );
    this.feed(
      "pick",
      hint(
        plan.hints?.rare,
        `picked ${criteria(
          result.established.find((c) => c.mint === plan.rare.mint),
          "meta",
        )}`,
      ),
    );
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
    await this.post(packedPost);
  }

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
    const tip = await this.rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
    if (tip < p.targetSlot + 2) return; // block not there yet, next tick
    const bh = await blockhashAt(this.rpc, p.targetSlot);
    const d = await draw(p.rows, p.boxId, bh.slot, bh.blockhash);
    const symbol = d.tier === "common" ? p.plan.common.symbol : p.plan.rare.symbol;
    const vault = BigInt(this.state.vaultLamports ?? "0");
    const { fromBank, fromVault } = prizeSplit(d.tier, BigInt(p.budgetLamports), vault, !!p.final);
    const lamports = fromBank + fromVault;
    let prize = {
      sig: "dry-run",
      mint: prizeMint(d.tier, p.plan),
      amount: "0",
      symbol,
      lamports: lamports.toString(),
      fromVault: fromVault.toString(),
    };
    if (this.dry) this.state.dryBalance = (BigInt(this.state.dryBalance ?? "0") - lamports).toString();
    else prize = { ...prize, ...(await payout(this.rpc, this.env.JUP_API_KEY, this.box, d, p.plan, lamports)) };
    this.state.vaultLamports = (vault - fromVault).toString();

    const extra = fromVault > 0n ? ` (${sol(fromVault)} from the vault)` : "";
    const tx = prize.sig;
    const winText = await this.xLine(
      `box #${p.boxId} just opened. {w} pulled ${d.tier}: ${sol(lamports)} sol of $${symbol}${extra}, already in their wallet. solana block ${d.slot} picked them. write the win post`,
      [`#${p.boxId}`, `$${symbol}`],
      `box #${p.boxId} opened. ${short(d.winner)} pulled ${d.tier}: ${sol(lamports)} sol of $${symbol}${extra}. block ${d.slot} decided it`,
      short(d.winner),
    );
    const proof = `${p.plan.reveal ? p.plan.reveal.slice(0, 180) + "\n\n" : ""}tx: https://solscan.io/tx/${prize.sig}\ncheck the seal and the draw: https://pullit.fun`;
    const resultPost = winText;
    await this.post(winText, [proof]);
    await this.line(
      "win",
      `{w} won ${d.tier === "epic" ? "an" : "a"} ${d.tier} pull: ${sol(lamports)} sol paid out in $${symbol}${extra}`,
      [`$${symbol}`],
      say.win(short(d.winner), d.tier, sol(lamports), symbol, extra),
      short(d.winner),
      tx,
    );
    await this.line(
      "box",
      `box #${p.boxId} unsealed: the revealed coins hash to the exact seal posted before the draw. nothing was swapped`,
      [`#${p.boxId}`],
      say.unsealed(p.boxId),
    );
    const left = BigInt(p.budgetLamports) - fromBank;
    if (left > 0n && !p.final)
      await this.line(
        "box",
        `${sol(left)} sol stays in the box and goes to box #${p.boxId + 1}`,
        [sol(left)],
        say.rollover(sol(left), p.boxId + 1),
      );
    const rec: BoxRecord = { ...p, draw: d, prize, posts: [...p.posts, resultPost] };
    delete (rec as Partial<typeof p>).rows;
    this.state.outbox = [...(this.state.outbox ?? []), { boxId: p.boxId, rows: p.rows }];
    this.state.history.push(rec);
    this.state.pending = undefined;
    this.state.nextBoxId++;
    this.state.phase = p.final ? "done" : "filling";
    if (!p.final) {
      const prevSize = BigInt(p.budgetLamports);
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
        `${mood}. fees into the box in the last hour: ${sol(perHour)} sol. next box #${p.boxId + 1} is ${n(size)} sol, the last one had ${sol(prevSize)} sol`,
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
      this.state.pub.thresholdLamports = boxSize(this.state.history.length, this.state.boxTarget).toString();
      this.state.pub.vaultLamports = this.state.vaultLamports;
    }
    this.log(`box #${p.boxId}: ${short(d.winner)} won ${d.tier} $${symbol} (${prize.sig})`);
  }

  async tick(now = Date.now()) {
    if (this.state.phase === "done") return;
    if (!this.env.MINT) {
      if (this.state.pub) this.state.pub.updatedAt = new Date(now).toISOString();
      return;
    }
    if (this.state.mintSeen !== this.env.MINT) {
      if (this.state.mintSeen) {
        // a different coin (e.g. a dry run on a test mint, then the real launch): start clean
        const { log, pub, mintSeen: old } = this.state;
        const own = [this.box.publicKey, this.env.TEAM_WALLET, this.dev?.publicKey].filter(Boolean) as string[];
        Object.assign(this.state, newState(now), { log, pub, excluded: own });
        this.state.pending = undefined;
        this.log(`mint changed from ${old}, state reset`);
      }
      this.state.mintSeen = this.env.MINT;
      this.state.launchedAt = now; // grace period for the Final Box counts from launch
      this.log(`mint set: ${this.env.MINT}`);
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
          `${s.holdersTotal.toLocaleString("en-US")} holders, ${s.eligible.toLocaleString("en-US")} of them are in the draw (you need $20 held for 15 minutes)`,
          [s.eligible.toLocaleString("en-US")],
          say.info(s.holdersTotal.toLocaleString("en-US"), s.eligible.toLocaleString("en-US")),
        );
    }
    const final = !this.dry && shouldRunFinalBox(this.state.feeLedger, this.state.launchedAt, now);
    await this.openBox(final);
    if ((this.state.phase as State["phase"]) === "drawing") return this.drawSoon();
    if (this.state.phase === "filling") {
      await this.shitpost(now);
      await this.chatter(now);
    }
  }
}
