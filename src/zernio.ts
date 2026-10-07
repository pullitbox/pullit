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
): Promise<string> {
  if (/https?:\/\//i.test(text)) throw new Error("post contains a link; links cost more on X, put it in a reply");
  for (const t of [text, ...replies]) if (t.length > 280) throw new Error(`post too long: ${t.length}`);
  const platform: Record<string, unknown> = { platform: "twitter", accountId };
  if (replies.length)
    platform.platformSpecificData = { threadItems: [text, ...replies].map((content) => ({ content })) };
  const r = await call<{ _id?: string; post?: { _id: string }; status?: string }>(apiKey, "POST", "/posts", {
    content: text,
    publishNow: true,
    platforms: [platform],
  });
  return r._id ?? r.post?._id ?? "unknown";
}
