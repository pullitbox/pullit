import { test } from "node:test";
import assert from "node:assert/strict";
import { prizeMint, prizeSplit, sealOf } from "../src/executor.ts";
import type { BoxPlan } from "../src/agent.ts";

const plan = { common: { mint: "C1", symbol: "C" }, rare: { mint: "R1", symbol: "R" } } as BoxPlan;

test("tiers take their share of the box, only secret opens the vault, all of it", () => {
  const bank = 1_000_000_000n,
    vault = 400_000_000n;
  assert.deepEqual(prizeSplit("common", bank, vault), { fromBank: 500_000_000n, fromVault: 0n });
  assert.deepEqual(prizeSplit("rare", bank, vault), { fromBank: 750_000_000n, fromVault: 0n });
  assert.deepEqual(prizeSplit("epic", bank, vault), { fromBank: bank, fromVault: 0n });
  assert.deepEqual(prizeSplit("secret", bank, vault), { fromBank: bank, fromVault: vault });
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

test("a milestone box does not open the vault, a secret pull still takes all of it", () => {
  assert.deepEqual(prizeSplit("epic", 1000n, 400n, false, 0), { fromBank: 1000n, fromVault: 0n });
  assert.deepEqual(prizeSplit("secret", 1000n, 400n, false, 0), { fromBank: 1000n, fromVault: 400n });
});

test("the bot cannot sell: every swap in the code starts from SOL", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const code = readdirSync("src")
    .map((f) => readFileSync(`src/${f}`, "utf8"))
    .join("\n");
  // the only place an input token is chosen for a Jupiter swap, and it is always SOL
  const inputs = [...code.matchAll(/inputMint[:=]\s*([^,\n}]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(inputs, ["MINTS.SOL"]);
  // no other swap API is called anywhere
  assert.equal((code.match(/api\.jup\.ag\/swap/g) ?? []).length, 2); // order + execute in buyInto/quote
});
