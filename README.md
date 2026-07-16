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
