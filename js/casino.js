/* ============================================================
   VAPORSTOCKS — casino module (slots + blackjack)
   Pure client-side games. Cash moves via api.settle(), which
   runs a Firestore transaction on the player's own user doc.
   ============================================================ */

let api = null;          // { fmt, toast, getCash, settle, el }
let mode = "slots";      // "slots" | "blackjack"

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

  el.innerHTML = `
    <div class="casino-head">
      <h3 class="sec" style="margin:0">The Vapor Lounge</h3>
      <div class="casino-tabs">
        <button data-cmode="slots" class="${mode === "slots" ? "active" : ""}">🎰 Slots</button>
        <button data-cmode="blackjack" class="${mode === "blackjack" ? "active" : ""}">🃏 Blackjack</button>
        <button data-cmode="scratch" class="${mode === "scratch" ? "active" : ""}">🎟️ Scratchers</button>
        <button data-cmode="lotto" class="${mode === "lotto" ? "active" : ""}">🎱 VaporBall</button>
      </div>
    </div>
    ${mode === "slots" ? slotsHtml : mode === "blackjack" ? bjHtml : mode === "scratch" ? scratchHtml : lottoHtml}
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
  if (mode === "lotto") api.renderLotto();
}

export function initCasino(apiIn) {
  api = apiIn;
  loadScratch();
  return { render: renderCasino };
}
