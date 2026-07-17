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

  // settle up front (single transaction: -bet +payout); animation plays regardless
  let settled = true;
  try { await api.settle(net, bet); }
  catch (e) { settled = false; slots.spinning = false; alert(e.message); renderCasino(); return; }

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
      if (payout >= bet * 5) api.toast("JACKPOT", `${label} pays ${api.fmt(payout)}!`);
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

const bj = { phase: "idle", deck: [], player: [], dealer: [], bet: 0, doubled: false, msg: "" };

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

async function bjDeal() {
  if (bj.phase !== "idle" && bj.phase !== "done") return;
  const bet = Math.floor(Number(document.querySelector("#bj-bet")?.value || 25));
  if (!(bet > 0)) return;
  try { await api.settle(-bet, bet); }
  catch (e) { alert(e.message); return; }

  bj.deck = freshShoe();
  bj.player = [bj.deck.pop(), bj.deck.pop()];
  bj.dealer = [bj.deck.pop(), bj.deck.pop()];
  bj.bet = bet;
  bj.doubled = false;
  bj.msg = "";
  bj.phase = "player";

  if (isBlackjack(bj.player)) await bjFinish();
  else renderCasino();
}
function bjHit() {
  if (bj.phase !== "player") return;
  bj.player.push(bj.deck.pop());
  if (handValue(bj.player) > 21) return bjFinish();
  renderCasino();
}
async function bjDouble() {
  if (bj.phase !== "player" || bj.player.length !== 2) return;
  try { await api.settle(-bj.bet, bj.bet); }
  catch (e) { alert(e.message); return; }
  bj.doubled = true;
  bj.player.push(bj.deck.pop());
  return bjFinish();
}
async function bjFinish() {
  bj.phase = "dealer";
  const pv = handValue(bj.player);
  const stake = bj.doubled ? bj.bet * 2 : bj.bet;

  if (pv <= 21 && !isBlackjack(bj.player)) {
    while (handValue(bj.dealer) < 17) bj.dealer.push(bj.deck.pop());
  }
  const dv = handValue(bj.dealer);

  let payout = 0, msg;
  if (pv > 21) { msg = `Bust with ${pv}. House takes ${api.fmt(stake)}.`; }
  else if (isBlackjack(bj.player) && !isBlackjack(bj.dealer)) {
    payout = bj.bet * 2.5;
    msg = `Blackjack! Pays 3:2 — ${api.fmt(payout)}.`;
  }
  else if (isBlackjack(bj.dealer) && !isBlackjack(bj.player)) { msg = "Dealer blackjack. Ouch."; }
  else if (dv > 21) { payout = stake * 2; msg = `Dealer busts with ${dv}. You win ${api.fmt(payout)}.`; }
  else if (pv > dv) { payout = stake * 2; msg = `${pv} beats ${dv}. You win ${api.fmt(payout)}.`; }
  else if (pv < dv) { msg = `Dealer's ${dv} beats your ${pv}.`; }
  else { payout = stake; msg = `Push at ${pv}. Bet returned.`; }

  if (payout > 0) {
    try { await api.settle(payout, 0); }
    catch (e) { console.error("payout failed", e); msg += " (Payout failed — refresh and check your cash.)"; }
  }
  bj.msg = msg;
  bj.phase = "done";
  renderCasino();
}


/* ================= ROULETTE =================
   European single-zero wheel (2.7% edge). Straight numbers pay
   35:1, dozens 2:1, even-money bets 1:1. Stack chips on any mix
   of cells, then spin. */

const ROUL_REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const ROUL_KEY = "vapor-roulette-pending";
let roul = { bets: {}, chip: 5, spinning: false, result: null, lastWin: 0, msg: "" };

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

const KENO_MS = 180000;
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
let kenoGames = null;        // global games-played counter (market/kenoStats)
let kenoStatsSub = null;
function watchKenoStats() {
  if (kenoStatsSub || !api.db) return;
  kenoStatsSub = onSnapshot(doc(api.db, "market", "kenoStats"),
    (snap) => { kenoGames = snap.exists() ? (snap.data().games || 0) : 0; 
      const el = document.querySelector("#keno-games");
      if (el) el.textContent = kenoGames.toLocaleString("en-US");
    },
    () => { kenoStatsSub = null; });   // not signed in yet — retry on next render
}
let kenoTickets = [];       // [{ round, picks, bet, paid, payout, hits }]
let kenoLastMsg = "";

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
  if (!(bet > 0)) return;
  if (bet > api.getCash()) { alert("Not enough credits."); return; }
  try { await api.settle(-bet, bet); }
  catch (e) { alert(e.message); return; }
  kenoBet = bet;
  kenoTickets.push({ round: kenoRound(), picks: [...kenoPicks].sort((a, b) => a - b), bet, paid: false, payout: 0, hits: null });
  setDoc(doc(api.db, "market", "kenoStats"), { games: increment(1) }, { merge: true }).catch(() => {});
  kenoPicks = [];
  kenoSave();
  api.toast("Keno ticket in", `Plays the draw in ${kenoCountdown()}.`);
  renderCasino();
}
async function kenoResolveDue() {
  const cur = kenoRound();
  let changed = false;
  for (const t of kenoTickets) {
    if (t.paid || t.round >= cur) continue;           // ticket plays when its round ends
    const draw = kenoDraw(t.round);
    const hits = t.picks.filter((p) => draw.includes(p)).length;
    const mult = (KENO_PAY[t.picks.length] || {})[hits] || 0;
    t.hits = hits;
    t.payout = t.bet * mult;
    t.paid = true;
    changed = true;
    if (t.payout > 0) {
      try { await api.settle(t.payout, 0); }
      catch (e) { t.paid = false; console.error("keno payout failed, retrying later", e); continue; }
      kenoLastMsg = `Last draw: ${hits}/${t.picks.length} hits — won ${api.fmt(t.payout)}!`;
      if (mult >= 40) api.toast("KENO", kenoLastMsg);
    } else {
      kenoLastMsg = `Last draw: ${hits}/${t.picks.length} hits — no win.`;
    }
  }
  if (changed) {
    kenoTickets = kenoTickets.filter((t) => !t.paid || t.round >= cur - 5);  // keep a short history
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

/* ================= RENDER ================= */
function cardHtml(c, hidden) {
  if (hidden) return `<span class="bj-card back">🂠</span>`;
  const red = c.s === "♥" || c.s === "♦";
  return `<span class="bj-card ${red ? "red" : ""}">${c.r}${c.s}</span>`;
}

function renderCasino() {
  const el = api.el();
  if (!el) return;
  const cash = api.getCash();

  const slotsHtml = `
    <div class="casino-panel">
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
      <div class="bj-table">
        <div class="bj-row">
          <span class="bj-label">Dealer${bj.dealer.length && !hideHole ? " · " + handValue(bj.dealer) : ""}</span>
          <div>${bj.dealer.map((c, i) => cardHtml(c, hideHole && i === 1)).join("")}</div>
        </div>
        <div class="bj-row">
          <span class="bj-label">You${bj.player.length ? " · " + handValue(bj.player) : ""}${bj.doubled ? " (doubled)" : ""}</span>
          <div>${bj.player.map((c) => cardHtml(c)).join("")}</div>
        </div>
      </div>
      <div class="casino-controls">
        ${inHand ? `
          <button class="btn-bj" id="bj-hit">Hit</button>
          <button class="btn-bj" id="bj-stand">Stand</button>
          ${bj.player.length === 2 ? `<button class="btn-bj ghost-bj" id="bj-double" ${api.getCash() < bj.bet ? "disabled" : ""}>Double</button>` : ""}
        ` : `
          <input id="bj-bet" type="number" min="1" step="1" value="${bj.bet || 25}">
          <button class="btn-spin" id="bj-deal">Deal</button>
        `}
      </div>
      <div class="casino-msg">${inHand ? `Bet: ${api.fmt(bj.bet)} — hit or stand?` : (bj.msg || "Blackjack pays 3:2. Dealer stands on 17. No splits — this is a dive bar, not the Bellagio.")}</div>
    </div>`;

  const scratchHtml = `
    <div class="casino-panel">
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

  const lottoHtml = `<div id="lotto-root"></div>`;

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
      <div class="keno-head">
        <span class="muted" style="font-size:12px">Next draw in</span>
        <span id="keno-cd" class="keno-cd">${kenoCountdown()}</span>
        <span class="muted" style="font-size:12px">· pick up to 10 · shared draw, same for everyone</span>
      </div>
      <div class="keno-stat">🎲 <span id="keno-games">${kenoGames === null ? "…" : kenoGames.toLocaleString("en-US")}</span> games played all-time</div>
      <div class="keno-grid">
        ${Array.from({ length: 80 }, (_, i) => i + 1).map((n) =>
          `<button class="keno-num ${kenoPicks.includes(n) ? "on" : ""} ${kenoDrawNow.includes(n) ? "drawn" : ""}" data-kn="${n}">${n}</button>`).join("")}
      </div>
      <p class="muted" style="font-size:11px;margin-top:6px">Highlighted cells were last draw's 20 numbers.</p>
      <div class="casino-controls" style="margin-top:10px">
        <input id="keno-qp-count" type="number" min="1" max="10" step="1" value="5" title="How many numbers to auto-pick">
        <button class="ghost" id="keno-qp">Random pick</button>
        <input id="keno-bet" type="number" min="1" step="1" value="${kenoBet}" title="Bet">
        <button class="btn-spin" id="keno-buy" ${kenoPicks.length ? "" : "disabled"}>Play ${kenoPicks.length || "—"} number${kenoPicks.length === 1 ? "" : "s"} next draw</button>
        <button class="ghost" id="keno-clear">Clear</button>
      </div>
      <div class="casino-msg">${kenoLastMsg || "Your ticket plays the next shared draw. More picks, bigger top prizes."}</div>
      ${kenoTickets.filter((t) => !t.paid).length ? `<div class="keno-mine">
        ${kenoTickets.filter((t) => !t.paid).map((t) => `<div class="lotto-ticket"><span class="muted" style="font-size:11px">draw ${t.round === kenoRound() ? "next" : "pending"} · ${api.fmt(t.bet)}</span> ${t.picks.map((p) => `<span class="ball" style="width:24px;height:24px;font-size:10px">${p}</span>`).join("")}</div>`).join("")}
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
        <button data-cmode="lotto" class="${mode === "lotto" ? "active" : ""}">Powerball</button>
      </div>
    </div>
    ${mode === "slots" ? slotsHtml : mode === "blackjack" ? bjHtml : mode === "roulette" ? rouletteHtml : mode === "scratch" ? scratchHtml : mode === "keno" ? kenoHtml : lottoHtml}
    <p class="muted" style="font-size:12px;margin-top:14px">House odds apply. The market is fairer. Cash: ${api.fmt(cash)}</p>
  `;

  el.querySelectorAll("[data-cmode]").forEach((b) =>
    b.addEventListener("click", () => { mode = b.dataset.cmode; renderCasino(); }));
  el.querySelector("#btn-spin")?.addEventListener("click", doSpin);
  el.querySelector("#bj-deal")?.addEventListener("click", bjDeal);
  el.querySelector("#bj-hit")?.addEventListener("click", bjHit);
  el.querySelector("#bj-stand")?.addEventListener("click", bjFinish);
  el.querySelector("#bj-double")?.addEventListener("click", bjDouble);
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
  if (mode === "keno") watchKenoStats();
  if (mode === "lotto") api.renderLotto();
}

export function initCasino(apiIn) {
  api = apiIn;
  loadScratch();
  kenoLoad();
  try {
    const p = JSON.parse(localStorage.getItem(ROUL_KEY) || "null");
    if (p && p.win > 0) api.settle(p.win, 0).then(() => localStorage.removeItem(ROUL_KEY)).catch(() => {});
  } catch { localStorage.removeItem(ROUL_KEY); }
  return { render: renderCasino };
}
