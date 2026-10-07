import { test } from "node:test";
import assert from "node:assert/strict";
import { b58decode, b58encode, buildTransferTx, keypairFromSecret, signSerializedTx } from "../src/solana.ts";
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

test("final box only after grace period and when fees dry up", () => {
  const H = 3_600_000;
  const now = Date.parse("2026-10-09T12:00:00Z");
  const launched = now - 30 * H;
  const busy = [{ at: now - H, lamports: "500000000" }];
  const dry = [
    { at: now - 10 * H, lamports: "500000000" },
    { at: now - H, lamports: "10000000" },
  ];
  assert.equal(shouldRunFinalBox(busy, launched, now), false);
  assert.equal(shouldRunFinalBox(dry, launched, now), true);
  assert.equal(shouldRunFinalBox([], now - 2 * H, now), false); // grace
});
