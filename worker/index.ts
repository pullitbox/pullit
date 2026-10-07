// Cloudflare Worker: runs the bot once a minute (cron) and serves the site + /api/state.
// Secrets (wrangler secret put): HELIUS_API_KEY, JUP_API_KEY, OPENROUTER_API_KEY,
// ZERNIO_API_KEY, DEV_SECRET, BOX_SECRET, PREVIEW_KEY.
// Vars (wrangler.jsonc): TEAM_WALLET, MINT, PUBLIC ("1" = site open to everyone), DRY_RUN.

import { Bot, newState, type Env as BotEnv, type State } from "../src/loop.ts";
import { HTML } from "./site.ts";
import { keypairFromSecret, Rpc } from "../src/solana.ts";
import { fetchToken } from "../src/jupiter.ts";
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
  PUBLIC?: string;
}

type Snap = NonNullable<State["lastSnap"]>;

const LOCK_MS = 4 * 60_000;

async function run(env: Env) {
  const lock = await env.STATE.get("lock");
  if (lock && Date.now() - Number(lock) < LOCK_MS) return; // previous tick still running
  await env.STATE.put("lock", String(Date.now()));
  const state = ((await env.STATE.get("state", "json")) as State | null) ?? newState();
  const bot = new Bot(env, state);
  // the sealed box is saved (and visible on the site) before the draw block exists
  bot.checkpoint = () => env.STATE.put("state", JSON.stringify(state));
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
    await env.STATE.delete("lock");
  }
}

function publicState(s: State | null) {
  if (!s) return { phase: "starting" };
  // a sealed box shows only its seal: the coins and the salt stay secret until it opens
  const sealed = (b: NonNullable<State["pending"]>) => {
    const { rows, plan, salt, ...rest } = b;
    void rows;
    void plan;
    void salt;
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
    dry: s.history.some((b) => b.prize?.sig === "dry-run") || undefined,
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

/** Where a wallet stands: in the draw (with tickets), waiting out the 15 min, or not in. */
async function walletStatus(env: Env, addr: string) {
  const state = (await env.STATE.get("state", "json")) as State | null;
  const snap = (await env.STATE.get("tickets", "json")) as Snap | null;
  const row = snap?.rows.find((r) => r[0] === addr);
  if (row) {
    const [, tickets, heldMinutes, multiplier] = row;
    return {
      status: "in",
      tickets,
      multiplier,
      heldMinutes,
      sharePct: snap!.totalTickets ? Math.round((tickets / snap!.totalTickets) * 10000) / 100 : 0,
      at: snap!.at,
    };
  }
  const since = state?.holderState?.[addr];
  if (since)
    return { status: "waiting", minutesLeft: Math.max(1, Math.ceil(15 - (Date.now() - since) / 60_000)), at: snap?.at };
  if (state?.excluded?.includes(addr)) return { status: "excluded", at: snap?.at };
  return { status: "out", at: snap?.at };
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
    if (url.pathname === "/api/state") return json(publicState((await env.STATE.get("state", "json")) as State | null));
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
