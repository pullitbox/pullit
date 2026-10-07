# pullit

A blind box that fills itself.

Trading fees of $PULLIT go into a box. When it is full, an AI picks what goes inside and seals it.
A Solana block that does not exist yet decides which holder opens it and what tier they pull.
Nobody knows the result in advance. Not the holders, not the AI, not us.

- site: https://pullit.fun
- x: https://x.com/Pullitbox
- ca: posted on the site and on x at launch

## How it works

1. **Fees fill the box.** Every 10 minutes the bot claims the creator fees of $PULLIT. 80% goes to the box wallet, 20% to the team wallet (agent costs, servers, building). A small part of the box share is set aside in the vault.
2. **The AI packs it.** When the box is full, the agent scans the market, throws out anything that looks unsafe, and picks two coins: a fresh runner and a runner of the meta. It writes a joke about its picks on the site log, never the names.
3. **The box is sealed.** The bot publishes a seal: `sha256(common mint | rare mint | salt)`. The contents cannot change after that without the seal breaking.
4. **A future block decides.** The bot commits to a slot about a minute ahead. When that block exists, its hash picks the winner (weighted by tickets) and the tier.
5. **The prize goes straight to the winner.** The bot swaps SOL from the box into the prize coin with Jupiter and delivers it to the winner's wallet in the same transaction. The seal and the draw are published so anyone can check them.

Whatever a pull leaves in the box rolls into the next one.

## Who is in the draw

- hold $20 or more of $PULLIT for 15 minutes. no claiming, no buttons
- the longer you hold, the more tickets, up to 3x at 24 hours
- a bag counts up to 1% of supply, and no wallet can have more than 10% of all tickets
- pools, the bonding curve and our own wallets are never in the draw

## What the bot can and cannot do

The bot holds the keys of the dev wallet (to claim fees) and the box wallet (to pay prizes). The code that runs is the code in this repo, deployed to a Cloudflare Worker.

It can:
- claim creator fees and split them 80/20 between the box and the team wallet
- swap box SOL into the prize coin and send it to the winner
- post on x

It cannot:
- sell or move $PULLIT. the code only reads $PULLIT balances, it never trades or transfers it
- send box funds anywhere except a draw winner
- pick a coin that the scanner did not list as safe. every AI answer goes through a validator in code, and a bad answer falls back to the top scored coins

## Check a box yourself

Every opened box can be recomputed from public data:

```
npm run verify -- 12
```

This downloads box #12 from the site, checks the seal against the revealed coins, takes the blockhash of the committed slot, and recomputes the winner and the tier from the published ticket list. The site has the same check under each box ("check it myself").

How the draw works in detail: [docs/draw.md](docs/draw.md).

## Docs

- [docs/draw.md](docs/draw.md): tickets, seed, winner, tier, seal
- [docs/agent.md](docs/agent.md): the market scanner, the AI, the validator
- [docs/fees.md](docs/fees.md): fee split, vault, rollover, final box
- [SECURITY.md](SECURITY.md): keys, wallets, reporting a problem

## Risks, plainly

- prizes are memecoins picked from the current market. they can go to zero
- the bot runs on Cloudflare and depends on Helius, Jupiter, OpenRouter and PumpPortal. if one is down, a box waits
- the team controls the keys. the code limits what the bot does, the keys could in theory be used by hand. every transaction of every wallet is public, so watch them
- not financial advice. its a box

## Run it

Node 22.6+ runs the TypeScript directly, nothing to build.

```
npm test               # unit tests
npm run scan           # print what the scanner sees right now (needs JUP_API_KEY)
npm run preview        # the site with made-up data on http://localhost:8787/?preview=x
DRY_RUN=1 MINT=<any mint> npm run bot   # the whole loop on any coin, no money moves, nothing is posted
```

Keys live in `.env` locally and in Cloudflare secrets in production. They are never in this repo.

## Map

```
src/scanner.ts    market scanner and safety filters
src/config.ts     all scanner thresholds
src/agent.ts      the AI that packs the box, the validator, tier odds
src/holders.ts    holder snapshots, tickets, the weighted pick
src/executor.ts   blockhash randomness, prize sizes, seal, Jupiter swap, payout
src/fees.ts       claim creator fees, 80/20 split, final box rule
src/loop.ts       the state machine that ties it together
src/voice.ts      the box's lines on the site log
worker/           Cloudflare Worker: cron, api, site
scripts/          local tools: scan, verify, preview, run the bot
test/             unit tests
```
