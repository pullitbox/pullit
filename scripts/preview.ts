// Serves the site locally with made-up data, to look at the design without a deploy.
//   npm run preview   then open http://localhost:8787/?preview=x
// Nothing here touches the chain: the state is generated, the draw math is the real one.

import { createServer } from "node:http";
import worker from "../worker/index.ts";
import { newState, type State } from "../src/loop.ts";
import { draw, prizeSplit, sealOf } from "../src/executor.ts";

const kv = new Map<string, string>();
const KV = {
  async get(k: string, type?: string) { const v = kv.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
  async put(k: string, v: string) { kv.set(k, v); },
  async delete(k: string) { kv.delete(k); },
};

const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addr = (i: number) => Array.from({ length: 44 }, (_, j) => b58[(i * 7919 + j * 104729 + j * j * i) % 58]).join("");
const hash = (i: number) => Array.from({ length: 44 }, (_, j) => b58[(i * 31 + j * 17 + j * j) % 58]).join("");

const s: State = newState(Date.now() - 6 * 3_600_000);
s.mintSeen = "PuLLitXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXpump";
const runners = [["MOTH", "DARK"], ["LAMP", "OWL"], ["GRIT", "TIDE"], ["BEAN", "DARK"], ["FERN", "OWL"], ["KILN", "MOSS"]];
for (let id = 1; id <= 6; id++) {
  const rows = Array.from({ length: 40 + id * 25 }, (_, i) => ({ owner: addr(i + 1), tickets: Math.round(((i * 37) % 900 + 50) * (1 + (i % 3) * 0.5)) }));
  const d = await draw(rows, id, 318_000_000 + id * 41_377, hash(id));
  const [c, r] = runners[id - 1];
  const symbol = d.tier === "common" ? c : r;
  const salt = hash(id + 9).slice(0, 32);
  const plan = { boxId: id, common: { mint: addr(500 + id), symbol: c, why: "" }, rare: { mint: addr(600 + id), symbol: r, why: "" }, post: "", reveal: "", source: "ai" as const };
  const bank = BigInt(id === 1 ? 150_000_000 : 300_000_000 + id * 7_000_000);
  const { fromBank, fromVault } = prizeSplit(d.tier, bank, 900_000_000n);
  const at = new Date(Date.now() - (7 - id) * 50 * 60_000).toISOString();
  s.history.push({
    boxId: id, budgetLamports: String(bank), targetSlot: d.slot, eligible: rows.length, seal: await sealOf(plan, salt), salt,
    plan, draw: d, prize: { sig: "5" + hash(id + 50) + hash(id), mint: "", amount: "0", symbol, lamports: String(fromBank + fromVault), fromVault: String(fromVault) },
    posts: [`box #${id} is full and sealed. a block opens it in about a minute`, `box #${id} opened. ${d.winner.slice(0, 4)}…${d.winner.slice(-4)} pulled ${d.tier}: $${symbol}. block ${d.slot} decided it`],
    at,
  });
  kv.set(`box:${id}`, JSON.stringify(rows));
}
s.nextBoxId = 7;
s.vaultLamports = "1240000000";
const F = (min: number, tag: string, m: string) => ({ at: new Date(Date.now() - min * 60_000).toISOString(), tag, m });
s.feed = [
  F(58, "fee", "fees came in. 0.044 for me, 0.005 for the vault. tastes like your bad entries"),
  F(55, "roast", "7xQp…Lk2a just took 2.3% of supply in one go. chill. leave some for the rest of us"),
  F(52, "scan", "looked at 1,214 coins. threw out 38. one dev held 40% of his own coin and called it community"),
  F(52, "pick", "picked some weird dog. looks nervous. holders keep showing up so i trust it more than you"),
  F(52, "pick", "the rare one has survived longer than your last 5 trades combined. respect"),
  F(52, "box", "box #6 sealed: 4be1…09fa. screenshot it, you paranoid little goblins"),
  F(52, "roast", "Ck8s…a7Tw sold the whole 0.8% bag right before the box opens. timing of a legend"),
  F(52, "draw", "locked to block 318,442,910. nobody knows it yet. not the dev, not the kols, not your group chat"),
  { ...F(51, "win", "9fKa…w2Ld pulled rare: 0.205 sol of $KILN. dont sell it in 4 minutes. you will"), tx: "5" + hash(77) + hash(78) },
  F(51, "box", "box #6 unsealed. seal matches. told you. im cardboard, not a dev"),
  F(51, "box", "0.137 sol stays in me for box #7. leftovers. like your bags"),
  F(40, "x", "breaking: local box 68% full, refuses to elaborate / holders still asking wen"),
  F(30, "hold", "Bq3x…P0aa has held me for 24h. 3x tickets. marry me"),
  F(8, "fee", "0.039 sol into the box. whoever keeps flipping 0.1 sol all day, i see you, i love you"),
];
s.history[5].at = new Date(Date.now() - 40 * 60_000).toISOString();
const mode = process.argv[2] ?? "filling";
s.pub = {
  updatedAt: new Date().toISOString(), box: addr(901), team: addr(902), dev: addr(903), mint: s.mintSeen,
  boxLamports: "204000000", thresholdLamports: "300000000", holders: 412, eligible: 188,
};
if (mode === "packed") {
  s.phase = "drawing";
  s.pending = { ...s.history[5], boxId: 7, seal: "9e41" + "0".repeat(56) + "c07a", at: new Date(Date.now() - 20_000).toISOString(), posts: ["box #7 is full and taped shut. i know whats inside and im not telling"], rows: [] } as State["pending"];
  delete s.pending!.draw; delete s.pending!.prize;
}
if (mode === "empty") { s.history = []; s.nextBoxId = 1; s.pub.boxLamports = "21000000"; s.pub.thresholdLamports = "150000000"; }
kv.set("state", JSON.stringify(s));
kv.set("tickets", JSON.stringify({ at: new Date().toISOString(), totalTickets: 120000, rows: [[addr(5), 2440, 312, 1.43]] }));
s.holderState[addr(6)] = Date.now() - 6 * 60_000; kv.set("state", JSON.stringify(s));

const env = { STATE: KV, PUBLIC: "1", PREVIEW_KEY: "x" } as never;
createServer(async (req, res) => {
  const r = await worker.fetch(new Request("http://localhost" + req.url), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, () => console.log(`preview (${mode}) on http://localhost:8787  in-draw wallet: ${addr(5)}  waiting wallet: ${addr(6)}`));
