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
  addDoc, deleteDoc, updateDoc, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let api = null;     // { db, me, myDoc, fmt, toast, el, adminEl, isAdmin, ADMIN_UID }
let preds = [];     // live snapshot
let myBets = {};    // predId -> bet data (mine)
let unsubPreds = null;
const betUnsubs = new Map();
const claiming = new Set();

const STATUS_LABEL = { open: "OPEN", locked: "LOCKED", resolved: "RESOLVED", void: "VOIDED" };

// A prediction with an expired timer behaves as locked even before the
// admin (or any client) touches it. Manual lock/unlock still works;
// reopening clears the timer.
const isOpen = (p) => p.status === "open" && !(p.closesAt && Date.now() > p.closesAt);
const effStatus = (p) => (p.status === "open" && p.closesAt && Date.now() > p.closesAt) ? "locked" : (p.status || "open");
function lockCountdown(p) {
  if (!p.closesAt || p.status !== "open") return "";
  const ms = p.closesAt - Date.now();
  if (ms <= 0) return "betting closed";
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `locks in ${h}h ${m}m` : `locks in ${m}m`;
}

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
      const pd = pSnap.data();
      if (!pSnap.exists() || pd.status !== "open" || (pd.closesAt && Date.now() > pd.closesAt))
        throw new Error("Betting is closed on this one.");
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

async function pickFree(pred, optionIdx) {
  const db = api.db, uid = api.me().uid;
  try {
    await runTransaction(db, async (tx) => {
      const predRef = doc(db, "predictions", pred.id);
      const betRef = doc(db, "predictions", pred.id, "bets", uid);
      const [pSnap, bSnap] = [await tx.get(predRef), await tx.get(betRef)];
      const pd = pSnap.data();
      if (!pSnap.exists() || pd.status !== "open" || (pd.closesAt && Date.now() > pd.closesAt))
        throw new Error("Picks are closed on this one.");
      const prev = bSnap.exists() ? bSnap.data() : null;
      tx.set(betRef, {
        option: optionIdx, amount: 0, free: true,
        name: api.myDoc()?.name || "Trader",
        at: prev?.at || Date.now(), settled: false, payout: 0
      });
    });
    api.toast("Pick locked in", `"${pred.options[optionIdx].label}" — worth ${api.fmt(pred.reward || 0)} if right. You can switch until it locks.`);
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
        if (pd.status === "void") { credited = b.free ? 0 : b.amount; label = b.free ? "lost" : "refunded"; }
        else if (pd.status === "resolved" && b.option === pd.outcome) {
          credited = b.free
            ? Math.round((pd.reward || 0) * 100) / 100
            : Math.round(b.amount * pd.options[pd.outcome].multiplier * 100) / 100;
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
  const status = effStatus(p);           // timer-expired open cards render as locked
  const open = isOpen(p);
  const free = p.type === "free";
  const countdown = lockCountdown(p);

  const options = p.options.map((o, i) => {
    const winner = status === "resolved" && p.outcome === i;
    const mine = bet && bet.option === i;
    return `<div class="pred-opt ${winner ? "winner" : ""} ${mine ? "mine" : ""}">
      <div class="pred-opt-label">${esc(o.label)}${winner ? " ✓" : ""}</div>
      <div class="pred-opt-mult">${free ? "" : o.multiplier + "x"}</div>
      ${open ? `<button class="pred-bet-btn" data-pid="${p.id}" data-opt="${i}">${free ? (mine ? "Picked ✓" : "Pick") : "Bet"}</button>` : ""}
    </div>`;
  }).join("");

  let myLine = "";
  if (bet) {
    const opt = p.options[bet.option];
    if (status === "resolved" && bet.settled) {
      myLine = bet.payout > 0
        ? `<div class="pred-mine up">You won ${api.fmt(bet.payout)} on "${esc(opt.label)}"</div>`
        : `<div class="pred-mine down">${bet.free ? `Wrong pick — "${esc(opt.label)}" (nothing lost)` : `You lost ${api.fmt(bet.amount)} on "${esc(opt.label)}"`}</div>`;
    } else if (status === "void") {
      myLine = `<div class="pred-mine">${bet.free ? "Voided — no harm done" : `Voided — ${api.fmt(bet.amount)} refunded`}</div>`;
    } else if (bet.free) {
      myLine = `<div class="pred-mine">Your pick: "${esc(opt.label)}" → worth ${api.fmt(p.reward || 0)} if right${open ? " · switch anytime before lock" : ""}</div>`;
    } else {
      myLine = `<div class="pred-mine">Your stake: ${api.fmt(bet.amount)} on "${esc(opt.label)}" → pays ${api.fmt(bet.amount * opt.multiplier)} if it hits</div>`;
    }
  }

  return `<div class="pred-card ${status}">
    <div class="pred-top">
      <span class="pred-status ${status}">${STATUS_LABEL[status]}</span>
      ${free ? `<span class="pred-free-tag">FREE · ${api.fmt(p.reward || 0)}</span>` : ""}
      <span class="pred-q">${esc(p.question)}</span>
      ${countdown ? `<span class="muted" style="font-size:11px;font-family:var(--mono)">${countdown}</span>` : ""}
    </div>
    <div class="pred-opts">${options}</div>
    ${open && !free ? `<div class="pred-stake-row">
      <input type="number" min="1" step="1" placeholder="Stake" class="pred-amt" id="amt-${p.id}">
      <span class="muted" style="font-size:12px">then hit Bet on an option · payout = stake × multiplier</span>
    </div>` : ""}
    ${open && free ? `<div class="pred-stake-row"><span class="muted" style="font-size:12px">No stake — pick an answer, get ${api.fmt(p.reward || 0)} if you're right. Nothing to lose.</span></div>` : ""}
    ${myLine}
  </div>`;
}

function renderPredictions() {
  const el = api.el();
  if (!el) return;
  const active = preds.filter((p) => effStatus(p) === "open" || effStatus(p) === "locked");
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
      if (!p) return;
      if (p.type === "free") return pickFree(p, Number(b.dataset.opt));
      const amt = Number(document.querySelector(`#amt-${b.dataset.pid}`)?.value || 0);
      if (!(amt > 0)) return alert("Enter a stake first.");
      placeBet(p, Number(b.dataset.opt), amt);
    }));
}

/* ---------------- admin view ---------------- */
let draftOptions = [{ label: "Yes", multiplier: 2 }, { label: "No", multiplier: 2 }];
let draftType = "wager";     // "wager" | "free"
let draftReward = 100;       // credits for a correct free pick
let draftLockHours = "";     // optional auto-lock timer
const expandedBets = new Map(); // predId -> bets array (loaded on demand)

async function createPrediction() {
  const q = document.querySelector("#adm-q")?.value.trim();
  if (!q) return alert("Write the question.");
  const free = draftType === "free";
  const opts = draftOptions
    .map((o) => ({ label: o.label.trim(), multiplier: free ? 1 : Number(o.multiplier) }))
    .filter((o) => o.label && (free || o.multiplier > 0));
  if (opts.length < 2) return alert(free ? "Need at least two options." : "Need at least two options with positive multipliers.");
  const reward = Math.round(Number(draftReward) * 100) / 100;
  if (free && !(reward > 0)) return alert("Set a reward for correct picks.");
  const hours = Number(draftLockHours);
  const closesAt = hours > 0 ? Date.now() + hours * 3600000 : null;
  try {
    await addDoc(collection(api.db, "predictions"), {
      question: q, options: opts, status: "open", outcome: null, createdAt: Date.now(),
      type: draftType, reward: free ? reward : null, closesAt
    });
    draftOptions = [{ label: "Yes", multiplier: 2 }, { label: "No", multiplier: 2 }];
    draftLockHours = "";
    api.toast("Prediction posted", q + (closesAt ? ` — auto-locks in ${hours}h` : ""));
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
  const status = effStatus(p);
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
      ${p.type === "free" ? `<span class="pred-free-tag">FREE · ${api.fmt(p.reward || 0)}</span>` : ""}
      <span class="pred-q">${esc(p.question)}</span>
      ${lockCountdown(p) ? `<span class="muted" style="font-size:11px;font-family:var(--mono)">${lockCountdown(p)}</span>` : ""}
    </div>
    <div class="adm-controls">
      ${status === "open" ? `<button class="ghost" data-act="lock" data-pid="${p.id}">Lock betting</button>` : ""}
      ${status === "locked" ? `<button class="ghost" data-act="reopen" data-pid="${p.id}">Reopen${p.closesAt ? " (clears timer)" : ""}</button>` : ""}
      ${(status === "open" || status === "locked") ? p.options.map((o, i) =>
        `<button class="adm-resolve" data-act="resolve" data-pid="${p.id}" data-opt="${i}">Resolve: ${esc(o.label)}${p.type === "free" ? "" : ` (${o.multiplier}x)`}</button>`).join("") : ""}
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
      <div class="adm-type-row">
        <button class="ghost ${draftType === "wager" ? "on" : ""}" data-ptype="wager">Wager</button>
        <button class="ghost ${draftType === "free" ? "on" : ""}" data-ptype="free">Free</button>
      </div>
      <input id="adm-q" type="text" placeholder='e.g. "Will KRILLIUM survive the week?"' maxlength="140">
      <div id="adm-opts">
        ${draftOptions.map((o, i) => `
          <div class="adm-opt-row">
            <input type="text" data-di="${i}" data-f="label" value="${esc(o.label)}" placeholder="Option label">
            ${draftType === "wager" ? `<input type="number" data-di="${i}" data-f="multiplier" value="${o.multiplier}" min="0.1" step="0.1" title="Payout multiplier">
            <span class="muted" style="font-size:12px">x payout</span>` : ""}
            ${draftOptions.length > 2 ? `<button class="ghost" data-rm="${i}">✕</button>` : ""}
          </div>`).join("")}
      </div>
      ${draftType === "free" ? `<div class="adm-opt-row">
        <span class="muted" style="font-size:12px">Reward for a correct pick:</span>
        <input type="number" id="adm-reward" value="${draftReward}" min="1" step="1">
      </div>` : ""}
      <div class="adm-opt-row">
        <span class="muted" style="font-size:12px">Auto-lock after (hours, blank = manual only):</span>
        <input type="number" id="adm-hours" value="${draftLockHours}" min="0.1" step="0.5" placeholder="—">
      </div>
      <div class="adm-form-actions">
        <button class="ghost" id="adm-add-opt">+ Option</button>
        <button class="btn-spin" id="adm-create">Post prediction</button>
      </div>
      <p class="muted" style="font-size:12px">${draftType === "wager"
        ? "Multiplier = total payout per credit staked (a 2x winner turns ₡100 into ₡200). Losing stakes are burned — winners are paid from thin air, house-of-vapor style."
        : "Free picks cost nothing to enter. Everyone who picked the winning option gets the reward; wrong picks lose nothing. Pure credit faucet with a quiz attached."}</p>
    </div>
    ${preds.map(admCard).join("") || `<p class="muted">No predictions yet.</p>`}
    ${treasuryPanel()}
    ${dangerZone()}
  `;

  el.querySelectorAll("[data-tr]").forEach((b) => b.addEventListener("click", () => {
    const amt = document.querySelector(`#tr-amt-${b.dataset.uid}`)?.value;
    adjustCash(b.dataset.uid, b.dataset.name, b.dataset.tr, amt);
  }));
  el.querySelectorAll("[data-liq]").forEach((b) => b.addEventListener("click", () =>
    forceSell(b.dataset.liq, b.dataset.name)));
  el.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", () => {
    const r = RESETS.find((x) => x.id === b.dataset.reset);
    runReset([r.id], r.label);
  }));
  el.querySelector("#reset-all")?.addEventListener("click", () =>
    runReset(RESETS.map((r) => r.id), "EVERYTHING (chat, predictions, Powerball, transfers, counters, all players)"));

  el.querySelectorAll("[data-ptype]").forEach((b) => b.addEventListener("click", () => {
    captureDraft(); draftType = b.dataset.ptype; renderAdmin();
  }));
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
    else if (act === "reopen") setStatus(p, { status: "open", closesAt: null });
    else if (act === "void") { if (confirm("Void and refund every stake?")) setStatus(p, { status: "void" }); }
    else if (act === "resolve") {
      const i = Number(b.dataset.opt);
      if (confirm(`Resolve as "${p.options[i].label}"? ${p.type === "free" ? `Correct pickers get ${api.fmt(p.reward || 0)}.` : `Winners get ${p.options[i].multiplier}x.`} This can't be undone.`))
        setStatus(p, { status: "resolved", outcome: i });
    }
    else if (act === "bets") loadBets(p.id);
    else if (act === "delete") { if (confirm("Delete this prediction? Bet records go with it.")) deleteDoc(doc(api.db, "predictions", p.id)); }
  }));
}

/* ---- treasury: admin add / remove / set player cash ---- */
async function adjustCash(uid, name, mode, value) {
  value = Math.round(Number(value) * 100) / 100;
  if (isNaN(value) || (mode !== "set" && !(value > 0)) || (mode === "set" && value < 0)) {
    return alert("Enter a valid amount.");
  }
  try {
    let delta = 0;
    await runTransaction(api.db, async (tx) => {
      const ref = doc(api.db, "users", uid);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("Player not found.");
      const cash = snap.data().cash || 0;
      const next = mode === "add" ? cash + value : mode === "remove" ? cash - value : value;
      if (next < 0) throw new Error(`That would take ${name} to ${api.fmt(next)}. Cash can't go negative.`);
      delta = Math.round((next - cash) * 100) / 100;
      tx.update(ref, { cash: Math.round(next * 100) / 100 });
    });
    if (delta !== 0) {
      addDoc(collection(api.db, "transfers"), {
        from: api.me().uid, fromName: "THE HOUSE",
        to: uid, toName: name, amount: delta, at: Date.now(), admin: true
      });
    }
    api.toast("Treasury", `${name}: ${delta >= 0 ? "+" : ""}${api.fmt(Math.abs(delta))}${delta < 0 ? " removed" : ""}`);
  } catch (e) { alert(e.message); }
}

/* ---- force-sell: liquidate a player's holdings into cash at
   current engine prices. For cheaters and other governance needs.
   Dead/delisted positions are wiped at zero value. ---- */
async function forceSell(uid, name) {
  const target = api.users().find((u) => u.id === uid);
  if (!target) return;
  const holdings = target.holdings || {};
  const lines = Object.entries(holdings).map(([tk, sh]) => {
    const px = api.priceOf(tk);
    return { tk, sh, px, value: px !== null ? sh * px : 0 };
  });
  const total = Math.round(lines.reduce((a, l) => a + l.value, 0) * 100) / 100;
  const summary = lines.map((l) => `${l.sh} ${l.tk} ${l.px !== null ? "@ " + api.fmt(l.px) : "(delisted, worthless)"}`).join("\n");
  if (!confirm(`Force-sell everything ${name} holds?\n\n${summary}\n\nProceeds to their cash: ${api.fmt(total)}. This can't be undone.`)) return;
  try {
    await runTransaction(api.db, async (tx) => {
      const ref = doc(api.db, "users", uid);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("Player not found.");
      const u = snap.data();
      // re-price against the live holdings snapshot inside the tx
      const proceeds = Object.entries(u.holdings || {}).reduce((a, [tk, sh]) => {
        const px = api.priceOf(tk);
        return a + (px !== null ? sh * px : 0);
      }, 0);
      tx.update(ref, {
        cash: Math.round(((u.cash || 0) + proceeds) * 100) / 100,
        holdings: {}
      });
    });
    addDoc(collection(api.db, "transfers"), {
      from: api.me().uid, fromName: "THE HOUSE",
      to: uid, toName: name, amount: total, at: Date.now(), admin: true, kind: "liquidation"
    });
    api.toast("Position liquidated", `${name}'s holdings sold for ${api.fmt(total)}.`);
  } catch (e) { alert(e.message); }
}


/* ---- danger zone: full-site resets ----
   Each wipes one system; RESET EVERYTHING runs the lot. Deletes are
   client-driven doc-by-doc (fine at friend-group scale). Player reset
   needs the widened admin branch in firestore.rules. */
let resetBusy = false;

async function wipeCollection(path, withSub) {
  const qs = await getDocs(collection(api.db, ...path));
  for (const d of qs.docs) {
    if (withSub) {
      const sub = await getDocs(collection(api.db, ...path, d.id, withSub));
      for (const sd of sub.docs) await deleteDoc(sd.ref);
    }
    await deleteDoc(d.ref);
  }
  return qs.size;
}
const RESETS = [
  { id: "chat", label: "Chat", run: async () => `${await wipeCollection(["chat"])} messages deleted` },
  { id: "preds", label: "Predictions", run: async () => `${await wipeCollection(["predictions"], "bets")} predictions deleted` },
  { id: "lotto", label: "Powerball", run: async () => `${await wipeCollection(["lottery"], "tickets")} draws deleted (pot resets to base)` },
  { id: "transfers", label: "Transfer log", run: async () => `${await wipeCollection(["transfers"])} transfers deleted` },
  { id: "stats", label: "Game counters", run: async () => {
      await deleteDoc(doc(api.db, "market", "casinoStats")).catch(() => {});
      await deleteDoc(doc(api.db, "market", "kenoStats")).catch(() => {});
      return "global counters zeroed";
    } },
  { id: "players", label: "Players (cash 1000, wipe holdings/stats/trades/caps)", run: async () => {
      const qs = await getDocs(collection(api.db, "users"));
      for (const d of qs.docs) {
        await updateDoc(d.ref, {
          cash: 1000, holdings: {}, gameStats: {}, work: {},
          dailyClaim: null, lastDivAt: null, lastPassiveDivAt: null
        });
        const trades = await getDocs(collection(api.db, "users", d.id, "trades"));
        for (const t of trades.docs) await deleteDoc(t.ref);
      }
      return `${qs.size} players reset to ₡1,000 (trade logs cleared)`;
    } }
];
async function runReset(ids, label) {
  if (resetBusy) return;
  if (prompt(`This wipes: ${label}. There is no undo.\nType RESET to confirm.`) !== "RESET") return;
  resetBusy = true;
  renderAdmin();
  const done = [];
  try {
    for (const id of ids) {
      const r = RESETS.find((x) => x.id === id);
      done.push(`${r.label}: ${await r.run()}`);
    }
    alert("Done:\n" + done.join("\n"));
  } catch (e) {
    alert(`Reset stopped partway (${done.length} completed): ${e.message}`);
  }
  resetBusy = false;
  renderAdmin();
}
function dangerZone() {
  return `<div class="adm-form" style="margin-top:20px;border-color:var(--down)">
    <h3 class="sec" style="margin-top:0;color:var(--down)">Danger Zone</h3>
    <div class="rd-gear">
      ${RESETS.map((r) => `<button class="ghost danger" data-reset="${r.id}" ${resetBusy ? "disabled" : ""}>Reset ${r.label}</button>`).join("")}
    </div>
    <div class="adm-form-actions" style="margin-top:12px">
      <button class="ghost danger" id="reset-all" ${resetBusy ? "disabled" : ""} style="font-weight:700">☢ RESET EVERYTHING</button>
    </div>
    <p class="muted" style="font-size:12px">${resetBusy ? "Working — don't close this tab…" : "Every reset asks you to type RESET first. Player reset keeps names and avatars but returns everyone to ₡1,000 with no holdings, stats, or claim history. The market roster itself is untouched — the stocks and their history are deterministic and carry on."}</p>
  </div>`;
}

function treasuryPanel() {
  const users = [...api.users()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  if (!users.length) return "";
  return `<div class="adm-form" style="margin-top:20px">
    <h3 class="sec" style="margin-top:0">Treasury</h3>
    ${users.map((u) => `
      <div class="adm-cash-row">
        <span class="adm-cash-name">${esc(u.name || "Trader")}${u.id === api.me()?.uid ? " (you)" : ""}</span>
        <span class="adm-cash-bal">${api.fmt(u.cash || 0)}</span>
        <input type="number" min="0" step="1" placeholder="Amount" id="tr-amt-${u.id}">
        <button class="ghost" data-tr="add" data-uid="${u.id}" data-name="${esc(u.name || "Trader")}">Add</button>
        <button class="ghost danger" data-tr="remove" data-uid="${u.id}" data-name="${esc(u.name || "Trader")}">Remove</button>
        <button class="ghost" data-tr="set" data-uid="${u.id}" data-name="${esc(u.name || "Trader")}">Set</button>
        ${Object.keys(u.holdings || {}).length ? `<button class="ghost danger" data-liq="${u.id}" data-name="${esc(u.name || "Trader")}">Force-sell</button>` : ""}
      </div>`).join("")}
    <p class="muted" style="font-size:12px">Add/Remove/Set touch cash only. Force-sell liquidates every position at the current market price into the player's cash (delisted stock is wiped at zero). All of it is logged to the transfer feed as THE HOUSE, and the player gets a toast if they're online.</p>
  </div>`;
}

function captureDraft() {
  document.querySelectorAll("#adm-opts [data-di]").forEach((inp) => {
    const o = draftOptions[Number(inp.dataset.di)];
    if (o) o[inp.dataset.f] = inp.dataset.f === "multiplier" ? Number(inp.value) : inp.value;
  });
  const r = document.querySelector("#adm-reward");
  if (r) draftReward = r.value;
  const h = document.querySelector("#adm-hours");
  if (h) draftLockHours = h.value;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function initPredictions(apiIn) {
  api = apiIn;
  return { renderPredictions, renderAdmin, subscribePredictions, unsubscribePredictions };
}
