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

  el.innerHTML = `
    <div class="casino-head">
      <h3 class="sec" style="margin:0">The Vapor Lounge</h3>
      <div class="casino-tabs">
        <button data-cmode="slots" class="${mode === "slots" ? "active" : ""}">🎰 Slots</button>
        <button data-cmode="blackjack" class="${mode === "blackjack" ? "active" : ""}">🃏 Blackjack</button>
      </div>
    </div>
    ${mode === "slots" ? slotsHtml : bjHtml}
    <p class="muted" style="font-size:12px;margin-top:14px">House odds apply. The market is fairer. Cash: ${api.fmt(cash)}</p>
  `;

  el.querySelectorAll("[data-cmode]").forEach((b) =>
    b.addEventListener("click", () => { mode = b.dataset.cmode; renderCasino(); }));
  el.querySelector("#btn-spin")?.addEventListener("click", doSpin);
  el.querySelector("#bj-deal")?.addEventListener("click", bjDeal);
  el.querySelector("#bj-hit")?.addEventListener("click", bjHit);
  el.querySelector("#bj-stand")?.addEventListener("click", bjFinish);
  el.querySelector("#bj-double")?.addEventListener("click", bjDouble);
}

export function initCasino(apiIn) {
  api = apiIn;
  return { render: renderCasino };
}
