// Checks the X keys in .env. Does NOT post unless you pass --post "text".
// Usage: npm run xcheck
//        npm run xcheck -- --post "box #0"

import { credsFromEnv, post, whoAmI } from "../src/x.ts";

const c = credsFromEnv(process.env);
const me = await whoAmI(c);
console.log(`Keys work. Logged in as @${me.username} (id ${me.id})`);

const i = process.argv.indexOf("--post");
if (i > 0) {
  const text = process.argv[i + 1];
  if (!text) throw new Error('give the text: --post "..."');
  const id = await post(c, text);
  console.log(`Posted: https://x.com/${me.username}/status/${id}`);
}
