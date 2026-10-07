import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTickets, holdMultiplier, pickWinner, HOLDERS } from "../src/holders.ts";

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
  assert.deepEqual(snap.rows.map((r) => r.owner), ["old"]);
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
  const rows = [{ owner: "a", tickets: 1 }, { owner: "b", tickets: 99 }];
  const w1 = await pickWinner(rows, "BLOCKHASHxyz", 7);
  const w2 = await pickWinner(rows, "BLOCKHASHxyz", 7);
  assert.deepEqual(w1, w2);
  let bWins = 0;
  for (let i = 0; i < 300; i++) if ((await pickWinner(rows, `h${i}`, 1))!.owner === "b") bWins++;
  assert.ok(bWins > 270, `b won ${bWins}/300`);
});
