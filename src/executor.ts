// Executor: draws the winner and the tier from a future blockhash, then pays the prize
// straight into the winner's wallet (Jupiter swap with `receiver`, or a plain SOL transfer).

import {
  fromB64,
  buildTransferTx,
  buildTx,
  burnIx,
  signSerializedTx,
  toB64,
  txSignature,
  type Keypair,
  type Rpc,
} from "./solana.ts";

/** Called with a transaction's signature right before it is sent, so the caller can save it first. */
export type OnSigned = (sig: string) => Promise<void> | void;
import { pickWinner, type TicketRow } from "./holders.ts";
import { rollTier, TIERS, type BoxPlan, type Tier } from "./agent.ts";

export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
};

export const EXEC = {
  gasPerBoxLamports: 5_000_000n, // 0.005 SOL of every box stays for tx fees and token account rent
  drawDelaySlots: 50, // ~20 seconds: the draw uses a block that does not exist yet when we announce it
  keepInBoxLamports: 15_000_000n, // 0.015 SOL stays for fees and token accounts
  slippageBps: 300,
};

// ---------- randomness ----------

/** Waits until `slot` is confirmed and returns its blockhash (skipped slots roll forward). */
export async function blockhashAt(
  rpc: Rpc,
  slot: number,
  timeoutMs = 180_000,
): Promise<{ slot: number; blockhash: string }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const tip = await rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
    if (tip >= slot + 2) {
      for (let s = slot; s <= tip; s++) {
        try {
          const b = await rpc.call<{ blockhash: string } | null>("getBlock", [
            s,
            {
              commitment: "confirmed",
              transactionDetails: "none",
              rewards: false,
              maxSupportedTransactionVersion: 0,
            },
          ]);
          if (b?.blockhash) return { slot: s, blockhash: b.blockhash };
        } catch (e) {
          // only a slot that really has no block moves the draw forward; any other error is retried
          if (!/skipped|missing in long-term storage|-3200[79]/i.test((e as Error).message)) throw e;
        }
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

export async function draw(
  rows: Pick<TicketRow, "owner" | "tickets">[],
  boxId: number,
  slot: number,
  blockhash: string,
  odds?: readonly number[],
  milestone = false,
): Promise<Draw> {
  const w = await pickWinner(rows, blockhash, boxId);
  if (!w) throw new Error("nobody eligible for this box");
  return { boxId, slot, blockhash, seed: w.seed, winner: w.owner, tier: rollTier(w.seed, odds, milestone) };
}

// ---------- payout ----------

/** common pays in the fresh runner, everything bigger in the meta runner. */
export function prizeMint(tier: Tier, plan: BoxPlan): string {
  return tier === "common" ? plan.common.mint : plan.rare.mint;
}

/**
 * How much of the box and of the vault a tier takes. The final box takes everything.
 * A milestone box also takes `milestoneVaultPct` of the vault on top.
 */
export function prizeSplit(
  tier: Tier,
  bank: bigint,
  vault: bigint,
  final = false,
  milestoneVaultPct = 0,
): { fromBank: bigint; fromVault: bigint } {
  if (final) return { fromBank: bank, fromVault: vault };
  const t = TIERS.find((x) => x.key === tier)!;
  const vaultPct = Math.min(100, t.vaultPct + milestoneVaultPct);
  return { fromBank: (bank * BigInt(t.boxPct)) / 100n, fromVault: (vault * BigInt(vaultPct)) / 100n };
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

interface OrderResp {
  transaction?: string;
  requestId?: string;
  outAmount?: string;
  errorMessage?: string;
  router?: string;
}
interface ExecResp {
  status?: string;
  signature?: string;
  code?: number;
  error?: string;
  totalOutputAmount?: string;
}

/**
 * Quote only (no signing). Used for dry runs.
 * The input is always SOL and there is no parameter to change it: this bot can buy tokens, it cannot sell any.
 */
export async function quote(
  jupKey: string,
  outputMint: string,
  lamports: bigint,
  taker: string,
  receiver: string,
): Promise<OrderResp> {
  const qs = new URLSearchParams({
    inputMint: MINTS.SOL,
    outputMint,
    amount: lamports.toString(),
    taker,
    slippageBps: String(EXEC.slippageBps),
  });
  // jupiter rejects a receiver equal to the taker (the buyback buys into the box itself)
  if (receiver !== taker) qs.set("receiver", receiver);
  const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs}`, { headers: { "x-api-key": jupKey } });
  const body = await res.text();
  let json: OrderResp & { error?: string; errorCode?: number } = {};
  try {
    json = JSON.parse(body);
  } catch {
    /* not json, the raw body goes into the error below */
  }
  if (!res.ok || !json.transaction)
    throw new Error(
      `Jupiter order failed (${res.status}): ${json.errorMessage ?? json.error ?? body.slice(0, 300)}${json.errorCode ? ` [code ${json.errorCode}]` : ""}`,
    );
  return json;
}

/** Buys `outputMint` with `lamports` of SOL from the box and delivers it to `receiver`. */
export async function buyInto(
  jupKey: string,
  box: Keypair,
  outputMint: string,
  lamports: bigint,
  receiver: string,
  onSigned?: OnSigned,
): Promise<{ sig: string; outAmount: string; router?: string }> {
  const order = await quote(jupKey, outputMint, lamports, box.publicKey, receiver);
  const signed = await signSerializedTx(fromB64(order.transaction!), box);
  await onSigned?.(txSignature(signed));
  const res = await fetch("https://api.jup.ag/swap/v2/execute", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": jupKey },
    body: JSON.stringify({ signedTransaction: toB64(signed), requestId: order.requestId }),
  });
  const ex = (await res.json()) as ExecResp;
  if (ex.status !== "Success" || !ex.signature)
    throw new Error(`Jupiter execute failed: ${ex.error ?? JSON.stringify(ex).slice(0, 200)}`);
  return { sig: ex.signature, outAmount: ex.totalOutputAmount ?? order.outAmount ?? "?", router: order.router };
}

export async function sendSol(
  rpc: Rpc,
  box: Keypair,
  to: string,
  lamports: bigint,
  onSigned?: OnSigned,
): Promise<string> {
  const { blockhash } = await rpc.latestBlockhash();
  const tx = await buildTransferTx(box, [{ to, lamports }], blockhash);
  await onSigned?.(txSignature(tx));
  return rpc.sendAndConfirm(tx);
}

/** How much of the box balance goes into the prize. */
export async function prizeBudget(rpc: Rpc, box: Keypair): Promise<bigint> {
  const bal = await rpc.balance(box.publicKey);
  return bal > EXEC.keepInBoxLamports ? bal - EXEC.keepInBoxLamports : 0n;
}

export async function payout(
  rpc: Rpc,
  jupKey: string,
  box: Keypair,
  d: Draw,
  plan: BoxPlan,
  lamports: bigint,
  onSigned?: OnSigned,
  inSol = false, // fallback when the sealed coin cannot be bought any more
): Promise<{ sig: string; mint: string; amount: string }> {
  const mint = inSol ? MINTS.SOL : prizeMint(d.tier, plan);
  if (mint === MINTS.SOL)
    return { sig: await sendSol(rpc, box, d.winner, lamports, onSigned), mint, amount: lamports.toString() };
  const r = await buyInto(jupKey, box, mint, lamports, d.winner, onSigned);
  return { sig: r.sig, mint, amount: r.outAmount };
}

/** Burns the box's whole balance of `mint`. Returns null if there is nothing to burn. */
export async function burnAll(rpc: Rpc, box: Keypair, mint: string): Promise<{ sig: string; amount: string } | null> {
  let acc = null;
  for (let i = 0; i < 8 && !acc?.amount; i++) {
    acc = await rpc.tokenAccount(box.publicKey, mint);
    if (!acc?.amount) await new Promise((r) => setTimeout(r, 1500)); // a fresh buy can take a moment to show
  }
  if (!acc?.amount) return null;
  const { blockhash } = await rpc.latestBlockhash();
  const tx = await buildTx(box, [burnIx(acc.program, acc.address, mint, box.publicKey, acc.amount)], blockhash);
  return { sig: await rpc.sendAndConfirm(tx), amount: acc.amount.toString() };
}
