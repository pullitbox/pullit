// End-to-end money test on mainnet with tiny amounts. The Dev wallet plays the winner.
// Default is a dry run: real scan, real AI pick, real future-block draw, real Jupiter quotes. No money moves.
// With --live it really does, from the box wallet (needs ~0.03 SOL there):
//   1. pays a 0.005 SOL prize in the sealed coin to Dev, saving the tx id before sending, then checks it landed
//   2. pays a 0.002 SOL prize in SOL (the fallback when a coin cannot be bought)
//   3. buys 0.003 SOL of the common coin into the box and burns all of it (the buyback and burn path)
// Usage:
//   npm run testbox
//   npm run testbox -- --live

import { fetchUniverse } from "../../src/jupiter.ts";
import { scan } from "../../src/scanner.ts";
import { packBox } from "../../src/agent.ts";
import { keypairFromSecret, Rpc, LAMPORTS } from "../../src/solana.ts";
import { blockhashAt, buyInto, burnAll, draw, EXEC, payout, prizeMint, quote } from "../../src/executor.ts";

const env = process.env;
for (const k of ["JUP_API_KEY", "HELIUS_API_KEY", "BOX_SECRET", "DEV_SECRET"])
  if (!env[k]) throw new Error(`${k} missing in .env`);
const live = process.argv.includes("--live");
const PRIZE = 5_000_000n; // 0.005 SOL
const PRIZE_SOL = 2_000_000n; // 0.002 SOL
const BURN = 3_000_000n; // 0.003 SOL
const sol = (l: bigint) => (Number(l) / Number(LAMPORTS)).toFixed(4);

const rpc = new Rpc(`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`);
const box = await keypairFromSecret(env.BOX_SECRET!);
const dev = await keypairFromSecret(env.DEV_SECRET!);
const bal = await rpc.balance(box.publicKey);
console.log(`box ${box.publicKey}: ${sol(bal)} SOL`);
console.log(`dev ${dev.publicKey} plays the winner`);
if (live && bal < 30_000_000n) throw new Error("put ~0.03 SOL in the box wallet for a live test");

console.log("\nscanning the market and packing…");
const result = scan(await fetchUniverse(env.JUP_API_KEY!));
const { plan, problems } = await packBox(env.OPENROUTER_API_KEY, result, 0, [], env.OPENROUTER_MODEL);
console.log(`agent (${plan.source}): common $${plan.common.symbol}, rare $${plan.rare.symbol}`);
if (problems.length) console.log(`  problems: ${problems.join("; ")}`);

const { slot: tip } = await rpc.latestBlockhash();
const target = tip + EXEC.drawDelaySlots;
console.log(`\ndraw on the block at slot ${target} (~20 s)…`);
const bh = await blockhashAt(rpc, target);
const d = await draw([{ owner: dev.publicKey, tickets: 1 }], 0, bh.slot, bh.blockhash);
console.log(`slot ${d.slot}, blockhash ${d.blockhash}\nseed ${d.seed}\ntier ${d.tier}`);
const mint = prizeMint(d.tier, plan);

if (!live) {
  const q = await quote(env.JUP_API_KEY!, mint, PRIZE, box.publicKey, dev.publicKey);
  const b = await quote(env.JUP_API_KEY!, plan.common.mint, BURN, box.publicKey, box.publicKey);
  console.log(`\nDRY RUN, nothing was sent:`);
  console.log(`  prize: ${sol(PRIZE)} SOL -> ${q.outAmount} raw units of ${mint} via ${q.router}`);
  console.log(`  burn:  ${sol(BURN)} SOL -> ${b.outAmount} raw units of $${plan.common.symbol}, then burned`);
  console.log(`\nrun with --live to really do it`);
  process.exit(0);
}

let ok = true;
const step = async (name: string, fn: () => Promise<string>) => {
  try {
    console.log(`\n${name}\n  ${await fn()}`);
  } catch (e) {
    ok = false;
    console.log(`\n${name}\n  FAILED: ${(e as Error).message}`);
  }
};

await step(`1. prize ${sol(PRIZE)} SOL in the sealed coin`, async () => {
  let saved = "";
  const r = await payout(rpc, env.JUP_API_KEY!, box, d, plan, PRIZE, (sig) => {
    saved = sig; // the bot saves this before sending
  });
  const status = await rpc.signatureStatus(r.sig);
  if (saved !== r.sig) throw new Error(`saved id ${saved} is not the sent one ${r.sig}`);
  if (status !== "landed") throw new Error(`tx ${r.sig} is ${status}`);
  return `landed, id known before sending. ${r.amount} raw units → https://solscan.io/tx/${r.sig}`;
});

await step(`2. prize ${sol(PRIZE_SOL)} SOL paid in SOL (fallback)`, async () => {
  const r = await payout(rpc, env.JUP_API_KEY!, box, d, plan, PRIZE_SOL, undefined, true);
  return `landed → https://solscan.io/tx/${r.sig}`;
});

await step(`3. buy ${sol(BURN)} SOL of $${plan.common.symbol} and burn it`, async () => {
  const b = await buyInto(env.JUP_API_KEY!, box, plan.common.mint, BURN, box.publicKey);
  const burn = await burnAll(rpc, box, plan.common.mint);
  if (!burn) throw new Error(`bought (${b.sig}) but nothing to burn`);
  const left = await rpc.tokenAccount(box.publicKey, plan.common.mint);
  if (left?.amount) throw new Error(`${left.amount} still in the box after the burn`);
  return `bought → https://solscan.io/tx/${b.sig}\n  burned ${burn.amount} → https://solscan.io/tx/${burn.sig}`;
});

console.log(`\nbox now ${sol(await rpc.balance(box.publicKey))} SOL`);
console.log(ok ? "\nall money paths work" : "\nsomething failed, send me the output");
