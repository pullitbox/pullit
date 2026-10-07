// Fee pipeline: claim pump creator fees into the dev (creator) wallet,
// then split them on chain: BOX share to the box wallet, the rest to the team wallet.
// Also decides when the Final Box should run (fees dried up).

import { buildTransferTx, fromB64, signSerializedTx, type Keypair, type Rpc } from "./solana.ts";

export const FEES = {
  boxSharePct: 80, // the rest (20%) goes to the team wallet
  keepInDevLamports: 20_000_000n, // 0.02 SOL stays for tx fees
  minSplitLamports: 50_000_000n, // don't split dust, wait until 0.05 SOL accumulated
  priorityFeeSol: 0.00001,
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
  const signed = await signSerializedTx(unsigned, dev);
  return rpc.sendAndConfirm(signed);
}

export interface SplitResult {
  totalLamports: bigint;
  boxLamports: bigint;
  teamLamports: bigint;
  sig: string;
}

/** Moves everything above the gas reserve out of the dev wallet: box share + team share. */
export async function splitFees(
  rpc: Rpc,
  dev: Keypair,
  boxWallet: string,
  teamWallet: string,
): Promise<SplitResult | null> {
  const bal = await rpc.balance(dev.publicKey);
  const available = bal - FEES.keepInDevLamports - 10_000n; // minus tx fee
  if (available < FEES.minSplitLamports) return null;
  const box = (available * BigInt(FEES.boxSharePct)) / 100n;
  const team = available - box;
  const { blockhash } = await rpc.latestBlockhash();
  const tx = await buildTransferTx(
    dev,
    [
      { to: boxWallet, lamports: box },
      { to: teamWallet, lamports: team },
    ],
    blockhash,
  );
  const sig = await rpc.sendAndConfirm(tx);
  return { totalLamports: available, boxLamports: box, teamLamports: team, sig };
}

/** True when the coin has been live long enough and fees over the window are below the floor. */
export function shouldRunFinalBox(ledger: FeeLedgerEntry[], launchedAt: number, now = Date.now()): boolean {
  if (now - launchedAt < FEES.finalGraceHours * 3_600_000) return false;
  const since = now - FEES.finalWindowHours * 3_600_000;
  const recent = ledger.filter((e) => e.at >= since).reduce((a, e) => a + BigInt(e.lamports), 0n);
  return recent < FEES.finalMinLamports;
}

export { fromB64 };
