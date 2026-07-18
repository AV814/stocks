/* ============================================================
   VAPORSTOCKS — trading floor chat
   One public room for everyone. Messages live in /chat with the
   last 50 streamed live. You can delete your own messages; the
   admin can delete anyone's. Presence shows who's on the floor.
   ============================================================ */

import {
  doc, collection, addDoc, deleteDoc, onSnapshot, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let api = null;   // { db, me, myDoc, users, isAdmin, avatarHtml, isViewing, dotEl, el, onlineCount }
let msgs = [];
let unsub = null;
let firstLoad = true;
let lastSentAt = 0;

const MAX_LEN = 300;
const PIX = 50;                       // 50x50 pixel doodle card
const IMG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const PALETTE = ["#000000", "#ffffff", "#c0392b", "#e8a33d", "#e8d44d", "#5aa03c",
                 "#3aa6a6", "#3a6ea5", "#7d4fa5", "#d976a8", "#7a5230", "#8a9280"];
let drawColor = "#000000";
let drawOpen = false;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function subscribeChat() {
  if (unsub) return;
  firstLoad = true;
  unsub = onSnapshot(
    query(collection(api.db, "chat"), orderBy("at", "desc"), limit(50)),
    (qs) => {
      msgs = qs.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
      const hadNew = qs.docChanges().some((c) => c.type === "added");
      if (!firstLoad && hadNew && !api.isViewing()) api.dotEl()?.classList.remove("hidden");
      firstLoad = false;
      updateLog();
    },
    (e) => console.error("chat subscribe failed", e)
  );
}
export function unsubscribeChat() {
  if (unsub) { unsub(); unsub = null; }
  msgs = [];
}

async function send() {
  const input = document.querySelector("#chat-input");
  const text = (input?.value || "").trim().slice(0, MAX_LEN);
  if (!text || !api.me()) return;
  if (Date.now() - lastSentAt < 1500) return;   // gentle local throttle
  lastSentAt = Date.now();
  input.value = "";
  try {
    await addDoc(collection(api.db, "chat"), {
      uid: api.me().uid,
      name: api.myDoc()?.name || "Trader",
      text,
      at: Date.now()
    });
  } catch (e) { alert(e.message); }
}

async function sendDoodle() {
  const cv = document.querySelector("#chat-canvas");
  if (!cv || !api.me()) return;
  if (Date.now() - lastSentAt < 1500) return;
  lastSentAt = Date.now();
  const img = cv.toDataURL("image/png");
  if (img.length > 11500) { alert("That drawing is too detailed to send — simplify it a bit."); return; }
  try {
    await addDoc(collection(api.db, "chat"), {
      uid: api.me().uid,
      name: api.myDoc()?.name || "Trader",
      text: "",
      img,
      at: Date.now()
    });
    clearCanvas();
    toggleDraw(false);
  } catch (e) { alert(e.message); }
}
function clearCanvas() {
  const cv = document.querySelector("#chat-canvas");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PIX, PIX);
}
function paintAt(cv, e) {
  const r = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * PIX);
  const y = Math.floor((e.clientY - r.top) / r.height * PIX);
  if (x < 0 || x >= PIX || y < 0 || y >= PIX) return;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = drawColor;
  ctx.fillRect(x, y, 1, 1);
}
function toggleDraw(force) {
  drawOpen = force !== undefined ? force : !drawOpen;
  document.querySelector("#chat-draw-panel")?.classList.toggle("hidden", !drawOpen);
  document.querySelector("#chat-draw-btn")?.classList.toggle("on", drawOpen);
}

async function removeMsg(id) {
  try { await deleteDoc(doc(api.db, "chat", id)); }
  catch (e) { alert(e.message); }
}

const timeOf = (t) => {
  const d = new Date(t), today = new Date();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString()
    ? hm
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm;
};

function msgHtml(m) {
  const user = api.users().find((u) => u.id === m.uid) || { name: m.name };
  const mine = m.uid === api.me()?.uid;
  const canDelete = mine || api.isAdmin();
  return `<div class="chat-msg ${mine ? "mine" : ""}">
    ${api.avatarHtml(user, 26)}
    <div class="chat-body">
      <div class="chat-meta">
        <span class="chat-name">${esc(m.name || "Trader")}</span>
        <span class="chat-time">${timeOf(m.at)}</span>
        ${canDelete ? `<button class="chat-del" data-del="${m.id}" title="Delete">✕</button>` : ""}
      </div>
      ${m.img && IMG_RE.test(m.img) ? `<img class="chat-img" src="${m.img}" alt="doodle">` : `<div class="chat-text">${esc(m.text)}</div>`}
    </div>
  </div>`;
}

function updateLog() {
  const log = document.querySelector("#chat-log");
  if (!log) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = msgs.length
    ? msgs.map(msgHtml).join("")
    : `<p class="muted" style="text-align:center;padding:30px 0">Nothing yet. Say something regrettable.</p>`;
  log.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => { if (confirm("Delete this message?")) removeMsg(b.dataset.del); }));
  if (nearBottom || firstLoad) log.scrollTop = log.scrollHeight;
  const oc = document.querySelector("#chat-online");
  if (oc) oc.textContent = api.onlineCount();
}

export function renderChat() {
  const el = api.el();
  if (!el) return;
  if (!el.querySelector("#chat-log")) {
    el.innerHTML = `
      <div class="chat-head">
        <h3 class="sec" style="margin:0">Trading Floor</h3>
        <span class="muted" style="font-size:12px"><span id="chat-online">${api.onlineCount()}</span> on the floor</span>
      </div>
      <div id="chat-log" class="chat-log"></div>
      <div id="chat-draw-panel" class="chat-draw hidden">
        <canvas id="chat-canvas" width="${PIX}" height="${PIX}"></canvas>
        <div class="chat-draw-side">
          <div class="chat-palette">
            ${PALETTE.map((c) => `<button class="chat-swatch ${c === drawColor ? "on" : ""}" data-col="${c}" style="background:${c}"></button>`).join("")}
          </div>
          <div class="chat-draw-actions">
            <button class="ghost" id="chat-clear">Clear</button>
            <button class="btn-spin" id="chat-upload">Upload to chat</button>
          </div>
        </div>
      </div>
      <div class="chat-input-row">
        <button class="ghost" id="chat-draw-btn" title="Draw a doodle">🎨</button>
        <input id="chat-input" type="text" maxlength="${MAX_LEN}" placeholder="Say something…" autocomplete="off">
        <button class="btn-spin" id="chat-send">Send</button>
      </div>`;
    el.querySelector("#chat-send").addEventListener("click", send);
    el.querySelector("#chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") send();
    });
    el.querySelector("#chat-draw-btn").addEventListener("click", () => toggleDraw());
    el.querySelector("#chat-clear").addEventListener("click", clearCanvas);
    el.querySelector("#chat-upload").addEventListener("click", sendDoodle);
    el.querySelectorAll(".chat-swatch").forEach((b) =>
      b.addEventListener("click", () => {
        drawColor = b.dataset.col;
        el.querySelectorAll(".chat-swatch").forEach((x) => x.classList.toggle("on", x === b));
      }));
    const cv = el.querySelector("#chat-canvas");
    clearCanvas();
    cv.addEventListener("pointerdown", (e) => { e.preventDefault(); cv.setPointerCapture(e.pointerId); paintAt(cv, e); });
    cv.addEventListener("pointermove", (e) => { if (e.buttons & 1) paintAt(cv, e); });
  }
  updateLog();
  api.dotEl()?.classList.add("hidden");
}

export function initChat(apiIn) {
  api = apiIn;
  return { renderChat, subscribeChat, unsubscribeChat };
}
