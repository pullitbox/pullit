// Asks the agent for sample log lines, to hear its voice before going live.
//   npm run quips
import { quip } from "../src/agent.ts";

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY missing in .env");
const events: [string, string[], string?][] = [
  [
    "{w} just bought 2.3% of the whole supply in one go. tickets only count a bag up to 1% of supply anyway",
    [],
    "7xQp…Lk2a",
  ],
  ["{w} sold their whole 0.8% bag right before the box opens, so they are out of the draw", [], "Ck8s…a7Tw"],
  ["{w} sold their whole 0.4% bag", [], "9fKa…w2Ld"],
  ["{w} has held for 24 hours straight and now gets 3x tickets", [], "Bq3x…P0aa"],
  ["{w} just bought 1.4% of the whole supply in one go", [], "HqT2…88xe"],
  ["{w} sold their whole 1.1% bag", [], "Lm0p…Qr7s"],
  ["claimed 0.106 sol of trading fees. 0.076 went in the box, 0.008 into the vault", ["0.106"]],
  [
    "scanned 1,214 coins for the box and threw out 38: devs holding too much, top holders too heavy, fake volume, mint not revoked",
    ["38"],
  ],
  ["box #7 is packed with 0.342 sol, 188 holders are in the draw", ["#7"]],
  ["{w} won a rare pull: 0.205 sol paid out in $KILN", ["$KILN"], "9fKa…w2Ld"],
  [
    "nothing happened for a while. say something on your own, like a bored box with opinions. box #8 is 41% full. vault holds 1.240 sol. 188 of 412 holders are in the draw. it is 3:00 utc",
    [],
  ],
  ["412 holders, 188 of them are in the draw (you need $20 held for 15 minutes)", ["188"]],
];
const recent: string[] = [];
for (const [facts, must, wallet] of events) {
  const line = await quip(key, facts, must, recent, process.env.OPENROUTER_MODEL, wallet);
  console.log(line ? `  ${line}` : "  (rejected, the template would be used)");
  if (line) recent.push(line);
}
