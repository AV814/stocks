/* ============================================================
   LWSTOCKS — LWBall nightly lottery
   Pick 4 numbers (1-20) + a PowerBall (1-5). ₡25 a ticket.
   Draws every night at 05:00 UTC (midnight EST / 1 AM EDT).

   The winning numbers are a pure function of the draw index,
   computed with the same counter-based PRNG as stock prices —
   every client derives the identical draw, so nothing about the
   result lives on (or can be tampered with on) the server.

   Firestore:
     lottery/{drawId}            — sales, pot, settled, winNums,
                                   winPb, winnersCount, potFinal
     lottery/{drawId}/tickets/{id} — uid, name, nums, pb, at,
                                     claimed, payout

   Pot = 1000 base + 25% of ticket sales + rollover from any
   night without a jackpot winner. Settlement and prize claims
   follow the same client-maintenance pattern as the market:
   whoever's browser notices first, does the bookkeeping.
   ============================================================ */

import {
  doc, collection, runTransaction, onSnapshot, getDoc, getDocs, query, where,
  setDoc, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { rand, deriveSeed } from "./market.js";

let api = null;   // { db, me, myDoc, fmt, toast, el: () => lotto root element }

const TICKET = 25;
const NUM_MAX = 20, PICKS = 4, PB_MAX = 5;
const BASE_POT = 1000;
const POT_CUT = 0.25;                        // quarter of each ticket feeds the pot
const LOTTO_SALT = 0x7a9b0421;

/* True Eastern-time midnight, DST-proof: the day index comes from the
   calendar date in America/New_York, so boundaries land on actual
   midnight ET year-round (browsers share IANA tz data, so every
   client computes the same index). Exported for the daily bonus and
   work caps too. */
const NY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
});
function nyParts(t) {
  const p = {};
  NY_FMT.formatToParts(t).forEach((x) => { p[x.type] = x.value; });
  return p;
}
export function nyDay(t = Date.now()) {
  const p = nyParts(t);
  return Math.floor(Date.UTC(+p.year, +p.month - 1, +p.day) / 86400000);
}
export function nyNextMidnight(t = Date.now()) {
  const p = nyParts(t);
  const sinceMid = (((+p.hour) % 24) * 3600 + (+p.minute) * 60 + (+p.second)) * 1000 + (t % 1000);
  return t - sinceMid + 86400000;
}

const drawId = (t = Date.now()) => nyDay(t);

/* ---------- the draw: deterministic per night ---------- */
export function drawFor(w) {
  const seed = deriveSeed(LOTTO_SALT, w);
  const nums = [];
  let n = 0;
  while (nums.length < PICKS) {
    const v = 1 + Math.floor(rand(seed, n++) * NUM_MAX);
    if (!nums.includes(v)) nums.push(v);
  }
  const pb = 1 + Math.floor(rand(seed, 999) * PB_MAX);
  return { nums: nums.sort((a, b) => a - b), pb };
}

function prizeFor(ticket, draw, potFinal, winnersCount) {
  const k = ticket.nums.filter((n) => draw.nums.includes(n)).length;
  const pbHit = ticket.pb === draw.pb;
  if (k === 4 && pbHit) return Math.floor((potFinal / Math.max(winnersCount, 1)) * 100) / 100;
  if (k === 4) return 5000;
  if (k === 3 && pbHit) return 1000;
  if (k === 3) return 200;
  if (k === 2 && pbHit) return 100;
  if (k === 1 && pbHit) return 50;
  if (pbHit) return TICKET;
  return 0;
}
const isJackpot = (t, d) => t.pb === d.pb && t.nums.filter((n) => d.nums.includes(n)).length === 4;

/* ---------- state ---------- */
let slip = [];                 // tickets queued for purchase [{nums, pb}]
let picking = { nums: [], pb: null };
let curWeekDoc = null;         // live pot for the current week
let myTickets = [];            // my tickets tonight
let lastResults = null;        // { id, draw, doc, mine: [tickets with prizes] }
let unsubWeek = null;
let watchedWeek = null;
let busy = false;

/* ---------- subscriptions & maintenance ---------- */
export function subscribeLottery() {
  watchWeek();
  maintain();
}
export function unsubscribeLottery() {
  if (unsubWeek) { unsubWeek(); unsubWeek = null; }
  watchedWeek = null; curWeekDoc = null; myTickets = []; lastResults = null; slip = [];
  picking = { nums: [], pb: null };
}

function watchWeek() {
  const w = drawId();
  if (watchedWeek === w && unsubWeek) return;
  if (unsubWeek) unsubWeek();
  watchedWeek = w;
  unsubWeek = onSnapshot(doc(api.db, "lottery", String(w)), (snap) => {
    curWeekDoc = snap.exists() ? snap.data() : null;
    renderLotto();
  });
}

// Settle past weeks (compute winners, roll unclaimed pots) and claim my prizes.
async function maintain() {
  const uid = api.me()?.uid;
  if (!uid) return;
  const w = drawId();
  for (let past = w - 7; past < w; past++) {
    try { await settleWeek(past); } catch (e) { console.error("settle failed", e); }
    try { await claimWeek(past); } catch (e) { console.error("claim failed", e); }
  }
  await loadMine();
  await loadLastResults();
  renderLotto();
}

async function settleWeek(w) {
  const ref = doc(api.db, "lottery", String(w));
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().settled) return;
  const draw = drawFor(w);
  const tickets = (await getDocs(collection(api.db, "lottery", String(w), "tickets")))
    .docs.map((d) => d.data());
  const winnersCount = tickets.filter((t) => isJackpot(t, draw)).length;

  const didSettle = await runTransaction(api.db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists() || s.data().settled) return false;
    const pot = s.data().pot || BASE_POT;
    let curSnap = null, curRef = null;
    if (winnersCount === 0) {
      curRef = doc(api.db, "lottery", String(drawId()));
      curSnap = await tx.get(curRef);
    }
    tx.set(ref, {
      ...s.data(), settled: true, potFinal: pot, winnersCount,
      winNums: draw.nums, winPb: draw.pb
    });
    if (winnersCount === 0 && curRef) {
      const cur = curSnap.exists() ? curSnap.data() : { sales: 0, pot: BASE_POT };
      tx.set(curRef, { ...cur, pot: Math.round(((cur.pot || BASE_POT) + pot) * 100) / 100, carriedIn: pot });
    }
    return true;
  });
  if (didSettle && winnersCount === 0 && (snap.data().sales || 0) > 0) {
    api.toast("LWBALL", `No jackpot winner last night — ${api.fmt(snap.data().pot || BASE_POT)} rolls over!`);
  }
}

async function claimWeek(w) {
  const uid = api.me().uid;
  const ref = doc(api.db, "lottery", String(w));
  const snap = await getDoc(ref);
  if (!snap.exists() || !snap.data().settled) return;
  const wd = snap.data();
  const draw = { nums: wd.winNums, pb: wd.winPb };
  const mine = await getDocs(query(collection(api.db, "lottery", String(w), "tickets"), where("uid", "==", uid)));
  let won = 0, jackpot = false;
  for (const tDoc of mine.docs) {
    if (tDoc.data().claimed) continue;
    const prize = prizeFor(tDoc.data(), draw, wd.potFinal, wd.winnersCount);
    const didClaim = await runTransaction(api.db, async (tx) => {
      const [tSnap, uSnap] = [await tx.get(tDoc.ref), await tx.get(doc(api.db, "users", uid))];
      if (!tSnap.exists() || tSnap.data().claimed) return false;
      if (prize > 0) tx.update(doc(api.db, "users", uid), { cash: Math.round(((uSnap.data().cash || 0) + prize) * 100) / 100 });
      tx.update(tDoc.ref, { claimed: true, payout: prize });
      return true;
    });
    if (didClaim && prize > 0) {
      won += prize;
      if (isJackpot(tDoc.data(), draw)) jackpot = true;
    }
  }
  if (jackpot) api.toast("LWBALL JACKPOT", `+${api.fmt(won)} received`);
  else if (won > 0) api.toast("LWBALL", `+${api.fmt(won)} received`);
}

async function loadMine() {
  const uid = api.me()?.uid;
  if (!uid) return;
  const w = drawId();
  const qs = await getDocs(query(collection(api.db, "lottery", String(w), "tickets"), where("uid", "==", uid)));
  myTickets = qs.docs.map((d) => d.data()).sort((a, b) => a.at - b.at);
}

async function loadLastResults() {
  const w = drawId() - 1;
  const snap = await getDoc(doc(api.db, "lottery", String(w)));
  const draw = drawFor(w);
  if (!snap.exists()) { lastResults = { id: w, draw, doc: null, mine: [] }; return; }
  const uid = api.me().uid;
  const mine = (await getDocs(query(collection(api.db, "lottery", String(w), "tickets"), where("uid", "==", uid))))
    .docs.map((d) => d.data());
  lastResults = { id: w, draw, doc: snap.data(), mine };
}

/* ---------- buying ---------- */
function quickPick() {
  const nums = [];
  while (nums.length < PICKS) {
    const v = 1 + Math.floor(Math.random() * NUM_MAX);
    if (!nums.includes(v)) nums.push(v);
  }
  return { nums: nums.sort((a, b) => a - b), pb: 1 + Math.floor(Math.random() * PB_MAX) };
}

async function buySlip() {
  if (busy || slip.length === 0) return;
  const cost = slip.length * TICKET;
  if (cost > (api.myDoc()?.cash || 0)) { alert("Not enough credits for the whole slip."); return; }
  busy = true;
  const w = drawId();
  const name = api.myDoc()?.name || "Trader";
  const uid = api.me().uid;
  try {
    await runTransaction(api.db, async (tx) => {
      const uRef = doc(api.db, "users", uid);
      const wRef = doc(api.db, "lottery", String(w));
      const [uSnap, wSnap] = [await tx.get(uRef), await tx.get(wRef)];
      const cash = uSnap.data()?.cash || 0;
      if (cash < cost) throw new Error("Not enough credits.");
      const wd = wSnap.exists() ? wSnap.data() : { sales: 0, pot: BASE_POT };
      tx.update(uRef, { cash: Math.round((cash - cost) * 100) / 100 });
      tx.set(wRef, {
        ...wd,
        sales: (wd.sales || 0) + cost,
        pot: Math.round(((wd.pot || BASE_POT) + cost * POT_CUT) * 100) / 100
      });
      for (const t of slip) {
        tx.set(doc(collection(api.db, "lottery", String(w), "tickets")), {
          uid, name, nums: t.nums, pb: t.pb, at: Date.now(), claimed: false, payout: 0
        });
      }
    });
    setDoc(doc(api.db, "market", "casinoStats"), { lotto: increment(slip.length) }, { merge: true }).catch(() => {});
    setDoc(doc(api.db, "users", uid), { gameStats: { lotto: increment(slip.length) } }, { merge: true }).catch(() => {});
    api.toast("Tickets in", `${slip.length} LWBall ticket${slip.length > 1 ? "s" : ""} for ${api.fmt(cost)}. Draw ${drawCountdown()}.`);
    slip = [];
    await loadMine();
  } catch (e) { alert(e.message); }
  busy = false;
  renderLotto();
}

/* ---------- render ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function drawCountdown() {
  const ms = nyNextMidnight() - Date.now();
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

const ballsHtml = (nums, pb, hitNums = [], hitPb = false) =>
  nums.map((n) => `<span class="ball ${hitNums.includes(n) ? "hit" : ""}">${n}</span>`).join("") +
  `<span class="ball pb ${hitPb ? "hit" : ""}">${pb}</span>`;

export function renderLotto() {
  const root = api.el();
  if (!root) return;
  const pot = curWeekDoc?.pot || BASE_POT;

  const pickGrid = Array.from({ length: NUM_MAX }, (_, i) => i + 1).map((n) =>
    `<button class="pick ${picking.nums.includes(n) ? "on" : ""}" data-n="${n}">${n}</button>`).join("");
  const pbRow = Array.from({ length: PB_MAX }, (_, i) => i + 1).map((n) =>
    `<button class="pick pb ${picking.pb === n ? "on" : ""}" data-pb="${n}">${n}</button>`).join("");

  let lastHtml = "";
  if (lastResults) {
    const lr = lastResults;
    const anyPlay = lr.doc && (lr.doc.sales || 0) > 0;
    lastHtml = `<div class="lotto-last">
      <h3 class="sec">Last night’s draw</h3>
      <div class="lotto-balls">${ballsHtml(lr.draw.nums, lr.draw.pb)}</div>
      ${anyPlay ? `<p class="muted" style="font-size:12px">
        ${lr.doc.winnersCount > 0 ? `${lr.doc.winnersCount} jackpot winner${lr.doc.winnersCount > 1 ? "s" : ""} split ${api.fmt(lr.doc.potFinal)}.` : `No jackpot winner — ${api.fmt(lr.doc.potFinal)} rolled into tonight's pot.`}
      </p>` : `<p class="muted" style="font-size:12px">Nobody played. The numbers echo in an empty hall.</p>`}
      ${lr.mine.map((t) => `<div class="lotto-ticket">${ballsHtml(t.nums, t.pb, lr.draw.nums, t.pb === lr.draw.pb)}
        <span class="${t.payout > 0 ? "up" : "muted"}">${t.payout > 0 ? "won " + api.fmt(t.payout) : "no win"}</span></div>`).join("")}
    </div>`;
  }

  root.innerHTML = `
    <div class="lotto-jackpot">
      <div class="lotto-pot-label">TONIGHT'S JACKPOT</div>
      <div class="lotto-pot">${api.fmt(pot)}</div>
      <div class="muted" style="font-size:12px">Nightly draw at midnight ET · ${drawCountdown()} · match 4 + the LWBall · ₡${TICKET}/ticket · a quarter of every ticket feeds the pot · no winner = rollover</div>
    </div>

    <div class="lotto-pickbox">
      <div class="muted" style="font-size:12px;margin-bottom:6px">Pick ${PICKS} numbers</div>
      <div class="pick-grid">${pickGrid}</div>
      <div class="muted" style="font-size:12px;margin:8px 0 6px">…and one LWBall</div>
      <div class="pick-row">${pbRow}</div>
      <div class="casino-controls" style="margin-top:12px">
        <button class="ghost" id="lt-qp">Quick pick</button>
        <button class="btn-spin" id="lt-add" ${picking.nums.length === PICKS && picking.pb ? "" : "disabled"}>Add to slip</button>
      </div>
    </div>

    ${slip.length ? `<div class="lotto-slip">
      ${slip.map((t, i) => `<div class="lotto-ticket">${ballsHtml(t.nums, t.pb)}<button class="ghost" data-rm="${i}">✕</button></div>`).join("")}
      <button class="btn-spin" id="lt-buy" ${busy ? "disabled" : ""}>Buy ${slip.length} ticket${slip.length > 1 ? "s" : ""} — ${api.fmt(slip.length * TICKET)}</button>
    </div>` : ""}

    ${myTickets.length ? `<div class="lotto-mine">
      <h3 class="sec">Your tickets tonight (${myTickets.length})</h3>
      ${myTickets.map((t) => `<div class="lotto-ticket">${ballsHtml(t.nums, t.pb)}</div>`).join("")}
    </div>` : ""}

    ${lastHtml}
    <div class="paytable" style="margin-top:16px">
      <div>4+● JACKPOT</div><div>4 ₡5,000</div><div>3+● ₡1,000</div><div>3 ₡200</div>
      <div>2+● ₡100</div><div>1+● ₡50</div><div>● ₡25</div>
    </div>`;

  root.querySelectorAll("[data-n]").forEach((b) => b.addEventListener("click", () => {
    const n = Number(b.dataset.n);
    if (picking.nums.includes(n)) picking.nums = picking.nums.filter((x) => x !== n);
    else if (picking.nums.length < PICKS) picking.nums.push(n);
    renderLotto();
  }));
  root.querySelectorAll("[data-pb]").forEach((b) => b.addEventListener("click", () => {
    picking.pb = Number(b.dataset.pb); renderLotto();
  }));
  root.querySelector("#lt-qp")?.addEventListener("click", () => { picking = { nums: [], pb: null }; slip.push(quickPick()); renderLotto(); });
  root.querySelector("#lt-add")?.addEventListener("click", () => {
    slip.push({ nums: [...picking.nums].sort((a, b) => a - b), pb: picking.pb });
    picking = { nums: [], pb: null };
    renderLotto();
  });
  root.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { slip.splice(Number(b.dataset.rm), 1); renderLotto(); }));
  root.querySelector("#lt-buy")?.addEventListener("click", buySlip);
}

export function initLottery(apiIn) {
  api = apiIn;
  return { renderLotto, subscribeLottery, unsubscribeLottery, maintain };
}
