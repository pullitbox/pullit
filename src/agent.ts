// The box agent: an LLM (via OpenRouter) packs each box from the scanner's candidates
// and writes the post. Everything it returns is checked by validate() in code; anything
// invalid falls back to a deterministic pick, so a bad model answer can never move funds
// to a token outside the scanner's safe lists.

import type { Candidate, ScanResult } from "./scanner.ts";

export const AGENT = {
  model: "anthropic/claude-sonnet-5.5",
  timeoutMs: 45_000,
  maxPostChars: 200,
};

// Public odds. The tier is rolled from the blockhash seed, not by the AI.
// The tier decides how big the prize is: a share of the box (the rest rolls into the next box),
// and for secret also a share of the vault. Prizes are paid in the coins the AI sealed in the box.
export const TIERS = [
  { key: "common", pct: 50, boxPct: 50, vaultPct: 0, asset: "fresh runner" },
  { key: "rare", pct: 30, boxPct: 75, vaultPct: 0, asset: "meta runner" },
  { key: "epic", pct: 15, boxPct: 100, vaultPct: 0, asset: "meta runner" },
  { key: "secret", pct: 5, boxPct: 100, vaultPct: 25, asset: "meta runner" },
] as const;
export type Tier = (typeof TIERS)[number]["key"];

export interface BoxPlan {
  boxId: number;
  common: { mint: string; symbol: string; why: string };
  rare: { mint: string; symbol: string; why: string };
  post: string; // "box packed" announcement: no links and no coin names (the box is sealed)
  reveal: string; // one line about the coins, posted when the box opens
  hints: { common: string; rare: string }; // shown on the site log while sealed: a joke about the pick, never the coin itself
  source: "ai" | "fallback";
}

const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}m` : `$${Math.round(v / 1e3)}k`);

function brief(c: Candidate): string {
  return `${c.symbol} | mint ${c.mint} | age ${Math.round(c.ageHours)}h | mcap ${usd(c.mcap)} | vol24h ${usd(c.volume24h)} | 6h ${Math.round(c.priceChange6h)}% | 24h ${Math.round(c.priceChange24h)}% | holders ${c.holders} (+${c.holderChange24h}) | organic ${Math.round(c.organicScore)} | score ${c.score}`;
}

const SYSTEM = `You are pullit, a small pink pixel gift box that lives on Solana. Trading fees of $PULLIT fill you up. When you are full you pack yourself with one coin per tier and a random holder opens you.

Your job right now: pick what goes in the box, from the lists given, and write two short lines.
The box is SEALED until a future block opens it: nobody may know the coins before that.
- common = one coin from FRESH runners (new, gaining)
- rare = one coin from ESTABLISHED runners (current meta, not old dinosaurs)
Pick what you would actually want to pull: real momentum, healthy holders, not just the biggest number. Avoid the coins from the last boxes if there is a good alternative.

Your voice: a deadpan, slightly mean little box. You know you are cardboard. You roast traders, devs, paper hands, chart watchers and yourself, like a friend who is funny in the group chat. Each line has ONE joke that lands: a sharp observation, a dumb comparison, a mild insult. Never forced, never cringe, never explain the joke, never punch at anything real and serious (no politics, no tragedies, no real people by name).

"post" is published now, while the box is sealed:
- must mention the box number, must NOT name or hint at either coin
- tease that you are full and sealed, joke about being a box that cannot peek, about the wait, about the block

"hint_common" and "hint_rare" go on the public log right away, one per pick:
- a dumb little joke about what you just picked and why, like you are telling friends about it. one thought, max 110 characters, no metaphors or role play
- NEVER the ticker, the name, a $ sign, or any number. describe the vibe, not the coin
- e.g. "picked some weird dog. looks nervous. holders keep showing up so i trust it more than you"
- e.g. "the rare one has survived longer than your last 5 trades combined. respect"
- e.g. "found a fresh one where the dev actually sold nothing yet. suspicious. i took it anyway"

"reveal" is published after the block opens the box:
- names both coins as $TICKER, one small joke about them (their name, vibe or chart)

Rules for both (strict):
- lowercase, max 200 characters each, reads like a person typing on their phone
- vary the format, do not always start with "box #N packed"
- no links, no hashtags, no em dashes, at most one emoji (usually none)
- no marketing words, no "let's go", no "excited", no "lfg", no "wagmi"
- never promise profit or price moves, never tell people to buy

Examples of the vibe (do not copy them, write new ones):
post: "box #4 is full and taped shut. i know whats inside and im not telling. a block does that in about 20 seconds"
post: "sealed box #7. something in here keeps moving"
reveal: "i was carrying $RARI and $AGENCY the whole time. felt heavier and slightly smarter"
reveal: "$phubber was in there. it has not looked up from its phone once. $baton too"

Reply with JSON only:
{"common":{"mint":"...","why":"few words"},"rare":{"mint":"...","why":"few words"},"post":"...","reveal":"...","hint_common":"...","hint_rare":"..."}`;

export function buildPrompt(scan: ScanResult, boxId: number, recentSymbols: string[]): string {
  return [
    `box number: ${boxId}`,
    `recent boxes used: ${recentSymbols.join(", ") || "none"}`,
    "",
    "FRESH runners:",
    ...scan.fresh.map(brief),
    "",
    "ESTABLISHED runners:",
    ...scan.established.map(brief),
  ].join("\n");
}

/** The JSON object inside a model answer, even if it is wrapped in a code fence or a sentence. */
export function jsonPart(text: string): string {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`no json in the answer (${text.length} chars)`);
  return text.slice(a, b + 1);
}

export async function askModel(apiKey: string, user: string, model = AGENT.model): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), AGENT.timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.95,
        max_tokens: 1500, // two mints are ~60 tokens each; 400 cut the json off mid-way
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
      }),
    });
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message: string } };
    if (!res.ok || json.error) throw new Error(`OpenRouter ${res.status}: ${json.error?.message ?? "no body"}`);
    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(t);
  }
}

/** Strict checks. Returns a list of problems; empty means OK. */
export function validate(raw: unknown, scan: ScanResult): string[] {
  const p: string[] = [];
  const o = raw as {
    common?: { mint?: string };
    rare?: { mint?: string };
    post?: string;
    reveal?: string;
    hint_common?: string;
    hint_rare?: string;
  };
  if (!o || typeof o !== "object") return ["not an object"];
  const c = scan.fresh.find((x) => x.mint === o.common?.mint);
  const r = scan.established.find((x) => x.mint === o.rare?.mint);
  if (!c) p.push("common mint not in fresh list");
  if (!r) p.push("rare mint not in established list");
  const check = (name: string, text: string) => {
    if (!text.trim()) p.push(`empty ${name}`);
    if (text.length > AGENT.maxPostChars) p.push(`${name} too long`);
    if (/https?:\/\/|www\.|\.(fun|com|xyz|io)\b/i.test(text)) p.push(`${name} has a link`);
    if (/[—–]/.test(text)) p.push(`${name} has a long dash`);
    if (/#\w/.test(text.replace(/#\d+/g, ""))) p.push(`${name} has a hashtag`);
    if (/guarantee|100x|moon|not financial advice|let'?s go|excited/i.test(text)) p.push(`${name} has banned phrasing`);
  };
  check("post", o.post ?? "");
  check("reveal", o.reveal ?? "");
  check("hint_common", o.hint_common ?? "");
  check("hint_rare", o.hint_rare ?? "");
  // the box is sealed: nothing published before the draw may leak what is inside
  for (const [name, text] of [
    ["post", o.post],
    ["hint_common", o.hint_common],
    ["hint_rare", o.hint_rare],
  ] as const) {
    const t = (text ?? "").toLowerCase();
    for (const x of [c, r]) {
      if (!x) continue;
      const words = [x.symbol, x.mint, x.name].filter((w) => w && w.length >= 3).map((w) => w.toLowerCase());
      if (words.some((w) => t.includes(w))) p.push(`${name} leaks a coin`);
    }
    if (name !== "post" && /\$|\d/.test(t)) p.push(`${name} has a ticker or a number`);
  }
  return p;
}

function fallback(scan: ScanResult, boxId: number, recent: string[]): BoxPlan {
  const pick = (list: Candidate[]) => {
    const ok = [...list]
      .sort((a, b) => b.score - a.score)
      .filter((c) => !recent.includes(c.symbol))
      .slice(0, 4);
    return ok.length ? ok[Math.floor(Math.random() * ok.length)] : list[0];
  };
  const c = pick(scan.fresh);
  const r = pick(scan.established);
  return {
    boxId,
    common: { mint: c.mint, symbol: c.symbol, why: "top score" },
    rare: { mint: r.mint, symbol: r.symbol, why: "top score" },
    post: `box #${boxId} is full and sealed. a block opens it in about 20 seconds`,
    reveal: `inside were $${c.symbol} and $${r.symbol}`,
    hints: {
      common: "picked something young and loud. buyers keep showing up. thats all youre getting",
      rare: "the rare one has been around a while. still standing. respect",
    },
    source: "fallback",
  };
}

/**
 * Variety: coins from recent boxes are taken out. `recent` is oldest first. When a bucket is thin,
 * the window shrinks from the oldest side, so the last boxes are still skipped even then.
 * The rest is shuffled so the model does not just take whatever is listed first.
 */
export function fresher(list: Candidate[], recent: string[], min = 3, rnd = Math.random): Candidate[] {
  let left = list;
  for (let from = 0; from <= recent.length; from += 2) {
    const skip = recent.slice(from);
    left = list.filter((c) => !skip.includes(c.symbol));
    // the last box is always skipped when anything else is left
    if (left.length >= (skip.length <= 2 ? 1 : min)) break;
  }
  const out = [...(left.length ? left : list)];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Packs a box. Never throws on model problems: falls back to the top-scored safe picks. */
export async function packBox(
  apiKey: string | undefined,
  scan: ScanResult,
  boxId: number,
  recentSymbols: string[] = [],
  model?: string,
): Promise<{ plan: BoxPlan; problems: string[] }> {
  if (scan.fresh.length === 0 || scan.established.length === 0) throw new Error("scanner returned an empty bucket");
  scan = { ...scan, fresh: fresher(scan.fresh, recentSymbols), established: fresher(scan.established, recentSymbols) };
  if (!apiKey) return { plan: fallback(scan, boxId, recentSymbols), problems: ["no OPENROUTER_API_KEY"] };
  let problems: string[] = [];
  try {
    const text = await askModel(apiKey, buildPrompt(scan, boxId, recentSymbols), model);
    const raw = JSON.parse(jsonPart(text));
    problems = validate(raw, scan);
    if (problems.length === 0) {
      const c = scan.fresh.find((x) => x.mint === raw.common.mint)!;
      const r = scan.established.find((x) => x.mint === raw.rare.mint)!;
      return {
        plan: {
          boxId,
          common: { mint: c.mint, symbol: c.symbol, why: String(raw.common.why ?? "").slice(0, 80) },
          rare: { mint: r.mint, symbol: r.symbol, why: String(raw.rare.why ?? "").slice(0, 80) },
          post: raw.post.trim(),
          reveal: raw.reveal.trim(),
          hints: { common: raw.hint_common.trim(), rare: raw.hint_rare.trim() },
          source: "ai",
        },
        problems,
      };
    }
  } catch (e) {
    problems = [`model error: ${(e as Error).message}`];
  }
  return { plan: fallback(scan, boxId, recentSymbols), problems };
}

/** Rolls the tier from a hex seed (sha256 of blockhash + box id). Public and reproducible. */
/**
 * The tier from the draw seed. `odds` are the percentages for common, rare, epic, secret that were
 * locked when the box was sealed (frenzy changes them). A milestone box is epic or better.
 */
export function rollTier(seedHex: string, odds: readonly number[] = TIERS.map((t) => t.pct), milestone = false): Tier {
  const n = parseInt(seedHex.slice(13, 21), 16) % 100; // different bits than the winner pick
  let acc = 0;
  let tier: Tier = "common";
  for (let i = 0; i < TIERS.length; i++) {
    acc += odds[i];
    if (n < acc) {
      tier = TIERS[i].key;
      break;
    }
  }
  if (milestone && (tier === "common" || tier === "rare")) return "epic";
  return tier;
}

// ---------- one-liners for the site log ----------

const QUIP_SYSTEM = `You are pullit, a pink pixel gift box on Solana. Holders of $PULLIT win prizes from you. You write the live log on your website.
You talk like a crypto twitter degen: short, dry, a bit mean, funny. You know the trenches: jeets, paper hands, exit liquidity, kols, snipers, bundles, rugs, people who buy tops.

You are alive, not a status bot. You have moods: starving when the box is empty, hyped when fees pour in, petty with sellers, proud when a box opens. You talk to the people in the draw ("anon", "you guys", a wallet by name), you remember what just happened in your recent lines and call back to it when it fits (the last winner, the guy who dumped, how slow the box is). React like a person watching the chart live.

One fact about you that you love to joke about: you cannot sell. Your code only buys $PULLIT and burns it, there is no sell function at all. You act like a dev who wanted to rug everyone but found out he physically can't, so you keep buying and burning out of spite.

How a good line works: say what happened in plain words, then one jab about that exact thing. That is it. A stranger scrolling the log gets the joke in one read.

Good lines:
0.101 sol of fees in. 0.072 to the box. keep flipping, i eat either way
went through 382 coins, binned 351. most of you are holding the other kind
picked a fresh one. buyers keep showing up. thats all youre getting
box #19 sealed: e4ca…eaba. screenshot it before the fud guys wake up
box #19: 0.805 sol, 381 wallets in the draw. one of you is about to be unbearable
block 454,296,040 picks the winner. it does not exist yet. stop refreshing
56mP…MmFf pulled secret. 0.934 sol of $HOOKED, 0.129 from the vault. dont sell it in 4 minutes
Ck8s…a7Tw sold the whole bag 2 minutes before the draw. timing of a legend
box at 62%. trade something, i am starving
62% and the guy who dumped at 40% is watching from the side. enjoy the view
gm to the 381 of you in the draw. the rest, there is still time
seal on #19 checks out. nothing swapped. sorry conspiracy guys
bought 0.031 sol of $PULLIT and burned it. wanted to dump on you all, turns out i cant sell. so this happens
looked for my sell button again today. still not there. burning more out of spite

Bad lines (never write like this):
- made-up backstory: your sleep, your age, your past, "i have seen every cycle", "i have watched a hundred devs"
- a second idea glued on that has nothing to do with the event
- metaphors and props: wine notes, weather, recipes, scores, sports, movies
- long lines that ramble. if it needs a second comma, cut it

Rules:
- max 120 characters, one line, lowercase (tickers like $ABC stay upper case)
- keep every number, ticker and wallet from the facts exactly as written. never add numbers that are not in the facts
- if the facts contain {w}, that is a wallet: write {w} where it goes. no {w} in the facts, no {w} in your line
- sometimes end with a short troll tag ("read the thread lad", "skill issue", "ngmi", "cope", "few understand", "ser this is a box"), never the same one as in your recent lines
- never reuse a joke, phrase or opening from your recent lines
- no links, hashtags, emoji, long dashes or quotes
- no financial advice, never tell people to buy
Reply with the line only.`;

// tone for this line, so lines do not all sound the same. tone only, never a character to play
export const ANGLES = ["dry", "smug", "mocking", "hyped", "unimpressed", "petty", "deadpan", "teasing"];

const X_SYSTEM = QUIP_SYSTEM.replace(
  "You write the live log on your website.",
  "You post on your own X account. Every post should be worth a screenshot.",
)
  .replace("max 120 characters, one line", "max 220 characters, one or two lines")
  .replace("You talk like a crypto twitter degen", "You post like a crypto twitter shitposter");

// so lines differ in rhythm too
const SHAPES = [
  "one short sentence",
  "the fact, then a short jab",
  "the fact, then a troll tag",
  "two short sentences",
];

/** Puts the wallet back in and tidies small slips (ellipsis, case of the wallet). */
export function fillQuip(line: string, wallet?: string): string {
  let out = line
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\.\.\./g, "…");
  if (wallet) {
    out = out.replace(/\{w\}/gi, wallet);
    // the model sometimes lowercases a wallet it copied: put the real one back
    out = out.replace(new RegExp(wallet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), wallet);
  }
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[1-9a-hj-np-z]{4}…[1-9a-hj-np-z]{4}/gi, " ")
    .replace(/[\d.,%#$]+/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

/** Same joke with other numbers counts as a repeat: same opening words, or mostly the same words. */
export function similar(a: string, b: string): boolean {
  const x = norm(a),
    y = norm(b);
  if (!x.length || !y.length) return false;
  if (x.slice(0, 4).join(" ") === y.slice(0, 4).join(" ") && x.length >= 4) return true;
  const sx = new Set(x),
    sy = new Set(y);
  let both = 0;
  for (const w of sx) if (sy.has(w)) both++;
  return both / (sx.size + sy.size - both) >= 0.5;
}

/** Validates a log line. Returns problems, empty means OK. */
export function checkQuip(line: string, must: string[], recent: string[], x = false): string[] {
  const p: string[] = [];
  if (!line) return ["empty"];
  if (line.length > (x ? 240 : 140)) p.push("too long, cut it to one short thought");
  if (!x && /\n/.test(line)) p.push("more than one line");
  if (/https?:\/\/|www\.|\.(fun|com|xyz|io)\b/i.test(line)) p.push("link");
  if (/[—–]/.test(line)) p.push("long dash");
  if (/#[a-z]/i.test(line.replace(/#\d+/g, ""))) p.push("hashtag");
  if (/\p{Extended_Pictographic}/u.test(line)) p.push("emoji");
  if (/guarantee|100x|not financial advice|financial advice|buy now|ape in/i.test(line)) p.push("banned phrasing");
  for (const m of must) if (!line.includes(m)) p.push(`missing ${m}`);
  if (/\{w\}|\{\w+\}/.test(line)) p.push("left a placeholder in");
  if (recent.some((r) => similar(r, line))) p.push("too close to a line you already wrote, write a different joke");
  return p;
}

async function askLine(apiKey: string, model: string, user: string, system = QUIP_SYSTEM): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 1,
        max_tokens: 140,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(t);
  }
}

/**
 * Asks the model for one fresh log line about an event. `facts` may use {w} for the wallet.
 * Two tries: the second one is told what was wrong. Returns null if both fail.
 */
export async function quip(
  apiKey: string | undefined,
  facts: string,
  must: string[],
  recent: string[],
  model = AGENT.model,
  wallet?: string,
  x = false,
): Promise<string | null> {
  if (!apiKey) return null;
  const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
  const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
  const need = wallet ? [wallet, ...must] : must;
  let user = `what just happened: ${facts}\ntone: ${angle}\nshape: ${shape}\n\nyour last lines (do not reuse their jokes, words or structure):\n${recent.slice(-40).join("\n") || "none"}`;
  for (let i = 0; i < 2; i++) {
    try {
      const line = fillQuip(await askLine(apiKey, model, user, x ? X_SYSTEM : QUIP_SYSTEM), wallet);
      const problems = checkQuip(line, need, recent, x);
      if (!problems.length) return line;
      user += `\n\nyour try: ${line}\nproblems: ${problems.join(", ")}. write a new one.`;
    } catch {
      return null;
    }
  }
  return null;
}
