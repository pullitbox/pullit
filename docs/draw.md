# The draw

Everything here is public and can be recomputed by anyone. `npm run verify -- <box>` does it for you.

## 1. Tickets

Every 5 minutes the bot takes a snapshot of all $PULLIT holders (Helius `getTokenAccounts`).

- a wallet needs $20 or more of $PULLIT, valued at the current price
- it must stay at $20+ for 15 minutes before its tickets count. dropping below $20 resets the timer
- tickets = `min(bag, 1% of supply) × multiplier`
- the multiplier grows from 1x to 3x over the first 24 hours of holding
- if one wallet would have more than 10% of all tickets, it is capped at 10% (repeated until nobody is over)
- pools, the bonding curve and our own wallets are excluded. any big holder whose account is owned by a program (not a normal wallet) is excluded automatically

The ticket list of each box is frozen when the box is packed and published with the box.

## 2. The seal

When the box is packed, the AI's two coins are hidden behind a seal:

```
seal = sha256("<common mint>|<rare mint>|<salt>")
```

The salt is 16 random bytes. The seal is published right away, the coins and the salt only after the box opens. If the bot swapped a coin later, the seal would not match.

## 3. The block

At packing time the bot reads the current slot and commits to `slot + 50` (about 20 seconds ahead). That block does not exist yet, so nobody can know its hash. When it is confirmed, the bot uses its blockhash. If the slot was skipped, it takes the next slot that has a block.

## 4. Winner and tier

```
seed   = sha256("<blockhash>:<box id>")             hex string
roll   = int(seed[0..13], 16) / 2^52 × total tickets
winner = walk the ticket list sorted by wallet address (a-z), adding tickets, until the sum passes roll
n      = int(seed[13..21], 16) mod 100
tier   = common if n < 50, rare if n < 80, epic if n < 95, else secret
```

The winner and the tier use different parts of the seed, so they are independent.

Code: `pickWinner` in `src/holders.ts`, `rollTier` in `src/agent.ts`, `sealOf` and `draw` in `src/executor.ts`.

## 5. The prize

The tier decides how much of the box the winner gets and which of the two sealed coins it is paid in. The bot swaps that SOL into the coin with Jupiter and sets the winner as the receiver, so the coins land directly in the winner's wallet. The transaction is linked on the site.
