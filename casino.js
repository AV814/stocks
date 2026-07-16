/* ============================================================
   VAPORSTOCKS — deterministic market engine
   Every price is a pure function of (stockSeed, timestamp).
   All clients compute identical prices with zero server calls.
   ============================================================ */

const MIN_MS = 60000;                 // one price step per minute
const EVENT_RAMP_MS = 3 * 3600000;   // news impact ramps in over 3h
const EVENT_RETAIN = 0.35;           // fraction of a news move that sticks
const EVENT_DECAY_MS = 36 * 3600000; // the overreaction fades over ~36h
const BANKRUPT_PRICE = 1.0;          // delisted below 1 credit
const REVERT = 0.00005;              // per-minute pull of the walk toward its anchor

/* ---------- counter-based PRNG (stable across platforms) ---------- */
function hashInt(a) {
  a |= 0;
  a = Math.imul(a ^ (a >>> 16), 0x21f0aaad);
  a = Math.imul(a ^ (a >>> 15), 0x735a2d97);
  return (a ^ (a >>> 15)) >>> 0;
}
function rand(seed, n) {
  return hashInt(seed ^ Math.imul(n | 0, 0x9e3779b1)) / 4294967296;
}
// approx gaussian in [-1.5, 1.5], mean 0, sd ~0.5
function gauss(seed, n) {
  return rand(seed, n) + rand(seed, n + 0x5bd1e995) + rand(seed, n + 0x1b873593) - 1.5;
}
function deriveSeed(seed, n) {
  return hashInt(seed ^ Math.imul(n | 0, 0x85ebca6b));
}

/* ---------- name generation ---------- */
const SYL_A = ["Zen","Vox","Nex","Lum","Cor","Byte","Hex","Sol","Arc","Neo","Qua","Vel",
  "Ori","Pix","Dyn","Astro","Ferro","Glyph","Holo","Kine","Mag","Nova","Omni","Pulse",
  "Ryn","Syn","Terra","Umbra","Vor","Wex","Xen","Yotta","Zorb","Blu","Cryo","Dro",
  "Eco","Flux","Gro","Iri","Juno","Krill","Loch","Myco","Nimb","Opal"];
const SYL_B = ["a","o","i","ex","ix","on","ar","us","ium","era","ora","ana","yne","ade","io","ea","ent","ic"];
const SUFFIX = [
  ["Corp","Conglomerate"], ["Labs","Biotech"], ["Systems","Software"], ["Holdings","Finance"],
  ["Dynamics","Defense"], ["Energy","Energy"], ["Logistics","Shipping"], ["Media","Media"],
  ["Foods","Consumer"], ["Robotics","Robotics"], ["Aerospace","Aerospace"], ["Micro","Semiconductors"],
  ["Networks","Telecom"], ["Motors","Automotive"], ["Pharma","Pharma"], ["Mining","Materials"]
];

function makeIdentity(seed, takenTickers) {
  const a = SYL_A[Math.floor(rand(seed, 1) * SYL_A.length)];
  const b = SYL_B[Math.floor(rand(seed, 2) * SYL_B.length)];
  const [suf, sector] = SUFFIX[Math.floor(rand(seed, 3) * SUFFIX.length)];
  const name = a + b + " " + suf;
  const base = (a + b).toUpperCase().replace(/[^A-Z]/g, "");
  let ticker = base.slice(0, 3 + Math.floor(rand(seed, 4) * 2));
  let i = 0;
  while (takenTickers.has(ticker)) {
    ticker = base.slice(0, 3) + String.fromCharCode(65 + ((Math.floor(rand(seed, 5) * 26) + i) % 26));
    i++;
  }
  return { name, ticker, sector };
}

/* ---------- per-stock parameters ---------- */
function stockParams(seed) {
  return {
    p0: 4 + Math.pow(rand(seed, 10), 2) * 146,            // 4–150, skewed low
    mu: (rand(seed, 11) - 0.5) * 0.00001,                  // gentle per-minute drift
    sigma: 0.0015 + rand(seed, 12) * 0.004                 // ~6–21% daily vol
  };
}

/* ---------- scheduled news events (deterministic) ---------- */
function eventImpact(seed, k) {
  const u = rand(seed, 200 + k * 3);
  let L;
  if (u > 0.97) L = 0.55 + rand(seed, 201 + k * 3) * 0.35;        // moonshot
  else if (u < 0.04) L = -0.6 - rand(seed, 202 + k * 3) * 0.4;    // disaster
  else L = (u - 0.51) * 1.0;                                       // ordinary news
  return L;
}

// events for a stock from birth up to horizon; cheap, cached by caller
function eventsFor(stock, horizon) {
  const out = [];
  let t = stock.birth;
  for (let k = 0; k < 5000; k++) {
    const gapH = 5 + rand(stock.seed, 100 + k) * 26;   // one event every 5–31h
    t += gapH * 3600000;
    if (t > horizon) break;
    out.push({ time: t, impact: eventImpact(stock.seed, k), k });
  }
  return out;
}

function eventContrib(e, t) {
  if (t <= e.time) return 0;
  const ramp = Math.min(1, (t - e.time) / EVENT_RAMP_MS);
  if (ramp < 1) return e.impact * ramp;
  const dt = t - e.time - EVENT_RAMP_MS;
  return e.impact * (EVENT_RETAIN + (1 - EVENT_RETAIN) * Math.exp(-dt / EVENT_DECAY_MS));
}
function eventDriftAt(events, t) {
  let d = 0;
  for (const e of events) {
    if (e.time > t) break;
    d += eventContrib(e, t);
  }
  return d;
}

/* ---------- headline generation ---------- */
const HEADLINES = {
  huge_up: [
    "{name} unveils breakthrough {sector} platform — analysts stunned",
    "{ticker} soars: {name} rumored acquisition target",
    "{name} lands landmark government contract",
    "Blowout quarter: {name} doubles guidance"
  ],
  up: [
    "{name} beats earnings expectations",
    "Analysts upgrade {ticker} to strong buy",
    "{name} announces major partnership in {sector}",
    "{name} launches share buyback program",
    "Insiders quietly accumulating {ticker}, filings show"
  ],
  flat: [
    "{name} reports mixed quarterly results",
    "{ticker} drifts as investors await {name} guidance",
    "{name} announces routine board reshuffle",
    "Analysts split on outlook for {ticker}"
  ],
  down: [
    "{name} misses quarterly earnings expectations",
    "Analysts downgrade {ticker} on weak {sector} demand",
    "{name} hit by supply chain disruptions",
    "Layoff rumors swirl at {name}"
  ],
  huge_down: [
    "{name} under investigation for accounting irregularities",
    "{name} recalls flagship product after safety scare",
    "CEO of {name} resigns amid scandal",
    "{name} loses biggest customer; guidance slashed"
  ]
};

function headlineFor(stock, ev) {
  const L = ev.impact;
  const bucket = L > 0.35 ? "huge_up" : L > 0.08 ? "up" : L > -0.08 ? "flat" : L > -0.35 ? "down" : "huge_down";
  const list = HEADLINES[bucket];
  const tpl = list[Math.floor(rand(stock.seed, 300 + ev.k) * list.length)];
  return {
    text: tpl.replace(/{name}/g, stock.name).replace(/{ticker}/g, stock.ticker).replace(/{sector}/g, stock.sector.toLowerCase()),
    bucket, impact: L, time: ev.time, ticker: stock.ticker
  };
}

/* ============================================================
   Engine: incremental walk cache + O(1)-ish price lookups
   ============================================================ */
class MarketEngine {
  constructor() { this.cache = new Map(); }

  _state(stock) {
    let s = this.cache.get(stock.seed);
    if (!s) {
      s = { step: 0, W: 0, deadStep: null, events: [], evHorizon: stock.birth,
            evIdx: 0, evSum: 0, params: stockParams(stock.seed) };
      this.cache.set(stock.seed, s);
    }
    return s;
  }

  _ensureEvents(stock, s, horizon) {
    if (horizon > s.evHorizon) {
      s.events = eventsFor(stock, horizon + 7 * 86400000);
      s.evHorizon = horizon + 7 * 86400000;
    }
  }

  // advance the walk to targetStep, watching for bankruptcy along the way
  _advance(stock, s, targetStep) {
    const { p0, mu, sigma } = s.params;
    const logP0 = Math.log(p0);
    while (s.step < targetStep) {
      s.step++;
      s.W = s.W * (1 - REVERT) + gauss(stock.seed, s.step);
      if (s.deadStep === null) {
        const t = stock.birth + s.step * MIN_MS;
        // roll fully-decayed events into a running sum at their permanent value
        while (s.evIdx < s.events.length &&
               s.events[s.evIdx].time + EVENT_RAMP_MS + 4 * EVENT_DECAY_MS <= t) {
          s.evSum += s.events[s.evIdx].impact *
            (EVENT_RETAIN + (1 - EVENT_RETAIN) * Math.exp(-4));
          s.evIdx++;
        }
        let drift = s.evSum;
        for (let j = s.evIdx; j < s.events.length && s.events[j].time <= t; j++) {
          drift += eventContrib(s.events[j], t);
        }
        const logP = logP0 + mu * s.step + sigma * s.W + drift;
        if (Math.exp(logP) < BANKRUPT_PRICE) s.deadStep = s.step;
      }
    }
  }

  // price at time t; returns null if bankrupt by then
  price(stock, t) {
    if (t < stock.birth) return null;
    const s = this._state(stock);
    this._ensureEvents(stock, s, t);
    const target = Math.floor((t - stock.birth) / MIN_MS);
    if (target > s.step) this._advance(stock, s, target);
    if (s.deadStep !== null && target >= s.deadStep) return null;

    const { p0, mu, sigma } = s.params;
    // interpolate into the next step for smooth per-second motion
    const frac = ((t - stock.birth) % MIN_MS) / MIN_MS;
    const W0 = this._walkAt(stock, s, target);
    const W = W0 + frac * (gauss(stock.seed, target + 1) - REVERT * W0);
    const wiggle = 0.0006 * Math.sin(t / 700 + stock.seed % 100);
    const logP = Math.log(p0) + mu * (target + frac) + sigma * W + eventDriftAt(s.events, t) + wiggle;
    return Math.exp(logP);
  }

  // W at an arbitrary past step (recompute backwards is expensive; sample forward instead)
  _walkAt(stock, s, step) {
    if (step === s.step) return s.W;
    // recompute from scratch only for history sampling (charts); cheap enough
    let W = 0;
    for (let i = 1; i <= step; i++) W = W * (1 - REVERT) + gauss(stock.seed, i);
    return W;
  }

  // efficient history sampler for charts: one forward pass
  history(stock, from, to, points) {
    const s = this._state(stock);
    this._ensureEvents(stock, s, to);
    const { p0, mu, sigma } = s.params;
    const logP0 = Math.log(p0);
    const startStep = Math.max(0, Math.floor((from - stock.birth) / MIN_MS));
    const endStep = Math.max(startStep, Math.floor((to - stock.birth) / MIN_MS));
    const stride = Math.max(1, Math.floor((endStep - startStep) / points));
    let W = 0;
    const out = [];
    const dead = this.bankruptcyStep(stock, to);
    for (let i = 1; i <= endStep; i++) {
      W = W * (1 - REVERT) + gauss(stock.seed, i);
      if (dead !== null && i >= dead) break;
      if (i >= startStep && (i - startStep) % stride === 0) {
        const t = stock.birth + i * MIN_MS;
        out.push({ t, p: Math.exp(logP0 + mu * i + sigma * W + eventDriftAt(s.events, t)) });
      }
    }
    return out;
  }

  bankruptcyStep(stock, horizon) {
    const s = this._state(stock);
    this._ensureEvents(stock, s, horizon);
    const target = Math.floor((horizon - stock.birth) / MIN_MS);
    if (target > s.step) this._advance(stock, s, target);
    return s.deadStep !== null && s.deadStep <= target ? s.deadStep : null;
  }

  bankruptcyTime(stock, horizon) {
    const step = this.bankruptcyStep(stock, horizon);
    return step === null ? null : stock.birth + step * MIN_MS;
  }

  // all headlines up to now for a set of stocks, newest first
  news(stocks, now, limit = 60) {
    const items = [];
    for (const st of stocks) {
      const s = this._state(st);
      this._ensureEvents(st, s, now);
      const deadAt = st.dead || null;
      items.push({ text: `${st.name} (${st.ticker}) begins trading on the exchange`, bucket: "ipo", impact: 0, time: st.birth, ticker: st.ticker });
      for (const ev of s.events) {
        if (ev.time > now) break;
        if (deadAt && ev.time > deadAt) break;
        items.push(headlineFor(st, ev));
      }
      if (deadAt && deadAt <= now) {
        items.push({ text: `${st.name} (${st.ticker}) files for bankruptcy — shares delisted at zero`, bucket: "bankrupt", impact: -9, time: deadAt, ticker: st.ticker });
      }
    }
    items.sort((a, b) => b.time - a.time);
    return items.slice(0, limit);
  }
}

export { MarketEngine, deriveSeed, makeIdentity, rand, MIN_MS, BANKRUPT_PRICE };
