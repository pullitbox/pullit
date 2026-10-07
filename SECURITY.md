# Security

## Keys

- the dev wallet key (claims fees) and the box wallet key (pays prizes) are stored as Cloudflare Worker secrets
- locally they live in `.env`, which is git-ignored
- no key, seed phrase or API key is in this repo or its history

## Wallets

All wallets are listed on the site under rules. Every transaction is public on Solana.

- dev: receives creator fees, splits them 80/20, nothing else
- box: holds the prize pool and the vault, only sends to draw winners
- team: receives 20% of fees

## Found a problem?

DM https://x.com/Pullitbox. If it is about funds at risk, say so in the first line and do not post details publicly until it is fixed.
