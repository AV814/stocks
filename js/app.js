import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, updateProfile, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, onSnapshot, runTransaction,
  setDoc, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_UID } from "./firebase-config.js";
import { MarketEngine, deriveSeed, makeIdentity } from "./market.js";
import { initCasino } from "./casino.js";
import { initPredictions } from "./predictions.js";
import { initSocial } from "./social.js";
import { initLottery } from "./lottery.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const engine = new MarketEngine();

const STARTING_CASH = 1000;
const MIN_ROSTER = 20;

/* ---------------- state ---------------- */
let me = null;            // firebase user
let myDoc = null;         // { cash, holdings, name }
let market = null;        // { seed, spawnCount, stocks: [...] }
let allUsers = [];        // leaderboard snapshot
let view = "market";
let openTicker = null;
let chartTf = "24H";
const sparkCache = new Map();   // seed -> { pts, p24, until }
let lastNewsSeen = Number(localStorage.getItem("vs_news_seen") || 0);
let unsubUser = null, unsubUsers = null;

const $ = (s) => document.querySelector(s);
const fmt = (n) => "₡" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";

/* ---- shared cash mover for casino: one transaction on my own doc.
   delta may be negative; minStake is the cash needed up front. ---- */
const BONUS_AMT = 50;
const bonusDay = () => Math.floor((Date.now() - 5 * 3600000) / 86400000); // midnight ET boundary
async function claimDaily() {
  if (!me || !myDoc) return;
  if (myDoc.dailyClaim === bonusDay()) return;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "users", me.uid);
      const snap = await tx.get(ref);
      const u = snap.data();
      if (u.dailyClaim === bonusDay()) throw new Error("Already claimed today. Greed is good, but patience pays.");
      tx.update(ref, { cash: Math.round(((u.cash || 0) + BONUS_AMT) * 100) / 100, dailyClaim: bonusDay() });
    });
    toast("DAILY BONUS", `${fmt(BONUS_AMT)} claimed. Back tomorrow after midnight ET.`);
  } catch (e) { alert(e.message); }
}
$("#bonus-btn").addEventListener("click", claimDaily);

async function settle(delta, minStake = 0) {
  await runTransaction(db, async (tx) => {
    const ref = doc(db, "users", me.uid);
    const snap = await tx.get(ref);
    const cash = snap.data()?.cash || 0;
    if (cash < minStake || cash + delta < 0) throw new Error("Not enough credits.");
    tx.update(ref, { cash: Math.round((cash + delta) * 100) / 100 });
  });
}

const lottery = initLottery({
  db, fmt, toast,
  me: () => me,
  myDoc: () => myDoc,
  el: () => $("#lotto-root")
});
const casino = initCasino({
  db, fmt, toast,
  getCash: () => myDoc?.cash || 0,
  settle,
  el: () => $("#view-casino"),
  renderLotto: lottery.renderLotto
});
const predictions = initPredictions({
  db, fmt, toast, ADMIN_UID,
  me: () => me,
  myDoc: () => myDoc,
  users: () => allUsers,
  priceOf: (tk) => {
    const st = findStock(tk);
    return st && !st.dead ? engine.price(st, Date.now()) : null;
  },
  isAdmin: () => me?.uid === ADMIN_UID,
  el: () => $("#view-predict"),
  adminEl: () => $("#view-admin")
});
const social = initSocial({
  db, fmt, toast,
  me: () => me,
  myDoc: () => myDoc
});

/* ================= AUTH ================= */
let signupMode = false;
$("#auth-toggle").addEventListener("click", (e) => {
  e.preventDefault();
  signupMode = !signupMode;
  $("#auth-submit").textContent = signupMode ? "Create account" : "Sign in";
  $("#auth-name").style.display = signupMode ? "block" : "none";
  $("#auth-toggle").textContent = signupMode ? "Sign in instead" : "Create an account";
});
$("#auth-name").style.display = "none";

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const pass = $("#auth-pass").value;
  const name = $("#auth-name").value.trim();
  $("#auth-error").textContent = "";
  try {
    if (signupMode) {
      if (!name) throw new Error("Pick a trader name.");
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: name });
      await setDoc(doc(db, "users", cred.user.uid), {
        name, cash: STARTING_CASH, holdings: {}, createdAt: serverTimestamp()
      });
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (err) {
    $("#auth-error").textContent = err.message.replace("Firebase: ", "");
  }
});
$("#sign-out").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  me = user;
  $("#boot").classList.add("hidden");
  $("#auth-screen").classList.toggle("hidden", !!user);
  $("#app").classList.toggle("hidden", !user);
  if (unsubUser) { unsubUser(); unsubUser = null; }
  if (unsubUsers) { unsubUsers(); unsubUsers = null; }
  predictions.unsubscribePredictions();
  social.unsubscribeTransfers();
  lottery.unsubscribeLottery();
  $("#tab-admin").classList.toggle("hidden", !user || user.uid !== ADMIN_UID);
  if (!user) return;
  predictions.subscribePredictions();
  social.subscribeTransfers();
  lottery.subscribeLottery();

  unsubUser = onSnapshot(doc(db, "users", user.uid), async (snap) => {
    if (!snap.exists()) {
      // account exists but doc missing (e.g. created elsewhere) — provision it
      await setDoc(doc(db, "users", user.uid), {
        name: user.displayName || "Trader", cash: STARTING_CASH, holdings: {}, createdAt: serverTimestamp()
      });
      return;
    }
    myDoc = snap.data();
    renderCash();
  });
  unsubUsers = onSnapshot(collection(db, "users"), (qs) => {
    allUsers = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (view === "leaderboard" || view === "admin") render();
  });
  subscribeMarket();
});

/* ================= MARKET STATE ================= */
function subscribeMarket() {
  onSnapshot(doc(db, "market", "state"), async (snap) => {
    if (!snap.exists()) { await initializeMarket(); return; }
    market = snap.data();
    runMaintenance();
    render();
  });
}

async function initializeMarket() {
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "market", "state");
      const cur = await tx.get(ref);
      if (cur.exists()) return;
      const seed = (Math.random() * 4294967296) >>> 0;
      const now = Date.now();
      const stocks = [];
      const taken = new Set();
      let i = 0;
      while (stocks.length < MIN_ROSTER && i < 500) {
        const s = deriveSeed(seed, i++);
        const birth = now - (1 + (s % 72)) * 3600000; // 1–72h of backstory
        const probe = { seed: s, birth };
        if (engine.bankruptcyTime(probe, now) !== null) continue; // already dead in its backstory
        const id = makeIdentity(s, taken);
        taken.add(id.ticker);
        stocks.push({ seed: s, birth, dead: null, ...id });
      }
      tx.set(ref, { seed, spawnCount: i, createdAt: now, stocks });
    });
  } catch (e) { console.error("init failed", e); }
}

let maintaining = false;
async function runMaintenance() {
  if (maintaining || !market) return;
  const now = Date.now();
  const needsWork = market.stocks.some(
    (s) => !s.dead && engine.bankruptcyTime(s, now) !== null
  ) || market.stocks.filter((s) => !s.dead).length < MIN_ROSTER;
  if (!needsWork) return;
  maintaining = true;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "market", "state");
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const st = snap.data();
      let changed = false;
      for (const s of st.stocks) {
        if (s.dead) continue;
        const deadAt = engine.bankruptcyTime(s, now);
        if (deadAt !== null) { s.dead = deadAt; changed = true; }
      }
      const taken = new Set(st.stocks.filter((s) => !s.dead).map((s) => s.ticker));
      while (st.stocks.filter((s) => !s.dead).length < MIN_ROSTER) {
        const seed = deriveSeed(st.seed, st.spawnCount++);
        const id = makeIdentity(seed, taken);
        taken.add(id.ticker);
        st.stocks.push({ seed, birth: now, dead: null, ...id });
        changed = true;
      }
      if (changed) tx.set(ref, st);
    });
  } catch (e) { console.error("maintenance failed", e); }
  maintaining = false;
}
setInterval(runMaintenance, 60000);

/* ================= HELPERS ================= */
function aliveStocks() { return market ? market.stocks.filter((s) => !s.dead) : []; }
function findStock(tk) { return market ? market.stocks.find((s) => s.ticker === tk) : null; }

function sparkFor(stock) {
  const now = Date.now();
  let c = sparkCache.get(stock.seed);
  if (!c || now > c.until) {
    const from = Math.max(stock.birth, now - 86400000);
    const pts = engine.history(stock, from, now, 40);
    c = { pts, p24: pts.length ? pts[0].p : null, until: now + 120000 };
    sparkCache.set(stock.seed, c);
  }
  return c;
}

function portfolioValue(u) {
  let v = u.cash || 0;
  const now = Date.now();
  for (const [tk, sh] of Object.entries(u.holdings || {})) {
    const st = findStock(tk);
    if (!st || st.dead) continue;
    const p = engine.price(st, now);
    if (p !== null) v += sh * p;
  }
  return v;
}

/* ================= TRADING ================= */
async function trade(ticker, shares, side) {
  const st = findStock(ticker);
  if (!st || st.dead) return alert("This stock is no longer listed.");
  shares = Math.floor(shares);
  if (!(shares > 0)) return;
  const price = engine.price(st, Date.now());
  if (price === null) return alert("This stock just went bankrupt.");
  const cost = shares * price;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "users", me.uid);
      const snap = await tx.get(ref);
      const u = snap.data();
      const held = (u.holdings || {})[ticker] || 0;
      if (side === "buy") {
        if (u.cash < cost) throw new Error("Not enough credits.");
        u.cash -= cost;
        u.holdings = { ...u.holdings, [ticker]: held + shares };
      } else {
        if (held < shares) throw new Error("You don't hold that many shares.");
        u.cash += cost;
        const h = { ...u.holdings };
        h[ticker] = held - shares;
        if (h[ticker] === 0) delete h[ticker];
        u.holdings = h;
      }
      tx.update(ref, { cash: u.cash, holdings: u.holdings });
    });
    addDoc(collection(db, "users", me.uid, "trades"), {
      ticker, shares, side, price, at: serverTimestamp()
    });
    toast(side === "buy" ? "Order filled" : "Position sold",
      `${side === "buy" ? "Bought" : "Sold"} ${shares} × ${ticker} @ ${fmt(price)}`);
  } catch (e) { alert(e.message); }
}

/* ================= RENDERING ================= */
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    view = b.dataset.view;
    openTicker = null;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === b));
    if (view === "news") {
      lastNewsSeen = Date.now();
      localStorage.setItem("vs_news_seen", lastNewsSeen);
      $("#news-dot").classList.add("hidden");
    }
    render();
  })
);

function showView(id) {
  ["market", "stock", "portfolio", "news", "leaderboard", "casino", "predict", "admin"].forEach((v) =>
    $(`#view-${v}`).classList.toggle("hidden", v !== id)
  );
}

function renderCash() {
  if (!myDoc) return;
  $("#cash-pill").textContent = fmt(myDoc.cash);
  $("#avatar-btn").innerHTML = social.avatarHtml(myDoc, 30);
  const claimed = myDoc.dailyClaim === bonusDay();
  const bb = $("#bonus-btn");
  bb.disabled = claimed;
  bb.title = claimed ? "Daily bonus claimed — resets midnight ET" : "Claim your free ₡50 daily bonus";
  bb.textContent = claimed ? "🎁 ✓" : "🎁 ₡50";
}
$("#avatar-btn").addEventListener("click", () => $("#avatar-file").click());
$("#avatar-file").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) social.uploadAvatar(f);
  e.target.value = "";
});

function render() {
  if (!market) return;
  if (openTicker) return renderStock();
  showView(view);
  if (view === "market") renderMarket();
  else if (view === "portfolio") renderPortfolio();
  else if (view === "news") renderNews();
  else if (view === "leaderboard") renderLeaderboard();
  else if (view === "casino") casino.render();
  else if (view === "predict") predictions.renderPredictions();
  else if (view === "admin") predictions.renderAdmin();
}

/* ---------- market list ---------- */
function renderMarket() {
  const now = Date.now();
  const rows = aliveStocks().map((st) => {
    const p = engine.price(st, now);
    if (p === null) return "";
    const c = sparkFor(st);
    const chg = c.p24 ? p / c.p24 - 1 : 0;
    return `<div class="mkt-row" data-tk="${st.ticker}">
      <div class="tk">${st.ticker}</div>
      <div class="co">${st.name} · ${st.sector}</div>
      <div class="px">${fmt(p)}</div>
      <div class="chg ${chg >= 0 ? "up" : "down"}">${pct(chg)}</div>
      <canvas class="spark" width="110" height="30" data-seed="${st.seed}"></canvas>
    </div>`;
  }).join("");
  $("#view-market").innerHTML = `
    <div class="mkt-row mkt-head">
      <div>Ticker</div><div>Company</div><div style="text-align:right">Price</div>
      <div style="text-align:right">24h</div><div style="text-align:right">Trend</div>
    </div>${rows}`;
  $("#view-market").querySelectorAll(".mkt-row[data-tk]").forEach((r) =>
    r.addEventListener("click", () => { openTicker = r.dataset.tk; renderStock(); })
  );
  drawSparks();
}

function drawSparks() {
  document.querySelectorAll("canvas.spark").forEach((cv) => {
    const seed = Number(cv.dataset.seed);
    const st = market.stocks.find((s) => s.seed === seed);
    if (!st) return;
    const { pts } = sparkFor(st);
    if (pts.length < 2) return;
    const ctx = cv.getContext("2d");
    const lo = Math.min(...pts.map((p) => p.p)), hi = Math.max(...pts.map((p) => p.p));
    const up = pts[pts.length - 1].p >= pts[0].p;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = up ? "#37d67a" : "#ff6161";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (i / (pts.length - 1)) * cv.width;
      const y = cv.height - 3 - ((p.p - lo) / (hi - lo || 1)) * (cv.height - 6);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
}

/* ---------- stock detail ---------- */
const TFS = { "1H": 3600000, "6H": 6 * 3600000, "24H": 86400000, "1W": 7 * 86400000, "ALL": null };

function renderStock() {
  const st = findStock(openTicker);
  if (!st) { openTicker = null; return render(); }
  showView("stock");
  const now = Date.now();
  const p = st.dead ? null : engine.price(st, now);
  const c = sparkFor(st);
  const chg = p !== null && c.p24 ? p / c.p24 - 1 : 0;
  const held = (myDoc?.holdings || {})[st.ticker] || 0;
  const el = $("#view-stock");
  el.innerHTML = `
    <button class="ghost back">← Exchange</button>
    <div class="stock-head">
      <div><h2>${st.ticker} ${st.dead ? '<span class="dead-tag">DELISTED</span>' : ""}</h2>
        <div class="sector">${st.name} · ${st.sector}</div></div>
      <div><span class="big-px">${p === null ? "₡0.00" : fmt(p)}</span>
        <span class="big-chg ${chg >= 0 ? "up" : "down"}">${p === null ? "" : pct(chg) + " today"}</span></div>
    </div>
    <div class="tf-row">${Object.keys(TFS).map((k) =>
      `<button data-tf="${k}" class="${k === chartTf ? "active" : ""}">${k}</button>`).join("")}</div>
    <canvas id="chart"></canvas>
    ${st.dead ? `<p class="muted" style="margin-top:14px">This company went bankrupt. Positions are worthless. Pour one out.</p>` : `
    <div class="trade-box">
      <input id="qty" type="number" min="1" step="1" placeholder="Shares" value="1">
      <button class="btn-buy" id="btn-buy">Buy</button>
      <button class="btn-sell" id="btn-sell" ${held ? "" : "disabled"}>Sell</button>
      <div class="trade-meta" id="trade-meta"></div>
    </div>`}
  `;
  el.querySelector(".back").addEventListener("click", () => { openTicker = null; render(); });
  el.querySelectorAll("[data-tf]").forEach((b) =>
    b.addEventListener("click", () => { chartTf = b.dataset.tf; renderStock(); }));
  if (!st.dead) {
    $("#btn-buy").addEventListener("click", () => trade(st.ticker, $("#qty").value, "buy"));
    $("#btn-sell").addEventListener("click", () => trade(st.ticker, $("#qty").value, "sell"));
    updateTradeMeta(st);
  }
  drawChart(st);
}

function updateTradeMeta(st) {
  const meta = $("#trade-meta");
  if (!meta || !myDoc) return;
  const p = engine.price(st, Date.now());
  if (p === null) return;
  const qty = Math.max(1, Math.floor(Number($("#qty")?.value || 1)));
  const held = (myDoc.holdings || {})[st.ticker] || 0;
  meta.textContent =
    `Cost ${fmt(qty * p)} · you hold ${held} share${held === 1 ? "" : "s"} · cash ${fmt(myDoc.cash)}`;
}

function drawChart(st) {
  const cv = $("#chart");
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  const now = st.dead || Date.now();
  const span = TFS[chartTf];
  const from = span ? Math.max(st.birth, now - span) : st.birth;
  const pts = engine.history(st, from, now, Math.min(400, w));
  if (!st.dead) {
    const live = engine.price(st, Date.now());
    if (live !== null) pts.push({ t: Date.now(), p: live });
  } else pts.push({ t: st.dead, p: 0 });
  if (pts.length < 2) { ctx.fillStyle = "#9a96a8"; ctx.fillText("Not enough history yet — check back in a few minutes.", 16, 30); return; }
  const lo = Math.min(...pts.map((p) => p.p)), hi = Math.max(...pts.map((p) => p.p));
  const pad = 14, X = (t) => pad + ((t - pts[0].t) / (pts[pts.length - 1].t - pts[0].t || 1)) * (w - 2 * pad);
  const Y = (p) => h - pad - ((p - lo) / (hi - lo || 1)) * (h - 2 * pad);
  // gridlines
  ctx.strokeStyle = "#2a3350"; ctx.lineWidth = 1;
  ctx.font = "10px IBM Plex Mono"; ctx.fillStyle = "#9a96a8";
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    ctx.fillText(v.toFixed(2), w - pad - 44, y - 4);
  }
  // line
  const up = pts[pts.length - 1].p >= pts[0].p;
  ctx.strokeStyle = up ? "#37d67a" : "#ff6161"; ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.p)) : ctx.moveTo(X(p.t), Y(p.p))));
  ctx.stroke();
}

/* ---------- portfolio ---------- */
function renderPortfolio() {
  if (!myDoc) return;
  const now = Date.now();
  const total = portfolioValue(myDoc);
  const gain = total / STARTING_CASH - 1;
  const holdings = Object.entries(myDoc.holdings || {});
  const rows = holdings.map(([tk, sh]) => {
    const st = findStock(tk);
    const dead = !st || st.dead;
    const p = dead ? 0 : engine.price(st, now) || 0;
    return `<div class="mkt-row" data-tk="${dead ? "" : tk}">
      <div class="tk">${tk}${dead ? '<span class="dead-tag">DELISTED</span>' : ""}</div>
      <div class="co">${st ? st.name : ""} · ${sh} share${sh === 1 ? "" : "s"}</div>
      <div class="px">${fmt(p)}</div>
      <div class="chg">${fmt(sh * p)}</div><div></div>
    </div>`;
  }).join("");
  $("#view-portfolio").innerHTML = `
    <div class="pf-summary">
      <div><div class="lbl">Net worth</div><div class="val">${fmt(total)}</div></div>
      <div><div class="lbl">Cash</div><div class="val">${fmt(myDoc.cash)}</div></div>
      <div><div class="lbl">All-time</div><div class="val ${gain >= 0 ? "up" : "down"}">${pct(gain)}</div></div>
    </div>
    <h3 class="sec">Positions</h3>
    ${rows || `<p class="muted">No positions yet. Hit the Exchange tab and buy something reckless.</p>`}`;
  $("#view-portfolio").querySelectorAll(".mkt-row[data-tk]").forEach((r) => {
    if (r.dataset.tk) r.addEventListener("click", () => { openTicker = r.dataset.tk; renderStock(); });
  });
}

/* ---------- news ---------- */
function currentNews() {
  return market ? engine.news(market.stocks, Date.now(), 80) : [];
}
function renderNews() {
  const items = currentNews();
  $("#view-news").innerHTML = `<h3 class="sec">The Vapor Journal</h3>` + items.map((n) => `
    <div class="news-item ${n.bucket}">
      <div class="news-time">${new Date(n.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
      <div class="news-tk">${n.ticker}</div>
      <div class="news-text">${n.text}</div>
    </div>`).join("");
}

/* ---------- leaderboard ---------- */
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let sendOpen = null; // uid of the row with the send form open

function renderLeaderboard() {
  const ranked = allUsers
    .map((u) => ({ ...u, total: portfolioValue(u) }))
    .sort((a, b) => b.total - a.total);
  $("#view-leaderboard").innerHTML = `<h3 class="sec">Standings</h3>` + ranked.map((u, i) => {
    const g = u.total / STARTING_CASH - 1;
    const isMe = u.id === me?.uid;
    const name = escHtml(u.name || "Trader");
    const open = sendOpen === u.id;
    return `<div class="lb-row ${isMe ? "me" : ""}">
      <div class="lb-rank">#${i + 1}</div>
      <div class="lb-name">${social.avatarHtml(u, 30)}<span>${name}</span></div>
      <div class="lb-val">${fmt(u.total)}</div>
      <div class="lb-val ${g >= 0 ? "up" : "down"}">${pct(g)}</div>
      <div class="lb-act">${isMe ? "" : `<button class="ghost lb-send" data-uid="${u.id}" data-name="${name}">${open ? "Cancel" : "Send ₡"}</button>`}</div>
    </div>
    ${open ? `<div class="lb-send-row">
      <input type="number" id="send-amt" min="0.01" step="0.01" placeholder="Amount">
      <button class="btn-spin" id="send-go">Send to ${name}</button>
      <span class="muted" style="font-size:12px">your cash: ${fmt(myDoc?.cash || 0)}</span>
    </div>` : ""}`;
  }).join("");

  $("#view-leaderboard").querySelectorAll(".lb-send").forEach((b) =>
    b.addEventListener("click", () => {
      sendOpen = sendOpen === b.dataset.uid ? null : b.dataset.uid;
      renderLeaderboard();
      $("#send-amt")?.focus();
    }));
  $("#send-go")?.addEventListener("click", async () => {
    const target = ranked.find((u) => u.id === sendOpen);
    if (!target) return;
    const ok = await social.sendMoney(target.id, target.name || "Trader", $("#send-amt")?.value);
    if (ok) { sendOpen = null; renderLeaderboard(); }
  });
}

/* ---------- ticker tape + toasts ---------- */
function renderTape() {
  if (!market) return;
  const now = Date.now();
  const news = currentNews().filter((n) => now - n.time < 6 * 3600000).slice(0, 4);
  const items = aliveStocks().map((st) => {
    const p = engine.price(st, now);
    if (p === null) return "";
    const c = sparkFor(st);
    const chg = c.p24 ? p / c.p24 - 1 : 0;
    return `<span class="tape-item"><b>${st.ticker}</b> ${fmt(p)} <span class="${chg >= 0 ? "up" : "down"}">${pct(chg)}</span></span>`;
  });
  const breaking = news.map((n) => `<span class="tape-item breaking">◆ ${n.text}</span>`);
  const half = [...items.slice(0, 7), ...breaking.slice(0, 2), ...items.slice(7)].join("");
  $("#tape").innerHTML = half + half; // duplicated for seamless loop
}

function toast(label, text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<div class="t-label">${label}</div>${text}`;
  $("#toast-stack").appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

let lastToastCheck = Date.now();
function checkNewsAlerts() {
  const items = currentNews().filter((n) => n.time > lastToastCheck && n.time <= Date.now());
  for (const n of items.slice(0, 3)) {
    if (n.bucket === "flat" || n.bucket === "ipo") continue;
    toast("MARKET WIRE", n.text);
  }
  if (items.length) lastToastCheck = Date.now();
  const newest = currentNews()[0];
  $("#news-dot")?.classList.toggle("hidden", !(newest && newest.time > lastNewsSeen && view !== "news"));
}

/* ---------- loops ---------- */
let tick = 0;
setInterval(() => {
  if (!market || !me) return;
  tick++;
  if (openTicker) {
    const st = findStock(openTicker);
    if (st && !st.dead) {
      const p = engine.price(st, Date.now());
      const el = document.querySelector(".big-px");
      if (el && p !== null) el.textContent = fmt(p);
      updateTradeMeta(st);
      if (tick % 15 === 0) drawChart(st); // refresh chart every ~30s
    }
  } else if (view === "market") {
    renderMarket();
  } else if (view === "portfolio") {
    renderPortfolio();
  }
}, 2000);

setInterval(() => { if (market && me) { renderTape(); checkNewsAlerts(); } }, 15000);
setTimeout(() => { if (market && me) { renderTape(); checkNewsAlerts(); } }, 1500);
