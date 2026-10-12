import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOST, frenzyLevel, newMilestones, oddsAt, usdShort } from "../src/boost.ts";
import { rollTier } from "../src/agent.ts";

test("every frenzy level has odds that add up to 100, epic gets better, secret stays at 0.5", () => {
  for (const f of BOOST.frenzy)
    assert.equal(
      f.odds.reduce((a, b) => a + b, 0),
      100,
    );
  for (let i = 1; i < BOOST.frenzy.length; i++) {
    assert.ok(BOOST.frenzy[i].odds[2] > BOOST.frenzy[i - 1].odds[2]);
    assert.equal(BOOST.frenzy[i].odds[3], 0.5);
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
  const seedFor = (n: number) => "0".repeat(13) + n.toString(16).padStart(8, "0");
  // odds with decimals roll on 0.0..99.9 (n % 1000 / 10)
  assert.equal(rollTier(seedFor(470), oddsAt(0)), "common");
  assert.equal(rollTier(seedFor(470), oddsAt(3)), "rare"); // 35 common at level 3
  assert.equal(rollTier(seedFor(100), oddsAt(0), true), "epic");
  assert.equal(rollTier(seedFor(994), oddsAt(0)), "epic");
  assert.equal(rollTier(seedFor(995), oddsAt(0)), "secret"); // the top 0.5%
  // boxes sealed with whole odds still roll exactly as they did (n % 100)
  assert.equal(rollTier(seedFor(99), [45, 30, 18, 7]), "secret");
  assert.equal(rollTier(seedFor(47), [45, 30, 18, 7]), "rare");
});
