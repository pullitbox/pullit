// A one-question community vote shown on the site. One vote per visitor (hashed ip + browser),
// each vote is its own KV key, so counts never lose a write and nothing personal is stored.
import type { KVNamespace } from "./cloudflare.ts";

export const VOTE = {
  id: "v1",
  question: "$100 from the dev wallet. where should it go?",
  options: [
    { key: "boxes", label: "into the next 5 boxes", note: "+$20 in each" },
    { key: "buyback", label: "buy back $pullit and burn it", note: "one market buy, then burned" },
  ],
  endsAt: Date.parse("2026-10-14T18:00:00Z"),
};

const prefix = () => `vote:${VOTE.id}:`;

async function hashVoter(req: Request): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const ua = req.headers.get("user-agent") ?? "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${VOTE.id}|${ip}|${ua}`));
  return [...new Uint8Array(buf)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function counts(kv: KVNamespace): Promise<Record<string, number>> {
  const c: Record<string, number> = Object.fromEntries(VOTE.options.map((o) => [o.key, 0]));
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await kv.list({ prefix: prefix(), cursor, limit: 1000 });
    for (const k of r.keys) {
      const choice = k.name.slice(prefix().length).split(":")[0];
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
