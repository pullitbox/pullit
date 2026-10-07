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
  const W = "W".repeat(44), D = "D".repeat(44), P = "P".repeat(44);
  b.state.excluded = [P];
  const now = Date.now();
  await b.react([{ owner: D, amount: 5e6 }, { owner: P, amount: 2e8 }], SUPPLY, { [D]: now });
  await b.react([{ owner: W, amount: 2e7 }, { owner: P, amount: 1e8 }], SUPPLY, { [W]: now });
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

test("next box size follows the last hour of fees", async () => {
  const { nextBoxSize, boxSize } = await import("../src/loop.ts");
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
  for (let i = 0; i < 40; i++) await b.line("info", "x", [], (await import("../src/voice.ts")).say.info(String(400 + i), String(100 + i)));
  const lines = b.state.feed.map((f) => f.m);
  const { similar } = await import("../src/agent.ts");
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) assert.ok(!similar(lines[i], lines[j]), lines[i] + " / " + lines[j]);
  assert.ok(lines.length >= 3 && lines.length <= 7);
});
