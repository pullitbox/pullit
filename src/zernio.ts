// Zernio API: posts to X through Zernio's official X integration (no own X developer billing).
// Docs: https://docs.zernio.com

const BASE = "https://zernio.com/api/v1";

async function call<T>(apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zernio ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export interface ZernioAccount {
  _id: string;
  platform: string;
  username?: string;
  name?: string;
}

export async function listAccounts(apiKey: string): Promise<ZernioAccount[]> {
  const r = await call<ZernioAccount[] | { accounts?: ZernioAccount[]; data?: ZernioAccount[] }>(
    apiKey,
    "GET",
    "/accounts",
  );
  return Array.isArray(r) ? r : (r.accounts ?? r.data ?? []);
}

export async function findXAccount(apiKey: string): Promise<ZernioAccount> {
  const acc = (await listAccounts(apiKey)).find((a) => a.platform === "twitter" || a.platform === "x");
  if (!acc) throw new Error("No X account connected in Zernio (Connections -> X)");
  return acc;
}

/** Posts to X. `replies` become a thread under the post (links are only allowed there, the main post stays clean for reach). */
export async function zernioPost(
  apiKey: string,
  accountId: string,
  text: string,
  replies: string[] = [],
): Promise<{ id: string; url?: string }> {
  if (/https?:\/\//i.test(text)) throw new Error("post contains a link; links cost more on X, put it in a reply");
  // x counts every link as 23 characters
  // x counts every link as 23 and most characters outside basic latin (emoji, cjk, "…") as 2
  const light = (c: number) =>
    c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247);
  const xLen = (t: string) =>
    [...t.replace(/https?:\/\/\S+/g, "x".repeat(23))].reduce((a, ch) => a + (light(ch.codePointAt(0)!) ? 1 : 2), 0);
  for (const t of [text, ...replies]) if (xLen(t) > 280) throw new Error(`post too long: ${xLen(t)}`);
  const platform: Record<string, unknown> = { platform: "twitter", accountId };
  if (replies.length)
    platform.platformSpecificData = { threadItems: [text, ...replies].map((content) => ({ content })) };
  const r = await call<{
    _id?: string;
    post?: { _id: string; platforms?: { platformPostUrl?: string }[] };
    platforms?: { platformPostUrl?: string }[];
  }>(apiKey, "POST", "/posts", {
    content: text,
    publishNow: true,
    platforms: [platform],
  });
  const url = (r.post?.platforms ?? r.platforms ?? []).find((p) => p.platformPostUrl)?.platformPostUrl;
  return { id: r._id ?? r.post?._id ?? "unknown", url };
}
