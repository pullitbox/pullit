import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBuys, luckyRoll, mustHold, GAMES } from "../src/games.ts";

const MINT = "M".repeat(44);
const tx = (sig: string, payer: string, amount: number, extra: object = {}) => ({
  signature: sig,
  slot: 100,
  timestamp: 1_700_000_000,
  feePayer: payer,
  tokenTransfers: [{ mint: MINT, fromUserAccount: "POOL", toUserAccount: payer, tokenAmount: amount }],
  ...extra,
});

test("buys are the fee payer receiving our token, sells and our own wallets are not", () => {
  const sell = {
    ...tx("s2", "B", 0),
    tokenTransfers: [{ mint: MINT, fromUserAccount: "B", toUserAccount: "POOL", tokenAmount: 500 }],
  };
  const buys = parseBuys(
    [tx("s1", "A", 1000), sell, tx("s3", "BOX", 1000), tx("s4", "C", 10, { transactionError: "x" })],
    MINT,
    0.05,
    new Set(["BOX"]),
  );
  assert.deepEqual(
    buys.map((b) => [b.sig, b.buyer, b.usd]),
    [["s1", "A", 50]],
  );
});

test("the lucky roll is deterministic and wins about 1 in luckyOdds", async () => {
  const a = await luckyRoll("sig", "hash");
  assert.deepEqual(a, await luckyRoll("sig", "hash"));
  let wins = 0;
  for (let i = 0; i < 3000; i++) if ((await luckyRoll("sig" + i, "hash")).win) wins++;
  const rate = wins / 3000;
  assert.ok(Math.abs(rate - 1 / GAMES.luckyOdds) < 0.02, String(rate));
});

test("a winner has to keep 90% of what they bought", () => {
  assert.equal(mustHold(1000), 900_000_000n);
});
