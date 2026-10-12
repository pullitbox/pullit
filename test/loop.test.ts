import { test } from "node:test";
import assert from "node:assert/strict";
import { Bot, newState } from "../src/loop.ts";

const bot = () => new Bot({ HELIUS_API_KEY: "x", JUP_API_KEY: "x", BOX_SECRET: "x", TEAM_WALLET: "T" }, newState());
const SUPPLY = 1e9;

test("first snapshot only remembers bags", async () => {
  const b = bot();
  await b.react([{ owner: "A".repeat(44), amount: 5e6 }], SUPPLY, {});
  assert.equal(b.state.feed.length, 0);
  assert.equal(b.state.bags!["A".repeat(44)], 0.5);
});

test("a big buy and a full exit get noticed, pools do not", async () => {
  const b = bot();
  const W = "W".repeat(44),
    D = "D".repeat(44),
    P = "P".repeat(44);
  b.state.excluded = [P];
  const now = Date.now();
  await b.react(
    [
      { owner: D, amount: 5e6 },
      { owner: P, amount: 2e8 },
    ],
    SUPPLY,
    { [D]: now },
  );
  await b.react(
    [
      { owner: W, amount: 2e7 },
      { owner: P, amount: 1e8 },
    ],
    SUPPLY,
    { [W]: now },
  );
  const text = b.state.feed.map((f) => f.m).join("\n");
  assert.match(text, /WWWW…WWWW/);
  assert.match(text, /DDDD…DDDD/);
  assert.doesNotMatch(text, /PPPP/);
  assert.ok(b.state.feed.length <= 2);
});

test("24h holders get crowned once", async () => {
  const b = bot();
  const H = "H".repeat(44);
  const since = Date.now() - 25 * 3_600_000;
  await b.react([{ owner: H, amount: 2e6 }], SUPPLY, { [H]: since });
  await b.react([{ owner: H, amount: 2e6 }], SUPPLY, { [H]: since });
  await b.react([{ owner: H, amount: 2e6 }], SUPPLY, { [H]: since });
  assert.equal(b.state.feed.filter((f) => /24h/.test(f.m)).length, 1);
});

test("next box size follows the last hour of fees", async (t) => {
  const { nextBoxSize, boxSize, FIXED_BOX } = await import("../src/loop.ts");
  if (FIXED_BOX) {
    // fixed size for now: every box is FIXED_BOX whatever the volume
    const big = [{ at: Date.now(), lamports: String(50e9) }];
    assert.equal(nextBoxSize(big).lamports, BigInt(FIXED_BOX * 1e9));
    assert.equal(boxSize(3, "4000000000"), BigInt(FIXED_BOX * 1e9));
    return t.skip("FIXED_BOX is on");
  }
  const now = Date.now();
  const at = (minAgo: number, sol: number) => ({ at: now - minAgo * 60_000, lamports: String(sol * 1e9) });
  // dead: 0.1 sol of fees in an hour -> smallest box
  assert.equal(nextBoxSize([at(10, 0.1)], now).lamports, 300_000_000n);
  // hot: 20 sol of fees in an hour -> 20 * 0.72 * 25/60 = 6 -> capped at the biggest size, 4
  assert.equal(nextBoxSize([at(5, 10), at(30, 10)], now).lamports, 4_000_000_000n);
  // medium: 3 sol/h -> 0.9 fillable -> 0.75
  assert.equal(nextBoxSize([at(20, 3)], now).lamports, 750_000_000n);
  // fees older than an hour do not count
  assert.equal(nextBoxSize([at(90, 50)], now).lamports, 300_000_000n);
  assert.equal(boxSize(0), 150_000_000n);
  assert.equal(boxSize(3, "2000000000"), 2_000_000_000n);
});

test("fill milestones are called once each, quiet when starting mid-box", async () => {
  const b = bot();
  const T = 1_000_000_000n;
  await b.milestone(200_000_000n, T);
  await b.milestone(260_000_000n, T);
  await b.milestone(300_000_000n, T);
  await b.milestone(510_000_000n, T);
  await b.milestone(920_000_000n, T);
  assert.equal(b.state.feed.length, 3); // 25, 50, 90
  const c = bot();
  await c.milestone(600_000_000n, T); // restart at 60%: no line
  assert.equal(c.state.feed.length, 0);
  await c.milestone(800_000_000n, T);
  assert.equal(c.state.feed.length, 1);
});

test("price moves and draw jumps get a line, small noise does not", async () => {
  const b = bot();
  await b.pulse(0.001, 100, 40);
  await b.pulse(0.00102, 101, 42);
  assert.equal(b.state.feed.length, 0);
  await b.pulse(0.0013, 120, 44);
  assert.equal(b.state.feed.length, 1);
  await b.pulse(0.0013, 140, 60);
  assert.equal(b.state.feed.length, 2);
});

test("chatter waits for silence", async () => {
  const b = bot();
  const now = Date.now();
  b.state.feed = [{ at: new Date(now - 60_000).toISOString(), tag: "fee", m: "x" }];
  await b.chatter(now);
  assert.equal(b.state.feed.length, 1);
  await b.chatter(now + 20 * 60_000);
  assert.equal(b.state.feed.length, 2);
});

test("the log never says the same thing twice", async () => {
  const b = bot();
  for (let i = 0; i < 40; i++)
    await b.line("info", "x", [], (await import("../src/voice.ts")).say.info(String(400 + i), String(100 + i)));
  const lines = b.state.feed.map((f) => f.m);
  const { similar } = await import("../src/agent.ts");
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) assert.ok(!similar(lines[i], lines[j]), lines[i] + " / " + lines[j]);
  assert.ok(lines.length >= 3 && lines.length <= 7);
});

test("a dry milestone box opens with locked odds and a box burn, the vault only on secret", async () => {
  const b = new Bot(
    { HELIUS_API_KEY: "x", JUP_API_KEY: "x", BOX_SECRET: "x", TEAM_WALLET: "T", DRY_RUN: "1" },
    newState(),
  );
  const slot = 1000;
  b.rpc = {
    call: async (m: string) => (m === "getSlot" ? slot + 5 : { blockhash: "BLOCKHASH111" }),
  } as unknown as typeof b.rpc;
  b.state.phase = "drawing";
  b.state.vaultLamports = "1000000000";
  b.state.dryBalance = "3000000000";
  b.state.pending = {
    boxId: 1,
    plan: {
      boxId: 1,
      common: { mint: "C", symbol: "CCC", why: "" },
      rare: { mint: "R", symbol: "RRR", why: "" },
      post: "",
      reveal: "",
      hints: { common: "", rare: "" },
      source: "fallback",
    },
    odds: [35, 30, 24, 11],
    frenzy: 3,
    milestone: 100_000,
    burnLamports: "100000000",
    budgetLamports: "1000000000",
    seal: "s",
    salt: "x",
    targetSlot: slot,
    eligible: 1,
    rows: [{ owner: "W".repeat(44), tickets: 10 }],
    posts: [],
    at: new Date().toISOString(),
  };
  await b.finishBox();
  const r = b.state.history[0];
  assert.ok(r.draw && ["epic", "secret"].includes(r.draw.tier)); // milestone box
  const fromVault = BigInt(r.prize!.fromVault);
  assert.equal(fromVault, r.draw!.tier === "secret" ? 1_000_000_000n : 0n);
  // prize = the whole box minus the burn, plus the vault cut
  assert.equal(r.prize!.lamports, (900_000_000n + fromVault).toString());
  // milestones no longer burn from the vault: only 10% of the box
  const vaultBurn = 0n;
  assert.equal(r.burn!.lamports, (100_000_000n + vaultBurn).toString());
  assert.equal(r.burn!.fromVault, undefined);
  assert.equal(b.state.burned!.lamports, (100_000_000n + vaultBurn).toString());
  assert.equal(b.state.vaultLamports, (1_000_000_000n - fromVault - vaultBurn).toString());
  assert.ok(b.state.feed.some((f) => f.tag === "burn"));
  assert.equal(r.paid, undefined);
});

test("a retry reuses the saved draw and does not take the dry balance twice", async () => {
  const b = new Bot(
    { HELIUS_API_KEY: "x", JUP_API_KEY: "x", BOX_SECRET: "x", TEAM_WALLET: "T", DRY_RUN: "1" },
    newState(),
  );
  let blocks = 0;
  b.rpc = {
    call: async (m: string) => {
      if (m === "getBlock") blocks++;
      return m === "getSlot" ? 1005 : { blockhash: "BLOCKHASH111" };
    },
  } as unknown as typeof b.rpc;
  let saves = 0;
  b.checkpoint = async () => {
    saves++;
    if (saves === 2) throw new Error("kv down"); // dies right after the payment is recorded
  };
  b.state.phase = "drawing";
  b.state.dryBalance = "1000000000";
  b.state.pending = {
    boxId: 1,
    plan: {
      boxId: 1,
      common: { mint: "C", symbol: "CCC", why: "" },
      rare: { mint: "R", symbol: "RRR", why: "" },
      post: "",
      reveal: "",
      hints: { common: "", rare: "" },
      source: "fallback",
    },
    burnLamports: "0",
    budgetLamports: "500000000",
    seal: "s",
    salt: "x",
    targetSlot: 1000,
    eligible: 1,
    rows: [{ owner: "W".repeat(44), tickets: 10 }],
    posts: [],
    at: new Date().toISOString(),
  };
  await assert.rejects(b.finishBox());
  const after = b.state.dryBalance;
  await b.finishBox();
  assert.equal(blocks, 1); // the block was read once
  assert.equal(b.state.dryBalance, after); // and paid once
  assert.equal(b.state.history.length, 1);
});

test("commits are sorted into journal kinds", async () => {
  const { journalKind } = await import("../src/loop.ts");
  assert.equal(journalKind("fix log scroll"), "fix");
  assert.equal(journalKind("milestone vault burn"), "burn");
  assert.equal(journalKind("entry by box size"), "rule");
  assert.equal(journalKind("live market rescan"), "ship");
});

test("journal drops entries of commits that were rewritten", async () => {
  const { Bot, newState } = await import("../src/loop.ts");
  const now = Date.parse("2026-10-10T12:00:00Z");
  const commits = [["new1234", now - 3_600_000, "bigger coin pool"]];
  const env = {
    HELIUS_API_KEY: "x",
    JUP_API_KEY: "x",
    BOX_SECRET: "x",
    TEAM_WALLET: "x",
    BUILD_COMMITS: btoa(JSON.stringify(commits)),
  };
  const state = newState(now);
  state.journal = [
    { at: new Date(now - 7_200_000).toISOString(), kind: "rule", text: "old leaky entry", commit: "old9999" },
    { at: new Date(now - 5 * 86_400_000).toISOString(), kind: "ship", text: "week old entry", commit: "week111" },
  ];
  await new Bot(env, state).journal(now);
  assert.deepEqual(
    state.journal.map((j) => j.commit),
    ["week111", "new1234"],
  );
  assert.equal(state.journal[1].text, "bigger coin pool");
});

test("fee share: half under $15k before the bond, all of it at $15k+, 80% after the bond", () => {
  const b = bot();
  const s = (b as unknown as { state: ReturnType<typeof newState> }).state;
  assert.equal(b.boxPct(), 100, "unknown cap: all to the box");
  s.market = { mcap: 12_400, volume1h: 0, at: "" };
  assert.equal(b.boxPct(), 50);
  s.market = { mcap: 15_000, volume1h: 0, at: "" };
  assert.equal(b.boxPct(), 100);
  s.bond = { at: 1 };
  s.market = { mcap: 12_000, volume1h: 0, at: "" };
  assert.equal(b.boxPct(), 80);
});
