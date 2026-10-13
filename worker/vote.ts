// A one-question community vote shown on the site. One vote per visitor (hashed ip + browser),
// each vote is its own KV key, so counts never lose a write and nothing personal is stored.
import type { KVNamespace } from "./cloudflare.ts";

export const VOTE = {
  id: "v2",
  usd: 300, // what the winning option gets, from the dev wallet
  boxes: 10, // "boxes" spreads it over this many boxes
  minVotes: 25, // fewer votes than this and "keep" wins
  question: "$300 of trading fees landed in the dev wallet by mistake. where should it go?",
  options: [
    { key: "boxes", label: "into the next 10 boxes", note: "+$30 in each" },
    { key: "buyback", label: "buy back $pullit and burn it", note: "one market buy, then burned" },
    { key: "keep", label: "the dev keeps it as a gift", note: "also wins if under 25 votes" },
  ],
  endsAt: Date.parse("2026-10-13T22:00:00Z"),
};

/** Finished votes, newest first. Their counts stay in kv under their own id. */
export const PAST_VOTES = [
  {
    id: "v1",
    question: "$100 from the dev wallet. where should it go?",
    options: [
      { key: "boxes", label: "into the next 5 boxes", note: "+$20 in each" },
      { key: "buyback", label: "buy back $pullit and burn it", note: "one market buy, then burned" },
    ],
    endsAt: Date.parse("2026-10-13T13:30:00Z"),
  },
];

const prefix = (id = VOTE.id) => `vote:${id}:`;

async function hashVoter(req: Request): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const ua = req.headers.get("user-agent") ?? "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${VOTE.id}|${ip}|${ua}`));
  return [...new Uint8Array(buf)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function counts(
  kv: KVNamespace,
  v: { id: string; options: { key: string }[] } = VOTE,
): Promise<Record<string, number>> {
  const c: Record<string, number> = Object.fromEntries(v.options.map((o) => [o.key, 0]));
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await kv.list({ prefix: prefix(v.id), cursor, limit: 1000 });
    for (const k of r.keys) {
      const choice = k.name.slice(prefix(v.id).length).split(":")[0];
      if (choice in c) c[choice]++;
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return c;
}

async function mine(kv: KVNamespace, h: string): Promise<string | null> {
  for (const o of VOTE.options) if (await kv.get(`${prefix()}${o.key}:${h}`)) return o.key;
  return null;
}

export async function voteState(kv: KVNamespace, req: Request) {
  const h = await hashVoter(req);
  return { ...VOTE, counts: await counts(kv), mine: await mine(kv, h), open: Date.now() < VOTE.endsAt };
}

export async function castVote(kv: KVNamespace, req: Request) {
  if (Date.now() >= VOTE.endsAt) return { error: "the vote is closed" };
  let choice = "";
  try {
    choice = String(((await req.json()) as { choice?: string }).choice ?? "");
  } catch {
    /* empty body */
  }
  if (!VOTE.options.some((o) => o.key === choice)) return { error: "pick one of the options" };
  const h = await hashVoter(req);
  if (!(await mine(kv, h))) await kv.put(`${prefix()}${choice}:${h}`, String(Date.now()));
  return voteState(kv, req);
}

/** The winning option once the vote has closed, else null. Under minVotes votes "keep" wins; a tie goes to the boxes. */
export async function voteResult(kv: KVNamespace): Promise<string | null> {
  if (Date.now() < VOTE.endsAt) return null;
  return winner(await counts(kv));
}

export function winner(c: Record<string, number>, min = VOTE.minVotes): string {
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  if (total < min) return "keep";
  const order = ["boxes", "buyback", "keep"]; // ties: earlier wins
  return order.reduce((best, k) => ((c[k] ?? 0) > (c[best] ?? 0) ? k : best), "boxes");
}

/** The finished votes with their final counts, newest first. */
export async function pastVotes(kv: KVNamespace) {
  return Promise.all(PAST_VOTES.map(async (v) => ({ ...v, counts: await counts(kv, v), open: false })));
}
