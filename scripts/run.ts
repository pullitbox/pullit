// Runs the bot on this machine: one tick per minute, state saved to out/state.json.
// Test on any existing coin without moving money or posting:
//   DRY_RUN=1 MINT=<some mint> npm run bot
// Real run (after launch, MINT in .env):
//   npm run bot

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { Bot, newState, type Env, type State } from "../src/loop.ts";

const env = process.env as unknown as Env;
for (const k of ["MINT", "HELIUS_API_KEY", "JUP_API_KEY", "BOX_SECRET", "TEAM_WALLET"] as const)
  if (!env[k]) throw new Error(`${k} missing`);

mkdirSync("out", { recursive: true });
const path = env.DRY_RUN === "1" ? `out/state-dry-${(env.MINT ?? "").slice(0, 6)}.json` : "out/state.json";
const state: State = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : newState();
const save = () => {
  writeFileSync(path + ".tmp", JSON.stringify(state, null, 2));
  renameSync(path + ".tmp", path);
};

const bot = new Bot(env, state);
await bot.init();
bot.log(`bot up. mint ${env.MINT}, ${bot.dry ? "DRY RUN (no money, no posts)" : "LIVE"}, state ${path}`);

let busy = false;
async function loop() {
  if (busy) return;
  busy = true;
  try {
    await bot.tick();
  } catch (e) {
    bot.log(`tick error: ${(e as Error).message}`);
  } finally {
    save();
    busy = false;
  }
}
await loop();
setInterval(loop, 60_000);
