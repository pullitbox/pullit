// Copies the bot's secrets from .env into the Cloudflare Worker (encrypted, never printed).
// Usage: npm run secrets
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["HELIUS_API_KEY", "JUP_API_KEY", "OPENROUTER_API_KEY", "ZERNIO_API_KEY", "DEV_SECRET", "BOX_SECRET"];
const out: Record<string, string> = {};
for (const k of KEYS) {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing in .env`);
  out[k] = v;
}
const file = join(tmpdir(), `pullit-secrets-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out), { mode: 0o600 });
try {
  execFileSync("npx", ["wrangler", "secret", "bulk", file], { stdio: "inherit" });
} finally {
  unlinkSync(file);
}
console.log(`uploaded ${KEYS.length} secrets: ${KEYS.join(", ")}`);
