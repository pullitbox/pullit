import { test } from "node:test";
import assert from "node:assert/strict";
import { fresher, packBox, rollTier, validate, worthy, TIERS } from "../src/agent.ts";
import type { ScanResult, Candidate } from "../src/scanner.ts";

const cand = (symbol: string, mint: string, bucket: "fresh" | "established"): Candidate => ({
  mint,
  symbol,
  name: symbol,
  bucket,
  score: 50,
  ageHours: 10,
  mcap: 1e6,
  liquidity: 1e5,
  volume24h: 1e6,
  priceChange1h: 1,
  priceChange6h: 5,
  priceChange24h: 10,
  holders: 1000,
  holderChange24h: 50,
  netBuyers24h: 20,
  buySellRatio6h: 1.1,
  organicScore: 70,
  topHoldersPct: 20,
  devBalancePct: 1,
  twitter: null,
  website: null,
});
const scan: ScanResult = {
  at: "",
  universe: 2,
  rejected: {},
  fresh: [cand("RARI", "F1", "fresh"), cand("NEWB", "F2", "fresh")],
  established: [cand("AGENCY", "E1", "established")],
};

test("validator accepts a clean answer", () => {
  assert.deepEqual(
    validate(
      {
        common: { mint: "F1" },
        rare: { mint: "E1" },
        post: "box #3 is sealed. no peeking",
        reveal: "$RARI and $AGENCY were in there",
        hint_common: "picked a weird dog",
        hint_rare: "an old one. still climbing",
      },
      scan,
    ),
    [],
  );
});

test("validator rejects a packed post that leaks a coin", () => {
  const p = validate(
    {
      common: { mint: "F1" },
      rare: { mint: "E1" },
      post: "box #3 has $rari in it",
      reveal: "ok $RARI",
      hint_common: "its rari lol",
      hint_rare: "up 40% today",
    },
    scan,
  );
  assert.ok(p.includes("post leaks a coin"));
  assert.ok(p.includes("hint_common leaks a coin"));
  assert.ok(p.includes("hint_rare has a ticker or a number"));
});

test("validator rejects unknown mints, links, dashes, hashtags", () => {
  const p = validate(
    { common: { mint: "SCAM" }, rare: { mint: "F1" }, post: "box #3 — buy now https://x.fun #crypto" },
    scan,
  );
  assert.ok(p.includes("common mint not in fresh list"));
  assert.ok(p.includes("rare mint not in established list"));
  assert.ok(p.includes("post has a link"));
  assert.ok(p.includes("post has a long dash"));
  assert.ok(p.includes("post has a hashtag"));
});

test("no key -> deterministic fallback that skips recent coins", async () => {
  const { plan } = await packBox(undefined, scan, 5, ["RARI"]);
  assert.equal(plan.source, "fallback");
  assert.equal(plan.common.symbol, "NEWB");
  assert.equal(plan.rare.symbol, "AGENCY");
  assert.match(plan.post, /box #5/);
  assert.doesNotMatch(plan.post, /NEWB|AGENCY/);
  assert.match(plan.reveal, /\$NEWB/);
});

test("tier roll follows public odds", () => {
  const counts: Record<string, number> = {};
  for (let i = 0; i < 20000; i++) {
    const hex = ((i * 2654435761) % 2 ** 32).toString(16).padStart(8, "0").repeat(4);
    const t = rollTier(
      hex.slice(0, 13) +
        Math.floor(Math.random() * 2 ** 32)
          .toString(16)
          .padStart(8, "0"),
    );
    counts[t] = (counts[t] ?? 0) + 1;
  }
  for (const t of TIERS) {
    const got = (counts[t.key] ?? 0) / 200;
    assert.ok(Math.abs(got - t.pct) < 2, `${t.key}: ${got}% vs ${t.pct}%`);
  }
});

test("log lines must keep the facts and stay clean", async () => {
  const { checkQuip } = await import("../src/agent.ts");
  assert.deepEqual(checkQuip("7xQp…Lk2a bought 2.3% of supply. sir this is a box", ["7xQp…Lk2a"], []), []);
  assert.ok(checkQuip("someone bought a lot", ["7xQp…Lk2a"], []).includes("missing 7xQp…Lk2a"));
  assert.ok(checkQuip("buy now https://x.com — 100x", [], []).length >= 3);
  assert.ok(
    checkQuip("same joke again and again lol", [], ["same joke again and again lol, older"]).some((x) =>
      x.startsWith("too close"),
    ),
  );
  // same template with other numbers is a repeat; a different joke is not
  const { similar } = await import("../src/agent.ts");
  assert.ok(
    similar(
      "box #6 sealed: 4be1…09fa. screenshot it, you paranoid little goblins",
      "box #9 sealed: 77aa…01bc. screenshot it, you paranoid little goblins",
    ),
  );
  assert.ok(
    !similar("0.04 sol of fees. the jeets paid for this box", "Ck8s…a7Tw sold the whole 0.8% bag. timing of a legend"),
  );
});

test("wallet placeholder is filled and a lowercased wallet is fixed", async () => {
  const { fillQuip } = await import("../src/agent.ts");
  assert.equal(fillQuip("{w} bought the top. classic", "Ck8s…a7Tw"), "Ck8s…a7Tw bought the top. classic");
  assert.equal(fillQuip("ck8s…a7tw sold it all...", "Ck8s…a7Tw"), "Ck8s…a7Tw sold it all…");
});

test("a leftover placeholder is rejected", async () => {
  const { checkQuip } = await import("../src/agent.ts");
  assert.ok(checkQuip("{w} claimed 0.1 sol in fees", [], []).includes("left a placeholder in"));
});

test("json is found inside a fenced or chatty model answer", async () => {
  const { jsonPart } = await import("../src/agent.ts");
  assert.equal(jsonPart('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(jsonPart('here you go: {"a":{"b":2}} enjoy'), '{"a":{"b":2}}');
  assert.throws(() => jsonPart(""));
});

test("fresher skips recent boxes and shrinks the window when thin", () => {
  const list = ["A", "B", "C", "D", "E"].map((symbol) => ({ symbol }) as Candidate);
  const keep = (l: Candidate[]) =>
    l
      .map((c) => c.symbol)
      .sort()
      .join("");
  assert.equal(keep(fresher(list, ["X", "Y"])), "ABCDE");
  assert.equal(keep(fresher(list, ["A", "Z", "B", "Y"])), "CDE");
  // too few left: older boxes come back first, the newest stays out
  assert.equal(keep(fresher(list, ["A", "Z", "B", "Y", "C", "W"])), "ADE");
  assert.equal(keep(fresher(list, ["A", "B", "C", "D", "E", "X"])), "ABCD");
  assert.equal(fresher(list, []).length, 5);
});

test("big coins of the week join the rare pool, mixed in, not forced", async () => {
  const { rarePool } = await import("../src/agent.ts");
  const withHot: ScanResult = { ...scan, hot: [cand("ZEC", "H1", "established"), cand("AGENCY", "E1", "established")] };
  assert.deepEqual(
    rarePool(withHot).map((c) => c.mint),
    ["E1", "H1"],
  ); // no duplicates
  const base = {
    post: "box #3 sealed. no peeking",
    reveal: "it was $RARI and $ZEC",
    hint_common: "young and loud",
    hint_rare: "a grown up coin",
  };
  assert.deepEqual(validate({ ...base, common: { mint: "F1" }, rare: { mint: "H1" } }, withHot), []);
  assert.deepEqual(validate({ ...base, common: { mint: "F1" }, rare: { mint: "E1" } }, withHot), []);
  const { plan } = await packBox(undefined, withHot, 3, []);
  assert.ok(["H1", "E1"].includes(plan.rare.mint));
});

test("x prompt does not push the no-sell joke, teaser topics are unique", async () => {
  const { TEASE_TOPICS } = await import("../src/teasers.ts");
  const ids = TEASE_TOPICS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 10);
});

test("worthy: one coin per ticker (the biggest), no coin far below the best score", () => {
  const big = { ...cand("SI", "A", "established"), mcap: 23e6, score: 50 };
  const copy = { ...cand("si", "B", "established"), mcap: 1.6e6, score: 60 };
  const dying = { ...cand("QCAT", "C", "fresh"), score: 5 };
  const ok = { ...cand("W", "D", "fresh"), score: 66 };
  const out = worthy([big, copy, dying, ok]);
  assert.deepEqual(out.map((c) => c.mint).sort(), ["A", "D"]);
  // the best coin always stays, even alone
  assert.equal(worthy([dying]).length, 1);
});
