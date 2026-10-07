// End-to-end test of one small box on mainnet, with the Dev wallet as the only "holder".
// Default is a DRY RUN: real scan, real AI pick, real blockhash draw, real Jupiter quote. No money moves.
// Usage:
//   npm run testbox                      dry run
//   npm run testbox -- --live            really buys ~0.005 SOL of the prize into Dev
//   npm run testbox -- --live --tier=rare   force a tier (common|rare|epic|secret)

import { fetchUniverse } from "../src/jupiter.ts";
import { scan } from "../src/scanner.ts";
import { packBox, type Tier } from "../src/agent.ts";
import { keypairFromSecret, Rpc, LAMPORTS } from "../src/solana.ts";
import { blockhashAt, draw, EXEC, payout, prizeMint, quote, MINTS } from "../src/executor.ts";

const env = process.env;
for (const k of ["JUP_API_KEY", "HELIUS_API_KEY", "BOX_SECRET", "DEV_SECRET"])
  if (!env[k]) throw new Error(`${k} missing in .env`);
const live = process.argv.includes("--live");
const forced = process.argv.find((a) => a.startsWith("--tier="))?.split("=")[1] as Tier | undefined;
const TEST_LAMPORTS = 5_000_000n; // 0.005 SOL

const rpc = new Rpc(`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`);
const box = await keypairFromSecret(env.BOX_SECRET!);
const dev = await keypairFromSecret(env.DEV_SECRET!);
const bal = await rpc.balance(box.publicKey);
console.log(`box ${box.publicKey}: ${Number(bal) / Number(LAMPORTS)} SOL`);
if (live && bal < TEST_LAMPORTS + EXEC.keepInBoxLamports)
  throw new Error("not enough SOL in box for a live test (need ~0.02)");

console.log("scanning market…");
const result = scan(await fetchUniverse(env.JUP_API_KEY!));
const { plan, problems } = await packBox(env.OPENROUTER_API_KEY, result, 0, [], env.OPENROUTER_MODEL);
console.log(
  `agent (${plan.source}): common $${plan.common.symbol}, rare $${plan.rare.symbol}${problems.length ? "  problems: " + problems.join("; ") : ""}`,
);
console.log(`post: ${plan.post}`);

const { slot: tip } = await rpc.latestBlockhash();
const target = tip + EXEC.drawDelaySlots;
console.log(`\ndraw will use the block at slot ${target} (~1 min)…`);
const bh = await blockhashAt(rpc, target);
const d = await draw([{ owner: dev.publicKey, tickets: 1 }], 0, bh.slot, bh.blockhash);
if (forced) d.tier = forced;
console.log(
  `slot ${d.slot} blockhash ${d.blockhash}\nseed ${d.seed}\nwinner ${d.winner} (Dev)\ntier ${d.tier}${forced ? " (forced)" : ""}`,
);

const mint = prizeMint(d.tier, plan);
if (!live) {
  if (mint) {
    const q = await quote(env.JUP_API_KEY!, mint, TEST_LAMPORTS, box.publicKey, dev.publicKey);
    console.log(`\nDRY RUN quote: 0.005 SOL -> ${q.outAmount} raw units of ${mint} via ${q.router}. Nothing was sent.`);
  } else console.log(`\nDRY RUN: epic would send 0.005 SOL to the winner. Nothing was sent.`);
  console.log("Run with --live to really do it.");
} else {
  const r = await payout(rpc, env.JUP_API_KEY!, box, d, plan, TEST_LAMPORTS);
  console.log(
    `\nLIVE: paid ${r.amount} of ${r.mint === MINTS.SOL ? "SOL (lamports)" : r.mint}\nhttps://solscan.io/tx/${r.sig}`,
  );
}
