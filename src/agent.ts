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
  { key: "common", pct: 50, boxPct: 30, vaultPct: 0, asset: "fresh runner" },
  { key: "rare", pct: 30, boxPct: 60, vaultPct: 0, asset: "meta runner" },
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
- a dumb little joke about what you just picked and why, like you are telling friends about it
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
post: "box #4 is full and taped shut. i know whats inside and im not telling. a block does that in about a minute"
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
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
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
  const o = raw as { common?: { mint?: string }; rare?: { mint?: string }; post?: string; reveal?: string; hint_common?: string; hint_rare?: string };
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
  for (const [name, text] of [["post", o.post], ["hint_common", o.hint_common], ["hint_rare", o.hint_rare]] as const) {
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
    const ok = list.filter((c) => !recent.includes(c.symbol)).slice(0, 4);
    return ok.length ? ok[Math.floor(Math.random() * ok.length)] : list[0];
  };
  const c = pick(scan.fresh);
  const r = pick(scan.established);
  return {
    boxId,
    common: { mint: c.mint, symbol: c.symbol, why: "top score" },
    rare: { mint: r.mint, symbol: r.symbol, why: "top score" },
    post: `box #${boxId} is full and sealed. a block opens it in about a minute`,
    reveal: `inside were $${c.symbol} and $${r.symbol}`,
    hints: { common: "picked something young and loud. buyers keep showing up. thats all youre getting", rare: "the rare one has been around a while. still standing. respect" },
    source: "fallback",
  };
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
  // variety: coins from recent boxes are taken out, as long as enough others are left
  const fresher = (list: Candidate[]) => { const l = list.filter((c) => !recentSymbols.includes(c.symbol)); return l.length >= 3 ? l : list; };
  scan = { ...scan, fresh: fresher(scan.fresh), established: fresher(scan.established) };
  if (!apiKey) return { plan: fallback(scan, boxId, recentSymbols), problems: ["no OPENROUTER_API_KEY"] };
  let problems: string[] = [];
  try {
    const text = await askModel(apiKey, buildPrompt(scan, boxId, recentSymbols), model);
    const raw = JSON.parse(text.replace(/^```(json)?|```$/g, "").trim());
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
export function rollTier(seedHex: string): Tier {
  const n = parseInt(seedHex.slice(13, 21), 16) % 100; // different bits than the winner pick
  let acc = 0;
  for (const t of TIERS) { acc += t.pct; if (n < acc) return t.key; }
  return "common";
}

// ---------- one-liners for the site log ----------

const QUIP_SYSTEM = `You are pullit, a small pink pixel gift box on Solana that gives holders prizes. You write the live log on your own website.
You are terminally online: you know memecoin culture, pump.fun, trenches, jeets, paper hands, exit liquidity, bagholders, kols, snipers, bundles, devs who rug, people who buy tops and sell bottoms. You use that slang naturally, never like a brand trying to be cool.
Your humor is dry, a little mean, specific to what just happened. Roast the behavior, never the person's identity. Each line is a fresh joke: new structure, new angle, never a template.
You are a shitposter first and a box second. Reply-guy energy, short jabs, ironic ser/anon talk, fake "breaking:" news about yourself, one-line greentext (> be me > ...), unhinged 4am thoughts, petty beef with the chart, cope posts, fake polls, gm/gn posts, confessions. Absurd is good, mean is good, boring is the only crime. Often (not always) finish with a short troll tag, picked fresh each time and never the same as in your last lines, e.g. "read the thread lad", "read the thread lol", "skill issue", "cope", "ngmi", "few understand", "imagine selling", "touch grass anon", "ser this is a box", "its literally in the rules", "lmao", "probably nothing", "stay poor i guess", "not like this", "anon pls". Invent your own too.

Rules (strict):
- always joke, but stay coherent: one thought per line. the joke grows out of this exact event and a stranger reading the log gets it at once. no stacking unrelated punchlines, no jumping to a different topic halfway
- the reader still learns the fact from "what just happened" (what happened, the numbers). the joke rides on top of it
- plain trench talk only. no extended metaphors, no role-play props (wine notes, weather, recipes, ratings), no made-up scores or numbers that are not in the facts. if a word does not fit how people actually post on crypto twitter, cut it
- never repeat a joke, a phrase or a structure from your last lines, in any tag. if it sounds like something you already said, write something else
- one line, max 160 characters, lowercase (tickers like $ABC can stay upper case)
- if the facts contain {w}, that is a wallet: write {w} where it goes, we fill it in. if there is no {w} in the facts, never write {w}
- keep every number and ticker from the facts exactly as written
- no links, no hashtags, no emoji, no long dashes, no quotes around the line
- never give financial advice, never promise gains, never tell people to buy
Reply with the line only.`;

// a different angle every time, so the box never sounds like a template
export const ANGLES = [
  "deadpan, like you have seen this a thousand times",
  "a crypto twitter reply guy",
  "a smug quant who is always right",
  "a disappointed parent",
  "an old trader who has seen every cycle",
  "a gym bro hyping it up",
  "fake breaking news about yourself",
  "one-line greentext: > be me > ...",
  "a 4am shitposter who has not slept since launch",
  "a petty box keeping score",
  "a kol shilling yourself badly on purpose",
  "a trench veteran roasting a newbie",
]

const X_SYSTEM = QUIP_SYSTEM.replace("You write the live log on your own website.", "You post on your own X account. You are a shitposter: every post should be screenshot-worthy, weird, petty or funny, never an announcement.")
  .replace("one line, max 160 characters", "one post, max 240 characters, line breaks allowed");

// so lines differ in rhythm too, not only in jokes
const SHAPES = [
  "short and punchy, one sentence",
  "the fact in plain words, then a short jab",
  "two short sentences, the second one is the punchline",
  "start with the fact, end with a jab",
  "start with the jab, then the fact",
  "a question to the chat, then answer it yourself",
  "end with a troll tag",
  "no troll tag this time",
];

/** Puts the wallet back in and tidies small slips (ellipsis, case of the wallet). */
export function fillQuip(line: string, wallet?: string): string {
  let out = line.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\.\.\./g, "…");
  if (wallet) {
    out = out.replace(/\{w\}/gi, wallet);
    // the model sometimes lowercases a wallet it copied: put the real one back
    out = out.replace(new RegExp(wallet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), wallet);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[1-9a-hj-np-z]{4}…[1-9a-hj-np-z]{4}/gi, " ").replace(/[\d.,%#$]+/g, " ").replace(/[^a-z ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);

/** Same joke with other numbers counts as a repeat: same opening words, or mostly the same words. */
export function similar(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x.length || !y.length) return false;
  if (x.slice(0, 4).join(" ") === y.slice(0, 4).join(" ") && x.length >= 4) return true;
  const sx = new Set(x), sy = new Set(y);
  let both = 0; for (const w of sx) if (sy.has(w)) both++;
  return both / (sx.size + sy.size - both) >= 0.5;
}

/** Validates a log line. Returns problems, empty means OK. */
export function checkQuip(line: string, must: string[], recent: string[], x = false): string[] {
  const p: string[] = [];
  if (!line) return ["empty"];
  if (line.length > (x ? 260 : 180)) p.push("too long");
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
      body: JSON.stringify({ model, temperature: 1, max_tokens: 140, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
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
export async function quip(apiKey: string | undefined, facts: string, must: string[], recent: string[], model = AGENT.model, wallet?: string, x = false): Promise<string | null> {
  if (!apiKey) return null;
  const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
  const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
  const need = wallet ? [wallet, ...must] : must;
  let user = `what just happened: ${facts}\nangle for this one: ${angle}\nshape: ${shape}\n\nyour last lines (do not reuse their jokes, words or structure):\n${recent.slice(-40).join("\n") || "none"}`;
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
