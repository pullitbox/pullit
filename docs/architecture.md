# Architecture

One Cloudflare Worker runs everything. A cron wakes it every minute, it does one step of the loop and saves its state in Cloudflare KV. There is no other server.

## Money

```mermaid
flowchart LR
  T[trades of $PULLIT] -->|creator fees| D[dev wallet]
  D -->|80%| B[box wallet]
  D -->|20%| TM[team wallet]
  B -->|10% of inflow, tracked| V[(vault)]
  B -->|prize, swapped by Jupiter| W[winner wallet]
  V -->|secret pull only| W
```

- the bot only ever sends box SOL to a draw winner, swapped into the prize coin in the same transaction
- the bot never trades or moves $PULLIT. it only reads balances to count tickets
- all three wallets are public. they are listed on the site

## One box, step by step

```mermaid
sequenceDiagram
  participant F as fees
  participant Bot
  participant AI
  participant Chain as solana
  F->>Bot: claim + split every 10 min
  Bot->>Bot: box full?
  Bot->>AI: safe coins from the scanner
  AI-->>Bot: two picks (checked by code)
  Bot->>Chain: commit to a future slot
  Bot-->>Bot: publish seal = sha256(common | rare | salt)
  Chain-->>Bot: blockhash of that slot
  Bot->>Bot: seed = sha256(blockhash:box) → winner + tier
  Bot->>Chain: swap + pay the winner
  Bot-->>Bot: publish salt, tickets, tx
```

The seal is published before the block exists. The salt and the full ticket list are published after. Anyone can recompute the seal, the winner and the tier: `npm run verify -- <box>`, or "check it myself" on the site.

## Code

| file                | what it does                                                  |
| ------------------- | ------------------------------------------------------------- |
| `worker/index.ts`   | cron, public api, site                                        |
| `src/loop.ts`       | the state machine: fill, pack, draw, pay, roll over           |
| `src/fees.ts`       | claim creator fees, 80/20 split, final box rule               |
| `src/scanner.ts`    | market scanner and safety filters                             |
| `src/agent.ts`      | AI picks, the validator around them, tier odds, log lines     |
| `src/holders.ts`    | holder snapshots, tickets, weighted pick                      |
| `src/executor.ts`   | blockhash randomness, prize sizes, seal, Jupiter swap, payout |
| `scripts/verify.ts` | recompute any opened box from public data                     |

## What lives where

- **keys**: Cloudflare secrets only. never in this repo
- **state**: Cloudflare KV. current box, history, tickets of every opened box
- **outside services**: Helius (rpc, holders), Jupiter (prices, swaps), PumpPortal (fee claims), OpenRouter (AI), Zernio (posts on x). if one is down, the box waits
