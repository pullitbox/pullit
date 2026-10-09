# Changelog

## 0.10.0

- bigger pool: the agent sees the top 20 fresh and top 20 meta runners instead of 12, plus a few big liquid coins of the week

## 0.9.0 (test run)

The whole loop runs on mainnet data with simulated fees. No money moves, nothing is posted from the test.

- boxes fill from creator fees, an AI packs two coins, a seal is published, a future block picks the holder and the tier
- box size follows the last hour of fees: 0.3 to 4 SOL
- entry grows with the box: $20 up to 0.5 SOL, up to $250 for a 5 SOL box
- tickets: bigger bag, longer hold (up to 3x at 24h), +25% for a buy in the last 15 minutes, any sell back to 1x
- frenzy: more volume in the last hour, better odds for the next box
- market cap milestones: epic or better, 20% of the vault to the winner, 10% of the vault burned
- buyback and burn on every box. the bot only buys, it cannot sell
- payments saved before they are sent, draw saved once, one tick at a time
- the agent re-scans the market every 10 minutes while a box fills
- site: live log, belt, vault, wallet check with odds, proof for every box, journal
