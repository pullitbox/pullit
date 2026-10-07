// Tiny dependency-free Solana helpers (works in Node 22+ and Cloudflare Workers):
// base58, Ed25519 keys via WebCrypto, signing pre-built transactions,
// SOL transfers, and a few RPC calls.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bad base58 char ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c === "1") bytes.unshift(0);
    else break;
  }
  return new Uint8Array(bytes);
}

const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------- keys ----------

// PKCS#8 header for an Ed25519 private key; the 32-byte seed follows it
// prettier-ignore
const PKCS8_ED25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

export interface Keypair {
  publicKey: string;
  pub: Uint8Array;
  key: CryptoKey;
}

/** Accepts a base58 64-byte secret (Phantom export) or a JSON byte array (solana-keygen file). */
export async function keypairFromSecret(secret: string): Promise<Keypair> {
  const raw = secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : b58decode(secret.trim());
  if (raw.length !== 64) throw new Error(`secret key must be 64 bytes, got ${raw.length}`);
  const seed = raw.slice(0, 32);
  const pub = raw.slice(32);
  const pkcs8 = new Uint8Array([...PKCS8_ED25519, ...seed]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { publicKey: b58encode(pub), pub, key };
}

async function sign(kp: Keypair, msg: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.key, msg as Uint8Array<ArrayBuffer>));
}

// ---------- transaction bytes ----------

function compactU16(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

function readCompactU16(buf: Uint8Array, off: number): [number, number] {
  let val = 0,
    shift = 0,
    i = off;
  for (;;) {
    const b = buf[i++];
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val, i];
    shift += 7;
  }
}

/**
 * Signs a serialized (legacy or v0) transaction someone else built, e.g. PumpPortal or Jupiter.
 * Puts our signature into the slot that matches our pubkey among the required signers.
 */
export async function signSerializedTx(txBytes: Uint8Array, kp: Keypair): Promise<Uint8Array> {
  const [numSigs, sigStart] = readCompactU16(txBytes, 0);
  const msgStart = sigStart + numSigs * 64;
  const msg = txBytes.slice(msgStart);
  let p = 0;
  if (msg[0] & 0x80) p = 1; // versioned message prefix
  const numRequired = msg[p];
  p += 3; // header
  const [numKeys, keysStart] = readCompactU16(msg, p);
  let slot = -1;
  for (let i = 0; i < Math.min(numKeys, numRequired); i++) {
    const k = msg.slice(keysStart + i * 32, keysStart + (i + 1) * 32);
    if (k.every((b, j) => b === kp.pub[j])) {
      slot = i;
      break;
    }
  }
  if (slot < 0) throw new Error("our key is not a required signer of this transaction");
  const sig = await sign(kp, msg);
  const out = txBytes.slice();
  out.set(sig, sigStart + slot * 64);
  return out;
}

/** Legacy transaction: one sender, several SOL transfers. */
export async function buildTransferTx(
  from: Keypair,
  transfers: { to: string; lamports: bigint }[],
  recentBlockhash: string,
): Promise<Uint8Array> {
  const system = new Uint8Array(32);
  const keys = [from.pub, ...transfers.map((t) => b58decode(t.to)), system];
  const msg: number[] = [1, 0, 1, ...compactU16(keys.length)];
  for (const k of keys) msg.push(...k);
  msg.push(...b58decode(recentBlockhash));
  msg.push(...compactU16(transfers.length));
  transfers.forEach((t, i) => {
    const data = new Uint8Array(12);
    const dv = new DataView(data.buffer);
    dv.setUint32(0, 2, true); // SystemInstruction::Transfer
    dv.setBigUint64(4, t.lamports, true);
    msg.push(keys.length - 1, ...compactU16(2), 0, i + 1, ...compactU16(12), ...data);
  });
  const message = new Uint8Array(msg);
  const sig = await sign(from, message);
  return new Uint8Array([...compactU16(1), ...sig, ...message]);
}

export interface Instruction {
  programId: string;
  keys: { pubkey: string; signer: boolean; writable: boolean }[];
  data: Uint8Array;
}

/** Legacy transaction with any instructions, signed by `payer` (the only signer). */
export async function buildTx(payer: Keypair, ixs: Instruction[], recentBlockhash: string): Promise<Uint8Array> {
  // account order: signers first, then writable before read-only; programs last
  const meta = new Map<string, { signer: boolean; writable: boolean }>([
    [payer.publicKey, { signer: true, writable: true }],
  ]);
  for (const ix of ixs) {
    for (const k of ix.keys) {
      const m = meta.get(k.pubkey) ?? { signer: false, writable: false };
      meta.set(k.pubkey, { signer: m.signer || k.signer, writable: m.writable || k.writable });
    }
  }
  for (const ix of ixs) if (!meta.has(ix.programId)) meta.set(ix.programId, { signer: false, writable: false });
  const rank = (m: { signer: boolean; writable: boolean }) => (m.signer ? 0 : 2) + (m.writable ? 0 : 1);
  const keys = [...meta.entries()]
    .map(([k, m], i) => ({ k, m, i }))
    .sort((a, b) => (a.k === payer.publicKey ? -1 : b.k === payer.publicKey ? 1 : rank(a.m) - rank(b.m) || a.i - b.i));
  if (keys.some((x) => x.m.signer && x.k !== payer.publicKey)) throw new Error("only the payer can sign");
  const index = new Map(keys.map((x, i) => [x.k, i]));
  const readonlyUnsigned = keys.filter((x) => !x.m.signer && !x.m.writable).length;
  const msg: number[] = [1, 0, readonlyUnsigned, ...compactU16(keys.length)];
  for (const x of keys) msg.push(...b58decode(x.k));
  msg.push(...b58decode(recentBlockhash));
  msg.push(...compactU16(ixs.length));
  for (const ix of ixs) {
    msg.push(index.get(ix.programId)!, ...compactU16(ix.keys.length), ...ix.keys.map((k) => index.get(k.pubkey)!));
    msg.push(...compactU16(ix.data.length), ...ix.data);
  }
  const message = new Uint8Array(msg);
  return new Uint8Array([...compactU16(1), ...(await sign(payer, message)), ...message]);
}

/** SPL Token (and Token-2022) Burn: removes `amount` from `account` and from the mint supply. */
export function burnIx(
  tokenProgram: string,
  account: string,
  mint: string,
  owner: string,
  amount: bigint,
): Instruction {
  const data = new Uint8Array(9);
  data[0] = 8; // TokenInstruction::Burn, same index in both token programs
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: account, signer: false, writable: true },
      { pubkey: mint, signer: false, writable: true },
      { pubkey: owner, signer: true, writable: false },
    ],
    data,
  };
}

// ---------- RPC ----------

export class Rpc {
  private url: string;
  constructor(url: string) {
    this.url = url;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result as T;
  }

  async balance(pubkey: string): Promise<bigint> {
    const r = await this.call<{ value: number }>("getBalance", [pubkey, { commitment: "confirmed" }]);
    return BigInt(r.value);
  }

  async latestBlockhash(): Promise<{ blockhash: string; slot: number }> {
    const r = await this.call<{ context: { slot: number }; value: { blockhash: string } }>("getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    return { blockhash: r.value.blockhash, slot: r.context.slot };
  }

  async send(tx: Uint8Array): Promise<string> {
    return this.call<string>("sendTransaction", [
      toB64(tx),
      // the blockhash comes from a "confirmed" read; the preflight must use the same level, or a fresh
      // blockhash is "not found" by a simulation that only looks at finalized blocks
      { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 },
    ]);
  }

  /** Waits until confirmed; throws if the transaction failed. */
  async confirm(sig: string, timeoutMs = 60_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const r = await this.call<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(
        "getSignatureStatuses",
        [[sig], { searchTransactionHistory: false }],
      );
      const s = r.value[0];
      if (s?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.err)}`);
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`tx ${sig} not confirmed in time`);
  }

  /** The token account `owner` holds for `mint`, with its program and raw balance, or null. */
  async tokenAccount(
    owner: string,
    mint: string,
  ): Promise<{ address: string; program: string; amount: bigint } | null> {
    const r = await this.call<{
      value: {
        pubkey: string;
        account: { owner: string; data: { parsed: { info: { tokenAmount: { amount: string } } } } };
      }[];
    }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const a = r.value[0];
    if (!a) return null;
    return {
      address: a.pubkey,
      program: a.account.owner,
      amount: BigInt(a.account.data.parsed.info.tokenAmount.amount),
    };
  }

  /** "landed", "failed" or "unknown" (not seen, may still land until its blockhash expires). */
  async signatureStatus(sig: string): Promise<"landed" | "failed" | "unknown"> {
    const r = await this.call<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(
      "getSignatureStatuses",
      [[sig], { searchTransactionHistory: true }],
    );
    const s = r.value[0];
    if (!s) return "unknown";
    if (s.err) return "failed";
    return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "landed" : "unknown";
  }

  async sendAndConfirm(tx: Uint8Array): Promise<string> {
    const sig = await this.send(tx);
    await this.confirm(sig);
    return sig;
  }
}

/** The fee payer's signature of a signed transaction, i.e. its id on chain. Known before it is sent. */
export function txSignature(tx: Uint8Array): string {
  const [, start] = readCompactU16(tx, 0);
  return b58encode(tx.slice(start, start + 64));
}

export { toB64, fromB64 };
export const LAMPORTS = 1_000_000_000n;
