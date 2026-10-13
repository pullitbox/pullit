// Fee pipeline: claim pump creator fees into the dev (creator) wallet,
// then split them on chain: BOX share to the box wallet, the rest to the team wallet.
// Also decides when the Final Box should run (fees dried up).

import {
  b58encode,
  buildTransferTx,
  fromB64,
  readCompactU16,
  signSerializedTx,
  txSignature,
  type Keypair,
  type Rpc,
} from "./solana.ts";

export const FEES = {
  boxSharePct: 80, // after the bond. the rest (20%) goes to the team wallet
  preBondBoxPct: 100, // before the bond: every lamport of fees goes to the box
  keepInDevLamports: 20_000_000n, // 0.02 SOL stays for tx fees
  minSplitLamports: 5_000_000n, // don't split dust, wait until 0.005 SOL accumulated
  priorityFeeSol: 0.0001, // claims kept dropping when the chain got busy at 0.00001
  // Final Box: if claimed fees over the window are below this, the box closes for good
  finalWindowHours: 6,
  finalMinLamports: 100_000_000n, // 0.1 SOL in 6h
  finalGraceHours: 12, // never trigger within the first 12h after launch
};

export interface FeeLedgerEntry {
  at: number;
  lamports: string;
  claimSig?: string;
  splitSig?: string;
}

/**
 * The dev wallet holds the dev bag, and the claim tx is built by PumpPortal, not by us. Before the dev
 * key signs it, every instruction is checked: only pump's own programs, compute budget, account
 * creation and unwrapping SOL. Anything that could move or burn tokens, or send SOL away, is refused,
 * so a bad or hacked API can never touch the bag. Program ids always sit in the static keys of a tx.
 */
const CLAIM_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // pump amm
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", // pump fees
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // create a token account
]);
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const SYSTEM = "11111111111111111111111111111111";

export function checkClaimTx(tx: Uint8Array): string | null {
  const [n, a] = readCompactU16(tx, 0);
  const m = tx.slice(a + n * 64);
  let p = m[0]! & 0x80 ? 1 : 0;
  p += 3;
  const [nk, k0] = readCompactU16(m, p);
  const keys = Array.from({ length: nk }, (_, i) => b58encode(m.slice(k0 + i * 32, k0 + (i + 1) * 32)));
  p = k0 + nk * 32 + 32; // keys, then the blockhash
  const [ni, i0] = readCompactU16(m, p);
  p = i0;
  for (let i = 0; i < ni; i++) {
    const prog = keys[m[p++]!];
    const [na, a0] = readCompactU16(m, p);
    const [nd, d0] = readCompactU16(m, a0 + na);
    const data = m.slice(d0, d0 + nd);
    p = d0 + nd;
    if (!prog) return "program not in the static keys";
    if (CLAIM_PROGRAMS.has(prog)) continue;
    // token programs: only init, close (unwrap) and sync native. no transfer, burn, approve, authority
    if (TOKEN_PROGRAMS.has(prog)) {
      if ([1, 9, 16, 17, 18].includes(data[0]!)) continue;
      return `token instruction ${data[0]} is not allowed`;
    }
    // system: only creating an account with rent-sized lamports, never a transfer
    if (prog === SYSTEM) {
      const kind = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
      const lamports = data.length >= 12 ? new DataView(data.buffer, data.byteOffset).getBigUint64(4, true) : 0n;
      if (kind === 0 && lamports <= 10_000_000n) continue;
      return `system instruction ${kind} is not allowed`;
    }
    return `unknown program ${prog}`;
  }
  return null;
}

/** Ask PumpPortal for an unsigned claim tx (claims all pump creator fees of this wallet). */
export async function claimPumpCreatorFees(rpc: Rpc, dev: Keypair): Promise<string | null> {
  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: dev.publicKey,
      action: "collectCreatorFee",
      priorityFee: FEES.priorityFeeSol,
      pool: "pump",
    }),
  });
  if (res.status !== 200) {
    const text = await res.text();
    // Nothing to claim is reported as an error by the API; treat it as a no-op
    if (/no.*fee|nothing|0 fees/i.test(text)) return null;
    throw new Error(`PumpPortal ${res.status}: ${text.slice(0, 200)}`);
  }
  const unsigned = new Uint8Array(await res.arrayBuffer());
  const bad = checkClaimTx(unsigned);
  if (bad) throw new Error(`refused to sign the claim tx: ${bad}`);
  const signed = await signSerializedTx(unsigned, dev);
  return rpc.sendAndConfirm(signed);
}

export interface Split {
  tx: Uint8Array;
  sig: string;
  totalLamports: bigint;
  boxLamports: bigint;
  teamLamports: bigint;
  kept: boolean; // the team share stays in the dev wallet
}

/**
 * How much SOL a claim tx brought into `wallet` (its balance change plus the tx fee it paid),
 * or null while the tx is not visible yet. Only this counts as fees: SOL that reaches the dev wallet
 * any other way (the dev's own money, a top-up, a sale) is never split.
 */
export async function claimedBy(rpc: Rpc, sig: string, wallet: string): Promise<bigint | null> {
  const t = await rpc.call<{
    meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[] };
    transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
  } | null>("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  if (!t) return null;
  if (t.meta.err) return 0n;
  const keys = t.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(wallet);
  if (i < 0) return 0n;
  const delta = BigInt(t.meta.postBalances[i]! - t.meta.preBalances[i]!) + (i === 0 ? BigInt(t.meta.fee) : 0n);
  return delta > 0n ? delta : 0n;
}

/**
 * Builds (does not send) the transfer of the box share of `amount` claimed fees. When the team
 * wallet is the dev wallet itself (or unset) the team share simply stays where it is.
 */
export async function buildSplit(
  rpc: Rpc,
  dev: Keypair,
  boxWallet: string,
  teamWallet: string,
  amount: bigint,
  boxPct = FEES.boxSharePct, // 100 before the bond: every lamport of fees goes to the box
): Promise<Split | null> {
  if (amount < FEES.minSplitLamports) return null;
  const bal = await rpc.balance(dev.publicKey);
  const room = bal - FEES.keepInDevLamports - 10_000n; // the dev wallet keeps its gas
  const total = amount < room ? amount : room;
  if (total < FEES.minSplitLamports) return null;
  const box = (total * BigInt(boxPct)) / 100n;
  const team = total - box;
  const kept = !teamWallet || teamWallet === dev.publicKey;
  const { blockhash } = await rpc.latestBlockhash();
  const tx = await buildTransferTx(
    dev,
    kept
      ? [{ to: boxWallet, lamports: box }]
      : [
          { to: boxWallet, lamports: box },
          { to: teamWallet, lamports: team },
        ],
    blockhash,
    true, // priority fee: splits were dropped when the chain got busy
  );
  return { tx, sig: txSignature(tx), totalLamports: total, boxLamports: box, teamLamports: team, kept };
}

/** True when the coin has been live long enough and fees over the window are below the floor. */
export function shouldRunFinalBox(ledger: FeeLedgerEntry[], launchedAt: number, now = Date.now()): boolean {
  if (now - launchedAt < FEES.finalGraceHours * 3_600_000) return false;
  const since = now - FEES.finalWindowHours * 3_600_000;
  const recent = ledger.filter((e) => e.at >= since).reduce((a, e) => a + BigInt(e.lamports), 0n);
  return recent < FEES.finalMinLamports;
}

export { fromB64 };
