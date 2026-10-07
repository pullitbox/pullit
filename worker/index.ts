// Cloudflare Worker: runs the bot once a minute (cron) and serves the site + /api/state.
// Secrets (wrangler secret put): HELIUS_API_KEY, JUP_API_KEY, OPENROUTER_API_KEY,
// ZERNIO_API_KEY, DEV_SECRET, BOX_SECRET, PREVIEW_KEY.
// Vars (wrangler.jsonc): TEAM_WALLET, MINT, PUBLIC ("1" = site open to everyone), DRY_RUN.

import { Bot, newState, type Env as BotEnv, type State } from "../src/loop.ts";
import { HTML } from "./site.ts";
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

async function run(env: Env) {
  const lock = await env.STATE.get("lock");
  if (lock && Date.now() - Number(lock.split(":")[0]) < LOCK_MS) return; // previous tick still running
  const token = `${Date.now()}:${crypto.randomUUID()}`;
  await env.STATE.put("lock", token);
  const state = ((await env.STATE.get("state", "json")) as State | null) ?? newState();
  const bot = new Bot(env, state);
  // the sealed box is saved (and visible on the site) before the draw block exists
  bot.checkpoint = () => env.STATE.put("state", JSON.stringify(state));
  // before any payment: stop if another tick has taken the lock
  bot.guard = async () => {
    if ((await env.STATE.get("lock")) !== token) throw new Error("lost the lock, another tick is running");
  };
  try {
    await bot.init();
    await bot.tick();
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
    await env.STATE.put("state", JSON.stringify(state));
    if ((await env.STATE.get("lock")) === token) await env.STATE.delete("lock");
  }
}

function publicState(s: State | null, repo?: string, dryRun = false) {
  if (!s) return { phase: "starting" };
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

/** One opened box with everything needed to recompute the draw. */
async function boxDetail(env: Env, id: number) {
  const state = (await env.STATE.get("state", "json")) as State | null;
  const rec = state?.history.find((b) => b.boxId === id);
  if (!rec) return null;
  const rows = (await env.STATE.get(`box:${id}`, "json")) as { owner: string; tickets: number }[] | null;
  return { ...rec, rows: rows ?? [] };
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env));
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const preview = !!env.PREVIEW_KEY && url.searchParams.get("preview") === env.PREVIEW_KEY;
    // before launch the site is hidden from the public; open it with ?preview=PREVIEW_KEY
    if (env.PUBLIC !== "1" && !preview) return new Response("not found", { status: 404 });
    if (url.pathname === "/api/selftest")
      return preview ? json(await selftest(env)) : new Response("not found", { status: 404 });
    if (url.pathname === "/api/state")
      return json(
        publicState((await env.STATE.get("state", "json")) as State | null, env.REPO_URL, env.DRY_RUN === "1"),
      );
    if (url.pathname === "/api/wallet") {
      const a = url.searchParams.get("a") ?? "";
      return ADDR.test(a) ? json(await walletStatus(env, a)) : json({ error: "not a solana address" }, 400);
    }
    if (url.pathname === "/api/box") {
      const d = await boxDetail(env, Number(url.searchParams.get("id")));
      return d ? json(d) : json({ error: "no such box" }, 404);
    }
    if (url.pathname === "/" || url.pathname === "/index.html")
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    return new Response("not found", { status: 404 });
  },
};
