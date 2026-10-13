# Fees

## Where fees go

$PULLIT launched on pump.fun. Its creator fees go to the dev wallet. Every 10 minutes the bot:

1. claims the creator fees (PumpPortal `collectCreatorFee`)
2. keeps 0.02 SOL in the dev wallet for transaction fees
3. sends the box share of the new fees to the box wallet, the rest stays in the dev wallet. before the bond: 75% (25% stays with the dev). after the bond: 80%

The bot remembers what the dev wallet held before the first claim and the 20% it kept since, so that SOL is never split again. The 20% pays for the AI, the servers and the people building this.

## The box and the vault

Of everything that goes into the box, 10% is set aside in the vault. The vault sits in the box wallet too. The bot keeps track of it separately and does not count it towards filling the box.

The vault grows every box. Only a secret pull opens it.

## Box size

The first box is 0.15 SOL. After that, every time a box opens, the bot looks at the fees of the last hour and picks the biggest size that would fill in about 25 minutes at that pace: 0.3, 0.5, 0.75, 1, 1.5, 2, 2.75, 3.5 or 4 SOL. Busy market, big box. Quiet market, small box.

## Prizes, buyback and burn

When a box opens:

1. 10% of the box buys $PULLIT on the market and burns it (SPL `Burn`, the supply goes down). Each burn has its own transaction on the site log.
2. 0.005 SOL stays for transaction fees and token account rent, so they never eat into the vault.
3. The tier decides the prize: common 50% of what is left, rare 75%, epic 100%, secret 100% plus the whole vault. Secret is 0.5% per box. The vault is no longer filled; what is in it goes to a secret pull or into the final box.
4. The prize is swapped into the sealed coin and goes straight to the winner's wallet.

Every payment is saved the moment it is signed, before it is sent, and again when it lands. If the bot restarts in the middle of a payout it first asks the chain whether that transaction landed, so it never pays twice. The draw itself is saved once computed, so a retry pays the same winner. If the sealed coin can no longer be bought after 5 tries, the prize is paid in SOL. If the buyback fails, that SOL stays in the box and rolls over; if only the burn fails, it is retried every minute until the bought $PULLIT is gone.

The bot can only buy. Every swap in the code starts from SOL, there is no parameter to swap anything else, and `test/executor.test.ts` fails if a second kind of swap ever appears.

## Rollover

Not every pull takes the whole box. Whatever is left stays in the box wallet and counts towards the next box, so the next one fills faster.

## Final box

If fees dry up (less than 0.1 SOL in 6 hours, and never in the first 12 hours after launch), the bot opens one last box with everything that is left, vault included, and stops.
