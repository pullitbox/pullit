import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOST, frenzyLevel, newMilestones, oddsAt, usdShort } from "../src/boost.ts";
import { rollTier } from "../src/agent.ts";

test("every frenzy level has odds that add up to 100, epic gets better, secret stays at 1", () => {
  for (const f of BOOST.frenzy)
    assert.equal(
      f.odds.reduce((a, b) => a + b, 0),
      100,
    );
  for (let i = 1; i < BOOST.frenzy.length; i++) {
    assert.ok(BOOST.frenzy[i].odds[2] > BOOST.frenzy[i - 1].odds[2]);
    assert.equal(BOOST.frenzy[i].odds[3], 1);
  }
});

test("frenzy level follows the last hour of volume", () => {
  assert.equal(frenzyLevel(0), 0);
  assert.equal(frenzyLevel(19_999), 0);
  assert.equal(frenzyLevel(20_000), 1);
  assert.equal(frenzyLevel(70_000), 2);
  assert.equal(frenzyLevel(10_000_000), 3);
});

test("milestones fire once each", () => {
  assert.deepEqual(newMilestones(120_000, []), [50_000, 100_000]);
  assert.deepEqual(newMilestones(120_000, [50_000, 100_000]), []);
  assert.equal(usdShort(2_500_000), "2.5M");
  assert.equal(usdShort(100_000), "100K");
});

test("the tier uses the odds locked in the box, a milestone box is epic or better", () => {
  const seedFor = (n: number) => "0".repeat(13) + n.toString(16).padStart(8, "0"); // n % 100 = roll
  assert.equal(rollTier(seedFor(47), oddsAt(0)), "common");
  assert.equal(rollTier(seedFor(47), oddsAt(3)), "rare"); // 35 common at level 3
  assert.equal(rollTier(seedFor(10), oddsAt(0), true), "epic");
  assert.equal(rollTier(seedFor(99), oddsAt(0), true), "secret");
});
