// Minimal X API v2 client with OAuth 1.0a user-context signing (WebCrypto HMAC-SHA1).
// Works in Node 22+ and Cloudflare Workers. Only what the bot needs: who am I, post.

export interface XCreds { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string }

const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function hmacSha1B64(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...sig));
}

/** Builds the OAuth 1.0a Authorization header. JSON bodies are not part of the signature. */
export async function oauthHeader(method: string, url: string, c: XCreds, nonce?: string, ts?: string): Promise<string> {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: nonce ?? crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: ts ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: c.accessToken,
    oauth_version: "1.0",
  };
  const params: [string, string][] = [...Object.entries(oauth)];
  u.searchParams.forEach((v, k) => params.push([k, v]));
  const paramStr = params
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${enc(u.origin + u.pathname)}&${enc(paramStr)}`;
  const signature = await hmacSha1B64(`${enc(c.apiSecret)}&${enc(c.accessSecret)}`, base);
  const all = { ...oauth, oauth_signature: signature };
  return "OAuth " + Object.entries(all).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ");
}

async function call<T>(method: string, url: string, c: XCreds, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: await oauthHeader(method, url, c),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`X ${method} ${new URL(url).pathname} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export async function whoAmI(c: XCreds): Promise<{ id: string; username: string }> {
  const r = await call<{ data: { id: string; username: string } }>("GET", "https://api.x.com/2/users/me", c);
  return r.data;
}

/** Posts a tweet. Links make a post ~13x more expensive on pay-per-use, so we refuse them. */
export async function post(c: XCreds, text: string, opts: { allowLinks?: boolean } = {}): Promise<string> {
  if (!opts.allowLinks && /https?:\/\/|\b\w+\.(fun|com|xyz|io|net|org)\b/i.test(text)) {
    throw new Error("post contains a link; links cost much more, pass allowLinks to override");
  }
  if (text.length > 280) throw new Error(`post too long: ${text.length}`);
  const r = await call<{ data: { id: string } }>("POST", "https://api.x.com/2/tweets", c, { text });
  return r.data.id;
}

export function credsFromEnv(env: Record<string, string | undefined>): XCreds {
  const need = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  return { apiKey: env.X_API_KEY!, apiSecret: env.X_API_SECRET!, accessToken: env.X_ACCESS_TOKEN!, accessSecret: env.X_ACCESS_SECRET! };
}
