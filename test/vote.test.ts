import { test } from "node:test";
import assert from "node:assert/strict";
import { castVote, voteState, VOTE } from "../worker/vote.ts";

function kv() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}
const req = (ip: string, body?: unknown) =>
  new Request("https://x/api/vote", {
    method: body ? "POST" : "GET",
    headers: { "cf-connecting-ip": ip, "user-agent": "t" },
    body: body ? JSON.stringify(body) : undefined,
  });

test("vote: one vote per visitor, counted by choice", { skip: Date.now() >= VOTE.endsAt }, async () => {
  const k = kv();
  const a = await castVote(k as never, req("1.1.1.1", { choice: "boxes" }));
  assert.ok(!("error" in a));
  await castVote(k as never, req("1.1.1.1", { choice: "buyback" })); // second try is ignored
  await castVote(k as never, req("2.2.2.2", { choice: "buyback" }));
  const s = await voteState(k as never, req("1.1.1.1"));
  assert.deepEqual(s.counts, { boxes: 1, buyback: 1, keep: 0 });
  assert.equal(s.mine, "boxes");
  const bad = await castVote(k as never, req("3.3.3.3", { choice: "rug" }));
  assert.ok("error" in bad);
});

test("vote: under the minimum the dev keeps it, else the most votes win, ties go to the boxes", async () => {
  const { winner } = await import("../worker/vote.ts");
  assert.equal(winner({ boxes: 10, buyback: 12, keep: 0 }, 25), "keep");
  assert.equal(winner({ boxes: 14, buyback: 12, keep: 0 }, 25), "boxes");
  assert.equal(winner({ boxes: 10, buyback: 16, keep: 0 }, 25), "buyback");
  assert.equal(winner({ boxes: 5, buyback: 5, keep: 20 }, 25), "keep");
  assert.equal(winner({ boxes: 13, buyback: 13, keep: 0 }, 25), "boxes");
});
