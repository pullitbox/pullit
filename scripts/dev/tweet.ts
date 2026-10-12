// Pins a tweet on pullit.fun: npm run tweet -- https://x.com/Pullitbox/status/123
// Newest first, the site shows 3. `npm run tweet -- --clear` removes them all,
// `npm run tweet -- --refresh` reloads text, photos and video of the pinned ones.
// The tweet is read here, on this computer: x does not answer cloudflare's servers.
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = process.argv[2];
const ok = (u: string) => /^https:\/\/(x|twitter)\.com\/\w+\/status\/\d+$/.test(u);
const kv = (...a: string[]) =>
  execFileSync("npx", ["wrangler", "kv", "key", ...a, "--binding", "STATE", "--remote"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
const put = (key: string, value: string) => {
  const f = join(tmpdir(), "pullit-kv.json");
  writeFileSync(f, value);
  try {
    kv("put", key, "--path", f);
  } finally {
    unlinkSync(f);
  }
};

type Media = { type: "photo" | "video"; src: string; poster?: string };
async function read(url: string) {
  const id = url.split("/").pop()!;
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const r = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${token}`, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36",
    },
  });
  if (!r.ok) throw new Error(`x answered ${r.status} for ${url}`);
  const t = (await r.json()) as {
    text?: string;
    created_at?: string;
    entities?: { media?: { url: string }[]; urls?: { url: string; display_url: string }[] };
    mediaDetails?: {
      type: string;
      media_url_https: string;
      video_info?: { variants: { content_type: string; url: string; bitrate?: number }[] };
    }[];
  };
  let text = t.text ?? "";
  for (const m of t.entities?.media ?? []) text = text.replace(m.url, "");
  for (const u of t.entities?.urls ?? []) text = text.replace(u.url, u.display_url);
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  const media: Media[] = (t.mediaDetails ?? []).slice(0, 4).flatMap((m): Media[] => {
    if (m.type === "photo") return [{ type: "photo", src: m.media_url_https }];
    const mp4 = (m.video_info?.variants ?? [])
      .filter((v) => v.content_type === "video/mp4")
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
      .find((v) => (v.bitrate ?? 0) <= 2_200_000);
    return mp4 ? [{ type: "video", src: mp4.url, poster: m.media_url_https }] : [];
  });
  const at = t.created_at
    ? new Date(t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : undefined;
  return { url, text, at, media, local: true, fetchedAt: Date.now() };
}

if (!arg) {
  console.log("usage: npm run tweet -- <tweet link>   |   --refresh   |   --clear");
  process.exit(1);
}
let list: string[] = [];
try {
  list = JSON.parse(kv("get", "xpins")) as string[];
} catch {
  list = [];
}
if (arg === "--clear") list = [];
else if (arg !== "--refresh") {
  const url = arg.split("?")[0];
  if (!ok(url)) {
    console.log("not a tweet link: " + arg);
    process.exit(1);
  }
  list = [url, ...list.filter((u) => u !== url)].slice(0, 6);
}
put("xpins", JSON.stringify(list));
for (const url of list.slice(0, 3)) {
  try {
    const pin = await read(url);
    put("xpin2:" + url.split("/").pop(), JSON.stringify(pin));
    console.log(`ok  ${url}  (${pin.media.map((m) => m.type).join(", ") || "text only"})`);
  } catch (e) {
    console.log(`??  ${url}: ${(e as Error).message}`);
  }
}
console.log(list.length ? "the site shows the first 3" : "pins cleared");
