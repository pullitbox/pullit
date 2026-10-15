import test from "node:test";
import assert from "node:assert/strict";
import { skipReason, SPAWN, newMintKeypair, coinSymbol, type SpawnState } from "../src/spawn.ts";
import { coinImage } from "../worker/coinimg.ts";
import { readFileSync } from "node:fs";

const H = 3_600_000;
test("spawn: first box launches, then gap, cap and the volume of the last coin decide", () => {
  const now = Date.parse("2026-10-15T16:00:00Z");
  const s: SpawnState = { coins: [] };
  assert.equal(skipReason(s, 38, now, null), null);
  s.coins.push({ boxId: 38, mint: "m38", symbol: coinSymbol(38), at: now, sig: "x" });
  assert.equal(skipReason(s, 38, now, null), "already decided");
  assert.match(skipReason(s, 39, now + H, 99_999)!, /too soon/);
  assert.match(skipReason(s, 40, now + 3 * H, SPAWN.minPrevVolumeUsd - 1)!, /wheel waits/);
  assert.equal(skipReason(s, 41, now + 3 * H, SPAWN.minPrevVolumeUsd), null);
  assert.equal(skipReason(s, 42, now + 22 * H, 0), null); // 12h+ later the wheel tries again
  const full: SpawnState = { coins: Array.from({ length: SPAWN.maxPerDay }, (_, i) => ({ boxId: i, mint: "m", symbol: "B", at: now - (i + 3) * 2 * H / 3, sig: "x" })) };
  full.coins.sort((a, b) => a.at - b.at);
  assert.match(skipReason(full, 99, now, 1e9)!, /daily cap/);
  assert.match(skipReason({ coins: [] }, 1, Date.parse("2026-10-15T07:16:00Z"), null)!, /quiet hours/);
  assert.equal(skipReason({ coins: [] }, 1, Date.parse("2026-10-15T02:00:00Z"), null), null);
});

test("spawn: mint keypair and coin picture", async () => {
  const kp = await newMintKeypair();
  assert.equal(kp.pub.length, 32);
  const png = await coinImage(38, readFileSync(new URL("../assets/box.svg", import.meta.url), "utf8"));
  assert.deepEqual([...png.slice(1, 4)], [80, 78, 71]);
  assert.ok(png.length > 2000);
});
