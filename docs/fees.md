# Fees

## Where fees go

$PULLIT launched on pump.fun. Its creator fees go to the dev wallet. Every 10 minutes the bot:

1. claims the creator fees (PumpPortal `collectCreatorFee`)
2. keeps 0.02 SOL in the dev wallet for transaction fees
3. sends 80% of the rest to the box wallet and 20% to the team wallet, in one transaction

The team share pays for the AI, the servers and the people building this.

## The box and the vault

Of everything that goes into the box, 10% is set aside in the vault. The vault sits in the box wallet too. The bot keeps track of it separately and does not count it towards filling the box.

The vault grows every box. Something opens it.

## Box size

The first box is 0.15 SOL. After that, every time a box opens, the bot looks at the fees of the last hour and picks the biggest size that would fill in about 25 minutes at that pace: 0.3, 0.5, 0.75, 1, 1.5, 2, 2.75, 3.5 or 4 SOL. Busy market, big box. Quiet market, small box.

## Rollover

Not every pull takes the whole box. Whatever is left stays in the box wallet and counts towards the next box, so the next one fills faster.

## Final box

If fees dry up (less than 0.1 SOL in 6 hours, and never in the first 12 hours after launch), the bot opens one last box with everything that is left, vault included, and stops.
