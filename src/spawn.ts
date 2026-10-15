// The flywheel: every opened box launches its own coin on pump.fun from the dev wallet ($BOX38 for box #38).
// The dev wallet is the creator, so the bot claims that coin's creator fees with everything else,
// and every lamport of a box buys $PULLIT. No dev buy by default: a launch only costs the create tx.
// Guard rails: a minimum gap, a daily cap, and the wheel pauses when the last coin did not trade enough.

import { b58encode, readCompactU16, signSerializedTx, type Keypair, type Rpc } from "./solana.ts";

export const SPAWN = {
  minGapMin: 120, // at least 2 hours between two launches
  maxPerDay: 8, // at most 8 launches in any 24 hours
  minPrevVolumeUsd: 2_000, // the last coin must have traded this much (24h) before the next one launches
  minDevLamports: 50_000_000n, // the dev wallet keeps at least 0.05 SOL, a launch never eats into it
  priorityFeeSol: 0.0005,
  maxOutLamports: 30_000_000n, // a create tx may move at most 0.03 SOL out of the dev wallet (plus the dev buy)
  website: "https://pullit.fun",
  twitter: "https://x.com/Pullitbox",
};

export interface SpawnedCoin {
  boxId: number;
  mint: string;
  symbol: string;
  at: number;
  sig: string;
}
export interface SpawnState {
  coins: SpawnedCoin[];
  triedBox?: number; // last box a launch was decided for (launched or skipped), so each box is looked at once
}

export const coinName = (boxId: number) => `pullit box #${boxId}`;
export const coinSymbol = (boxId: number) => `BOX${boxId}`;
export const coinDescription = (boxId: number) =>
  `pullit box #${boxId} just opened. every fee this coin makes goes to $PULLIT: half of every box burns $PULLIT, the prize is $PULLIT too. pullit.fun`;

/** Why the box that just opened should NOT launch a coin, or null if it should. Pure, for tests. */
export function skipReason(
  s: SpawnState,
  boxId: number,
  now: number,
  prevVolumeUsd: number | null, // 24h volume of the last launched coin, null if unknown
): string | null {
  if (s.triedBox === boxId || s.coins.some((c) => c.boxId === boxId)) return "already decided";
  const last = s.coins.at(-1);
  if (last && now - last.at < SPAWN.minGapMin * 60_000) return "too soon after the last launch";
  if (s.coins.filter((c) => now - c.at < 86_400_000).length >= SPAWN.maxPerDay) return "daily cap reached";
  if (last && prevVolumeUsd != null && prevVolumeUsd < SPAWN.minPrevVolumeUsd)
    return `last coin $${last.symbol} only traded $${Math.round(prevVolumeUsd)}, the wheel waits`;
  return null;
}

/** A fresh keypair for the new mint (WebCrypto, extractable so the public key can be read). */
export async function newMintKeypair(): Promise<Keypair> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b58encode(pub), pub, key: kp.privateKey };
}

const OK_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", // pump fees
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // create a token account
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", // token metadata
]);
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const SYSTEM = "11111111111111111111111111111111";

/**
 * The create tx is built by PumpPortal and signed by the dev key, which also holds the dev bag.
 * Only pump's own programs and account setup are allowed; no token transfer, burn, approve or authority
 * change, and SOL sent straight out of the wallet is capped.
 */
export function checkCreateTx(tx: Uint8Array, maxOut: bigint): string | null {
  const [n, a] = readCompactU16(tx, 0);
  const m = tx.slice(a + n * 64);
  let p = (m[0]! & 0x80 ? 1 : 0) + 3;
  const [nk, k0] = readCompactU16(m, p);
  const keys = Array.from({ length: nk }, (_, i) => b58encode(m.slice(k0 + i * 32, k0 + (i + 1) * 32)));
  p = k0 + nk * 32 + 32;
  const [ni, i0] = readCompactU16(m, p);
  p = i0;
  let out = 0n;
  let pump = false;
  for (let i = 0; i < ni; i++) {
    const prog = keys[m[p++]!];
    const [na, a0] = readCompactU16(m, p);
    const [nd, d0] = readCompactU16(m, a0 + na);
    const data = m.slice(d0, d0 + nd);
    p = d0 + nd;
    if (!prog) return "program not in the static keys";
    if (prog === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P") pump = true;
    if (OK_PROGRAMS.has(prog)) continue;
    if (TOKEN_PROGRAMS.has(prog)) {
      if ([1, 9, 16, 17, 18].includes(data[0]!)) continue; // init, close, sync native
      return `token instruction ${data[0]} is not allowed`;
    }
    if (prog === SYSTEM) {
      const dv = new DataView(data.buffer, data.byteOffset);
      const kind = dv.getUint32(0, true);
      const lamports = data.length >= 12 ? dv.getBigUint64(4, true) : 0n;
      if (kind === 0 || kind === 2) {
        out += lamports;
        continue;
      }
      return `system instruction ${kind} is not allowed`;
    }
    return `unknown program ${prog}`;
  }
  if (!pump) return "no pump instruction in the tx";
  if (out > maxOut) return `tx moves ${out} lamports, more than ${maxOut}`;
  return null;
}

/** Uploads the image and metadata to pump's ipfs and launches the coin. Returns the mint and the tx. */
export async function launchCoin(
  rpc: Rpc,
  dev: Keypair,
  boxId: number,
  image: Uint8Array,
  devBuySol = 0,
): Promise<{ mint: string; sig: string }> {
  const form = new FormData();
  form.append("file", new Blob([image as Uint8Array<ArrayBuffer>], { type: "image/png" }), `box${boxId}.png`);
  form.append("name", coinName(boxId));
  form.append("symbol", coinSymbol(boxId));
  form.append("description", coinDescription(boxId));
  form.append("twitter", SPAWN.twitter);
  form.append("website", SPAWN.website);
  form.append("showName", "true");
  const up = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
  if (!up.ok) throw new Error(`pump ipfs ${up.status}: ${(await up.text()).slice(0, 200)}`);
  const meta = (await up.json()) as { metadataUri?: string };
  if (!meta.metadataUri) throw new Error("pump ipfs returned no metadataUri");

  const mint = await newMintKeypair();
  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: dev.publicKey,
      action: "create",
      tokenMetadata: { name: coinName(boxId), symbol: coinSymbol(boxId), uri: meta.metadataUri },
      mint: mint.publicKey,
      denominatedInSol: "true",
      amount: devBuySol,
      slippage: 10,
      priorityFee: SPAWN.priorityFeeSol,
      pool: "pump",
    }),
  });
  if (!res.ok) throw new Error(`PumpPortal create ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const unsigned = new Uint8Array(await res.arrayBuffer());
  const maxOut = SPAWN.maxOutLamports + BigInt(Math.round(devBuySol * 1.05 * 1e9));
  const bad = checkCreateTx(unsigned, maxOut);
  if (bad) throw new Error(`refused to sign the create tx: ${bad}`);
  const signed = await signSerializedTx(await signSerializedTx(unsigned, mint), dev);
  const sig = await rpc.sendAndConfirm(signed);
  return { mint: mint.publicKey, sig };
}

