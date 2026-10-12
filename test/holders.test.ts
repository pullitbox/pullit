import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTickets, entryUsd, holdMultiplier, pickWinner, HOLDERS } from "../src/holders.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const minAgo = (m: number) => NOW - m * 60_000;
const SUPPLY = 1_000_000_000;

test("multiplier ramps 1x to max over rampHours", () => {
  assert.equal(holdMultiplier(0), 1);
  assert.equal(holdMultiplier(HOLDERS.rampHours * 60), HOLDERS.maxMultiplier);
  assert.equal(holdMultiplier(HOLDERS.rampHours * 60 * 5), HOLDERS.maxMultiplier);
});

test("excludes pools, dust and fresh wallets; keeps timers", () => {
  const snap = computeTickets(
    [
      { owner: "POOL", amount: 500_000_000 },
      { owner: "dust", amount: 10 }, // $0.001
      { owner: "fresh", amount: 1_000_000 },
      { owner: "old", amount: 1_000_000 },
    ],
    { old: minAgo(60), fresh: minAgo(5) },
    { priceUsd: 0.0001, totalSupply: SUPPLY, exclude: ["POOL"], now: NOW },
  );
  assert.deepEqual(
    snap.rows.map((r) => r.owner),
    ["old"],
  );
  assert.ok(snap.state.fresh, "fresh wallet timer is remembered");
  assert.equal(snap.state.dust, undefined);
  assert.equal(snap.state.POOL, undefined);
});

test("whale is capped by bag cap and ticket share cap", () => {
  const balances = [{ owner: "whale", amount: 100_000_000 }];
  const prev: Record<string, number> = { whale: minAgo(600) };
  for (let i = 0; i < 20; i++) {
    balances.push({ owner: `w${i}`, amount: 1_000_000 });
    prev[`w${i}`] = minAgo(600);
  }
  const snap = computeTickets(balances, prev, { priceUsd: 0.0001, totalSupply: SUPPLY, exclude: [], now: NOW });
  const whale = snap.rows.find((r) => r.owner === "whale")!;
  assert.ok(whale.sharePct <= HOLDERS.maxTicketSharePct + 0.01, `whale share ${whale.sharePct}`);
});

test("winner pick is deterministic and weighted", async () => {
  const rows = [
    { owner: "a", tickets: 1 },
    { owner: "b", tickets: 99 },
  ];
  const w1 = await pickWinner(rows, "BLOCKHASHxyz", 7);
  const w2 = await pickWinner(rows, "BLOCKHASHxyz", 7);
  assert.deepEqual(w1, w2);
  let bWins = 0;
  for (let i = 0; i < 300; i++) if ((await pickWinner(rows, `h${i}`, 1))!.owner === "b") bWins++;
  assert.ok(bWins > 270, `b won ${bWins}/300`);
});

test("a fresh buy gets +25% tickets, a sell puts the hold back to 1x", () => {
  const T0 = 1_800_000_000_000;
  const H = 3_600_000;
  const opts = (now: number, memo: Record<string, [number, number]>) => ({
    priceUsd: 0.001,
    totalSupply: 1e12,
    exclude: [],
    now,
    memo,
  });
  // A and B have held for 12h and bought nothing lately; then A buys more and B sells a bit
  const prev = { A: T0 - 12 * H, B: T0 - 12 * H };
  const memo: Record<string, [number, number]> = { A: [100_000, T0 - 12 * H], B: [100_000, T0 - 12 * H] };
  const snap = computeTickets(
    [
      { owner: "A", amount: 110_000 },
      { owner: "B", amount: 90_000 },
    ],
    prev,
    opts(T0, memo),
  );
  const a = snap.rows.find((r) => r.owner === "A")!;
  const b = snap.rows.find((r) => r.owner === "B")!;
  assert.equal(a.boosted, true);
  assert.equal(b.boosted, false);
  assert.ok(a.multiplier > 1.9);
  assert.ok(b.multiplier < 1.02); // reset, still in the draw
  assert.deepEqual(snap.sold, ["B"]);
  // an hour later the boost is gone
  const later = computeTickets([{ owner: "A", amount: 110_000 }], snap.state, opts(T0 + H + 1, snap.memo));
  assert.equal(later.rows[0].boosted, false);
});

test("bigger boxes need bigger bags, but a small bag keeps its hold timer", () => {
  assert.deepEqual([0.3, 0.5, 0.75, 1, 1.5, 2, 2.5, 4, 5].map(entryUsd), [20, 20, 50, 50, 50, 75, 100, 100, 250]);
  const snap = computeTickets(
    [
      { owner: "S", amount: 30_000 }, // $30
      { owner: "B", amount: 80_000 }, // $80
    ],
    { S: minAgo(60), B: minAgo(60) },
    { priceUsd: 0.001, totalSupply: SUPPLY, exclude: [], now: NOW, minUsd: 75 },
  );
  assert.deepEqual(
    snap.rows.map((r) => r.owner),
    ["B"],
  );
  assert.equal(snap.state.S, minAgo(60)); // still holding, timer kept for smaller boxes
});

test("holders in the red get the red multiplier on their tickets", () => {
  const now = Date.now();
  // plenty of other holders, so the 10% ticket cap does not flatten the two we compare
  const others = Array.from({ length: 40 }, (_, i) => ({ owner: String(i).padStart(44, "x"), amount: 5_000_000 }));
  const balances = [
    { owner: "A".repeat(44), amount: 1_000_000 },
    { owner: "B".repeat(44), amount: 1_000_000 },
    ...others,
  ];
  const prev = Object.fromEntries(balances.map((b) => [b.owner, now - 60 * 60_000]));
  const snap = computeTickets(balances, prev, {
    priceUsd: 0.0001,
    totalSupply: 1e9,
    exclude: [],
    now,
    red: new Set(["B".repeat(44)]),
  });
  const a = snap.rows.find((r) => r.owner === "A".repeat(44))!;
  const b = snap.rows.find((r) => r.owner === "B".repeat(44))!;
  assert.ok(b.red && !a.red);
  assert.ok(Math.abs(b.tickets / a.tickets - HOLDERS.redMultiplier) < 1e-9);
});
