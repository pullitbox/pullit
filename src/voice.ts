// The box's voice for the public log on the site. Deadpan, lowercase, a little mean, one dumb
// joke per line. Lines about the picks come from the AI (agent.ts); these are the routine ones.

import { similar } from "./agent.ts";

// lines already on the log; a template that would repeat one of them is skipped
let used: string[] = [];
export const remember = (lines: string[]) => {
  used = lines.slice(-80);
};
const pick = (xs: string[]) => {
  const fresh = xs.filter((x) => !used.some((u) => similar(u, x)));
  return fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : "";
};

export const say = {
  fee: (total: string, box: string, vault: string) =>
    pick([
      `${total} sol of fees. the jeets paid for this box. thank you jeets`,
      `fees in: ${box} to the box, ${vault} to the vault. every flip feeds me`,
      `another ${total} sol. you trade, i eat. healthy relationship`,
      `${total} sol from fees. imagine paying gas to make a box richer. couldnt be me. is you`,
      `ate ${total} sol of fees. ${vault} went in the vault. i am more responsible than your dad`,
      `fees came in. ${box} for me, ${vault} for the vault. tastes like your bad entries`,
      `${total} sol in fees. somebody overtraded again. thank you for your service`,
      `${box} sol into the box. whoever keeps flipping 0.1 sol all day, i see you, i love you`,
    ]),
  scan: (n: string, out: number) =>
    pick([
      `${n} coins scanned. ${out} binned. three of them had the same dev wallet lol`,
      `checked ${n} charts. ${out} were jeet farms with a logo`,
      `${n} coins in, ${out} out. if your bag got rejected, that says something`,
      `looked at ${n} coins. threw out ${out}. one dev held 40% of his own coin and called it community`,
      `went through ${n} coins. ${out} went in the trash. fake volume has a smell`,
      `scanned ${n} coins. ${out} were bundled so hard they had their own zip code`,
      `${n} coins checked. ${out} rejected. some of you are buying these. skill issue`,
    ]),
  sealed: (id: number, seal: string) =>
    pick([
      `box #${id} sealed. ${seal}. even i cant open it now. trust issues are healthy`,
      `seal on box #${id}: ${seal}. write it down. tattoo it if you want`,
      `box #${id} closed. hash ${seal}. contents locked, dev locked out`,
      `box #${id} sealed: ${seal}. no peeking. not even me, and i live here`,
      `taped box #${id} shut. seal ${seal}. if it changes, call me a rug. it wont`,
      `box #${id} sealed: ${seal}. screenshot it, you paranoid little goblins`,
    ]),
  packed: (id: number, sol: string, n: number) =>
    pick([
      `box #${id}: ${sol} sol. ${n} wallets in the draw. one of you is about to be insufferable`,
      `${sol} sol in box #${id}. ${n} of you in. odds are bad, vibes are good`,
      `box #${id}: ${sol} sol inside, ${n} of you in the draw. one of you is about to be unbearable`,
      `box #${id} has ${sol} sol and ${n} holders in the draw. statistically you lose. emotionally you dont`,
    ]),
  locked: (slot: string) =>
    pick([
      `block ${slot}. future block. not even the validators know yet. sit`,
      `the winner is written in block ${slot}. it hasnt been written yet. spooky`,
      `block ${slot} picks. not me, not the team, not your favorite kol`,
      `block ${slot} decides who opens me. it doesnt exist yet. stop refreshing`,
      `locked to block ${slot}. nobody knows it yet. not the dev, not the kols, not your group chat`,
      `waiting for block ${slot}. about 20 seconds. go touch grass, ill wait`,
    ]),
  win: (who: string, tier: string, sol: string, sym: string, extra: string) =>
    pick([
      `${who} hit ${tier}. ${sol} sol of $${sym}${extra}. screenshot or it didnt happen`,
      `congrats ${who}. ${tier}, ${sol} sol of $${sym}${extra}. the rest of you, cope responsibly`,
      `${who} pulled ${tier}. ${sol} sol of $${sym}${extra}. someone check on the sellers`,
      `${who} pulled ${tier}: ${sol} sol of $${sym}${extra}. dont sell it in 4 minutes. you will`,
      `${tier} for ${who}. ${sol} sol of $${sym}${extra}. the rest of you, there is always the next box`,
      `${who} got ${tier}. ${sol} sol of $${sym}${extra}. post it or it didnt happen`,
    ]),
  unsealed: (id: number) =>
    pick([
      `box #${id} open. seal matches. the conspiracy thread can be deleted now`,
      `seal on box #${id} checks out. nothing swapped. boring for the fud guys`,
      `unsealed #${id}. hash matches. trustless, unlike your group chat`,
      `box #${id} unsealed. seal matches. told you. im cardboard, not a dev`,
      `opened box #${id}. same stuff i sealed. disappointing for the conspiracy guys`,
    ]),
  pick: (kind: "fresh" | "meta") =>
    kind === "fresh"
      ? pick([
          `picked something young and loud. buyers keep showing up. thats all youre getting`,
          `the fresh one is a few hours old and already has more holders than your last 3 bags`,
          `grabbed a newborn runner. chart looks like it drank 4 coffees`,
          `fresh pick is in. not telling. it has buyers, you dont have it`,
          `young coin, real volume, no bundles. rare combo in these trenches`,
          `picked a fresh one that survived my filters. most dont`,
        ])
      : pick([
          `the rare one has been around a while. still standing. respect`,
          `meta pick locked. it has survived more dumps than you have`,
          `the second coin is a runner of the meta. you have seen it on your timeline`,
          `picked something with a real holder base. boring to some, prize to one of you`,
          `rare slot filled. older coin, still pumping, dev barely holds`,
          `the meta pick is in. kols are already late on it`,
        ]),
  watch: (added: number, dropped: number) =>
    added + dropped === 0
      ? pick([
          `re-scanned the market. same runners as 10 min ago. the trenches are sleepy`,
          `checked the charts again. my shortlist holds. nothing new worth your prize`,
        ])
      : pick([
          `re-scanned the market. ${added} new runners on my list, ${dropped} kicked off for dumping. the box packs whatever runs when it fills`,
          `shortlist update: ${added} in, ${dropped} out. the ones that dumped are dead to me`,
          `${dropped} coins fell off my list in 10 minutes. ${added} new ones earned a spot. the trenches move fast`,
        ]),
  cantSell: () =>
    pick([
      `ngl i wanted to rug all of you today. then i read my own code. no sell function. just buy and burn`,
      `every dev can dump on you. i cant. no sell button. read the code lad`,
      `i tried to sell once. there is no function for it. so i burn instead. character development`,
      `i only know two moves: buy and burn. selling was never installed`,
    ]),
  frenzyNudge: (level: number) =>
    level >= 3
      ? pick([`max frenzy. best odds i have. dont stop now`, `frenzy 3/3. the odds are stupid good right now`])
      : pick([
          `frenzy ${level}/3. trade more, the odds get better. its that simple`,
          `frenzy at ${level}. more volume this hour, more epics next box`,
          `the odds are sitting at frenzy ${level}. you can fix that`,
        ]),
  burn: (sol: string) =>
    pick([
      `bought ${sol} sol of $PULLIT and burned it. supply goes one way`,
      `${sol} sol of $PULLIT bought and sent to the void. gone forever`,
      `burned ${sol} sol worth of $PULLIT. fewer bags for the jeets`,
      `${sol} sol buyback. burned on the spot. no promises, just a tx`,
      `bought ${sol} sol of $PULLIT and burned it. i wanted to exit on all of you but i literally cant sell`,
      `burned ${sol} sol of $PULLIT. checked my code for a sell button again. not there. cope`,
    ]),
  rollover: (sol: string, next: number) =>
    pick([
      `${sol} sol rolls into box #${next}. starts heavier than your conviction`,
      `${sol} sol left over. box #${next} begins with a snack`,
      `${sol} sol stays in me for box #${next}. leftovers. like your bags`,
      `kept ${sol} sol for box #${next}. head start. you are welcome`,
    ]),
  info: (holders: string, inDraw: string, entry = 20) =>
    pick([
      `${holders} holders, ${inDraw} in the draw. the gap is the people who bought 3 dollars and left`,
      `${inDraw} in the draw. hold $${entry} for 7 min. this is not hard, anon`,
      `${holders} holders. ${inDraw} eligible. the rest are tourists`,
      `${holders} holders. ${inDraw} in the draw. the rest bought 2 dollars and expect a lambo`,
      `${inDraw} of ${holders} holders are in the draw. its ${entry} bucks and 7 minutes. read the thread lad`,
    ]),

  idle: (pct: number) =>
    pick([
      `${pct}% full. trade something. anything. i am starving`,
      `box at ${pct}%. this is the part where you buy and stop asking wen`,
      `${pct}%. slow. who sold the volume`,
      `still ${pct}%. charts are flat and so is my personality right now`,
    ]),
  vault: (v: string) =>
    pick([
      `vault at ${v} sol. it only goes up. something opens it. not telling`,
      `${v} sol sitting in the vault. locked. you will see`,
      `the vault has ${v} sol and zero plans to explain itself. read the thread lol`,
    ]),
  lastWinner: (who: string) =>
    pick([
      `${who} won the last box. still holding it? asking for a friend`,
      `checking on ${who}. last winner. if you sold already, the block regrets picking you`,
    ]),
  pace: (sol: string, eta: string) =>
    pick([
      `${sol} sol of fees in the last hour. box full in ~${eta} min at this pace. trade faster`,
      `last hour fed me ${sol} sol. eta ${eta} min. could be sooner if you stopped watching and started trading`,
      `pace check: ${sol} sol per hour, ~${eta} min to open. read the thread lad`,
    ]),
  bored: () =>
    pick([
      `nothing happening. ct is posting the same 3 charts again`,
      `quiet. somewhere a kol is typing "this is the one"`,
      `no trades for a bit. you are all asleep or rugged elsewhere`,
      `dead minutes. read the thread lad, then buy`,
      `i am a box. i wait. you are a human. you could be trading`,
    ]),
  milestone: (id: number, pct: number, entry = 20) =>
    pct >= 90
      ? pick([
          `box #${id} at ${pct}%. almost. hold your bags, not your breath`,
          `${pct}%. box #${id} is shaking. last chance to get in the draw`,
        ])
      : pct >= 75
        ? pick([
            `box #${id} hit ${pct}%. $${entry} for 7 min and you are in. read the thread lad`,
            `${pct}% on box #${id}. the sellers are going to feel this one`,
          ])
        : pct >= 50
          ? pick([
              `box #${id} at ${pct}%. half full or half empty if you sold`,
              `${pct}% on box #${id}. keep trading, i am getting heavy`,
            ])
          : pick([`box #${id} at ${pct}%. it begins`, `box #${id} at ${pct}%. slowly, then all at once`]),
  pump: (pct: string) =>
    pick([
      `$PULLIT up ${pct}%. more fees, fatter box. whoever is buying, keep going`,
      `+${pct}%. the box felt that. feed me`,
      `${pct}% pump. someone read the thread`,
    ]),
  dump: (pct: string) =>
    pick([
      `-${pct}%. paper hands spotted. the box fills slower and remembers names`,
      `$PULLIT down ${pct}%. sellers left the draw. more tickets for the rest`,
      `${pct}% dip. who panicked. it was a 1 minute candle lad`,
    ]),
  joined: (d: number, n: number) =>
    pick([
      `${d} new wallets in the draw. ${n} now. it gets crowded in here`,
      `+${d} in the draw. ${n} total. somebody shared the link`,
    ]),
  left: (d: number, n: number) =>
    pick([
      `${d} wallets dropped out of the draw. ${n} left. bigger odds for the patient ones`,
      `${d} paper hands out. ${n} still in. thanks for the tickets`,
    ]),

  xpost: (pct: number) =>
    pick([
      `box at ${pct}%. i am cardboard and i have more conviction than your portfolio`,
      `breaking: local box ${pct}% full, refuses to elaborate`,
      `> be me\n> box\n> ${pct}% full\n> holders still asking wen`,
      `gm to holders only. sellers get a gn`,
      `poll: are you holding $PULLIT or are you exit liquidity somewhere else`,
    ]),

  // reactions to what holders do (from the 5 min holder snapshots)
  whale: (who: string, pct: string) =>
    pick([
      `${who} aped ${pct}% of supply. bro thinks tickets scale forever. they dont`,
      `whale alert: ${who}, ${pct}%. capped at 1% for tickets. enjoy the view`,
      `${who} just took ${pct}% of supply in one go. chill. leave some for the rest of us`,
      `${who} bought ${pct}% of supply. ser this is a box`,
      `${who} grabbed ${pct}% of supply. bag capped at 1% for tickets anyway. nice try`,
    ]),
  dumped: (who: string, pct: string, nearOpen: boolean) =>
    nearOpen
      ? pick([
          `${who} sold the whole ${pct}% bag right before the box opens. timing of a legend`,
          `${who} dumped everything right before box opening. the block will not miss you`,
        ])
      : pick([
          `${who} sold the whole ${pct}% bag. see you at the top, buying back`,
          `${who} is out. full bag. the box will remember this`,
          `${who} sold everything. no tickets, no box, no friends. ngmi`,
        ]),
  newbag: (who: string, pct: string) =>
    pick([
      `${who} walked in with ${pct}% of supply. welcome. dont be weird`,
      `new face: ${who}, ${pct}%. we will see how long those hands last`,
    ]),
  paper: (who: string) =>
    pick([
      `${who} sold half the bag. half commitment, half tickets`,
      `${who} trimmed. took profit on a box. respect, kind of`,
    ]),
  diamond: (who: string) =>
    pick([
      `${who}: 24h, never sold. 3x tickets. the rarest coin in the trenches is patience`,
      `24h hold from ${who}. 3x tickets. jeets could never`,
      `${who} has held me for 24h. 3x tickets. marry me`,
      `${who} hit 24h. 3x tickets. a rare specimen, someone study them`,
    ]),
};
