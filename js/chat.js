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
const PIX = 64;                       // 64x64 pixel doodle card
const IMG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const PALETTE = ["#000000", "#ffffff", "#c0392b", "#e8a33d", "#e8d44d", "#5aa03c",
                 "#3aa6a6", "#3a6ea5", "#7d4fa5", "#d976a8", "#7a5230", "#8a9280"];
let drawColor = "#000000";
let drawOpen = false;
let brushSize = 1;          // 1-4 pixel square brush
let drawTool = "brush";     // "brush" | "fill"
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

const DOODLE_COST = 25;
async function sendDoodle() {
  const cv = document.querySelector("#chat-canvas");
  if (!cv || !api.me()) return;
  if (Date.now() - lastSentAt < 1500) return;
  const img = cv.toDataURL("image/png");
  if (img.length > 11500) { alert("That drawing is too detailed to send — simplify it a bit."); return; }
  if ((api.myDoc()?.cash || 0) < DOODLE_COST) { alert(`Posting a masterpiece costs ${api.fmt(DOODLE_COST)}. You're short.`); return; }
  lastSentAt = Date.now();
  try { await api.settle(-DOODLE_COST, DOODLE_COST); }   // gallery fee
  catch (e) { alert(e.message); return; }
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
  } catch (e) {
    api.settle(DOODLE_COST, 0).catch(() => {});          // post failed — refund the fee
    alert(e.message);
  }
}
function clearCanvas() {
  const cv = document.querySelector("#chat-canvas");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PIX, PIX);
}
let lastPx = null;   // previous pixel of the current stroke
function pxOf(cv, clientX, clientY) {
  const r = cv.getBoundingClientRect();
  return {
    x: Math.floor((clientX - r.left) / r.width * PIX),
    y: Math.floor((clientY - r.top) / r.height * PIX)
  };
}
function plot(ctx, x, y) {
  const off = Math.floor((brushSize - 1) / 2);
  const px = Math.max(0, Math.min(PIX - brushSize, x - off));
  const py = Math.max(0, Math.min(PIX - brushSize, y - off));
  if (x < 0 || x >= PIX || y < 0 || y >= PIX) return;
  ctx.fillRect(px, py, brushSize, brushSize);
}

// bucket tool: exact-color flood fill from the clicked pixel
function floodFill(cv, e) {
  const { x, y } = pxOf(cv, e.clientX, e.clientY);
  if (x < 0 || x >= PIX || y < 0 || y >= PIX) return;
  const ctx = cv.getContext("2d");
  const img = ctx.getImageData(0, 0, PIX, PIX);
  const d = img.data;
  const at = (px, py) => (py * PIX + px) * 4;
  const t = at(x, y);
  const [tr, tg, tb, ta] = [d[t], d[t + 1], d[t + 2], d[t + 3]];
  // parse the current color to rgb
  const m = drawColor.match(/^#(..)(..)(..)$/);
  const [nr, ng, nb] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  if (tr === nr && tg === ng && tb === nb && ta === 255) return;   // already that color
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cx >= PIX || cy < 0 || cy >= PIX) continue;
    const i = at(cx, cy);
    if (d[i] !== tr || d[i + 1] !== tg || d[i + 2] !== tb || d[i + 3] !== ta) continue;
    d[i] = nr; d[i + 1] = ng; d[i + 2] = nb; d[i + 3] = 255;
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  ctx.putImageData(img, 0, 0);
}
// Bresenham line so fast strokes leave no gaps between sampled points
function plotLine(ctx, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(ctx, x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
function paintAt(cv, e, strokeStart) {
  const ctx = cv.getContext("2d");
  ctx.fillStyle = drawColor;
  // use the browser's coalesced samples when available — these are the
  // high-rate points between pointermove frames
  const points = (e.getCoalescedEvents?.() || [e]).map((ev) => pxOf(cv, ev.clientX, ev.clientY));
  if (strokeStart) lastPx = null;
  for (const p of points) {
    if (lastPx) plotLine(ctx, lastPx.x, lastPx.y, p.x, p.y);
    else plot(ctx, p.x, p.y);
    lastPx = p;
  }
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
    : `<p class="muted" style="text-align:center;padding:30px 0">No current chats.</p>`;
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
          <div class="chat-tools">
            <button class="ghost on" id="chat-tool-brush" title="Brush">🖌</button>
            <button class="ghost" id="chat-tool-fill" title="Fill bucket">🪣</button>
            <input type="color" id="chat-custom" value="#000000" title="Pick any color">
          </div>
          <label class="chat-size-l">Brush <span id="chat-size-v">1</span>px
            <input type="range" id="chat-size" min="1" max="4" step="1" value="1">
          </label>
          <div class="chat-palette">
            ${PALETTE.map((c) => `<button class="chat-swatch ${c === drawColor ? "on" : ""}" data-col="${c}" style="background:${c}"></button>`).join("")}
          </div>
          <div class="chat-draw-actions">
            <button class="ghost" id="chat-clear">Clear</button>
            <button class="btn-spin" id="chat-upload">Upload — ₡25</button>
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
        el.querySelector("#chat-custom").value = b.dataset.col;
        el.querySelectorAll(".chat-swatch").forEach((x) => x.classList.toggle("on", x === b));
      }));
    el.querySelector("#chat-custom").addEventListener("input", (e) => {
      drawColor = e.target.value;
      el.querySelectorAll(".chat-swatch").forEach((x) => x.classList.remove("on"));
    });
    const toolBtns = { brush: el.querySelector("#chat-tool-brush"), fill: el.querySelector("#chat-tool-fill") };
    const setTool = (t) => {
      drawTool = t;
      toolBtns.brush.classList.toggle("on", t === "brush");
      toolBtns.fill.classList.toggle("on", t === "fill");
    };
    toolBtns.brush.addEventListener("click", () => setTool("brush"));
    toolBtns.fill.addEventListener("click", () => setTool("fill"));
    el.querySelector("#chat-size").addEventListener("input", (e) => {
      brushSize = Number(e.target.value);
      el.querySelector("#chat-size-v").textContent = brushSize;
    });
    const cv = el.querySelector("#chat-canvas");
    clearCanvas();
    cv.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (drawTool === "fill") { floodFill(cv, e); return; }
      cv.setPointerCapture(e.pointerId);
      paintAt(cv, e, true);
    });
    cv.addEventListener("pointermove", (e) => { if (drawTool === "brush" && (e.buttons & 1)) paintAt(cv, e); });
    cv.addEventListener("pointerup", () => { lastPx = null; });
  }
  updateLog();
  api.dotEl()?.classList.add("hidden");
}

export function initChat(apiIn) {
  api = apiIn;
  return { renderChat, subscribeChat, unsubscribeChat };
}
