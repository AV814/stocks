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
