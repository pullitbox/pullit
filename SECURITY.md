# Security

## Keys

- the dev wallet key (claims fees) and the box wallet key (pays prizes) are Cloudflare Worker secrets
- locally they live in `.env`, which is git-ignored
- no key, seed phrase or API key is in this repo or its history

## Wallets

All wallets are listed on the site under rules. Every transaction is public on Solana.

| wallet | what it does                                                                    |
| ------ | ------------------------------------------------------------------------------- |
| dev    | receives the creator fees and splits them 80/20, nothing else                   |
| box    | holds the prize pool and the vault. sends only to draw winners or into the burn |
| team   | receives 20% of fees: the agent, the servers, the people building               |

## What the code guarantees

- **it cannot sell.** every swap starts from SOL; there is no parameter to swap anything else. `test/executor.test.ts` fails if a second kind of swap ever appears
- **it cannot pay twice.** a payment is saved the moment it is signed, before it is sent. after a restart the bot asks the chain whether that transaction landed before doing anything else
- **it cannot change the winner.** the draw is computed once from a block that did not exist when the box was sealed, saved, and reused on any retry
- **one tick at a time.** each run takes a lock with its own token and checks it again right before any payment

## Found a problem?

DM https://x.com/Pullitbox. If it is about funds at risk, say so in the first line and do not post details publicly until it is fixed.
