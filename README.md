<p align="center"><img src="assets/social-preview.png" alt="pullit: a blind box that fills itself" width="720"></p>

<p align="center">
  <a href="https://github.com/pullitbox/pullit/actions/workflows/test.yml"><img src="https://github.com/pullitbox/pullit/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/license-MIT-pink" alt="MIT">
  <img src="https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-orange" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="no runtime dependencies">
</p>

<p align="center">
  <a href="https://pullit.fun">pullit.fun</a> · <a href="https://x.com/Pullitbox">@Pullitbox</a> · <a href="docs/architecture.md">architecture</a> · <a href="#check-a-box-yourself">check a box</a>
</p>

# pullit

Trading fees of $PULLIT fill a box. When it is full, an AI picks what goes inside and seals it.
A Solana block that does not exist yet decides which holder opens it and what tier they pull.
Nobody knows the result in advance. Not the holders, not the AI, not us.

The bot can only buy. It buys the prize for the winner and buys $PULLIT to burn it. It has no code to sell anything.

## How it works

1. **Fees fill the box.** Every 10 minutes the bot claims the creator fees of $PULLIT. 80% goes to the box wallet, 20% to the team wallet (agent costs, servers, building). A small part of the box share is set aside in the vault.
2. **The AI packs it.** When the box is full, the agent scans the market, throws out anything that looks unsafe, and picks two coins: a fresh runner and a runner of the meta. It writes a joke about its picks on the site log, never the names.
3. **The box is sealed.** The bot publishes a seal: `sha256(common mint | rare mint | salt)`. The contents cannot change after that without the seal breaking.
4. **A future block decides.** The bot commits to a slot about 20 seconds ahead. When that block exists, its hash picks the winner (weighted by tickets) and the tier.
5. **The prize goes straight to the winner.** The bot swaps SOL from the box into the prize coin with Jupiter and delivers it to the winner's wallet in the same transaction. The seal and the draw are published so anyone can check them.
6. **Buyback and burn.** A tenth of every box buys $PULLIT and burns it. Each burn is a transaction on the site log.

Whatever a pull leaves in the box rolls into the next one.

## Boosts

- **Frenzy.** The more $PULLIT trades in an hour, the better the odds of the next box. Four levels, from epic 15% / secret 5% up to epic 24% / secret 11%. The odds are locked into the box when it is sealed, so they are part of the public record.
- **Milestones.** The first box after the market cap crosses 50K, 100K, 250K, 500K, 1M, 2.5M, 5M or 10M is epic or better, also takes 20% of the vault, and burns another 10% of the vault (bought back from the market).
- **Launch reserve.** At launch the box buys some $PULLIT for itself, in public. It can only burn it: 10% of it at 50K, 125K, 200K and 350K market cap. The amount and every burn are on the site.
- **It can only buy.** Every box buys $PULLIT and burns it. The bot has no code that sells anything: every swap starts from SOL, and a test fails if that ever changes (`test/executor.test.ts`).

All numbers live in [`src/boost.ts`](src/boost.ts).

## Who is in the draw

- hold $PULLIT for 7 minutes. no claiming, no buttons
- how much depends on the box: $20 for boxes up to 0.5 SOL, $50 up to 1.5, $75 above 1.5, $100 from 2.5, $250 from 5. a smaller bag keeps its hold time and joins again when a smaller box comes
- the longer you hold, the more tickets, up to 3x at 24 hours
- bought in the last 15 minutes before the box opens: +25% tickets
- any sell puts your hold back to 1x. you stay in the draw
- check your chance on the site: it also shows what $50 more would do
- a bag counts up to 1% of supply, and no wallet can have more than 10% of all tickets
- pools, the bonding curve and our own wallets are never in the draw

## What the bot can and cannot do

The bot holds the keys of the dev wallet (to claim fees) and the box wallet (to pay prizes). The code that runs is the code in this repo, deployed to a Cloudflare Worker.

It can:

- claim creator fees and split them 80/20 between the box and the team wallet
- swap box SOL into the prize coin and send it to the winner
- buy $PULLIT with box SOL and burn it
- post on x

It cannot:

- sell $PULLIT. every swap in the code goes from SOL to a token, never the other way
- send box funds anywhere except a draw winner or the burn
- pick a coin that the scanner did not list as safe. every AI answer goes through a validator in code, and a bad answer falls back to the top scored coins

## Check a box yourself

Every opened box can be recomputed from public data. The site has the check under each box ("check it myself"), or run it here (Node 22.6+):

```
npm install
npm run verify -- 12
```

This downloads box #12 from the site, checks the seal against the revealed coins, takes the blockhash of the committed slot, and recomputes the winner and the tier from the published ticket list.

How the draw works in detail: [docs/draw.md](docs/draw.md).

## Docs

- [docs/architecture.md](docs/architecture.md): how it fits together, with diagrams
- [docs/draw.md](docs/draw.md): tickets, seed, winner, tier, seal
- [docs/agent.md](docs/agent.md): the market scanner, the AI, the validator
- [docs/fees.md](docs/fees.md): fee split, vault, rollover, final box
- [SECURITY.md](SECURITY.md): keys, wallets, what the code guarantees, reporting a problem
- [CHANGELOG.md](CHANGELOG.md): what changed

## Risks, plainly

- prizes are memecoins picked from the current market. they can go to zero
- the bot runs on Cloudflare and depends on Helius, Jupiter, OpenRouter and PumpPortal. if one is down, a box waits
- the team controls the keys. the code limits what the bot does, the keys could in theory be used by hand. every transaction of every wallet is public, so watch them
- not financial advice. its a box

## Map

```
src/loop.ts       the state machine: fill, pack, draw, pay, burn
src/executor.ts   blockhash randomness, prize sizes, seal, Jupiter swap, payout, burn
src/holders.ts    holder snapshots, tickets, the weighted pick
src/boost.ts      frenzy odds, market cap milestones, burn share
src/fees.ts       claim creator fees, 80/20 split, final box rule
src/scanner.ts    market scanner and safety filters (thresholds in src/config.ts)
src/agent.ts      the AI that packs the box, the validator, tier odds, its voice
src/solana.ts     keys, transactions and rpc, no dependencies
worker/           Cloudflare Worker: cron, api, site
scripts/verify.ts recompute any opened box
scripts/dev/       local tools: scanner, preview, test runs
test/             unit tests, run on every push
```
