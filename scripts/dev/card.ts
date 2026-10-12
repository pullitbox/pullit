// Renders sample share cards to out/card-<tier>.png, to look at the design without a deploy.
//   node --experimental-strip-types scripts/dev/card.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { renderCard, type CardData } from "../../worker/card.ts";

const svg = readFileSync("assets/box.svg", "utf8");
mkdirSync("out", { recursive: true });
const samples: CardData[] = [
  { boxId: 35, tier: "secret", sol: "3.89", symbol: "HOTBOT", winner: "4iSy…kVvZ", eligible: 72, slot: 456031751 },
  { boxId: 22, tier: "epic", sol: "1.42", symbol: "CLAUDIA", winner: "Fkwn…NCJ5", eligible: 140, slot: 456020118 },
  { boxId: 9, tier: "rare", sol: "0.48", symbol: "baton", winner: "97SB…omtd", eligible: 88, slot: 456011904 },
  { boxId: 3, tier: "common", sol: "0.15", symbol: "W", winner: "3gw9…djMu", eligible: 31, slot: 456004210 },
  {
    boxId: 120,
    tier: "epic",
    sol: "12.48",
    symbol: "SUPERLONGTICKERNAME",
    winner: "Ab12…yz89",
    eligible: 2104,
    slot: 456999999,
  },
];
for (const d of samples) {
  const t = Date.now();
  const b = await renderCard(d, svg);
  writeFileSync(`out/card-${d.boxId}-${d.tier}.png`, b);
  console.log(`card ${d.boxId} ${d.tier}: ${(b.length / 1024).toFixed(1)} kB in ${Date.now() - t} ms`);
}
