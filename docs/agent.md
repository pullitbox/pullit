# The agent

The agent decides what goes in the box. It never touches money directly: it returns a choice, the code checks it, and only then does anything happen.

While a box fills, the agent re-scans the market every 10 minutes and keeps a shortlist of the top 5 fresh and top 5 meta runners. It tells the log how the list changed (how many came in, how many dropped out), never which coins. When the box is full it scans once more and packs from what is running at that moment.

## Scanner

`src/scanner.ts` pulls the market from Jupiter Tokens v2 (top trending, top traded and top organic lists over 5m, 1h, 6h, 24h, plus recent tokens) and splits it in two buckets:

|             | fresh runners | meta runners |
| ----------- | ------------- | ------------ |
| age         | under 3 days  | 3 to 60 days |
| market cap  | 100k+         | 1.5m+        |
| liquidity   | 25k+          | 100k+        |
| 24h volume  | 80k+          | 300k+        |
| top holders | under 30%     | under 40%    |

Every candidate also has to pass: mint and freeze authority revoked, not flagged suspicious by Jupiter, dev holding under 10%, organic score 25+. Majors, stables and old dinosaurs are excluded by symbol. All numbers live in `src/config.ts`.

## Extra coins

`HOT` in `src/config.ts` is a short hand-picked list of big liquid coins that are hot right now. The ones with 100k+ liquidity and an organic score of 40+ join the meta runners as extra options for the rare slot. Mint authority is not checked for them, since bridged coins keep one.

What is left is ranked by turnover, 6h momentum, holder growth, net buyers and organic score. Coins used in the last 8 boxes are taken out of the lists, so the boxes do not repeat.

## The AI

The ranked lists go to a language model (through OpenRouter). It picks one coin from each bucket and writes:

- a short post while the box is sealed, without naming the coins
- one line per pick for the site log, a joke about the coin without naming it
- a line for when the box opens

## The validator

`validate()` in `src/agent.ts` rejects the answer if:

- a coin is not in the scanner's lists
- any text has a link, a hashtag, a long dash, or banned phrasing (no "100x", no "guaranteed")
- the sealed post or a log line names a coin, its ticker or any number

A rejected or missing answer falls back to the top scored coin of each bucket. So the worst case of a bad model answer is a boring box, never a coin the scanner did not approve.
