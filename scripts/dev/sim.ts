// Replays a dry run of the bot on the site, sped up, so the whole loop can be watched in a few minutes:
// fees fill the box, it seals, a block opens it, the card shows the win, the next box starts.
//   node --experimental-strip-types scripts/dev/sim.ts [out/state-dry-XXXX.json] [speed=20]
//   then open http://localhost:8788
// Nothing touches the chain: it serves the state the dry run already wrote, replayed in time.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import worker from "../../worker/index.ts";
import type { State } from "../../src/loop.ts";

const path = process.argv[2] ?? "out/state-dry-Aqv8Gj.json";
const speed = Number(process.argv[3]) || 20;
const S = JSON.parse(readFileSync(path, "utf8")) as State;
const DRAW_MS = 20_000; // a box opens about 20 s after it is sealed
const opened = (b: State["history"][number]) => Date.parse(b.at) + DRAW_MS;

const t0 = Date.parse(S.history[0]!.at) - 3 * 60_000;
const tEnd = Math.max(...S.feed.map((f) => Date.parse(f.at)), opened(S.history.at(-1)!)) + 60_000;
const start = Date.now();
/** Dry-run time now, and dry-run time mapped back onto the wall clock. */
const T = () => Math.min(tEnd, t0 + (Date.now() - start) * speed);
const wall = (at: string | number) => new Date(start + (Date.parse(String(at)) - t0) / speed).toISOString();
const wallN = (at: number) => new Date(start + (at - t0) / speed).toISOString();

const rows = (id: number) =>
  existsSync(`out/box-${id}.json`)
    ? (JSON.parse(readFileSync(`out/box-${id}.json`, "utf8")) as { owner: string; tickets: number }[])
    : [];

function stateAt(now: number): State {
  const history = S.history.filter((b) => opened(b) <= now).map((b) => ({ ...b, at: wallN(opened(b)) }));
  const sealed = S.history.find((b) => Date.parse(b.at) <= now && now < opened(b));
  const next = S.history.find((b) => Date.parse(b.at) > now);
  const prevOpen = history.length ? opened(S.history[history.length - 1]!) : t0;
  // the box fills from the last open to the moment it seals
  let boxLamports = 0n;
  let threshold = BigInt(S.pub?.thresholdLamports ?? "150000000");
  if (next) {
    threshold = BigInt(next.budgetLamports);
    const f = Math.max(0, Math.min(1, (now - prevOpen) / (Date.parse(next.at) - prevOpen)));
    boxLamports = (threshold * BigInt(Math.round(f * 1000))) / 1000n;
  }
  // unlucky streaks, the way the bot counts them
  let misses: Record<string, number> = {};
  for (const b of history) {
    const m: Record<string, number> = {};
    for (const r of rows(b.boxId))
      if (r.tickets > 0 && r.owner !== b.draw!.winner) m[r.owner] = (misses[r.owner] ?? 0) + 1;
    misses = m;
  }
  const pending = sealed
    ? ({ ...sealed, at: wallN(Date.parse(sealed.at)), rows: [] } as unknown as State["pending"])
    : undefined;
  if (pending) {
    delete (pending as Partial<typeof pending>).draw;
    delete (pending as Partial<typeof pending>).prize;
    delete (pending as Partial<typeof pending>).salt;
  }
  return {
    ...S,
    history,
    pending,
    phase: sealed ? "drawing" : "filling",
    nextBoxId: history.length + 1,
    misses,
    feed: S.feed.filter((f) => Date.parse(f.at) <= now).map((f) => ({ ...f, at: wall(f.at) })),
    pub: { ...S.pub!, boxLamports: boxLamports.toString(), thresholdLamports: threshold.toString() },
  };
}

const KV = {
  async get(k: string, type?: string) {
    let v: string | null = null;
    if (k === "state") v = JSON.stringify(stateAt(T()));
    else if (k === "tickets" && existsSync("out/tickets.json")) v = readFileSync("out/tickets.json", "utf8");
    else if (k.startsWith("box:")) v = JSON.stringify(rows(Number(k.slice(4))));
    return v == null ? null : type === "json" ? JSON.parse(v) : v;
  },
  async put() {},
  async delete() {},
};
const env = { STATE: KV, PUBLIC: "1", MINT: S.mintSeen, PREVIEW_KEY: "x" } as never;
const port = Number(process.env.PORT) || 8788;
createServer(async (req, res) => {
  const r = await worker.fetch(new Request("http://localhost" + req.url), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () =>
  console.log(
    `replaying ${S.history.length} boxes at ${speed}x (${Math.round((tEnd - t0) / speed / 1000)} s) on http://localhost:${port}`,
  ),
);
