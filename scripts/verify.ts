// Recomputes one opened box from public data: the seal, the blockhash of the committed slot,
// the winner and the tier. Uses the same code the bot uses.
//   npm run verify -- 12
//   npm run verify -- 12 --site=https://pullit.fun --rpc=https://api.mainnet-beta.solana.com

import { pickWinner } from "../src/holders.ts";
import { rollTier } from "../src/agent.ts";
import { sealOf } from "../src/executor.ts";

const arg = (k: string, d: string) =>
  process.argv
    .find((a) => a.startsWith(`--${k}=`))
    ?.split("=")
    .slice(1)
    .join("=") ?? d;
const id = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)));
if (!id) throw new Error("usage: npm run verify -- <box number>");
const site = arg("site", "https://pullit.fun");
const rpc = arg("rpc", "https://api.mainnet-beta.solana.com");
const preview = arg("preview", "");

const res = await fetch(`${site}/api/box?id=${id}${preview ? `&preview=${preview}` : ""}`);
if (!res.ok) throw new Error(`box #${id}: ${res.status} ${await res.text()}`);
const b = await res.json();
const d = b.draw;
const ok = (x: boolean) => (x ? "ok " : "BAD");
let bad = 0;
const check = (good: boolean, line: string) => {
  if (!good) bad++;
  console.log(`${ok(good)}  ${line}`);
};

console.log(`box #${id}: ${b.eligible} holders in the draw, ${b.rows.length} wallets in the ticket list\n`);

const seal = await sealOf(b.plan, b.salt ?? "");
check(
  !!b.salt && seal === b.seal,
  `seal sha256(common|rare|salt) = ${seal.slice(0, 16)}…  published ${String(b.seal).slice(0, 16)}…`,
);

try {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBlock",
      params: [d.slot, { transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }],
    }),
  });
  const j = await r.json();
  check(j.result?.blockhash === d.blockhash, `slot ${d.slot} has blockhash ${d.blockhash}`);
  if (d.slot < b.targetSlot) check(false, `used slot ${d.slot} is before the committed slot ${b.targetSlot}`);
  else check(true, `used slot ${d.slot} is at or after the committed slot ${b.targetSlot}`);
} catch (e) {
  console.log(`??   could not reach ${rpc} to check the blockhash: ${(e as Error).message}`);
}

const w = await pickWinner(b.rows, d.blockhash, b.boxId);
check(w?.seed === d.seed, `seed sha256(blockhash:${b.boxId}) = ${w?.seed.slice(0, 16)}…`);
check(w?.owner === d.winner, `winner ${w?.owner}`);
const tier = rollTier(w?.seed ?? "");
check(tier === d.tier, `tier ${tier}`);

console.log(
  bad
    ? `\n${bad} check(s) failed`
    : `\nall checks passed. $${b.plan.common.symbol} and $${b.plan.rare.symbol} were in the box, ${d.winner.slice(0, 4)}…${d.winner.slice(-4)} pulled ${tier}`,
);
process.exitCode = bad ? 1 : 0;
