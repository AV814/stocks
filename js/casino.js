/* ============================================================
   VAPORSTOCKS — casino module (slots + blackjack)
   Pure client-side games. Cash moves via api.settle(), which
   runs a Firestore transaction on the player's own user doc.
   ============================================================ */

import { rand, deriveSeed } from "./market.js";
import { doc, onSnapshot, setDoc, increment } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let api = null;          // { fmt, toast, getCash, settle, el, renderLotto }
let mode = "slots";      // slots | blackjack | roulette | scratch | keno | lotto

/* ================= SLOTS =================
   Weighted reels, ~91% RTP:
   7-7-7 50x · 💎💎💎 25x · 🔔🔔🔔 12x · ⭐⭐⭐ 8x
   🍋🍋🍋 6x · 🍒🍒🍒 5x · two 🍒 2x · one 🍒 0.5x        */

const SYMBOLS = [
  { s: "🍒", w: 30 }, { s: "🍋", w: 20 }, { s: "⭐", w: 18 },
  { s: "🔔", w: 14 }, { s: "💎", w: 10 }, { s: "7️⃣", w: 8 }
];
const REEL_TOTAL = SYMBOLS.reduce((a, x) => a + x.w, 0);

function spinSymbol() {
  let r = Math.random() * REEL_TOTAL;
  for (const x of SYMBOLS) { r -= x.w; if (r < 0) return x.s; }
  return SYMBOLS[0].s;
}
function slotPayout(reels, bet) {
  const [a, b, c] = reels;
  if (a === b && b === c) {
    const mult = { "7️⃣": 50, "💎": 25, "🔔": 12, "⭐": 8, "🍋": 6, "🍒": 5 }[a] || 0;
    return { mult, label: `Triple ${a}` };
  }
  const cherries = reels.filter((s) => s === "🍒").length;
  if (cherries === 2) return { mult: 2, label: "Two cherries" };
  if (cherries === 1) return { mult: 0.5, label: "One cherry" };
  return { mult: 0, label: null };
}

const slots = { reels: ["🍒", "🍋", "⭐"], spinning: false, lastResult: null, bet: 10 };
const SLOT_KEY = "vapor-slots-pending";
let slotsRecovering = false;
function recoverSlots() {
  if (slotsRecovering || !api.me?.()) return;
  let p = null;
  try { p = JSON.parse(localStorage.getItem(SLOT_KEY) || "null"); }
  catch { localStorage.removeItem(SLOT_KEY); return; }
  if (!p || !(p.win > 0)) return;
  slotsRecovering = true;
  api.settle(p.win, 0)
    .then(() => { localStorage.removeItem(SLOT_KEY); api.toast("SLOTS", `Recovered an unpaid win of ${api.fmt(p.win)} from your last session.`); })
    .catch(() => {})
    .finally(() => { slotsRecovering = false; });
}

async function doSpin() {
  if (slots.spinning) return;
  const bet = Math.floor(Number(document.querySelector("#slot-bet")?.value || slots.bet));
  if (!(bet > 0)) return;
  if (bet > api.getCash()) { alert("Not enough credits."); return; }
  slots.bet = bet;
  slots.spinning = true;
  slots.lastResult = null;

  const finalReels = [spinSymbol(), spinSymbol(), spinSymbol()];
  const { mult, label } = slotPayout(finalReels, bet);
  const payout = Math.round(bet * mult * 100) / 100;
  const net = payout - bet;

  // wager comes out now; the payout lands only when the reels stop,
  // so the cash pill can't spoil the result mid-spin
  try { await api.settle(-bet, bet); }
  catch (e) { slots.spinning = false; alert(e.message); renderCasino(); return; }
  bumpStat("slots");
  if (payout > 0) localStorage.setItem(SLOT_KEY, JSON.stringify({ win: payout }));  // reload-safe

  // animate: reels stop left → right
  renderCasino();
  const stopAt = [900, 1500, 2100];
  const t0 = Date.now();
  const iv = setInterval(() => {
    const dt = Date.now() - t0;
    for (let i = 0; i < 3; i++) {
      const el = document.querySelector(`#reel-${i}`);
      if (!el) continue;
      if (dt < stopAt[i]) el.textContent = spinSymbol();
      else el.textContent = finalReels[i];
    }
    if (dt >= stopAt[2]) {
      clearInterval(iv);
      slots.reels = finalReels;
      slots.spinning = false;
      slots.lastResult = { win: payout > 0, payout, net, label, bet };
      if (payout > 0) {
        api.settle(payout, 0)
          .then(() => localStorage.removeItem(SLOT_KEY))
          .catch((e) => console.error("slots payout failed, recovery will retry", e));
        if (payout >= bet * 5) api.toast("JACKPOT", `${label} pays ${api.fmt(payout)}!`);
      }
      renderCasino();
    }
  }, 70);
}

/* ================= SCRATCH-OFFS =================
   Equal-EV prize ladder, ~72% RTP, ~21% of tickets win:
   1x 12% · 2x 6% · 5x 2.4% · 20x 0.6% · 100x 0.12% · 1000x 0.012%
   Find three matching symbols on a 3x3 grid to win that prize. */

const SCRATCH_TIERS = [
  { id: "bucks",   name: "Vapor Bucks",   price: 10,  hue: "#8bd450" },
  { id: "neon",    name: "Neon Fortune",  price: 50,  hue: "#e8a33d" },
  { id: "heist",   name: "Diamond Heist", price: 250, hue: "#7ec8e3" }
];
const SCRATCH_LADDER = [[1, 0.12], [2, 0.06], [5, 0.024], [20, 0.006], [100, 0.0012], [1000, 0.00012]];
const PRIZE_SYM = { 1: "🍀", 2: "💰", 5: "🔔", 20: "💎", 100: "🚀", 1000: "👑" };
const DUD_SYMS = ["🌫️", "🧦", "🥫", "🪫", "📉", "🃏"];

let scratch = null; // { tier, grid, mult, prize, winSym, revealed:Set, done }

function rollLadder() {
  let r = Math.random();
  for (const [mult, p] of SCRATCH_LADDER) { if (r < p) return mult; r -= p; }
  return 0;
}
function buildGrid(winMult) {
  const winSym = winMult ? PRIZE_SYM[winMult] : null;
  const pool = [...Object.values(PRIZE_SYM), ...DUD_SYMS].filter((s) => s !== winSym);
  const grid = winSym ? [winSym, winSym, winSym] : [];
  const counts = {};
  while (grid.length < 9) {
    const s = pool[Math.floor(Math.random() * pool.length)];
    if ((counts[s] || 0) >= 2) continue;
    counts[s] = (counts[s] || 0) + 1;
    grid.push(s);
  }
  for (let i = grid.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [grid[i], grid[j]] = [grid[j], grid[i]];
  }
  return { grid, winSym };
}

/* Pending tickets survive reloads: the outcome is decided (and the
   price paid) at purchase, but the PRIZE only hits your balance once
   the ticket is fully scratched — no peeking at the cash pill. */
const SCRATCH_KEY = "vapor-scratch-pending";

function saveScratch() {
  if (!scratch || (scratch.done && scratch.paid)) { localStorage.removeItem(SCRATCH_KEY); return; }
  localStorage.setItem(SCRATCH_KEY, JSON.stringify({
    tierId: scratch.tier.id, grid: scratch.grid, mult: scratch.mult,
    prize: scratch.prize, winSym: scratch.winSym,
    revealed: [...scratch.revealed], done: scratch.done, paid: scratch.paid
  }));
}
function loadScratch() {
  try {
    const raw = localStorage.getItem(SCRATCH_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    const tier = SCRATCH_TIERS.find((t) => t.id === s.tierId);
    if (!tier || !Array.isArray(s.grid) || s.grid.length !== 9) { localStorage.removeItem(SCRATCH_KEY); return; }
    scratch = { tier, grid: s.grid, mult: s.mult, prize: s.prize, winSym: s.winSym,
                revealed: new Set(s.revealed || []), done: !!s.done, paid: !!s.paid };
    if (scratch.done && !scratch.paid) payScratch(); // interrupted payout — retry
  } catch { localStorage.removeItem(SCRATCH_KEY); }
}

async function payScratch() {
  if (!scratch || !scratch.done || scratch.paid) return;
  if (scratch.prize <= 0) { scratch.paid = true; saveScratch(); return; }
  try {
    await api.settle(scratch.prize, 0);
    scratch.paid = true;
    saveScratch();
    if (scratch.mult >= 20) api.toast("SCRATCH JACKPOT", `${scratch.tier.name}: ${scratch.mult}x pays ${api.fmt(scratch.prize)}!`);
  } catch (e) {
    console.error("scratch payout failed, will retry", e);
    setTimeout(payScratch, 4000);
  }
}

async function buyScratch(tier) {
  if (scratch && !(scratch.done && scratch.paid)) return;
  if (tier.price > api.getCash()) { alert("Not enough credits."); return; }
  try { await api.settle(-tier.price, tier.price); }   // price only — prize pays on full reveal
  catch (e) { alert(e.message); return; }
  bumpStat("scratch");
  const mult = rollLadder();
  const { grid, winSym } = buildGrid(mult);
  scratch = { tier, grid, mult, prize: tier.price * mult, winSym, revealed: new Set(), done: false, paid: false };
  saveScratch();
  renderCasino();
}
function revealCell(i) {
  if (!scratch || scratch.done) return;
  if (scratch.revealed.has(i)) return;
  scratch.revealed.add(i);
  const cell = document.querySelector(`[data-sc="${i}"]`);
  if (cell) { cell.classList.add("revealed"); cell.textContent = scratch.grid[i]; }
  if (scratch.revealed.size === 9) {
    scratch.done = true;
    saveScratch();
    payScratch();
    renderCasino();
  } else {
    saveScratch();
  }
}

/* ================= BLACKJACK =================
   6-deck shoe, fresh shuffle each hand. Dealer stands on all 17s.
   Blackjack pays 3:2. Double on first two cards. No splits.     */

const bj = { phase: "idle", deck: [], hands: [], active: 0, dealer: [], bet: 0, msg: "", anim: null, split: false };

function freshShoe() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];
  for (let d = 0; d < 6; d++)
    for (const s of suits) for (const r of ranks) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function handValue(cards) {
  let v = 0, aces = 0;
  for (const c of cards) {
    if (c.r === "A") { v += 11; aces++; }
    else if (["J","Q","K"].includes(c.r)) v += 10;
    else v += Number(c.r);
  }
  while (v > 21 && aces > 0) { v -= 10; aces--; }
  return v;
}
const isBlackjack = (cards) => cards.length === 2 && handValue(cards) === 21;
const curHand = () => bj.hands[bj.active];

async function bjDeal() {
  if (bj.phase === "player") return;
  const bet = Math.floor(Number(document.querySelector("#bj-bet")?.value || 25));
  if (!(bet > 0)) return;
  try { await api.settle(-bet, bet); }
  catch (e) { alert(e.message); return; }

  bumpStat("blackjack");
  bj.deck = freshShoe();
  bj.hands = [{ cards: [bj.deck.pop(), bj.deck.pop()], bet, doubled: false, stood: false }];
  bj.active = 0;
  bj.dealer = [bj.deck.pop(), bj.deck.pop()];
  bj.bet = bet;
  bj.split = false;
  bj.msg = "";
  bj.phase = "player";
  bj.anim = { player: new Set(["0-0", "0-1"]), dealer: new Set([0]), hole: false, base: 0.1 };

  if (isBlackjack(bj.hands[0].cards)) await bjFinish();
  else renderCasino();
}

const canSplit = () => bj.phase === "player" && !bj.split && bj.hands.length === 1
  && bj.hands[0].cards.length === 2 && bj.hands[0].cards[0].r === bj.hands[0].cards[1].r
  && api.getCash() >= bj.bet;

async function bjSplit() {
  if (!canSplit()) return;
  try { await api.settle(-bj.bet, bj.bet); }
  catch (e) { alert(e.message); return; }
  const [c1, c2] = bj.hands[0].cards;
  bj.split = true;
  bj.hands = [
    { cards: [c1, bj.deck.pop()], bet: bj.bet, doubled: false, stood: false },
    { cards: [c2, bj.deck.pop()], bet: bj.bet, doubled: false, stood: false }
  ];
  bj.active = 0;
  bj.anim = { player: new Set(["0-1", "1-1"]), dealer: new Set(), hole: false, base: 0 };
  if (c1.r === "A") {
    // split aces get one card each and stand — house rules everywhere
    bj.hands.forEach((h) => h.stood = true);
    return bjFinish();
  }
  bjAdvanceIfDone();
  renderCasino();
}

function bjAdvanceIfDone() {
  // move to the next unfinished hand; finish when all are done
  while (bj.active < bj.hands.length) {
    const h = bj.hands[bj.active];
    if (!h.stood && handValue(h.cards) <= 21) return false;
    bj.active++;
  }
  return true;
}
function bjHit() {
  if (bj.phase !== "player") return;
  const h = curHand();
  h.cards.push(bj.deck.pop());
  bj.anim = { player: new Set([`${bj.active}-${h.cards.length - 1}`]), dealer: new Set(), hole: false, base: 0 };
  if (handValue(h.cards) > 21) {
    h.stood = true;
    bj.active++;
    if (bjAdvanceIfDone()) return bjFinish();
  }
  renderCasino();
}
function bjStand() {
  if (bj.phase !== "player") return;
  curHand().stood = true;
  bj.active++;
  if (bjAdvanceIfDone()) return bjFinish();
  renderCasino();
}
async function bjDouble() {
  if (bj.phase !== "player") return;
  const h = curHand();
  if (h.cards.length !== 2) return;
  try { await api.settle(-h.bet, h.bet); }
  catch (e) { alert(e.message); return; }
  h.doubled = true;
  h.cards.push(bj.deck.pop());
  h.stood = true;
  bj.anim = { player: new Set([`${bj.active}-2`]), dealer: new Set(), hole: false, base: 0 };
  bj.active++;
  if (bjAdvanceIfDone()) return bjFinish();
  renderCasino();
}

async function bjFinish() {
  bj.phase = "dealer";
  const natural = !bj.split && bj.hands.length === 1 && isBlackjack(bj.hands[0].cards);
  const anyLive = bj.hands.some((h) => handValue(h.cards) <= 21) && !natural;

  if (anyLive) {
    while (handValue(bj.dealer) < 17) bj.dealer.push(bj.deck.pop());
  }
  const dv = handValue(bj.dealer);
  const dealerBJ = isBlackjack(bj.dealer);

  let payout = 0;
  const parts = [];
  bj.hands.forEach((h, idx) => {
    const pv = handValue(h.cards);
    const stake = h.doubled ? h.bet * 2 : h.bet;
    const tag = bj.hands.length > 1 ? `Hand ${idx + 1}: ` : "";
    if (pv > 21) { parts.push(`${tag}bust with ${pv}`); return; }
    if (natural && !dealerBJ) { payout += h.bet * 2.5; parts.push(`Blackjack! Pays 3:2 — ${api.fmt(h.bet * 2.5)}`); return; }
    if (dealerBJ && !natural) { parts.push(`${tag}dealer blackjack`); return; }
    if (dv > 21) { payout += stake * 2; parts.push(`${tag}dealer busts, +${api.fmt(stake * 2)}`); return; }
    if (pv > dv) { payout += stake * 2; parts.push(`${tag}${pv} beats ${dv}, +${api.fmt(stake * 2)}`); return; }
    if (pv < dv) { parts.push(`${tag}${dv} beats ${pv}`); return; }
    payout += stake; parts.push(`${tag}push at ${pv}`);
  });
  const msg = parts.join(" · ") + ".";

  const preDealt = bj.anim?.player || new Set();
  const drawn = new Set();
  for (let i = 2; i < bj.dealer.length; i++) drawn.add(i);
  const base = preDealt.size ? 0.35 : 0.1;
  bj.anim = { player: preDealt, dealer: drawn, hole: true, base };
  const revealMs = (base + 0.2 + drawn.size * 0.16 + 0.55) * 1000;

  if (payout > 0) {
    localStorage.setItem(BJ_KEY, JSON.stringify({ win: payout }));   // survives a mid-reveal reload
    setTimeout(async () => {
      try { await api.settle(payout, 0); localStorage.removeItem(BJ_KEY); }
      catch (e) { console.error("blackjack payout failed, recovery will retry", e); }
    }, revealMs);
  }
  bj.msg = msg;
  bj.phase = "done";
  renderCasino();
}

const BJ_KEY = "vapor-bj-pending";
let bjRecovering = false;
function recoverBlackjack() {
  if (bjRecovering || !api.me?.()) return;
  let p = null;
  try { p = JSON.parse(localStorage.getItem(BJ_KEY) || "null"); }
  catch { localStorage.removeItem(BJ_KEY); return; }
  if (!p || !(p.win > 0)) return;
  bjRecovering = true;
  api.settle(p.win, 0)
    .then(() => { localStorage.removeItem(BJ_KEY); api.toast("BLACKJACK", `Recovered an unpaid win of ${api.fmt(p.win)} from your last session.`); })
    .catch(() => {})
    .finally(() => { bjRecovering = false; });
}


/* ================= ROULETTE =================
   European single-zero wheel (2.7% edge). Straight numbers pay
   35:1, dozens 2:1, even-money bets 1:1. Stack chips on any mix
   of cells, then spin. */

const ROUL_REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const ROUL_KEY = "vapor-roulette-pending";
let roul = { bets: {}, chip: 5, spinning: false, result: null, lastWin: 0, msg: "" };

let roulRecovering = false;
function recoverRoulette() {
  if (roulRecovering || !api.me?.()) return;
  let p = null;
  try { p = JSON.parse(localStorage.getItem(ROUL_KEY) || "null"); }
  catch { localStorage.removeItem(ROUL_KEY); return; }
  if (!p || !(p.win > 0)) return;
  roulRecovering = true;
  api.settle(p.win, 0)
    .then(() => { localStorage.removeItem(ROUL_KEY); api.toast("ROULETTE", `Recovered an unpaid win of ${api.fmt(p.win)} from your last session.`); })
    .catch(() => {})
    .finally(() => { roulRecovering = false; });
}

function roulTotal() { return Object.values(roul.bets).reduce((a, b) => a + b, 0); }
function roulPlace(key) {
  if (roul.spinning) return;
  roul.bets[key] = (roul.bets[key] || 0) + Math.max(1, Math.floor(roul.chip));
  renderCasino();
}
function roulPayout(bets, n) {
  let win = 0;
  for (const [key, amt] of Object.entries(bets)) {
    if (key === `n${n}`) win += amt * 36;
    else if (n === 0) continue;                       // outside bets lose on zero
    else if (key === "red" && ROUL_REDS.has(n)) win += amt * 2;
    else if (key === "black" && !ROUL_REDS.has(n)) win += amt * 2;
    else if (key === "odd" && n % 2 === 1) win += amt * 2;
    else if (key === "even" && n % 2 === 0) win += amt * 2;
    else if (key === "low" && n <= 18) win += amt * 2;
    else if (key === "high" && n >= 19) win += amt * 2;
    else if (key === "d1" && n <= 12) win += amt * 3;
    else if (key === "d2" && n >= 13 && n <= 24) win += amt * 3;
    else if (key === "d3" && n >= 25) win += amt * 3;
  }
  return win;
}
async function roulSpin() {
  if (roul.spinning) return;
  const total = roulTotal();
  if (total <= 0) { alert("Place some chips first."); return; }
  try { await api.settle(-total, total); }
  catch (e) { alert(e.message); return; }
  bumpStat("roulette");
  const n = Math.floor(Math.random() * 37);
  const win = roulPayout(roul.bets, n);
  if (win > 0) localStorage.setItem(ROUL_KEY, JSON.stringify({ win }));  // survives a mid-spin reload
  roul.spinning = true;
  roul.result = null;
  renderCasino();
  const t0 = Date.now();
  const iv = setInterval(async () => {
    const dt = Date.now() - t0;
    const el = document.querySelector("#roul-ball");
    if (el && dt < 2000) {
      const r = Math.floor(Math.random() * 37);
      el.textContent = r;
      el.className = "roul-ball " + (r === 0 ? "green" : ROUL_REDS.has(r) ? "red" : "black");
    }
    if (dt >= 2000) {
      clearInterval(iv);
      roul.spinning = false;
      roul.result = n;
      roul.lastWin = win;
      roul.msg = win > 0
        ? `${n} ${n === 0 ? "green" : ROUL_REDS.has(n) ? "red" : "black"} — you win ${api.fmt(win)} (net ${win - total >= 0 ? "+" : "-"}${api.fmt(Math.abs(win - total))})`
        : `${n} ${n === 0 ? "green" : ROUL_REDS.has(n) ? "red" : "black"} — the house sweeps ${api.fmt(total)}.`;
      roul.bets = {};
      if (win > 0) {
        try { await api.settle(win, 0); localStorage.removeItem(ROUL_KEY); }
        catch (e) { console.error("roulette payout failed", e); }
      }
      if (win >= total * 10) api.toast("ROULETTE", roul.msg);
      renderCasino();
    }
  }, 60);
}

/* ================= KENO =================
   A shared draw every 3 minutes: 20 of 80 numbers, derived from
   the round index with the market PRNG — every client sees the
   same draw. Pick 1-10 numbers, bet, and your ticket plays the
   next draw. Tickets persist in localStorage and settle on the
   next visit if you close the tab. */

const KENO_MS = 90000;
const KENO_SALT = 0x6b656e6f;
const KENO_KEY = "vapor-keno-tickets";
const KENO_PAY = {
  1: { 1: 3 },
  2: { 2: 9 },
  3: { 2: 2, 3: 16 },
  4: { 2: 1, 3: 5, 4: 40 },
  5: { 3: 2, 4: 12, 5: 150 },
  6: { 3: 1, 4: 4, 5: 40, 6: 400 },
  7: { 4: 2, 5: 15, 6: 80, 7: 1000 },
  8: { 5: 8, 6: 40, 7: 400, 8: 5000 },
  9: { 5: 4, 6: 15, 7: 80, 8: 1000, 9: 10000 },
  10: { 5: 2, 6: 8, 7: 40, 8: 200, 9: 2000, 10: 25000 }
};

let kenoPicks = [];
let kenoBet = 10;
let kenoGamesN = 1;
/* Global play counters for every game, one shared doc in /market
   (any signed-in player may write it — no rules change needed).
   Each play also bumps the player's own gameStats for the
   leaderboard hover card. */
let gameStats = {};          // { slots, blackjack, roulette, scratch, keno, lotto }
let statsSub = null;
const STAT_LABEL = { slots: "spins", blackjack: "hands", roulette: "spins", scratch: "tickets", keno: "games", lotto: "tickets", poker: "hands" };
function watchCasinoStats() {
  if (statsSub || !api.db) return;
  statsSub = onSnapshot(doc(api.db, "market", "casinoStats"),
    (snap) => {
      gameStats = snap.exists() ? snap.data() : {};
      document.querySelectorAll("[data-stat]").forEach((el) => {
        el.textContent = (gameStats[el.dataset.stat] || 0).toLocaleString("en-US");
      });
    },
    () => { statsSub = null; });   // not signed in yet — retry on next render
}
function bumpStat(game) {
  if (!api.db) return;
  setDoc(doc(api.db, "market", "casinoStats"), { [game]: increment(1) }, { merge: true }).catch(() => {});
  const uid = api.me?.()?.uid;
  if (uid) setDoc(doc(api.db, "users", uid), { gameStats: { [game]: increment(1) } }, { merge: true }).catch(() => {});
}
const statLine = (game) => `<div class="keno-stat">🎲 <span data-stat="${game}">${(gameStats[game] || 0).toLocaleString("en-US")}</span> ${STAT_LABEL[game]} played all-time</div>`;
let kenoTickets = [];       // [{ round, picks, bet, paid, payout, hits }]

const kenoRound = () => Math.floor(Date.now() / KENO_MS);
function kenoDraw(round) {
  const seed = deriveSeed(KENO_SALT, round);
  const out = [];
  let n = 0;
  while (out.length < 20) {
    const v = 1 + Math.floor(rand(seed, n++) * 80);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}
function kenoSave() { localStorage.setItem(KENO_KEY, JSON.stringify(kenoTickets)); }
function kenoLoad() {
  try { kenoTickets = JSON.parse(localStorage.getItem(KENO_KEY) || "[]"); }
  catch { kenoTickets = []; }
}
async function kenoBuy() {
  if (kenoPicks.length < 1) { alert("Pick at least one number."); return; }
  const bet = Math.floor(Number(document.querySelector("#keno-bet")?.value || kenoBet));
  const games = Math.min(50, Math.max(1, Math.floor(Number(document.querySelector("#keno-games-n")?.value || 1))));
  if (!(bet > 0)) return;
  const cost = bet * games;
  if (cost > api.getCash()) { alert(`Not enough credits — that card costs ${api.fmt(cost)}.`); return; }
  try { await api.settle(-cost, cost); }
  catch (e) { alert(e.message); return; }
  kenoBet = bet;
  for (let g = 0; g < games; g++) bumpStat("keno");
  kenoTickets.push({
    startRound: kenoRound(), games, played: 0, lastResolved: null,
    picks: [...kenoPicks].sort((a, b) => a - b), bet,
    totalWon: 0, done: false
  });
  kenoPicks = [];
  kenoSave();
  api.toast("Keno card in", games > 1
    ? `${games} games at ${api.fmt(bet)} each (${api.fmt(cost)}). First draw ${kenoCountdown()}.`
    : `Plays the draw in ${kenoCountdown()}.`);
  renderCasino();
}
let kenoReport = null;   // detailed breakdown of the most recent resolved game
async function kenoResolveDue() {
  if (!api.me?.()) return;          // not signed in yet — tickets settle after login
  const cur = kenoRound();
  let changed = false;
  for (const t of kenoTickets) {
    // migrate any pre-card single tickets from the old format
    if (t.round !== undefined && t.startRound === undefined) {
      t.startRound = t.round; t.games = 1; t.played = t.paid ? 1 : 0;
      t.lastResolved = t.paid ? t.round : null; t.totalWon = t.payout || 0; t.done = !!t.paid;
    }
    if (t.done) continue;
    const firstDue = t.lastResolved === null ? t.startRound : t.lastResolved + 1;
    const lastDue = Math.min(cur - 1, t.startRound + t.games - 1);
    for (let r = firstDue; r <= lastDue; r++) {
      const draw = kenoDraw(r);
      const hits = t.picks.filter((p) => draw.includes(p)).length;
      const mult = (KENO_PAY[t.picks.length] || {})[hits] || 0;
      const payout = t.bet * mult;
      if (payout > 0) {
        try { await api.settle(payout, 0); }
        catch (e) { console.error("keno payout failed, retrying later", e); return; }
      }
      t.played++;
      t.lastResolved = r;
      t.totalWon = Math.round((t.totalWon + payout) * 100) / 100;
      changed = true;
      kenoReport = {
        picks: t.picks, draw, hits, bet: t.bet, mult, payout,
        game: t.played, games: t.games, totalWon: t.totalWon,
        spent: t.bet * t.games
      };
      if (mult >= 40) api.toast("KENO", `${hits}/${t.picks.length} hits — ${mult}x pays ${api.fmt(payout)}!`);
      if (t.played >= t.games) {
        t.done = true;
        if (t.games > 1) api.toast("KENO CARD COMPLETE", `${t.games} games: spent ${api.fmt(t.bet * t.games)}, won ${api.fmt(t.totalWon)}.`);
        break;
      }
    }
  }
  if (changed) {
    kenoTickets = kenoTickets.filter((t) => !t.done);
    kenoSave();
    renderCasino();
  }
}
function kenoCountdown() {
  const ms = (kenoRound() + 1) * KENO_MS - Date.now();
  const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(sec).padStart(2, "0")}`;
}
setInterval(() => {
  if (!api) return;
  kenoResolveDue();
  const cd = document.querySelector("#keno-cd");
  if (cd) cd.textContent = kenoCountdown();
}, 1000);


/* ================= FIVE-CARD DRAW POKER =================
   Heads-up against the house, single 52-card deck. Bet, get 5
   cards, optionally double down while you can still see only
   your own hand, discard any cards for replacements, then the
   dealer (who plays a sound drawing strategy) shows down.
   Winner takes even money on the total stake. The house edge:
   THE HOUSE WINS TIES. */

let pk = { phase: "idle", deck: [], hand: [], dealer: [], bet: 0, doubled: false, discard: new Set(), msg: "", result: null };

function pkDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const deck = [];
  for (const s of suits) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
const RNAME = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const rName = (r) => RNAME[r] || String(r);
const RWORD = { 2:"Twos",3:"Threes",4:"Fours",5:"Fives",6:"Sixes",7:"Sevens",8:"Eights",9:"Nines",10:"Tens",11:"Jacks",12:"Queens",13:"Kings",14:"Aces" };

// score: [category, tiebreakers...] — compare lexicographically
function pkScore(hand) {
  const rs = hand.map((c) => c.r).sort((a, b) => b - a);
  const flush = hand.every((c) => c.s === hand[0].s);
  let straightHigh = 0;
  const uniq = [...new Set(rs)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;  // wheel
  }
  const counts = {};
  rs.forEach((r) => counts[r] = (counts[r] || 0) + 1);
  const groups = Object.entries(counts)
    .map(([r, n]) => ({ r: Number(r), n }))
    .sort((a, b) => b.n - a.n || b.r - a.r);
  const kick = groups.flatMap((g) => Array(g.n).fill(g.r));
  if (straightHigh && flush) return { s: [8, straightHigh], name: straightHigh === 14 ? "Royal Flush" : "Straight Flush" };
  if (groups[0].n === 4) return { s: [7, groups[0].r, groups[1].r], name: `Four ${RWORD[groups[0].r]}` };
  if (groups[0].n === 3 && groups[1].n === 2) return { s: [6, groups[0].r, groups[1].r], name: `Full House, ${RWORD[groups[0].r]} over ${RWORD[groups[1].r]}` };
  if (flush) return { s: [5, ...rs], name: "Flush" };
  if (straightHigh) return { s: [4, straightHigh], name: "Straight" };
  if (groups[0].n === 3) return { s: [3, ...kick], name: `Three ${RWORD[groups[0].r]}` };
  if (groups[0].n === 2 && groups[1].n === 2) return { s: [2, ...kick], name: `Two Pair, ${RWORD[groups[0].r]} and ${RWORD[groups[1].r]}` };
  if (groups[0].n === 2) return { s: [1, ...kick], name: `Pair of ${RWORD[groups[0].r]}` };
  return { s: [0, ...rs], name: `${rName(rs[0])} High` };
}
function pkCmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// best 5-of-6 for the doubled-hand bonus card; returns {s, name, unusedIdx}
function pkBest5of6(cards) {
  let best = null, unused = 5;
  for (let skip = 0; skip < 6; skip++) {
    const sub = cards.filter((_, i) => i !== skip);
    const sc = pkScore(sub);
    if (!best || pkCmp(sc.s, best.s) > 0) { best = sc; unused = skip; }
  }
  return { ...best, unusedIdx: unused };
}

// dealer drawing strategy: sensible video-poker holds
function pkDealerPlay() {
  const h = pk.dealer;
  const sc = pkScore(h);
  let keep;
  if (sc.s[0] >= 4) keep = new Set([0, 1, 2, 3, 4]);                       // straight or better stands
  else if (sc.s[0] === 3) {                                               // trips: draw 2
    const r = sc.s[1];
    keep = new Set(h.map((c, i) => c.r === r ? i : -1).filter((i) => i >= 0));
  } else if (sc.s[0] === 2) {                                             // two pair: draw 1
    keep = new Set();
    const pr = [sc.s[1], sc.s[2]];
    h.forEach((c, i) => { if (pr.includes(c.r)) keep.add(i); });
  } else if (sc.s[0] === 1) {                                             // pair: draw 3
    const r = sc.s[1];
    keep = new Set(h.map((c, i) => c.r === r ? i : -1).filter((i) => i >= 0));
  } else {
    // 4 to a flush?
    const bySuit = {};
    h.forEach((c, i) => (bySuit[c.s] = bySuit[c.s] || []).push(i));
    const fl = Object.values(bySuit).find((a) => a.length === 4);
    if (fl) keep = new Set(fl);
    else {
      // keep face cards (up to 3 highest)
      keep = new Set(h.map((c, i) => ({ c, i })).filter((x) => x.c.r >= 11)
        .sort((a, b) => b.c.r - a.c.r).slice(0, 3).map((x) => x.i));
    }
  }
  pk.dealer = h.map((c, i) => keep.has(i) ? c : pk.deck.pop());
}

async function pkDeal() {
  if (pk.phase === "dealt") return;
  const bet = Math.floor(Number(document.querySelector("#pk-bet")?.value || 25));
  if (!(bet > 0)) return;
  try { await api.settle(-bet, bet); }
  catch (e) { alert(e.message); return; }
  bumpStat("poker");
  pk = { phase: "dealt", deck: pkDeck(), hand: [], dealer: [], bet, doubled: false, discard: new Set(), msg: "", result: null };
  for (let i = 0; i < 5; i++) { pk.hand.push(pk.deck.pop()); pk.dealer.push(pk.deck.pop()); }
  renderCasino();
}
async function pkDouble() {
  if (pk.phase !== "dealt" || pk.doubled) return;
  try { await api.settle(-pk.bet, pk.bet); }
  catch (e) { alert(e.message); return; }
  pk.doubled = true;
  renderCasino();
}
const PK_KEY = "vapor-poker-pending";
let pkRecovering = false;
function recoverPoker() {
  if (pkRecovering || !api.me?.()) return;
  let p = null;
  try { p = JSON.parse(localStorage.getItem(PK_KEY) || "null"); }
  catch { localStorage.removeItem(PK_KEY); return; }
  if (!p || !(p.win > 0)) return;
  pkRecovering = true;
  api.settle(p.win, 0)
    .then(() => { localStorage.removeItem(PK_KEY); api.toast("POKER", `Recovered an unpaid win of ${api.fmt(p.win)} from your last session.`); })
    .catch(() => {})
    .finally(() => { pkRecovering = false; });
}

async function pkDraw() {
  if (pk.phase !== "dealt") return;
  pk.swapped = new Set(pk.discard);
  pk.hand = pk.hand.map((c, i) => pk.discard.has(i) ? pk.deck.pop() : c);
  pkDealerPlay();
  // the double-down tax: a doubled hand buys the house one extra card,
  // and it plays the best five of six (sim-tuned to ~50/50 overall)
  let house;
  if (pk.doubled) {
    pk.dealer.push(pk.deck.pop());
    house = pkBest5of6(pk.dealer);
  } else {
    house = pkScore(pk.dealer);
  }
  const mine = pkScore(pk.hand);
  const stake = pk.doubled ? pk.bet * 2 : pk.bet;
  const cmp = pkCmp(mine.s, house.s);
  pk.result = { mine, house };
  // reveal choreography: swapped cards flip in, then the house flips
  pk.revealBase = pk.swapped.size ? 0.55 : 0.15;
  const revealDone = (pk.revealBase + pk.dealer.length * 0.16 + 0.45) * 1000;
  if (cmp > 0) {
    const winnings = Math.round(stake * 1.95 * 100) / 100;
    pk.msg = `${mine.name} beats ${house.name} — you win ${api.fmt(winnings)}.`;
    localStorage.setItem(PK_KEY, JSON.stringify({ win: winnings }));   // survives a mid-reveal reload
    setTimeout(async () => {
      try { await api.settle(winnings, 0); localStorage.removeItem(PK_KEY); }
      catch (e) { console.error("poker payout failed, recovery will retry", e); }
    }, revealDone);
    if (mine.s[0] >= 5) setTimeout(() => api.toast("POKER", `${mine.name}! ${api.fmt(winnings)}`), revealDone);
  } else if (cmp === 0) {
    pk.msg = `Both show ${mine.name}. Ties go to the house. That's the edge.`;
  } else {
    pk.msg = `${house.name} beats your ${mine.name}. The house rakes ${api.fmt(stake)}.`;
  }
  pk.phase = "done";
  renderCasino();
}

/* ================= RENDER ================= */
function cardHtml(c, hidden, delay) {
  if (hidden) return `<span class="bj-card back">🂠</span>`;
  const red = c.s === "♥" || c.s === "♦";
  if (delay !== undefined && delay !== null) {
    return `<span class="pk-flip" style="animation-delay:${delay.toFixed(2)}s">
      <span class="pk-face pk-back">🂠</span>
      <span class="pk-face pk-front bj-card ${red ? "red" : ""}">${c.r}${c.s}</span>
    </span>`;
  }
  return `<span class="bj-card ${red ? "red" : ""}">${c.r}${c.s}</span>`;
}

function renderCasino() {
  const el = api.el();
  if (!el) return;
  const cash = api.getCash();

  const slotsHtml = `
    <div class="casino-panel">
      ${statLine("slots")}
      <div class="slot-reels">
        ${slots.reels.map((s, i) => `<div class="reel" id="reel-${i}">${s}</div>`).join("")}
      </div>
      <div class="casino-controls">
        <input id="slot-bet" type="number" min="1" step="1" value="${slots.bet}" ${slots.spinning ? "disabled" : ""}>
        <button class="btn-spin" id="btn-spin" ${slots.spinning ? "disabled" : ""}>${slots.spinning ? "Spinning…" : "Spin"}</button>
      </div>
      <div class="casino-msg ${slots.lastResult ? (slots.lastResult.net >= 0 ? "up" : "down") : ""}">
        ${slots.spinning ? "Good luck…" :
          slots.lastResult ? (slots.lastResult.win
            ? `${slots.lastResult.label} — paid ${api.fmt(slots.lastResult.payout)} (net ${slots.lastResult.net >= 0 ? "+" + api.fmt(slots.lastResult.net) : "-" + api.fmt(-slots.lastResult.net)})`
            : `No luck. ${api.fmt(slots.lastResult.bet)} to the house.`)
          : "Place a bet and spin."}
      </div>
      <div class="paytable">
        <div>7️⃣7️⃣7️⃣ 50x</div><div>💎💎💎 25x</div><div>🔔🔔🔔 12x</div><div>⭐⭐⭐ 8x</div>
        <div>🍋🍋🍋 6x</div><div>🍒🍒🍒 5x</div><div>🍒🍒 2x</div><div>🍒 0.5x</div>
      </div>
    </div>`;

  const inHand = bj.phase === "player";
  const hideHole = inHand;
  const bjHtml = `
    <div class="casino-panel">
      ${statLine("blackjack")}
      <div class="bj-table">
        <div class="bj-row">
          <span class="bj-label">Dealer${bj.dealer.length && !hideHole ? " · " + handValue(bj.dealer) : ""}</span>
          <div>${bj.dealer.map((c, i) => {
            const a = bj.anim;
            if (a && i === 1 && a.hole) return cardHtml(c, false, a.base);
            if (a && a.dealer.has(i)) return cardHtml(c, false, a.base + (a.hole ? 0.2 : 0) + Math.max(0, i - 2) * 0.16);
            return cardHtml(c, hideHole && i === 1);
          }).join("")}</div>
        </div>
        ${bj.hands.map((h, hi) => `<div class="bj-row ${inHand && hi === bj.active && bj.hands.length > 1 ? "bj-active" : ""}">
          <span class="bj-label">${bj.hands.length > 1 ? `Hand ${hi + 1}` : "You"}${h.cards.length ? " · " + handValue(h.cards) : ""}${h.doubled ? " (doubled)" : ""}${inHand && hi === bj.active && bj.hands.length > 1 ? " ◀" : ""}</span>
          <div>${h.cards.map((c, i) => {
            const a = bj.anim, key = hi + "-" + i;
            if (a && a.player.has(key)) {
              const order = [...a.player].sort().indexOf(key);
              return cardHtml(c, false, order * 0.09);
            }
            return cardHtml(c);
          }).join("")}</div>
        </div>`).join("")}
      </div>
      <div class="casino-controls">
        ${inHand ? `
          <button class="btn-bj" id="bj-hit">Hit</button>
          <button class="btn-bj" id="bj-stand">Stand</button>
          ${curHand()?.cards.length === 2 ? `<button class="btn-bj ghost-bj" id="bj-double" ${api.getCash() < curHand().bet ? "disabled" : ""}>Double</button>` : ""}
          ${canSplit() ? `<button class="btn-bj ghost-bj" id="bj-split">Split</button>` : ""}
        ` : `
          <input id="bj-bet" type="number" min="1" step="1" value="${bj.bet || 25}">
          <button class="btn-spin" id="bj-deal">Deal</button>
        `}
      </div>
      <div class="casino-msg ${bj.phase === "done" && bj.anim ? "pk-msg-in" : ""}" ${bj.phase === "done" && bj.anim ? `style="animation-delay:${(bj.anim.base + 0.2 + bj.anim.dealer.size * 0.16 + 0.25).toFixed(2)}s"` : ""}>${inHand ? `${bj.hands.length > 1 ? `Playing hand ${bj.active + 1} of ${bj.hands.length}` : `Bet: ${api.fmt(bj.bet)}`} — hit or stand?` : (bj.msg || "Blackjack pays 3:2. Dealer stands on 17. Split pairs once; split aces get one card each.")}</div>
    </div>`;

  const scratchHtml = `
    <div class="casino-panel">
      ${statLine("scratch")}
      ${scratch ? `
        <div class="scratch-name" style="color:${scratch.tier.hue}">${scratch.tier.name} · ${api.fmt(scratch.tier.price)}</div>
        <div class="scratch-grid">
          ${scratch.grid.map((s, i) => `<button class="scratch-cell ${scratch.revealed.has(i) ? "revealed" : ""}" data-sc="${i}">${scratch.revealed.has(i) ? s : ""}</button>`).join("")}
        </div>
        <div class="casino-controls" style="margin-top:12px">
          ${scratch.done ? "" : `<button class="ghost" id="sc-all">Reveal all</button>`}
        </div>
        <div class="casino-msg ${scratch.done ? (scratch.prize > 0 ? "up" : "down") : ""}">
          ${scratch.done
            ? (scratch.prize > 0 ? `Three ${scratch.winSym} — you won ${api.fmt(scratch.prize)} (${scratch.mult}x)!` : "No three of a kind. Into the bin it goes.")
            : "Scratch the foil — click or drag across the cells. Three matching symbols wins."}
        </div>
      ` : `<div class="casino-msg">Pick a ticket. Match three symbols to win that prize.</div>`}
      ${(!scratch || scratch.done) ? `
        <div class="scratch-shop">
          ${SCRATCH_TIERS.map((t) => `<button class="scratch-buy" style="border-color:${t.hue}" data-tier="${t.id}">
            <span style="color:${t.hue};font-weight:700">${t.name}</span>
            <span class="muted">${api.fmt(t.price)} · win up to ${api.fmt(t.price * 1000)}</span>
          </button>`).join("")}
        </div>` : ""}
    </div>`;

  const lottoHtml = `${statLine("lotto")}<div id="lotto-root"></div>`;

  const pkLive = pk.phase === "dealt";
  const pkFlip = (c, delay) => {
    const red = c.s === "♥" || c.s === "♦";
    return `<span class="pk-flip" style="animation-delay:${delay}s">
      <span class="pk-face pk-back">🂠</span>
      <span class="pk-face pk-front bj-card ${red ? "red" : ""}">${rName(c.r)}${c.s}</span>
    </span>`;
  };
  const pokerCard = (c, i, mineRow) => {
    const red = c.s === "♥" || c.s === "♦";
    // freshly swapped cards flip in when the showdown renders
    if (mineRow && pk.phase === "done" && !pk.animShown && pk.swapped?.has(i)) return pkFlip(c, i * 0.09);
    const disc = mineRow && pk.discard.has(i);
    return `<button class="bj-card pk-card ${red ? "red" : ""} ${disc ? "disc" : ""}" ${mineRow && pkLive ? `data-pk="${i}"` : ""}>${rName(c.r)}${c.s}</button>`;
  };
  const pokerHtml = `
    <div class="casino-panel">
      ${statLine("poker")}
      <div class="bj-table">
        <div class="bj-row">
          <span class="bj-label">House${pk.result ? " · " + pk.result.house.name : ""}${pk.phase === "done" && pk.doubled ? " (6th card)" : ""}</span>
          <div>${pk.phase === "done" ? pk.dealer.map((c, i) => {
                   const dim = pk.doubled && pk.result.house.unusedIdx === i ? "pk-unused" : "";
                   if (pk.animShown) {
                     const red = c.s === "♥" || c.s === "♦";
                     return `<span class="bj-card ${red ? "red" : ""} ${dim}">${rName(c.r)}${c.s}</span>`;
                   }
                   return `<span class="${dim}" style="display:inline-block">${pkFlip(c, (pk.revealBase || 0.15) + i * 0.16)}</span>`;
                 }).join("") :
                 pkLive ? '<span class="bj-card back">🂠</span>'.repeat(5) : ""}</div>
        </div>
        <div class="bj-row">
          <span class="bj-label">You${pk.result ? " · " + pk.result.mine.name : ""}${pk.doubled ? " (doubled)" : ""}</span>
          <div>${pk.hand.map((c, i) => pokerCard(c, i, true)).join("")}</div>
        </div>
      </div>
      <div class="casino-controls">
        ${pkLive ? `
          ${!pk.doubled ? `<button class="btn-bj ghost-bj" id="pk-double" ${api.getCash() < pk.bet ? "disabled" : ""}>Double down</button>` : ""}
          <button class="btn-spin" id="pk-draw">${pk.discard.size ? `Swap ${pk.discard.size} & showdown` : "Stand pat & showdown"}</button>
        ` : `
          <input id="pk-bet" type="number" min="1" step="1" value="${pk.bet || 25}">
          <button class="btn-spin" id="pk-deal">Deal</button>
        `}
      </div>
      <div class="casino-msg ${pk.phase === "done" ? (pk.msg.includes("you win") ? "up" : "down") + (pk.animShown ? "" : " pk-msg-in") : ""}" ${pk.phase === "done" && !pk.animShown ? `style="animation-delay:${((pk.revealBase || 0.15) + pk.dealer.length * 0.16 + 0.2).toFixed(2)}s"` : ""}>${
        pkLive ? `Bet ${api.fmt(pk.doubled ? pk.bet * 2 : pk.bet)} — tap cards to mark for the swap. Double down while the house is face-down — but a doubled hand buys the house a sixth card.` :
        pk.msg || "Five-card draw against the house. Wins pay 1.95x, one swap — and if you double down, the house deals itself a sixth card and plays its best five. Ties go to the house."}</div>
    </div>`;

  const numCell = (n) => {
    const amt = roul.bets[`n${n}`];
    const col = n === 0 ? "green" : ROUL_REDS.has(n) ? "red" : "black";
    return `<button class="roul-cell ${col}" data-rb="n${n}">${n}${amt ? `<span class="chip">${amt}</span>` : ""}</button>`;
  };
  const outCell = (key, label, wide) => {
    const amt = roul.bets[key];
    return `<button class="roul-out ${wide ? "wide" : ""}" data-rb="${key}">${label}${amt ? `<span class="chip">${amt}</span>` : ""}</button>`;
  };
  const rouletteHtml = `
    <div class="casino-panel">
      ${statLine("roulette")}
      <div class="roul-result">
        <span id="roul-ball" class="roul-ball ${roul.result === null ? "" : roul.result === 0 ? "green" : ROUL_REDS.has(roul.result) ? "red" : "black"}">${roul.spinning ? "…" : roul.result ?? "—"}</span>
      </div>
      <div class="roul-board">
        ${numCell(0)}
        <div class="roul-nums">${Array.from({ length: 36 }, (_, i) => numCell(i + 1)).join("")}</div>
      </div>
      <div class="roul-outs">
        ${outCell("d1", "1st 12")}${outCell("d2", "2nd 12")}${outCell("d3", "3rd 12")}
        ${outCell("low", "1-18")}${outCell("red", "RED")}${outCell("black", "BLACK")}${outCell("high", "19-36")}
        ${outCell("odd", "ODD")}${outCell("even", "EVEN")}
      </div>
      <div class="casino-controls" style="margin-top:12px">
        <label class="muted" style="font-size:12px">Chip</label>
        <input id="roul-chip" type="number" min="1" step="1" value="${roul.chip}">
        <button class="ghost" id="roul-clear" ${roul.spinning ? "disabled" : ""}>Clear</button>
        <button class="btn-spin" id="roul-spin" ${roul.spinning || roulTotal() === 0 ? "disabled" : ""}>Spin — ${api.fmt(roulTotal())}</button>
      </div>
      <div class="casino-msg ${roul.lastWin > 0 ? "up" : roul.result !== null ? "down" : ""}">${roul.spinning ? "No more bets…" : roul.msg || "Click cells to stack chips. Straight numbers pay 35:1, dozens 2:1, outside bets even money. Zero is the house's little friend."}</div>
    </div>`;

  const kenoDrawNow = kenoDraw(kenoRound() - 1);
  const kenoHtml = `
    <div class="casino-panel">
      ${statLine("keno")}
      <div class="keno-head">
        <span class="muted" style="font-size:12px">Next draw in</span>
        <span id="keno-cd" class="keno-cd">${kenoCountdown()}</span>
        <span class="muted" style="font-size:12px">· pick up to 10 · shared draw, same for everyone</span>
      </div>

      <div class="keno-grid">
        ${Array.from({ length: 80 }, (_, i) => i + 1).map((n) =>
          `<button class="keno-num ${kenoPicks.includes(n) ? "on" : ""} ${kenoDrawNow.includes(n) ? "drawn" : ""}" data-kn="${n}">${n}</button>`).join("")}
      </div>
      <p class="muted" style="font-size:11px;margin-top:6px">Highlighted cells were last draw's 20 numbers.</p>
      <div class="casino-controls" style="margin-top:10px;flex-wrap:wrap">
        <input id="keno-qp-count" type="number" min="1" max="10" step="1" value="5" title="How many numbers to auto-pick">
        <button class="ghost" id="keno-qp">Random pick</button>
        <label class="muted" style="font-size:12px">Bet</label>
        <input id="keno-bet" type="number" min="1" step="1" value="${kenoBet}" title="Bet per game">
        <label class="muted" style="font-size:12px">Games</label>
        <input id="keno-games-n" type="number" min="1" max="50" step="1" value="${kenoGamesN}" title="Number of consecutive draws this card plays">
        <button class="btn-spin" id="keno-buy" ${kenoPicks.length ? "" : "disabled"}>Buy card${kenoPicks.length ? ` — ${api.fmt(kenoBet * kenoGamesN)}` : ""}</button>
        <button class="ghost" id="keno-clear">Clear</button>
      </div>
      ${kenoReport ? `<div class="keno-report">
        <div class="keno-report-h">LAST GAME${kenoReport.games > 1 ? ` · game ${kenoReport.game}/${kenoReport.games} of your card` : ""}</div>
        <div class="keno-report-row"><span>Your picks</span><div>${kenoReport.picks.map((p) => `<span class="ball ${kenoReport.draw.includes(p) ? "hit" : ""}" style="width:26px;height:26px;font-size:11px">${p}</span>`).join("")}</div></div>
        <div class="keno-report-row"><span>Hits</span><b class="${kenoReport.payout > 0 ? "up" : ""}">${kenoReport.hits}/${kenoReport.picks.length}${kenoReport.mult ? ` — ${kenoReport.mult}x` : ""}</b></div>
        <div class="keno-report-row"><span>This game</span><b class="${kenoReport.payout > 0 ? "up" : "down"}">${kenoReport.payout > 0 ? "+" + api.fmt(kenoReport.payout) : "-" + api.fmt(kenoReport.bet)}</b></div>
        ${kenoReport.games > 1 ? `<div class="keno-report-row"><span>Card so far</span><b class="${kenoReport.totalWon >= kenoReport.spent / kenoReport.games * kenoReport.game ? "up" : ""}">won ${api.fmt(kenoReport.totalWon)} of ${api.fmt(kenoReport.spent)} spent</b></div>` : ""}
      </div>` : `<div class="casino-msg">Your card plays the next shared draw. More picks, bigger top prizes.</div>`}
      ${kenoTickets.filter((t) => !t.done).length ? `<div class="keno-mine">
        ${kenoTickets.filter((t) => !t.done).map((t) => `<div class="lotto-ticket">
          <span class="muted" style="font-size:11px">${t.games > 1 ? `game ${t.played + 1}/${t.games} · won ${api.fmt(t.totalWon)} so far` : "next draw"} · ${api.fmt(t.bet)}/game</span>
          ${t.picks.map((p) => `<span class="ball" style="width:24px;height:24px;font-size:10px">${p}</span>`).join("")}</div>`).join("")}
      </div>` : ""}
      <div class="paytable" style="margin-top:12px">
        <div>Pick 1: 1hit 3x</div><div>Pick 3: 3hit 16x</div><div>Pick 5: 5hit 150x</div>
        <div>Pick 7: 7hit 1000x</div><div>Pick 10: 10hit 25000x</div>
      </div>
    </div>`;

  el.innerHTML = `
    <div class="casino-head">
      <h3 class="sec" style="margin:0">The Vapor Lounge</h3>
      <div class="casino-tabs">
        <button data-cmode="slots" class="${mode === "slots" ? "active" : ""}">Slots</button>
        <button data-cmode="blackjack" class="${mode === "blackjack" ? "active" : ""}">Blackjack</button>
        <button data-cmode="roulette" class="${mode === "roulette" ? "active" : ""}">Roulette</button>
        <button data-cmode="scratch" class="${mode === "scratch" ? "active" : ""}">Scratch Tickets</button>
        <button data-cmode="keno" class="${mode === "keno" ? "active" : ""}">Keno</button>
        <button data-cmode="poker" class="${mode === "poker" ? "active" : ""}">Poker</button>
        <button data-cmode="lotto" class="${mode === "lotto" ? "active" : ""}">Powerball</button>
      </div>
    </div>
    ${mode === "slots" ? slotsHtml : mode === "blackjack" ? bjHtml : mode === "roulette" ? rouletteHtml : mode === "scratch" ? scratchHtml : mode === "keno" ? kenoHtml : mode === "poker" ? pokerHtml : lottoHtml}
  `;

  el.querySelectorAll("[data-cmode]").forEach((b) =>
    b.addEventListener("click", () => { mode = b.dataset.cmode; renderCasino(); }));
  el.querySelector("#btn-spin")?.addEventListener("click", doSpin);
  el.querySelector("#bj-deal")?.addEventListener("click", bjDeal);
  el.querySelector("#bj-hit")?.addEventListener("click", bjHit);
  el.querySelector("#bj-stand")?.addEventListener("click", bjStand);
  el.querySelector("#bj-double")?.addEventListener("click", bjDouble);
  el.querySelector("#bj-split")?.addEventListener("click", bjSplit);
  el.querySelectorAll(".scratch-buy").forEach((b) =>
    b.addEventListener("click", () => buyScratch(SCRATCH_TIERS.find((t) => t.id === b.dataset.tier))));
  el.querySelectorAll(".scratch-cell").forEach((c) => {
    const i = Number(c.dataset.sc);
    c.addEventListener("pointerdown", () => revealCell(i));
    c.addEventListener("pointerenter", (e) => { if (e.buttons & 1) revealCell(i); });
  });
  el.querySelector("#sc-all")?.addEventListener("click", () => {
    for (let i = 0; i < 9; i++) revealCell(i);
  });
  el.querySelectorAll("[data-rb]").forEach((b) => b.addEventListener("click", () => roulPlace(b.dataset.rb)));
  el.querySelector("#roul-chip")?.addEventListener("change", (e) => { roul.chip = Math.max(1, Math.floor(Number(e.target.value) || 1)); });
  el.querySelector("#roul-clear")?.addEventListener("click", () => { roul.bets = {}; renderCasino(); });
  el.querySelector("#roul-spin")?.addEventListener("click", roulSpin);
  el.querySelectorAll("[data-kn]").forEach((b) => b.addEventListener("click", () => {
    const n = Number(b.dataset.kn);
    if (kenoPicks.includes(n)) kenoPicks = kenoPicks.filter((x) => x !== n);
    else if (kenoPicks.length < 10) kenoPicks.push(n);
    renderCasino();
  }));
  el.querySelectorAll("[data-pk]").forEach((c) => c.addEventListener("click", () => {
    const i = Number(c.dataset.pk);
    pk.discard.has(i) ? pk.discard.delete(i) : pk.discard.add(i);
    renderCasino();
  }));
  el.querySelector("#pk-deal")?.addEventListener("click", pkDeal);
  el.querySelector("#pk-double")?.addEventListener("click", pkDouble);
  el.querySelector("#pk-draw")?.addEventListener("click", pkDraw);
  el.querySelector("#keno-games-n")?.addEventListener("change", (e) => {
    kenoGamesN = Math.min(50, Math.max(1, Math.floor(Number(e.target.value) || 1)));
    renderCasino();
  });
  el.querySelector("#keno-bet")?.addEventListener("change", (e) => {
    kenoBet = Math.max(1, Math.floor(Number(e.target.value) || 1));
    renderCasino();
  });
  el.querySelector("#keno-buy")?.addEventListener("click", kenoBuy);
  el.querySelector("#keno-clear")?.addEventListener("click", () => { kenoPicks = []; renderCasino(); });
  el.querySelector("#keno-qp")?.addEventListener("click", () => {
    const count = Math.min(10, Math.max(1, Math.floor(Number(document.querySelector("#keno-qp-count")?.value || 5))));
    const picks = [];
    while (picks.length < count) {
      const n = 1 + Math.floor(Math.random() * 80);
      if (!picks.includes(n)) picks.push(n);
    }
    kenoPicks = picks;
    renderCasino();
  });
  watchCasinoStats();
  recoverRoulette();
  recoverPoker();
  recoverBlackjack();
  recoverSlots();
  bj.anim = null;                                  // flips play once, not on background re-renders
  if (pk.phase === "done") pk.animShown = true;
  if (mode === "lotto") api.renderLotto();
}

export function initCasino(apiIn) {
  api = apiIn;
  loadScratch();
  kenoLoad();
  return { render: renderCasino };
}
