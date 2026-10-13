// End to end: the real bot (not dry run) against a simulated chain, Jupiter, PumpPortal and Helius.
// Hours of trading pass in fast forward. Checks the money: only claimed fees are split (80% to the
// box), the dev's own SOL is never touched, every box pays its winner once and buys back and burns
// once, and a stale copy of the bot never pays a winner twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { b58encode, buildTx, keypairFromSecret, txSignature, type Keypair } from "../src/solana.ts";
import { Bot, newState, type Env, type State } from "../src/loop.ts";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SOL = 1_000_000_000n;

async function secret(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return b58encode(new Uint8Array([...pkcs8.slice(-32), ...raw]));
}
const randKey = () => b58encode(crypto.getRandomValues(new Uint8Array(32)));
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

function readU16(b: Uint8Array, o: number): [number, number] {
  let v = 0,
    s = 0,
    i = o;
  for (;;) {
    const x = b[i++]!;
    v |= (x & 0x7f) << s;
    if (!(x & 0x80)) return [v, i];
    s += 7;
  }
}
/** Legacy tx: account keys, blockhash and instructions. */
function parseTx(tx: Uint8Array) {
  const [n, a] = readU16(tx, 0);
  const m = tx.slice(a + n * 64);
  let p = 3;
  const [nk, k0] = readU16(m, p);
  const keys = Array.from({ length: nk }, (_, i) => b58encode(m.slice(k0 + i * 32, k0 + (i + 1) * 32)));
  p = k0 + nk * 32;
  const blockhash = b58encode(m.slice(p, p + 32));
  p += 32;
  const [ni, i0] = readU16(m, p);
  p = i0;
  const ixs: { program: string; accounts: string[]; data: Uint8Array }[] = [];
  for (let i = 0; i < ni; i++) {
    const prog = keys[m[p++]!]!;
    const [na, a0] = readU16(m, p);
    const accounts = Array.from(m.slice(a0, a0 + na)).map((x) => keys[x]!);
    const [nd, d0] = readU16(m, a0 + na);
    ixs.push({ program: prog, accounts, data: m.slice(d0, d0 + nd) });
    p = d0 + nd;
  }
  return { keys, blockhash, ixs };
}

class Chain {
  now = Date.UTC(2026, 9, 12, 18, 0, 0);
  t0 = this.now;
  sol = new Map<string, bigint>();
  tok = new Map<string, bigint>(); // `${owner}|${mint}`
  ata = new Map<string, { owner: string; mint: string }>();
  ataOf = new Map<string, string>();
  txs = new Map<string, { keys: string[]; deltas: Map<string, bigint>; time: number; kind: string }>();
  byAddr = new Map<string, string[]>(); // newest first
  effects = new Map<string, (sig: string) => { keys: string[]; deltas: Map<string, bigint>; kind: string }>();
  orders = new Map<string, { taker: string; receiver: string; mint: string; lamports: bigint }>();
  creatorFees = 0n;
  claimed = 0n;
  log: string[] = [];
  ourCap = 40_000; // $PULLIT market cap
  holders: [string, bigint][] = [];
  owners = new Map<string, string>(); // program-owned accounts
  dev: Keypair;
  box: Keypair;
  mint: string;
  constructor(dev: Keypair, box: Keypair, mint: string) {
    this.dev = dev;
    this.box = box;
    this.mint = mint;
  }
  slot = () => 400_000_000 + Math.floor((this.now - this.t0) / 400);
  bal = (a: string) => this.sol.get(a) ?? 0n;
  add(a: string, d: bigint) {
    const v = this.bal(a) + d;
    if (v < 0n) throw new Error(`insufficient lamports in ${a.slice(0, 4)}`);
    this.sol.set(a, v);
  }
  addTok(owner: string, mint: string, d: bigint) {
    const k = `${owner}|${mint}`;
    const v = (this.tok.get(k) ?? 0n) + d;
    if (v < 0n) throw new Error("insufficient tokens");
    this.tok.set(k, v);
    if (!this.ataOf.has(k)) {
      const a = randKey();
      this.ataOf.set(k, a);
      this.ata.set(a, { owner, mint });
    }
  }
  record(sig: string, keys: string[], deltas: Map<string, bigint>, kind: string) {
    this.txs.set(sig, { keys, deltas, time: this.now, kind });
    for (const k of new Set(keys)) this.byAddr.set(k, [sig, ...(this.byAddr.get(k) ?? [])]);
    this.log.push(kind);
  }
  /** A tx someone else builds for one of our wallets to sign; its effect runs when it is sent. */
  async foreignTx(
    kp: Keypair,
    effect: (sig: string) => { keys: string[]; deltas: Map<string, bigint>; kind: string },
    program = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  ) {
    const bh = randKey();
    this.effects.set(bh, effect);
    return buildTx(
      kp,
      [
        {
          programId: program,
          keys: [{ pubkey: kp.publicKey, signer: true, writable: true }],
          data: new Uint8Array([1]),
        },
      ],
      bh,
    );
  }
  send(tx: Uint8Array): string {
    const sig = txSignature(tx);
    if (this.txs.has(sig)) return sig;
    const { keys, blockhash, ixs } = parseTx(tx);
    const payer = keys[0]!;
    const deltas = new Map<string, bigint>();
    const d = (a: string, v: bigint) => deltas.set(a, (deltas.get(a) ?? 0n) + v);
    d(payer, -5000n);
    this.add(payer, -5000n);
    const fx = this.effects.get(blockhash);
    if (fx) {
      this.effects.delete(blockhash);
      const r = fx(sig);
      for (const [a, v] of r.deltas) d(a, v);
      this.record(sig, [payer, ...r.keys], deltas, r.kind);
      return sig;
    }
    let kind = "tx";
    for (const ix of ixs) {
      if (ix.program === SYSTEM && ix.data[0] === 2) {
        const lam = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(4, true);
        if (lam > 0n) {
          this.add(ix.accounts[0]!, -lam);
          this.add(ix.accounts[1]!, lam);
          d(ix.accounts[0]!, -lam);
          d(ix.accounts[1]!, lam);
        }
        kind = `transfer ${ix.accounts[0]!.slice(0, 4)}>${ix.accounts[1]!.slice(0, 4)}`;
      } else if (ix.program === TOKEN && ix.data[0] === 8) {
        const amt = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true);
        const a = this.ata.get(ix.accounts[0]!)!;
        this.addTok(a.owner, a.mint, -amt);
        kind = "burn";
      } else if (ix.program === "ComputeBudget111111111111111111111111111111") {
        // priority fee setup: no lamports move in the simulation
      } else throw new Error(`unknown instruction ${ix.program}`);
    }
    this.record(sig, keys, deltas, kind);
    return sig;
  }

  async rpc(method: string, params: any[]): Promise<unknown> {
    switch (method) {
      case "getBalance":
        return { value: Number(this.bal(params[0])) };
      case "getLatestBlockhash":
        return { context: { slot: this.slot() }, value: { blockhash: randKey() } };
      case "sendTransaction":
        return this.send(unb64(params[0]));
      case "getSignatureStatuses":
        return {
          value: params[0].map((s: string) =>
            this.txs.has(s) ? { err: null, confirmationStatus: "confirmed" } : null,
          ),
        };
      case "getSlot":
        return this.slot();
      case "getBlock":
        return { blockhash: b58encode(new Uint8Array(32).map((_, i) => (params[0] * (i + 7)) % 256)) };
      case "getTokenAccountsByOwner": {
        const k = `${params[0]}|${params[1].mint}`;
        const a = this.ataOf.get(k);
        return {
          value: a
            ? [
                {
                  pubkey: a,
                  account: {
                    owner: TOKEN,
                    data: { parsed: { info: { tokenAmount: { amount: String(this.tok.get(k) ?? 0n) } } } },
                  },
                },
              ]
            : [],
        };
      }
      case "getMultipleAccounts":
        return { value: params[0].map((a: string) => ({ owner: this.owners.get(a) ?? SYSTEM })) };
      case "getTransaction": {
        const t = this.txs.get(params[0]);
        if (!t) return null;
        const keys = [...new Set(t.keys)];
        return {
          meta: {
            err: null,
            fee: 5000,
            preBalances: keys.map(() => 10_000_000_000),
            postBalances: keys.map((k) => 10_000_000_000 + Number(t.deltas.get(k) ?? 0n)),
          },
          transaction: { message: { accountKeys: keys } },
        };
      }
      case "getSignaturesForAddress":
        return (this.byAddr.get(params[0]) ?? [])
          .slice(0, params[1]?.limit ?? 1000)
          .map((s) => ({ signature: s, blockTime: Math.floor(this.txs.get(s)!.time / 1000), err: null }));
      case "getTokenAccounts": // helius DAS: holders of our mint
        return {
          token_accounts: [...this.tok.entries()]
            .filter(([k, v]) => k.endsWith(`|${this.mint}`) && v > 0n)
            .map(([k, v]) => ({ owner: k.split("|")[0], amount: String(v) })),
        };
    }
    throw new Error(`rpc ${method} not simulated`);
  }

  token(id: string, sym: string, ageH: number, mcap: number) {
    const at = new Date(this.now - ageH * 3_600_000).toISOString();
    return {
      id,
      symbol: sym,
      name: sym,
      decimals: 6,
      usdPrice: mcap / 1e9,
      totalSupply: 1e9,
      mcap,
      liquidity: mcap * 0.1,
      firstPool: { id: "pool", createdAt: at },
      graduatedAt: at,
      mintAuthority: null,
      freezeAuthority: null,
      audit: {
        isSus: false,
        mintAuthorityDisabled: true,
        freezeAuthorityDisabled: true,
        topHoldersPercentage: 20,
        devBalancePercentage: 1,
      },
      organicScore: 70,
      holderCount: 5000,
      stats6h: { buyVolume: mcap * 0.1, sellVolume: mcap * 0.09, priceChange: 10 },
      stats24h: {
        buyVolume: mcap * 0.3,
        sellVolume: mcap * 0.25,
        holderChange: 300,
        numNetBuyers: 200,
        priceChange: 20,
      },
    };
  }
  universe = () => [
    ...Array.from({ length: 8 }, (_, i) =>
      this.token(`Meta${i}`.padEnd(44, "1"), `META${i}`, 24 * (4 + i), 2_000_000 + i * 500_000),
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      this.token(`Frsh${i}`.padEnd(44, "1"), `FRSH${i}`, 6 + i * 5, 200_000 + i * 50_000),
    ),
  ];

  async http(url: string, init?: RequestInit): Promise<Response> {
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.includes("helius-rpc.com")) {
      try {
        return json({ jsonrpc: "2.0", id: 1, result: await this.rpc(body.method, body.params) });
      } catch (e) {
        return json({ jsonrpc: "2.0", id: 1, error: { message: (e as Error).message } });
      }
    }
    if (url.startsWith("https://api.jup.ag/tokens")) {
      if (url.includes("/search")) return json([this.token(this.mint, "PULLIT", 1, this.ourCap)]);
      if (url.includes("/tag")) return json([]);
      return json(this.universe());
    }
    if (url.startsWith("https://api.jup.ag/swap/v2/order")) {
      const q = new URL(url).searchParams;
      const taker = q.get("taker")!;
      const o = {
        taker,
        receiver: q.get("receiver") ?? taker,
        mint: q.get("outputMint")!,
        lamports: BigInt(q.get("amount")!),
      };
      const id = randKey();
      this.orders.set(id, o);
      const kp = taker === this.box.publicKey ? this.box : this.dev;
      const tx = await this.foreignTx(kp, () => {
        this.add(o.taker, -o.lamports);
        this.addTok(o.receiver, o.mint, o.lamports * 1000n);
        const ata = this.ataOf.get(`${o.receiver}|${o.mint}`)!;
        return {
          keys: [o.receiver, ata],
          deltas: new Map([[o.taker, -o.lamports]]),
          kind: `swap ${o.mint === this.mint ? "buyback" : "prize"} ${o.receiver.slice(0, 4)}`,
        };
      });
      return json({ transaction: b64(tx), requestId: id, outAmount: String(o.lamports * 1000n) });
    }
    if (url.startsWith("https://api.jup.ag/swap/v2/execute")) {
      const sig = this.send(unb64(body.signedTransaction));
      return json({
        status: "Success",
        signature: sig,
        totalOutputAmount: this.orders.get(body.requestId)!.lamports * 1000n + "",
      });
    }
    if (url.startsWith("https://pumpportal.fun")) {
      if (body.action === "collectCreatorFee") {
        if (this.creatorFees === 0n) return new Response("no fees to claim", { status: 400 });
        const tx = await this.foreignTx(
          this.dev,
          () => {
            const f = this.creatorFees;
            this.creatorFees = 0n;
            this.claimed += f;
            this.add(this.dev.publicKey, f);
            return { keys: [], deltas: new Map([[this.dev.publicKey, f]]), kind: "claim" };
          },
          PUMP,
        );
        return new Response(tx as Uint8Array<ArrayBuffer>);
      }
      return new Response("not simulated", { status: 500 });
    }
    if (url.includes("openrouter.ai")) return json({ error: { message: "no credits" } }, 402);
    if (url.includes("api.helius.xyz/v0/addresses/")) return json([]); // no buy history: nobody is in the red
    throw new Error(`http ${url} not simulated`);
  }
}

test("e2e: hours of trading in fast forward, every lamport where it belongs", { timeout: 600_000 }, async () => {
  const devS = await secret();
  const boxS = await secret();
  const dev = await keypairFromSecret(devS);
  const box = await keypairFromSecret(boxS);
  const mint = randKey();
  const c = new Chain(dev, box, mint);
  c.sol.set(dev.publicKey, SOL / 10n); // 0.1 SOL left after the dev buy
  c.sol.set(box.publicKey, SOL / 50n); // 0.02 SOL for gas
  const curve = randKey();
  c.owners.set(curve, PUMP);
  c.addTok(curve, mint, 500_000_000_000_000n);
  c.addTok(box.publicKey, mint, 300_000_000_000_000n); // launch reserve, bought before box #1
  c.addTok(dev.publicKey, mint, 30_000_000_000_000n);
  const holders = Array.from({ length: 30 }, () => randKey());
  holders.forEach((h, i) => c.addTok(h, mint, BigInt(2 + (i % 7) * 3) * 1_000_000_000_000n)); // 2M..20M tokens, $80+

  const realFetch = globalThis.fetch;
  const RealDate = Date;
  const realTimeout = globalThis.setTimeout;
  globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) =>
    c.http(String(u instanceof Request ? u.url : u), i)) as typeof fetch;
  // the simulated clock drives Date.now() and new Date() alike
  globalThis.Date = class extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length) super(...(a as [string]));
      else super(c.now);
    }
    static now() {
      return c.now;
    }
  } as DateConstructor;
  // time only moves when the bot waits: a wait of 4 s moves the simulated clock 4 s
  globalThis.setTimeout = ((fn: () => void, ms = 0) => {
    c.now += Math.min(Number(ms) || 0, 5_000);
    return realTimeout(fn, 0);
  }) as typeof setTimeout;

  const env: Env = {
    MINT: mint,
    HELIUS_API_KEY: "h",
    JUP_API_KEY: "j",
    OPENROUTER_API_KEY: "o",
    BOX_SECRET: boxS,
    DEV_SECRET: devS,
    TEAM_WALLET: dev.publicKey,
  };
  let state: State = newState(c.now);
  let stale: State | null = null;
  try {
    const bot = new Bot(env, state);
    bot.checkpoint = async () => {
      // keep a copy of the state as it was right before a prize was sent: the stale tick of the test below
      const p = state.pending;
      if (!stale && p?.paid?.inflight && !p.paid.coin) stale = structuredClone(state);
    };
    bot.guard = async () => {};
    await bot.init();
    let topUp = 0n;
    for (let minute = 0; minute < 300; minute++) {
      c.now += 60_000;
      c.creatorFees += SOL / 40n; // 0.025 SOL of creator fees a minute
      if (minute === 120) {
        c.add(dev.publicKey, 5n * SOL); // the dev tops up its own wallet: must never be split
        topUp = 5n * SOL;
      }
      try {
        await bot.tick(c.now);
      } catch (e) {
        state.log.push(`TICK ERROR ${(e as Error).message}`);
      }
    }
    const errors = state.log.filter((l) => /TICK ERROR|tick error|failed/i.test(l));
    assert.deepEqual(errors, [], "no errors in the bot log");

    // fees: before the bond the box gets 75% of every split
    const fromDevToBox = [...c.txs.values()]
      .filter((t) => t.kind.startsWith(`transfer ${dev.publicKey.slice(0, 4)}>${box.publicKey.slice(0, 4)}`))
      .reduce((a, t) => a + (t.deltas.get(box.publicKey) ?? 0n), 0n);
    const splitTotal = state.feeLedger.reduce((a, e) => a + BigInt(e.lamports), 0n);
    assert.ok(c.claimed > 5n * SOL, `fees were claimed (${c.claimed})`);
    const boxShare = state.feeLedger.reduce((a, e) => a + (BigInt(e.lamports) * 75n) / 100n, 0n);
    assert.equal(fromDevToBox, boxShare, "box got 75% of the split fees before the bond");
    assert.ok(
      splitTotal + BigInt(state.pendingFees ?? "0") === c.claimed,
      "every claimed lamport is split or still pending",
    );
    const devFees = [...c.txs.values()].filter((t) => t.keys[0] === dev.publicKey).length * 5000;
    assert.equal(
      c.bal(dev.publicKey),
      SOL / 10n + topUp + c.claimed - fromDevToBox - BigInt(devFees),
      "dev keeps its own SOL, the top-up and its 20%",
    );

    // boxes: each paid its winner once, bought back once, burned once
    const opened = state.history.filter((b) => b.prize);
    assert.ok(opened.length >= 3, `boxes opened: ${opened.length}`);
    for (const b of opened) {
      const toWinner = [...c.txs.values()].filter(
        (t) => t.kind.startsWith("swap prize") && t.keys.includes(b.draw!.winner),
      );
      assert.equal(toWinner.length >= 1, true, `box #${b.boxId} paid its winner`);
      assert.ok(b.burn?.burnSig && b.burn.burnSig !== "pending", `box #${b.boxId} burned`);
    }
    const prizes = [...c.txs.values()].filter((t) => t.kind.startsWith("swap prize")).length;
    const buybacks = [...c.txs.values()].filter((t) => t.kind.startsWith("swap buyback")).length;
    assert.equal(prizes, opened.length, "one prize per box");
    assert.equal(buybacks, opened.length, "one buyback per box");
    // the launch reserve is never sold or burned by the boxes (no reserve cap was crossed)
    assert.equal(state.reserve?.left, "300000000000000");

    // a stale copy of the bot from right before a payout must not pay that winner again
    assert.ok(stale, "captured a state from before a payout");
    const before = prizes;
    const ghost = new Bot(env, stale!);
    ghost.checkpoint = async () => {};
    ghost.guard = async () => {};
    await ghost.init();
    try {
      await ghost.tick(c.now);
    } catch {
      /* any error is fine, paying twice is not */
    }
    const after = [...c.txs.values()].filter((t) => t.kind.startsWith("swap prize")).length;
    assert.equal(after, before, "the stale bot found the payout on chain and did not pay again");
    console.log(
      `e2e: ${opened.length} boxes, ${(Number(c.claimed) / 1e9).toFixed(3)} SOL claimed, ${(Number(fromDevToBox) / 1e9).toFixed(3)} to the box, tiers ${opened.map((b) => b.draw!.tier).join(",")}`,
    );
  } finally {
    globalThis.fetch = realFetch;
    globalThis.Date = RealDate;
    globalThis.setTimeout = realTimeout;
  }
});

test("e2e: market cap milestones: epic boxes, the reserve burns each slice once", { timeout: 600_000 }, async () => {
  const devS = await secret();
  const boxS = await secret();
  const dev = await keypairFromSecret(devS);
  const box = await keypairFromSecret(boxS);
  const mint = randKey();
  const c = new Chain(dev, box, mint);
  c.ourCap = 140_000; // past 50K and 100K milestones and the 50K and 125K reserve burns
  c.sol.set(dev.publicKey, SOL / 10n);
  c.sol.set(box.publicKey, SOL / 50n);
  c.addTok(box.publicKey, mint, 300_000_000_000_000n);
  Array.from({ length: 20 }, () => randKey()).forEach((h) => c.addTok(h, mint, 2_000_000_000_000n));
  const realFetch = globalThis.fetch;
  const RealDate = Date;
  const realTimeout = globalThis.setTimeout;
  globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) =>
    c.http(String(u instanceof Request ? u.url : u), i)) as typeof fetch;
  globalThis.Date = class extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length) super(...(a as [string]));
      else super(c.now);
    }
    static now() {
      return c.now;
    }
  } as DateConstructor;
  globalThis.setTimeout = ((fn: () => void, ms = 0) => {
    c.now += Math.min(Number(ms) || 0, 5_000);
    return realTimeout(fn, 0);
  }) as typeof setTimeout;
  const env: Env = {
    MINT: mint,
    HELIUS_API_KEY: "h",
    JUP_API_KEY: "j",
    OPENROUTER_API_KEY: "o",
    BOX_SECRET: boxS,
    DEV_SECRET: devS,
    TEAM_WALLET: dev.publicKey,
  };
  const state = newState(c.now);
  try {
    const bot = new Bot(env, state);
    bot.checkpoint = async () => {};
    bot.guard = async () => {};
    await bot.init();
    for (let minute = 0; minute < 150; minute++) {
      c.now += 60_000;
      c.creatorFees += SOL / 40n;
      try {
        await bot.tick(c.now);
      } catch (e) {
        state.log.push(`TICK ERROR ${(e as Error).message}`);
      }
    }
    assert.deepEqual(
      state.log.filter((l) => /TICK ERROR|tick error|failed/i.test(l)),
      [],
    );
    // reserve: 10% at 50K and 10% at 125K, once each, no matter how many ticks see the cap
    assert.deepEqual(
      state.reserve?.burns.map((b) => b.milestone),
      [50_000, 125_000],
    );
    assert.equal(state.reserve?.initial, "300000000000000");
    assert.equal(state.reserve?.left, "240000000000000");
    assert.equal(
      c.tok.get(`${box.publicKey}|${mint}`),
      240_000_000_000_000n,
      "the box still holds what is left of the reserve",
    );
    // milestone boxes: epic or better
    const ms = state.history.filter((b) => b.milestone);
    // jumping past two caps at once gives one milestone box, for the highest
    assert.deepEqual(
      ms.map((b) => b.milestone),
      [100_000],
    );
    assert.ok(
      ms.every((b) => b.draw!.tier === "epic" || b.draw!.tier === "secret"),
      "milestone boxes are epic or better",
    );
    console.log(
      `e2e milestones: ${state.history.length} boxes, milestone tiers ${ms.map((b) => b.draw!.tier).join(",")}`,
    );
  } finally {
    globalThis.fetch = realFetch;
    globalThis.Date = RealDate;
    globalThis.setTimeout = realTimeout;
  }
});
