import { test } from "node:test";
import assert from "node:assert/strict";
import { prizeMint, prizeSplit, sealOf } from "../src/executor.ts";
import type { BoxPlan } from "../src/agent.ts";

const plan = { common: { mint: "C1", symbol: "C" }, rare: { mint: "R1", symbol: "R" } } as BoxPlan;

test("tiers take their share of the box, secret also a quarter of the vault", () => {
  const bank = 1_000_000_000n, vault = 400_000_000n;
  assert.deepEqual(prizeSplit("common", bank, vault), { fromBank: 300_000_000n, fromVault: 0n });
  assert.deepEqual(prizeSplit("rare", bank, vault), { fromBank: 600_000_000n, fromVault: 0n });
  assert.deepEqual(prizeSplit("epic", bank, vault), { fromBank: bank, fromVault: 0n });
  assert.deepEqual(prizeSplit("secret", bank, vault), { fromBank: bank, fromVault: 100_000_000n });
});

test("the final box empties everything whatever the tier", () => {
  assert.deepEqual(prizeSplit("common", 5n, 7n, true), { fromBank: 5n, fromVault: 7n });
});

test("common pays in the fresh runner, bigger tiers in the meta runner", () => {
  assert.equal(prizeMint("common", plan), "C1");
  for (const t of ["rare", "epic", "secret"] as const) assert.equal(prizeMint(t, plan), "R1");
});

test("seal is stable and changes with the contents", async () => {
  const a = await sealOf(plan, "s");
  assert.equal(a, await sealOf(plan, "s"));
  assert.notEqual(a, await sealOf({ ...plan, rare: { ...plan.rare, mint: "R2" } }, "s"));
  assert.match(a, /^[0-9a-f]{64}$/);
});
