// Dry run of the agent: scans the market and asks the AI to pack a box. Moves no money, posts nothing.
// Usage: npm run pack            (box #1)
//        BOX=7 npm run pack

import { fetchUniverse } from "../src/jupiter.ts";
import { scan } from "../src/scanner.ts";
import { packBox } from "../src/agent.ts";

const { JUP_API_KEY, OPENROUTER_API_KEY, OPENROUTER_MODEL } = process.env;
if (!JUP_API_KEY) throw new Error("JUP_API_KEY missing");

const result = scan(await fetchUniverse(JUP_API_KEY));
console.log(`candidates: ${result.fresh.length} fresh, ${result.established.length} established`);
const t0 = Date.now();
const { plan, problems } = await packBox(
  OPENROUTER_API_KEY,
  result,
  Number(process.env.BOX ?? 1),
  [],
  OPENROUTER_MODEL,
);
console.log(`\nsource: ${plan.source} (${Date.now() - t0} ms)`);
if (problems.length) console.log("problems:", problems);
console.log(`common: $${plan.common.symbol} (${plan.common.why})`);
console.log(`rare:   $${plan.rare.symbol} (${plan.rare.why})`);
console.log(`\npost (${plan.post.length} chars):\n${plan.post}`);
