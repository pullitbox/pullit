// Pins a tweet on pullit.fun: npm run tweet -- https://x.com/Pullitbox/status/123
// Newest first, up to 6. `npm run tweet -- --clear` removes them all.
import { execFileSync } from "node:child_process";

const arg = process.argv[2];
const ok = (u: string) => /^https:\/\/(x|twitter)\.com\/\w+\/status\/\d+$/.test(u);
const kv = (...a: string[]) =>
  execFileSync("npx", ["wrangler", "kv", "key", ...a, "--binding", "STATE", "--remote"], { encoding: "utf8" });

if (!arg) {
  console.log("usage: npm run tweet -- <tweet link>   or   npm run tweet -- --clear");
  process.exit(1);
}
let list: string[] = [];
if (arg !== "--clear") {
  const url = arg.split("?")[0];
  if (!ok(url)) {
    console.log("not a tweet link: " + arg);
    process.exit(1);
  }
  try {
    list = JSON.parse(kv("get", "xpins")) as string[];
  } catch {
    list = [];
  }
  list = [url, ...list.filter((u) => u !== url)].slice(0, 6);
}
kv("put", "xpins", JSON.stringify(list));
console.log(list.length ? "pinned on the site:\n" + list.join("\n") : "pins cleared");
