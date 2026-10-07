// Executor: draws the winner and the tier from a future blockhash, then pays the prize
// straight into the winner's wallet (Jupiter swap with `receiver`, or a plain SOL transfer).

import { fromB64, buildTransferTx, signSerializedTx, toB64, type Keypair, type Rpc } from "./solana.ts";
import { pickWinner, type TicketRow } from "./holders.ts";
import { rollTier, TIERS, type BoxPlan, type Tier } from "./agent.ts";

export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
};

export const EXEC = {
  drawDelaySlots: 150, // ~1 minute: the draw uses a block that does not exist yet when we announce it
  keepInBoxLamports: 15_000_000n, // 0.015 SOL stays for fees and token accounts
  slippageBps: 300,
};

// ---------- randomness ----------

/** Waits until `slot` is confirmed and returns its blockhash (skipped slots roll forward). */
export async function blockhashAt(rpc: Rpc, slot: number, timeoutMs = 180_000): Promise<{ slot: number; blockhash: string }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const tip = await rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
    if (tip >= slot + 2) {
      for (let s = slot; s <= tip; s++) {
        try {
          const b = await rpc.call<{ blockhash: string } | null>("getBlock", [s, {
            commitment: "confirmed", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0,
          }]);
          if (b?.blockhash) return { slot: s, blockhash: b.blockhash };
        } catch { /* skipped slot, try next */ }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`no block at or after slot ${slot} in time`);
}

export interface Draw {
  boxId: number;
  slot: number;
  blockhash: string;
  seed: string;
  winner: string;
  tier: Tier;
}

export async function draw(rows: Pick<TicketRow, "owner" | "tickets">[], boxId: number, slot: number, blockhash: string): Promise<Draw> {
  const w = await pickWinner(rows, blockhash, boxId);
  if (!w) throw new Error("nobody eligible for this box");
  return { boxId, slot, blockhash, seed: w.seed, winner: w.owner, tier: rollTier(w.seed) };
}

// ---------- payout ----------

/** common pays in the fresh runner, everything bigger in the meta runner. */
export function prizeMint(tier: Tier, plan: BoxPlan): string {
  return tier === "common" ? plan.common.mint : plan.rare.mint;
}

/** How much of the box and of the vault a tier takes. The final box takes everything. */
export function prizeSplit(tier: Tier, bank: bigint, vault: bigint, final = false): { fromBank: bigint; fromVault: bigint } {
  if (final) return { fromBank: bank, fromVault: vault };
  const t = TIERS.find((x) => x.key === tier)!;
  return { fromBank: (bank * BigInt(t.boxPct)) / 100n, fromVault: (vault * BigInt(t.vaultPct)) / 100n };
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The seal published while the box is closed: sha256("<common mint>|<rare mint>|<salt>"). */
export function sealOf(plan: Pick<BoxPlan, "common" | "rare">, salt: string): Promise<string> {
  return sha256Hex(`${plan.common.mint}|${plan.rare.mint}|${salt}`);
}

export function newSalt(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

interface OrderResp { transaction?: string; requestId?: string; outAmount?: string; errorMessage?: string; router?: string }
interface ExecResp { status?: string; signature?: string; code?: number; error?: string; totalOutputAmount?: string }

/** Quote only (no signing). Used for dry runs. */
export async function quote(jupKey: string, outputMint: string, lamports: bigint, taker: string, receiver: string): Promise<OrderResp> {
  const qs = new URLSearchParams({
    inputMint: MINTS.SOL, outputMint, amount: lamports.toString(), taker, receiver,
    slippageBps: String(EXEC.slippageBps),
  });
  const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs}`, { headers: { "x-api-key": jupKey } });
  const json = (await res.json()) as OrderResp;
  if (!res.ok || !json.transaction) throw new Error(`Jupiter order failed: ${json.errorMessage ?? res.status}`);
  return json;
}

/** Buys `outputMint` with `lamports` of SOL from the box and delivers it to `receiver`. */
export async function buyInto(jupKey: string, box: Keypair, outputMint: string, lamports: bigint, receiver: string): Promise<{ sig: string; outAmount: string; router?: string }> {
  const order = await quote(jupKey, outputMint, lamports, box.publicKey, receiver);
  const signed = await signSerializedTx(fromB64(order.transaction!), box);
  const res = await fetch("https://api.jup.ag/swap/v2/execute", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": jupKey },
    body: JSON.stringify({ signedTransaction: toB64(signed), requestId: order.requestId }),
  });
  const ex = (await res.json()) as ExecResp;
  if (ex.status !== "Success" || !ex.signature) throw new Error(`Jupiter execute failed: ${ex.error ?? JSON.stringify(ex).slice(0, 200)}`);
  return { sig: ex.signature, outAmount: ex.totalOutputAmount ?? order.outAmount ?? "?", router: order.router };
}

export async function sendSol(rpc: Rpc, box: Keypair, to: string, lamports: bigint): Promise<string> {
  const { blockhash } = await rpc.latestBlockhash();
  return rpc.sendAndConfirm(await buildTransferTx(box, [{ to, lamports }], blockhash));
}

/** How much of the box balance goes into the prize. */
export async function prizeBudget(rpc: Rpc, box: Keypair): Promise<bigint> {
  const bal = await rpc.balance(box.publicKey);
  return bal > EXEC.keepInBoxLamports ? bal - EXEC.keepInBoxLamports : 0n;
}

export async function payout(
  rpc: Rpc, jupKey: string, box: Keypair, d: Draw, plan: BoxPlan, lamports: bigint,
): Promise<{ sig: string; mint: string; amount: string }> {
  const mint = prizeMint(d.tier, plan);
  if (mint === MINTS.SOL) return { sig: await sendSol(rpc, box, d.winner, lamports), mint, amount: lamports.toString() };
  const r = await buyInto(jupKey, box, mint, lamports, d.winner);
  return { sig: r.sig, mint, amount: r.outAmount };
}
