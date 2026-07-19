# VAPORSTOCKS

A fake-stock trading game for a friendly competition. Static site (GitHub Pages) + Firebase for auth and shared state. No server, no billing plan required — everything runs on the Firebase free (Spark) tier.

## How it works (the trick)

There is no server generating prices. Every stock's price is a **pure deterministic function of its seed and the clock**: a seeded random walk plus scheduled news events whose price impact ramps in over the 3 hours after the headline drops. Every player's browser computes identical prices locally, so the tape ticks every second with zero database traffic.

Firebase only stores what genuinely has to be shared:

- `market/state` — the stock roster (seeds, birth/death times, names). Mutated only when a stock goes bankrupt or a replacement IPOs, via a Firestore transaction run by whichever client notices first. Transactions serialize, so concurrent players can't corrupt it.
- `users/{uid}` — cash, holdings, display name. Trades are Firestore transactions against your own doc.
- `users/{uid}/trades` — trade log.

Because news impact ramps in *after* the headline, checking the News tab early and reacting fast is a real edge. That's the game.

Stocks that cross below ₡1.00 are bankrupt and delisted (holders get nothing), and a fresh IPO spawns to keep the roster at 20.

## Setup (~10 minutes)

### 1. Firebase project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (Analytics optional, off is fine).
2. **Build → Authentication → Get started → Email/Password → Enable.**
3. **Build → Firestore Database → Create database** → production mode → pick a region.
4. Firestore → **Rules** tab → paste the contents of `firestore.rules` → Publish.
5. Project settings (gear icon) → **Your apps → Web app (`</>`)** → register it (no hosting needed) → copy the `firebaseConfig` object into `js/firebase-config.js`.

### 2. GitHub Pages
1. Push this folder to a GitHub repo.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → branch `main`, folder `/ (root)`.
3. Your game is at `https://<you>.github.io/<repo>/`.

### 3. Lock sign-ins to your friends (recommended)
In Firebase → Authentication → Settings → **Authorized domains**, add your `github.io` domain (localhost is there by default). To keep randoms out entirely, Authentication → Settings → User actions → disable *Enable create* after everyone has signed up, or just don't share the URL.

### 4. First run
The first person to sign in initializes the market automatically (20 stocks with 1–72 hours of backfilled price history, so charts aren't empty on day one). Everyone starts with **₡1,000**.

## Casino

The **Casino** tab has slots (~91% return to player; paytable shown in-game) and blackjack (6-deck shoe reshuffled each hand, dealer stands on all 17s, blackjack pays 3:2, double down allowed, no splits). All outcomes are computed client-side with the same trust model as trading; cash moves through the same Firestore transaction guardrails (no negative balances).

## Prediction markets

The **Predictions** tab lets players stake credits on questions the admin posts, e.g. "Will KRILLIUM survive the week?" with options like Yes (2x) / No (1.8x). Payout = stake × multiplier, one option per player per question (top-ups on the same option allowed).

The **Admin** tab (visible only to the admin account) creates questions, sets per-option multipliers, locks betting, resolves the outcome, or voids a question (refunds all stakes). It also shows per-option staked totals and payout liability. Losing stakes are burned and winnings are minted, so multipliers are pure game design — set them however you like.

Payout mechanics: when a question resolves, each winner's own browser claims the credits via a Firestore transaction on their own user doc the next time they load the game (the rules only allow players to write their own account, so the admin can't push cash to others directly). Bets are recorded under `predictions/{id}/bets/{uid}` for auditing.

### Admin setup (one time)
1. Sign in to the game, open the **Predictions** tab, and copy your UID from the note at the bottom (or grab it from Firebase console → Authentication).
2. Paste it as `ADMIN_UID` in `js/firebase-config.js`.
3. Paste the same UID into the `predictions` rule in `firestore.rules` and republish the rules in the Firebase console.


### Treasury (admin)

The Admin tab includes a Treasury panel listing every player with their cash balance and Add / Remove / Set controls. Adjustments touch cash only (holdings are never modified), can't take anyone negative, are logged to the `transfers` feed as THE HOUSE, and toast the player if they're online. Enforced by an admin-only branch in the Firestore rules.


## The Vapor Lounge extras

**Scratchers** — instant tickets at three price points (Vapor Bucks ₡10, Neon Fortune ₡50, Diamond Heist ₡250). Scratch a 3x3 grid by clicking or dragging; three matching symbols wins that prize, up to 1000x. About 1 in 5 tickets wins something; overall return is ~72%.

**VaporBall** — a nightly Powerball-style lottery. Pick 4 numbers (1-20) plus a VaporBall (1-5), ₡25 per ticket, draws every night at midnight ET (05:00 UTC). The winning numbers are a pure function of the draw index using the same deterministic PRNG as stock prices, so every client computes the identical draw and nobody — including the admin — can rig or predict it. The jackpot starts at ₡1,000, grows by a quarter of every ticket sold, and rolls over when nobody hits 4+VaporBall (co-winners split the pot). Settlement and prize claims use the same client-maintenance pattern as the market: the first browser to notice a completed draw does the bookkeeping (claims are checked for the past 7 draws, so nobody loses a prize by being offline a few days), and each winner's own client credits their prizes.


## More Vapor Lounge games & governance

**Five-Card Draw Poker** (casino) — heads-up against the house. Bet, receive five cards, optionally double down while the dealer is still face-down, mark any cards to discard, then draw and show down. The dealer draws on a sensible strategy. Wins pay 1.95x the stake, and doubling down buys the house a sixth card (it plays its best five of six) — sim-tuned to roughly 50/50 overall (~1% house). Card flips animate on the swap and showdown, in blackjack too.


**Roulette** — European single-zero wheel. Stack chips of any size across straight numbers (35:1), dozens (2:1), and even-money outside bets; zero sweeps the outside. ~2.7% house edge, the gentlest table in the Lounge.

**Keno** — a shared draw every 3 minutes: 20 of 80 numbers derived deterministically from the round index, so every client sees the identical draw at the same moment. Pick up to 10 numbers, bet, and your ticket plays the next draw (top prize 25,000x on a perfect 10). Tickets persist locally and settle on your next visit if you close the tab.

**Daily bonus** — the 🎁 button in the header grants ₡50 once per day (resets midnight ET).

**Free-pick predictions** — the Admin tab can now post two kinds of predictions: the original wager type, and a free type where players just pick an answer at no cost and everyone who guessed right receives a fixed reward when it resolves. A credit faucet with a quiz attached.

**Prediction timers** — predictions can be given an optional auto-lock timer (in hours). When it expires, betting closes automatically; manual Lock still works anytime, and Reopen clears the timer.

**Force-sell (admin)** — the Treasury can liquidate any player's entire holdings into cash at current market prices (delisted stock wiped at zero), with a confirmation showing the position breakdown. For cheaters and other governance needs. Logged to the transfer feed.


## Stats, presence & dividends

Every casino game shows an all-time global play counter at the top of its panel (spins, hands, tickets), stored in `market/casinoStats` and updated live. Each play also increments the player's personal `gameStats`.

Hovering a name on the leaderboard (tap on mobile) opens a stat card: their current holdings priced live, and how many of each game they've played. On the right of each row, a green dot shows who's online, powered by Firebase Realtime Database presence: each client arms a server-side `onDisconnect` handler, so the dot flips off the moment a tab closes or a connection drops. RTDB is used only for the `status/` presence node; all game data stays in Firestore.

**Dividends**: when a stock receives positive news (impact ≥ 0.15), holders are paid 5-10% of the share price at event time per share — bigger news, bigger rate. Payouts are computed deterministically from the news events with a `lastDivAt` cursor on each player's doc, checked every minute while online and caught up on the next visit. Owning stocks now yields income, not just price exposure.


## Trading floor chat

The Chat tab is one public room for everyone: last 50 messages streamed live, avatars, an online count from presence, and an unread dot on the tab when messages arrive while you're elsewhere. You can delete your own messages; the admin can delete anyone's. The 🎨 button opens a doodle pad: a 50x50 pixel canvas with a 12-color palette — draw and upload straight into the chat as a crisp pixel-art card. Enforced in the rules: authors post as themselves, messages are text (500-char cap) or a small PNG doodle (12KB cap).


## Work (guaranteed wages)

The Work tab is the counterweight to the casino: three skill games that pay honest wages with no house edge, each capped at ₡200/day (resets midnight ET, tracked on your user doc).

- **Minesweeper** — 9x9, 10 mines, first click always safe. Clearing the board pays ₡50 plus a speed bonus up to ₡30 (full under 60 seconds). Right-click or Flag mode to mark mines.
- **Snake** — ₡2 per pellet, banked when you crash. Speeds up as you grow. Keyboard or the on-screen pad on touch devices.
- **Intrusion** — a typing breach: command strings appear and you must type each one exactly before a draining timer empties. Each cleared command banks credits and refunds a little time; one wrong key or a timeout ends the run, and the pace ramps with your streak. Green-terminal styling like Hack, but a reflex/typing job.
- **Pipes** — a BioShock-style hack: drag tiles onto each other to swap them (or tap-tap on mobile) and route the flow from inlet to outlet — no rotation, just like the original, and no four-way pieces. Every board is dealt solvable: a hidden solution path is generated first and its pieces shuffled across the grid for you to find. Fluid starts after an 8-second grace, advances every 1.5s, locks pipes it fills, and bursts on any unconnected pipe. ₡60 + speed bonus up to ₡30.
- **Hack** — a Fallout-style terminal: twelve candidate passwords buried in symbol noise, four attempts, and every wrong guess reports its LIKENESS (letters correct and in position). Deduce the password for ₡30 + ₡20 per spare attempt. Click words in the dump or type them at the prompt.

Work plays are counted in the same global and per-player stat counters as casino games.


## Vapor Tower (Raid tab)

A text-adventure roguelike and the game's biggest repeatable money loop. Sign a contract at one of three difficulties (entry ₡50/₡150/₡400, paying ₡160/₡520/₡1,500), buy per-run gear in the shop — weapons, armor, Vitality Smoothies — then fight turn-by-turn through four floors of corporate security with supply crates between fights (cash, potions, attack buffs, or the occasional trap), and take the boss in the penthouse for the payout. Combat is intent-based: every enemy telegraphs its next move, and Block (70% reduction plus a riposte) is the answer to telegraphed slams and charged nukes. Enemies come in archetypes (brutes, twins, guards, leeches, bombers), bosses enrage at half health, weapons carry traits (crit, armor-pierce, stun, bleed), items include Health Potions, Adrenaline, and EMP Grenades, and Supply Offices offer pick-1-of-3 perk drafts between fights. Death or fleeing forfeits the entry and gear; gear never carries between runs, so every attempt demands fresh investment. Runs persist through reloads, and payouts are crash-safe. Timing note: everything scheduled at "midnight ET" (Powerball draw, daily bonus, work caps) now uses true America/New_York midnight, DST-proof.


## Recent additions

- **Sell everything** button on the Portfolio tab liquidates all positions at market in one transaction (with a confirmation breakdown).
- **Passive dividends**: holdings pay 1% of their current value every 10 minutes, accruing while offline (capped at 48 hours of accrual). Returning after a gap shows a "while you were away" toast with the total. News-event dividends still pay on top.
- **Keno**: draws every 90 seconds now. Buy multi-game cards — the same picks and bet across up to 50 consecutive draws, paid per draw with a running total, plus a detailed per-game report (your picks with hits highlighted, multiplier, net, and card progress).
- **Admin Danger Zone**: per-system resets (chat, predictions, Powerball, transfer log, game counters, players back to ₡1,000) and a RESET EVERYTHING button, each requiring typed confirmation. Requires the widened admin rules branch.

## Profile pictures & sending credits

Click the avatar circle in the header (next to your cash) to set a profile picture. The image is center-cropped, shrunk to 96px, and stored as a compressed data URL on your user doc — no Firebase Storage or billing plan required. It shows next to your name on the leaderboard.

The leaderboard also has a **Send ₡** button on every other player's row. Transfers move cash in a single atomic transaction, the recipient gets a live "CREDITS RECEIVED" toast, and every transfer is logged to the `transfers` collection with sender, recipient, amount, and timestamp. The Firestore rules only permit writing another player's doc when the sole change is their cash increasing, so credits can be given but never taken.

## Local development

Modules require a web server — opening `index.html` directly won't work. From the project folder:

```
python3 -m http.server 8080
```

then open http://localhost:8080.

## Tuning knobs

All in `js/market.js`:

| What | Where | Default |
|---|---|---|
| Roster size | `MIN_ROSTER` in `app.js` | 20 |
| Starting cash | `STARTING_CASH` in `app.js` | 1000 |
| Bankruptcy threshold | `BANKRUPT_PRICE` | ₡1.00 |
| News frequency | `gapH` in `eventsFor` | one per stock every 5–31h |
| News impact ramp | `EVENT_RAMP_MS` | 3 hours |
| Volatility | `sigma` in `stockParams` | ~6–21% daily |
| Event size / tail risk | `eventImpact` | moonshots ~3%, disasters ~4% of events |

Changing these mid-game changes history for everyone (prices are recomputed from seeds), so tune before launch or accept a market-wide "revision of reality."

## Honest limitations

- **Trust model:** trade prices are computed client-side, so a determined friend could cheat via the browser console. Firestore rules stop the basics (no negative cash, can't touch other accounts), but this is a friends game, not a bank. If someone's returns look impossible, check their `trades` subcollection — every fill is logged with price and timestamp.
- **Clocks:** prices use the local device clock. A skewed clock shows slightly stale prices; nothing breaks.
- **Free-tier headroom:** with a handful of players the read/write volume is a rounding error against Spark limits.
