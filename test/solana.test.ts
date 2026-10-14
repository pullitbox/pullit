import { test } from "node:test";
import assert from "node:assert/strict";
import {
  b58decode,
  b58encode,
  buildTransferTx,
  buildTx,
  burnIx,
  keypairFromSecret,
  signSerializedTx,
} from "../src/solana.ts";
import { shouldRunFinalBox } from "../src/fees.ts";

async function newKeypairSecret(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return b58encode(new Uint8Array([...pkcs8.slice(-32), ...raw]));
}

test("base58 roundtrip incl. leading zeros", () => {
  const bytes = new Uint8Array([0, 0, 1, 2, 255, 128]);
  assert.deepEqual(b58decode(b58encode(bytes)), bytes);
  assert.equal(b58encode(new Uint8Array(32)), "11111111111111111111111111111111"); // system program
});

test("keypair import and transfer tx is validly signed", async () => {
  const secret = await newKeypairSecret();
  const kp = await keypairFromSecret(secret);
  const to = await keypairFromSecret(await newKeypairSecret());
  const tx = await buildTransferTx(kp, [{ to: to.publicKey, lamports: 1234n }], "11111111111111111111111111111111");
  assert.equal(tx[0], 1);
  const sig = tx.slice(1, 65);
  const msg = tx.slice(65);
  const pubKey = await crypto.subtle.importKey("raw", kp.pub as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, [
    "verify",
  ]);
  assert.ok(
    await crypto.subtle.verify(
      { name: "Ed25519" },
      pubKey,
      sig as Uint8Array<ArrayBuffer>,
      msg as Uint8Array<ArrayBuffer>,
    ),
  );
  // header + 3 keys (from, to, system)
  assert.deepEqual([...msg.slice(0, 4)], [1, 0, 1, 3]);
});

test("signSerializedTx fills the right slot of a foreign tx", async () => {
  const kp = await keypairFromSecret(await newKeypairSecret());
  const to = await keypairFromSecret(await newKeypairSecret());
  const built = await buildTransferTx(kp, [{ to: to.publicKey, lamports: 1n }], "11111111111111111111111111111111");
  const blank = built.slice();
  blank.fill(0, 1, 65); // wipe signature like an unsigned tx from an API
  const resigned = await signSerializedTx(blank, kp);
  assert.deepEqual(resigned, built); // Ed25519 is deterministic
});

test("final box is off: a dry night never closes the box", () => {
  const H = 3_600_000;
  const now = Date.parse("2026-10-09T12:00:00Z");
  const launched = now - 30 * H;
  const busy = [{ at: now - H, lamports: "500000000" }];
  const dry = [
    { at: now - 10 * H, lamports: "500000000" },
    { at: now - H, lamports: "10000000" },
  ];
  assert.equal(shouldRunFinalBox(busy, launched, now), false);
  assert.equal(shouldRunFinalBox(dry, launched, now), false); // finalBox: false
  assert.equal(shouldRunFinalBox([], now - 2 * H, now), false); // grace
});

test("the generic tx builder makes the same bytes as the transfer builder", async () => {
  const kp = await keypairFromSecret(await newKeypairSecret());
  const to = (await keypairFromSecret(await newKeypairSecret())).publicKey;
  const bh = "11111111111111111111111111111111";
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, 777n, true);
  const ix = {
    programId: "11111111111111111111111111111111",
    keys: [
      { pubkey: kp.publicKey, signer: true, writable: true },
      { pubkey: to, signer: false, writable: true },
    ],
    data,
  };
  assert.deepEqual(await buildTx(kp, [ix], bh), await buildTransferTx(kp, [{ to, lamports: 777n }], bh));
});

test("burn instruction: index 8, amount little endian, owner signs", () => {
  const ix = burnIx("TokenProgram", "Acc", "Mint", "Owner", 258n);
  assert.deepEqual([...ix.data], [8, 2, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey, k.signer, k.writable]),
    [
      ["Acc", false, true],
      ["Mint", false, true],
      ["Owner", true, false],
    ],
  );
});

test("a signed tx knows its own id before it is sent", async () => {
  const { txSignature } = await import("../src/solana.ts");
  const kp = await keypairFromSecret(await newKeypairSecret());
  const tx = await buildTransferTx(kp, [{ to: kp.publicKey, lamports: 1n }], "11111111111111111111111111111111");
  assert.equal(b58decode(txSignature(tx)).length, 64);
  assert.deepEqual(b58decode(txSignature(tx)), tx.slice(1, 65));
});

test("split: only claimed fees are split, capped by what the dev wallet holds", async () => {
  const { buildSplit } = await import("../src/fees.ts");
  const dev = await keypairFromSecret(await newKeypairSecret());
  const box = (await keypairFromSecret(await newKeypairSecret())).publicKey;
  let bal = 0n;
  const rpc = {
    balance: async () => bal,
    latestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111" }),
  } as never;
  // 5 SOL of the dev's own money, nothing claimed: nothing moves
  bal = 5_000_000_000n;
  assert.equal(await buildSplit(rpc, dev, box, dev.publicKey, 0n), null);
  // 1 SOL claimed: all of it to the box, the dev's 5 SOL are not touched
  const r = await buildSplit(rpc, dev, box, dev.publicKey, 1_000_000_000n);
  assert.ok(r && r.kept);
  assert.equal(r.totalLamports, 1_000_000_000n);
  assert.equal(r.boxLamports, 1_000_000_000n);
  assert.equal(r.sig.length > 40, true);
  // the dev took almost everything out: the split is capped by what is left above the gas reserve
  bal = 100_000_000n;
  const c = await buildSplit(rpc, dev, box, dev.publicKey, 1_000_000_000n);
  assert.equal(c?.totalLamports, 100_000_000n - 20_000_000n - 10_000n);
});

test("claim tx check: pump claims pass, anything that moves the dev bag or its SOL is refused", async () => {
  const { checkClaimTx } = await import("../src/fees.ts");
  const dev = await keypairFromSecret(await newKeypairSecret());
  const other = (await keypairFromSecret(await newKeypairSecret())).publicKey;
  const bh = "11111111111111111111111111111111";
  const ix = (programId: string, data: number[]) => ({
    programId,
    keys: [{ pubkey: dev.publicKey, signer: true, writable: true }],
    data: new Uint8Array(data),
  });
  const claim = await buildTx(
    dev,
    [
      ix("ComputeBudget111111111111111111111111111111", [3, 0, 0, 0, 0]),
      ix("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", [1, 2, 3]),
    ],
    bh,
  );
  assert.equal(checkClaimTx(claim), null);
  // spl token transfer (3) or burn (8) of the dev bag
  for (const tag of [3, 8, 12, 4, 6])
    assert.match(
      checkClaimTx(
        await buildTx(dev, [ix("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", [tag, 0, 0, 0, 0, 0, 0, 0, 0])], bh),
      ) ?? "",
      /not allowed/,
    );
  // a SOL transfer away from the dev wallet
  assert.match(
    checkClaimTx(await buildTransferTx(dev, [{ to: other, lamports: 5_000_000_000n }], bh)) ?? "",
    /not allowed/,
  );
  // a program nobody vetted
  assert.match(checkClaimTx(await buildTx(dev, [ix(other, [0])], bh)) ?? "", /unknown program/);
  // unwrapping SOL after a claim is fine
  assert.equal(checkClaimTx(await buildTx(dev, [ix("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", [9])], bh)), null);
});
