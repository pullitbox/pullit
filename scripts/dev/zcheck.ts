// Checks the Zernio key and the connected X account. Posts only with --post "text".
// Usage: npm run zcheck
//        npm run zcheck -- --post "box #0"

import { findXAccount, listAccounts, zernioPost } from "../../src/zernio.ts";

const key = process.env.ZERNIO_API_KEY;
if (!key) throw new Error("Set ZERNIO_API_KEY in .env");

const accounts = await listAccounts(key);
console.log(
  `Key works. Connected accounts: ${accounts.map((a) => `${a.platform}:${a.username ?? a.name ?? a._id}`).join(", ") || "none"}`,
);
const x = await findXAccount(key);
console.log(`X account id for the bot: ${x._id}`);

const i = process.argv.indexOf("--post");
if (i > 0) {
  const text = process.argv[i + 1];
  if (!text) throw new Error('give the text: --post "..."');
  const id = await zernioPost(key, x._id, text);
  console.log(`Sent to Zernio, post id ${id}. Check x.com/Pullitbox`);
}
