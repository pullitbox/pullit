// Prints the recent commits as base64 JSON, passed to the Worker on deploy (BUILD_COMMITS),
// so the box can write its journal about what just shipped.
import { execFileSync } from "node:child_process";

let out: [string, number, string][] = [];
try {
  out = execFileSync("git", ["log", "-n", "15", "--since=48 hours ago", "--format=%h%x09%ct%x09%s"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, time, ...msg] = l.split("\t");
      return [hash, Number(time) * 1000, msg.join(" ")] as [string, number, string];
    });
} catch {
  /* not a git checkout: no journal entries */
}
process.stdout.write(Buffer.from(JSON.stringify(out)).toString("base64"));
