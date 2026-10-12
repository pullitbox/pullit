// Cloudflare Worker: runs the bot once a minute (cron) and serves the site + /api/state.
// Secrets (wrangler secret put): HELIUS_API_KEY, JUP_API_KEY, OPENROUTER_API_KEY,
// ZERNIO_API_KEY, DEV_SECRET, BOX_SECRET, PREVIEW_KEY.
// Vars (wrangler.jsonc): TEAM_WALLET, MINT, PUBLIC ("1" = site open to everyone), DRY_RUN.

import { Bot, newState, type Env as BotEnv, type State } from "../src/loop.ts";
import { HTML, SOON, BOXSVG } from "./site.ts";
import { renderCard, type CardData } from "./card.ts";
import { keypairFromSecret, Rpc } from "../src/solana.ts";
import { fetchToken } from "../src/jupiter.ts";
import { HOLDERS } from "../src/holders.ts";
import { findXAccount } from "../src/zernio.ts";
import type { ExecutionContext, KVNamespace, ScheduledEvent } from "./cloudflare.ts";

/** Checks every dependency from inside Cloudflare without moving money or posting. */
async function selftest(env: Env) {
  const r: Record<string, string> = {};
  const step = async (name: string, f: () => Promise<string>) => {
    try {
      r[name] = "ok " + (await f());
    } catch (e) {
      r[name] = "FAIL " + (e as Error).message;
    }
  };
  await step("box_key_ed25519", async () => (await keypairFromSecret(env.BOX_SECRET)).publicKey.slice(0, 4));
  await step("dev_key_ed25519", async () =>
    env.DEV_SECRET ? (await keypairFromSecret(env.DEV_SECRET)).publicKey.slice(0, 4) : "missing",
  );
  await step("helius_rpc", async () => {
    const kp = await keypairFromSecret(env.BOX_SECRET);
    const rpc = new Rpc(`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`);
    return `box ${(Number(await rpc.balance(kp.publicKey)) / 1e9).toFixed(4)} SOL`;
  });
  await step(
    "jupiter",
    async () =>
      `SOL $${(await fetchToken(env.JUP_API_KEY, "So11111111111111111111111111111111111111112"))?.usdPrice?.toFixed(2)}`,
  );
  await step("openrouter", async () => (env.OPENROUTER_API_KEY ? "key set" : "missing"));
  await step("zernio", async () =>
    env.ZERNIO_API_KEY ? "@" + ((await findXAccount(env.ZERNIO_API_KEY)).username ?? "connected") : "missing",
  );
  await step("kv", async () => {
    await env.STATE.put("selftest", String(Date.now()));
    return "write ok";
  });
  return r;
}

interface Env extends BotEnv {
  STATE: KVNamespace;
  PREVIEW_KEY?: string;
  REPO_URL?: string; // e.g. https://github.com/pullitbox/pullit, set once the repo is public
  PUBLIC?: string;
}

type Snap = NonNullable<State["lastSnap"]>;

// longer than the slowest possible tick (AI lines, packing, waiting for the draw block)
const LOCK_MS = 15 * 60_000;

async function run(env: Env, claimOnly = false) {
  const lock = await env.STATE.get("lock");
  if (lock && Date.now() - Number(lock.split(":")[0]) < LOCK_MS) return; // previous tick still running
  const token = `${Date.now()}:${crypto.randomUUID()}`;
  await env.STATE.put("lock", token);
  const state = ((await env.STATE.get("state", "json")) as State | null) ?? newState();
  const bot = new Bot(env, state);
  // the sealed box is saved (and visible on the site) before the draw block exists
  // a tick that lost the lock must never write: its state is older than the one that took over
  const mine = async () => (await env.STATE.get("lock")) === token;
  // kv allows about one write per second per key: retry instead of losing the state
  const put = async (k: string, v: string) => {
    for (let i = 0; ; i++)
      try {
        return await env.STATE.put(k, v);
      } catch (e) {
        if (i >= 2) throw e;
        await new Promise((r) => setTimeout(r, 1100));
      }
  };
  bot.checkpoint = async () => {
    if (!(await mine())) throw new Error("lost the lock, not saving");
    await put("state", JSON.stringify(state));
  };
  // before any payment: stop if another tick has taken the lock
  bot.guard = async () => {
    if ((await env.STATE.get("lock")) !== token) throw new Error("lost the lock, another tick is running");
  };
  try {
    await bot.init();
    if (claimOnly) await bot.claimTick();
    else await bot.tick();
  } catch (e) {
    bot.log(`tick error: ${(e as Error).message}`);
  } finally {
    // big blobs live in their own keys so the state stays small
    if (state.lastSnap) {
      await env.STATE.put("tickets", JSON.stringify(state.lastSnap));
      delete state.lastSnap;
    }
    for (const b of state.outbox ?? []) await env.STATE.put(`box:${b.boxId}`, JSON.stringify(b.rows));
    delete state.outbox;
    if (await mine()) {
      await put("state", JSON.stringify(state));
      await env.STATE.delete("lock");
    } else console.log("lost the lock during the tick, state not written");
  }
}

function publicState(s: State | null, repo?: string, dryRun = false, live = true) {
  if (!s) return { phase: "starting" };
  // before launch (no MINT) the public sees an empty box, never the test runs. preview shows everything
  if (!live)
    return {
      phase: "filling",
      nextBoxId: 1,
      pub: {},
      pending: null,
      vaultLamports: "0",
      feed: [],
      history: [],
      boxesOpened: 0,
      givenLamports: "0",
    };
  // a sealed box shows only its seal: the coins and the salt stay secret until it opens
  const sealed = (b: NonNullable<State["pending"]>) => {
    const { rows, plan, salt, paid, ...rest } = b;
    return rest;
  };
  return {
    phase: s.phase,
    nextBoxId: s.nextBoxId,
    pub: s.pub,
    pending: s.pending ? sealed(s.pending) : null,
    vaultLamports: s.vaultLamports ?? "0",
    feed: (s.feed ?? []).slice(-30).reverse(),
    history: s.history.slice(-30).reverse(),
    boxesOpened: s.history.length,
    givenLamports: s.history.reduce((a, b) => a + BigInt(b.prize?.lamports ?? "0"), 0n).toString(),
    burned: s.burned,
    journal: (s.journal ?? [])
      .slice(-30)
      .reverse()
      .map(({ commit, ...j }) => ({ ...j, link: repo && commit ? `${repo}/commit/${commit}` : undefined })),
    dry: dryRun || s.history.some((b) => b.prize?.sig === "dry-run") || undefined,
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3",
      "access-control-allow-origin": "*",
    },
  });

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Where a wallet stands: in the draw (with tickets), waiting out the minimum hold, or not in. And what a buy would change. */
async function walletStatus(env: Env, addr: string) {
  const state = (await env.STATE.get("state", "json")) as State | null;
  const snap = (await env.STATE.get("tickets", "json")) as Snap | null;
  const total = snap?.totalTickets ?? 0;
  const share = (t: number, extra = 0) =>
    total + extra > 0 ? Math.round(((t + extra) / (total + extra)) * 10000) / 100 : 0;
  // what $50 more would do: the bag counts at today's price, with the buy boost and the wallet's multiplier
  const entry = state?.pub?.entryUsd ?? HOLDERS.minHoldUsd;
  const whatIf = (tickets: number, mult: number) => {
    const price = snap?.priceUsd;
    if (!price) return undefined;
    const add = Math.max(50, entry);
    const extra = (add / price) * mult * (1 + HOLDERS.buyBoostPct / 100);
    return { addUsd: add, sharePct: share(tickets, extra) };
  };
  const row = snap?.rows.find((r) => r[0] === addr);
  if (row) {
    const [, tickets, heldMinutes, multiplier, boosted] = row;
    return {
      status: "in",
      tickets,
      multiplier,
      maxMultiplier: HOLDERS.maxMultiplier,
      hoursToMax: Math.max(0, Math.ceil(HOLDERS.rampHours - heldMinutes / 60)),
      boosted: !!boosted,
      heldMinutes,
      sharePct: share(tickets),
      ifBuy: whatIf(tickets, multiplier),
      at: snap!.at,
    };
  }
  const since = state?.holderState?.[addr];
  // held long enough but the bag is smaller than this box's entry
  if (since && (Date.now() - since) / 60_000 >= HOLDERS.minHoldMinutes)
    return { status: "out", short: true, ifBuy: whatIf(0, 1), minUsd: entry, at: snap?.at };
  if (since)
    return {
      status: "waiting",
      minutesLeft: Math.max(1, Math.ceil(HOLDERS.minHoldMinutes - (Date.now() - since) / 60_000)),
      at: snap?.at,
    };
  if (state?.excluded?.includes(addr)) return { status: "excluded", at: snap?.at };
  return { status: "out", ifBuy: whatIf(0, 1), minUsd: entry, at: snap?.at };
}

/**
 * The state the public may see: only once the real coin is set and the bot has started on it
 * (mintSeen), so boxes from a test run never show up on the site. The preview key sees everything.
 */
async function liveState(env: Env, preview: boolean): Promise<State | null> {
  const s = (await env.STATE.get("state", "json")) as State | null;
  if (preview) return s;
  return s && env.MINT && s.mintSeen === env.MINT ? s : null;
}

/** One opened box with everything needed to recompute the draw. */
async function boxDetail(env: Env, id: number, preview: boolean) {
  const state = await liveState(env, preview);
  const rec = state?.history.find((b) => b.boxId === id);
  if (!rec) return null;
  const rows = (await env.STATE.get(`box:${id}`, "json")) as { owner: string; tickets: number }[] | null;
  return { ...rec, rows: rows ?? [] };
}

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const solStr = (l: string | bigint | undefined, d = 2) => {
  const s = (Number(l ?? 0) / 1e9).toFixed(d);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};

/** What the share card of a box shows, or null while the box is not opened. */
async function cardData(env: Env, id: number, preview: boolean): Promise<CardData | null> {
  const state = await liveState(env, preview);
  const b = state?.history.find((x) => x.boxId === id);
  if (!b?.draw || !b.prize) return null;
  return {
    boxId: b.boxId,
    tier: b.draw.tier,
    sol: solStr(b.prize.lamports),
    symbol: b.prize.symbol,
    winner: shortAddr(b.draw.winner),
    eligible: b.eligible,
    slot: b.draw.slot,
  };
}

/** The site with link-preview tags of one box, opening that box when it loads. */
function boxPage(d: CardData, origin: string): string {
  const title = `box #${d.boxId}: ${d.tier} pull, ${d.sol} sol of $${d.symbol}`;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const img = `${origin}/card/${d.boxId}.png`;
  const tags = [
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(`${d.winner} pulled it. 1 of ${d.eligible} in the draw. block ${d.slot} picked them.`)}">`,
    `<meta property="og:image" content="${img}">`,
    `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    `<meta property="og:url" content="${origin}/box/${d.boxId}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${img}">`,
    `<script>if(!location.hash)history.replaceState(null,"","/"+location.search+"#box-${d.boxId}")</script>`,
  ].join("\n");
  return HTML.replace(/<meta property="og:title"[^>]*>\n<meta property="og:description"[^>]*>/, () => tags);
}

/** Holder leaderboards: biggest winners, longest in the draw, longest without a win. */
async function top(env: Env, preview: boolean) {
  const state = await liveState(env, preview);
  const snap = state ? ((await env.STATE.get("tickets", "json")) as Snap | null) : null;
  const excluded = new Set(state?.excluded ?? []);
  const won = new Map<string, { lamports: bigint; wins: number; best: string }>();
  const rank = ["common", "rare", "epic", "secret"];
  for (const b of state?.history ?? []) {
    if (!b.draw || !b.prize) continue;
    const w = won.get(b.draw.winner) ?? { lamports: 0n, wins: 0, best: "common" };
    w.lamports += BigInt(b.prize.lamports);
    w.wins++;
    if (rank.indexOf(b.draw.tier) > rank.indexOf(w.best)) w.best = b.draw.tier;
    won.set(b.draw.winner, w);
  }
  const winners = [...won.entries()]
    .sort((a, b) => (b[1].lamports > a[1].lamports ? 1 : b[1].lamports < a[1].lamports ? -1 : 0))
    .slice(0, 5)
    .map(([w, v]) => ({ wallet: w, sol: solStr(v.lamports, 3), wins: v.wins, best: v.best }));
  const holders = (snap?.rows ?? [])
    .filter((r) => !excluded.has(r[0]))
    .sort((a, b) => b[2] - a[2])
    .slice(0, 5)
    .map((r) => ({ wallet: r[0], heldMinutes: r[2], multiplier: r[3] }));
  const unlucky = Object.entries(state?.misses ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, n]) => ({ wallet: w, boxes: n }));
  return { winners, holders, unlucky, at: snap?.at };
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // cron can't go below a minute: claim passes every 15s in between
    ctx.waitUntil(
      (async () => {
        await run(env);
        for (const at of [15_000, 30_000, 45_000]) {
          const wait = event.scheduledTime + at - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          await run(env, true);
        }
      })(),
    );
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const preview = !!env.PREVIEW_KEY && url.searchParams.get("preview") === env.PREVIEW_KEY;
    // before launch the site is hidden from the public; open it with ?preview=PREVIEW_KEY
    if (env.PUBLIC !== "1" && !preview) {
      // before launch everyone sees the box and "coming soon"; the full site opens with ?preview=PREVIEW_KEY
      if (url.pathname === "/" || url.pathname === "/index.html")
        return new Response(SOON, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
        });
      return new Response("not found", { status: 404 });
    }
    if (url.pathname === "/api/selftest")
      return preview ? json(await selftest(env)) : new Response("not found", { status: 404 });
    if (url.pathname === "/api/state")
      return json(
        publicState(
          (await env.STATE.get("state", "json")) as State | null,
          env.REPO_URL,
          env.DRY_RUN === "1",
          !!(await liveState(env, preview)),
        ),
      );
    if (url.pathname === "/api/wallet") {
      const a = url.searchParams.get("a") ?? "";
      if (!ADDR.test(a)) return json({ error: "not a solana address" }, 400);
      // before the real coin runs there are no holders to check against
      if (!(await liveState(env, preview))) return json({ status: "out", minUsd: 20 });
      return json(await walletStatus(env, a));
    }
    if (url.pathname === "/api/top") return json(await top(env, preview));
    const bm = url.pathname.match(/^\/box\/(\d+)\/?$/);
    if (bm) {
      const d = await cardData(env, Number(bm[1]), preview);
      if (!d) return Response.redirect(`${url.origin}/`, 302);
      return new Response(boxPage(d, url.origin), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }
    const cm = url.pathname.match(/^\/card\/(\d+)\.png$/);
    if (cm) {
      const d = await cardData(env, Number(cm[1]), preview);
      if (!d) return new Response("not found", { status: 404 });
      return new Response(await renderCard(d, BOXSVG), {
        // an opened box never changes, so its card can be cached for good
        headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
      });
    }
    if (url.pathname === "/api/box") {
      const d = await boxDetail(env, Number(url.searchParams.get("id")), preview);
      return d ? json(d) : json({ error: "no such box" }, 404);
    }
    if (url.pathname === "/" || url.pathname === "/index.html")
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    return new Response("not found", { status: 404 });
  },
};
