/* ============================================================
   VAPORSTOCKS — prediction markets
   Admin (ADMIN_UID) creates questions with per-option payout
   multipliers, then locks/resolves/voids them. Players stake
   credits on one option per question. Payouts are claimed by
   each winner's own client via a transaction on their user doc
   (rules only allow players to write their own account).

   Firestore:
     predictions/{id}         — question, options[{label,multiplier}],
                                status: open|locked|resolved|void,
                                outcome (option index), createdAt
     predictions/{id}/bets/{uid} — option, amount, name, at,
                                   settled, payout
   ============================================================ */

import {
  doc, collection, onSnapshot, runTransaction, getDoc, getDocs,
  addDoc, deleteDoc, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let api = null;     // { db, me, myDoc, fmt, toast, el, adminEl, isAdmin, ADMIN_UID }
let preds = [];     // live snapshot
let myBets = {};    // predId -> bet data (mine)
let unsubPreds = null;
const betUnsubs = new Map();
const claiming = new Set();

const STATUS_LABEL = { open: "OPEN", locked: "LOCKED", resolved: "RESOLVED", void: "VOIDED" };

/* ---------------- subscription ---------------- */
export function subscribePredictions() {
  if (unsubPreds) return;
  const db = api.db;
  unsubPreds = onSnapshot(query(collection(db, "predictions"), orderBy("createdAt", "desc")), (qs) => {
    preds = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    syncMyBets();
    autoClaim();
    renderPredictions();
    renderAdmin();
  });
}
export function unsubscribePredictions() {
  if (unsubPreds) { unsubPreds(); unsubPreds = null; }
  betUnsubs.forEach((u) => u());
  betUnsubs.clear();
  preds = []; myBets = {};
}

// keep a live copy of my own bet on each prediction
function syncMyBets() {
  const db = api.db, uid = api.me()?.uid;
  if (!uid) return;
  const liveIds = new Set(preds.map((p) => p.id));
  for (const [id, unsub] of betUnsubs) {
    if (!liveIds.has(id)) { unsub(); betUnsubs.delete(id); delete myBets[id]; }
  }
  for (const p of preds) {
    if (betUnsubs.has(p.id)) continue;
    const unsub = onSnapshot(doc(db, "predictions", p.id, "bets", uid), (snap) => {
      if (snap.exists()) myBets[p.id] = snap.data(); else delete myBets[p.id];
      autoClaim();
      renderPredictions();
    });
    betUnsubs.set(p.id, unsub);
  }
}

/* ---------------- betting ---------------- */
async function placeBet(pred, optionIdx, amount) {
  const db = api.db, uid = api.me().uid;
  amount = Math.floor(amount);
  if (!(amount > 0)) return;
  try {
    await runTransaction(db, async (tx) => {
      const predRef = doc(db, "predictions", pred.id);
      const betRef = doc(db, "predictions", pred.id, "bets", uid);
      const userRef = doc(db, "users", uid);
      const [pSnap, bSnap, uSnap] = [await tx.get(predRef), await tx.get(betRef), await tx.get(userRef)];
      if (!pSnap.exists() || pSnap.data().status !== "open") throw new Error("Betting is closed on this one.");
      const u = uSnap.data();
      if ((u.cash || 0) < amount) throw new Error("Not enough credits.");
      let bet;
      if (bSnap.exists()) {
        const b = bSnap.data();
        if (b.option !== optionIdx) throw new Error(`You already backed "${pred.options[b.option].label}". No hedging.`);
        bet = { ...b, amount: b.amount + amount };
      } else {
        bet = { option: optionIdx, amount, name: u.name || "Trader", at: Date.now(), settled: false, payout: 0 };
      }
      tx.update(userRef, { cash: u.cash - amount });
      tx.set(betRef, bet);
    });
    api.toast("Bet placed", `${api.fmt(amount)} on "${pred.options[optionIdx].label}"`);
  } catch (e) { alert(e.message); }
}

/* ---------------- auto-claim payouts ---------------- */
async function autoClaim() {
  const db = api.db, uid = api.me()?.uid;
  if (!uid) return;
  for (const p of preds) {
    if (p.status !== "resolved" && p.status !== "void") continue;
    const bet = myBets[p.id];
    if (!bet || bet.settled || claiming.has(p.id)) continue;
    claiming.add(p.id);
    try {
      let credited = 0, label = "";
      await runTransaction(db, async (tx) => {
        const predRef = doc(db, "predictions", p.id);
        const betRef = doc(db, "predictions", p.id, "bets", uid);
        const userRef = doc(db, "users", uid);
        const [pSnap, bSnap, uSnap] = [await tx.get(predRef), await tx.get(betRef), await tx.get(userRef)];
        if (!pSnap.exists() || !bSnap.exists()) return;
        const pd = pSnap.data(), b = bSnap.data();
        if (b.settled) return;
        if (pd.status === "void") { credited = b.amount; label = "refunded"; }
        else if (pd.status === "resolved" && b.option === pd.outcome) {
          credited = Math.round(b.amount * pd.options[pd.outcome].multiplier * 100) / 100;
          label = "won";
        } else if (pd.status === "resolved") { credited = 0; label = "lost"; }
        else return;
        if (credited > 0) tx.update(userRef, { cash: (uSnap.data().cash || 0) + credited });
        tx.set(betRef, { ...b, settled: true, payout: credited });
      });
      if (label === "won") api.toast("PREDICTION PAID", `"${p.question}" — you won ${api.fmt(credited)}!`);
      else if (label === "refunded") api.toast("Bet refunded", `"${p.question}" was voided — ${api.fmt(credited)} returned.`);
    } catch (e) { console.error("claim failed", e); }
    claiming.delete(p.id);
  }
}

/* ---------------- player view ---------------- */
function predCard(p) {
  const bet = myBets[p.id];
  const status = p.status || "open";
  const open = status === "open";
  const pool = null; // per-option pools are visible on the admin page only

  const options = p.options.map((o, i) => {
    const winner = status === "resolved" && p.outcome === i;
    const mine = bet && bet.option === i;
    return `<div class="pred-opt ${winner ? "winner" : ""} ${mine ? "mine" : ""}">
      <div class="pred-opt-label">${esc(o.label)}${winner ? " ✓" : ""}</div>
      <div class="pred-opt-mult">${o.multiplier}x</div>
      ${open ? `<button class="pred-bet-btn" data-pid="${p.id}" data-opt="${i}">Bet</button>` : ""}
    </div>`;
  }).join("");

  let myLine = "";
  if (bet) {
    const opt = p.options[bet.option];
    if (status === "resolved" && bet.settled) {
      myLine = bet.payout > 0
        ? `<div class="pred-mine up">You won ${api.fmt(bet.payout)} on "${esc(opt.label)}"</div>`
        : `<div class="pred-mine down">You lost ${api.fmt(bet.amount)} on "${esc(opt.label)}"</div>`;
    } else if (status === "void") {
      myLine = `<div class="pred-mine">Voided — ${api.fmt(bet.amount)} refunded</div>`;
    } else {
      myLine = `<div class="pred-mine">Your stake: ${api.fmt(bet.amount)} on "${esc(opt.label)}" → pays ${api.fmt(bet.amount * opt.multiplier)} if it hits</div>`;
    }
  }

  return `<div class="pred-card ${status}">
    <div class="pred-top">
      <span class="pred-status ${status}">${STATUS_LABEL[status]}</span>
      <span class="pred-q">${esc(p.question)}</span>
    </div>
    <div class="pred-opts">${options}</div>
    ${open ? `<div class="pred-stake-row">
      <input type="number" min="1" step="1" placeholder="Stake" class="pred-amt" id="amt-${p.id}">
      <span class="muted" style="font-size:12px">then hit Bet on an option · payout = stake × multiplier</span>
    </div>` : ""}
    ${myLine}
  </div>`;
}

function renderPredictions() {
  const el = api.el();
  if (!el) return;
  const active = preds.filter((p) => p.status === "open" || p.status === "locked");
  const done = preds.filter((p) => p.status === "resolved" || p.status === "void");
  el.innerHTML = `
    <h3 class="sec">Prediction Desk</h3>
    ${preds.length === 0 ? `<p class="muted">Nothing on the board yet. The house sets the lines — check back soon.</p>` : ""}
    ${active.map(predCard).join("")}
    ${done.length ? `<h3 class="sec" style="margin-top:22px">Settled</h3>` + done.map(predCard).join("") : ""}
    ${!api.isAdmin() && api.ADMIN_UID.startsWith("PASTE") ? `<p class="muted" style="font-size:12px;margin-top:14px">Admin not configured. Your UID (for firebase-config.js and firestore.rules): <code>${api.me()?.uid || ""}</code></p>` : ""}
  `;
  el.querySelectorAll(".pred-bet-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const p = preds.find((x) => x.id === b.dataset.pid);
      const amt = Number(document.querySelector(`#amt-${b.dataset.pid}`)?.value || 0);
      if (!(amt > 0)) return alert("Enter a stake first.");
      placeBet(p, Number(b.dataset.opt), amt);
    }));
}

/* ---------------- admin view ---------------- */
let draftOptions = [{ label: "Yes", multiplier: 2 }, { label: "No", multiplier: 2 }];
const expandedBets = new Map(); // predId -> bets array (loaded on demand)

async function createPrediction() {
  const q = document.querySelector("#adm-q")?.value.trim();
  if (!q) return alert("Write the question.");
  const opts = draftOptions
    .map((o) => ({ label: o.label.trim(), multiplier: Number(o.multiplier) }))
    .filter((o) => o.label && o.multiplier > 0);
  if (opts.length < 2) return alert("Need at least two options with positive multipliers.");
  try {
    await addDoc(collection(api.db, "predictions"), {
      question: q, options: opts, status: "open", outcome: null, createdAt: Date.now()
    });
    draftOptions = [{ label: "Yes", multiplier: 2 }, { label: "No", multiplier: 2 }];
    api.toast("Prediction posted", q);
  } catch (e) { alert(e.message); }
}

async function setStatus(p, patch) {
  try {
    await runTransaction(api.db, async (tx) => {
      const ref = doc(api.db, "predictions", p.id);
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      tx.set(ref, { ...snap.data(), ...patch });
    });
  } catch (e) { alert(e.message); }
}

async function loadBets(pid) {
  const qs = await getDocs(collection(api.db, "predictions", pid, "bets"));
  expandedBets.set(pid, qs.docs.map((d) => ({ uid: d.id, ...d.data() })));
  renderAdmin();
}

function admCard(p) {
  const status = p.status || "open";
  const bets = expandedBets.get(p.id);
  const betRows = bets ? (bets.length ? bets.map((b) =>
    `<div class="adm-bet"><span>${esc(b.name)}</span><span>${api.fmt(b.amount)} on "${esc(p.options[b.option]?.label || "?")}"</span><span>${b.settled ? (b.payout > 0 ? `paid ${api.fmt(b.payout)}` : "lost") : "pending"}</span></div>`
  ).join("") : `<div class="muted" style="font-size:12px">No bets yet.</div>`) : "";
  const exposure = bets ? p.options.map((o, i) => {
    const staked = bets.filter((b) => b.option === i).reduce((a, b) => a + b.amount, 0);
    return `${esc(o.label)}: ${api.fmt(staked)} staked → ${api.fmt(staked * o.multiplier)} liability`;
  }).join(" · ") : "";

  return `<div class="pred-card ${status}">
    <div class="pred-top">
      <span class="pred-status ${status}">${STATUS_LABEL[status]}</span>
      <span class="pred-q">${esc(p.question)}</span>
    </div>
    <div class="adm-controls">
      ${status === "open" ? `<button class="ghost" data-act="lock" data-pid="${p.id}">Lock betting</button>` : ""}
      ${status === "locked" ? `<button class="ghost" data-act="reopen" data-pid="${p.id}">Reopen</button>` : ""}
      ${(status === "open" || status === "locked") ? p.options.map((o, i) =>
        `<button class="adm-resolve" data-act="resolve" data-pid="${p.id}" data-opt="${i}">Resolve: ${esc(o.label)} (${o.multiplier}x)</button>`).join("") : ""}
      ${(status === "open" || status === "locked") ? `<button class="ghost" data-act="void" data-pid="${p.id}">Void (refund all)</button>` : ""}
      <button class="ghost" data-act="bets" data-pid="${p.id}">${bets ? "Refresh bets" : "View bets"}</button>
      ${(status === "resolved" || status === "void") ? `<button class="ghost danger" data-act="delete" data-pid="${p.id}">Delete</button>` : ""}
    </div>
    ${exposure ? `<div class="muted" style="font-size:12px;margin-top:8px">${exposure}</div>` : ""}
    ${betRows ? `<div class="adm-bets">${betRows}</div>` : ""}
  </div>`;
}

function renderAdmin() {
  const el = api.adminEl();
  if (!el) return;
  if (!api.isAdmin()) { el.innerHTML = `<p class="muted">You are not the house.</p>`; return; }

  el.innerHTML = `
    <h3 class="sec">The House Desk</h3>
    <div class="adm-form">
      <input id="adm-q" type="text" placeholder='e.g. "Will KRILLIUM survive the week?"' maxlength="140">
      <div id="adm-opts">
        ${draftOptions.map((o, i) => `
          <div class="adm-opt-row">
            <input type="text" data-di="${i}" data-f="label" value="${esc(o.label)}" placeholder="Option label">
            <input type="number" data-di="${i}" data-f="multiplier" value="${o.multiplier}" min="0.1" step="0.1" title="Payout multiplier">
            <span class="muted" style="font-size:12px">x payout</span>
            ${draftOptions.length > 2 ? `<button class="ghost" data-rm="${i}">✕</button>` : ""}
          </div>`).join("")}
      </div>
      <div class="adm-form-actions">
        <button class="ghost" id="adm-add-opt">+ Option</button>
        <button class="btn-spin" id="adm-create">Post prediction</button>
      </div>
      <p class="muted" style="font-size:12px">Multiplier = total payout per credit staked (a 2x winner turns ₡100 into ₡200). Losing stakes are burned, so the house neither holds nor pays the float — winners are paid from thin air, house-of-vapor style.</p>
    </div>
    ${preds.map(admCard).join("") || `<p class="muted">No predictions yet.</p>`}
  `;

  el.querySelector("#adm-add-opt")?.addEventListener("click", () => {
    captureDraft(); draftOptions.push({ label: "", multiplier: 2 }); renderAdmin();
  });
  el.querySelector("#adm-create")?.addEventListener("click", () => { captureDraft(); createPrediction(); });
  el.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
    captureDraft(); draftOptions.splice(Number(b.dataset.rm), 1); renderAdmin();
  }));
  el.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
    const p = preds.find((x) => x.id === b.dataset.pid);
    if (!p) return;
    const act = b.dataset.act;
    if (act === "lock") setStatus(p, { status: "locked" });
    else if (act === "reopen") setStatus(p, { status: "open" });
    else if (act === "void") { if (confirm("Void and refund every stake?")) setStatus(p, { status: "void" }); }
    else if (act === "resolve") {
      const i = Number(b.dataset.opt);
      if (confirm(`Resolve as "${p.options[i].label}"? Winners get ${p.options[i].multiplier}x. This can't be undone.`))
        setStatus(p, { status: "resolved", outcome: i });
    }
    else if (act === "bets") loadBets(p.id);
    else if (act === "delete") { if (confirm("Delete this prediction? Bet records go with it.")) deleteDoc(doc(api.db, "predictions", p.id)); }
  }));
}

function captureDraft() {
  document.querySelectorAll("#adm-opts [data-di]").forEach((inp) => {
    const o = draftOptions[Number(inp.dataset.di)];
    if (o) o[inp.dataset.f] = inp.dataset.f === "multiplier" ? Number(inp.value) : inp.value;
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function initPredictions(apiIn) {
  api = apiIn;
  return { renderPredictions, renderAdmin, subscribePredictions, unsubscribePredictions };
}
