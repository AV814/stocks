/* ============================================================
   LWSTOCKS — trading floor chat
   One public room for everyone. Messages live in /chat with the
   last 50 streamed live. You can delete your own messages; the
   admin can delete anyone's. Presence shows who's on the floor.
   ============================================================ */

import { createDrawPad } from "./drawpad.js";
import {
  doc, collection, addDoc, deleteDoc, onSnapshot, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let api = null;   // { db, me, myDoc, users, isAdmin, avatarHtml, isViewing, dotEl, el, onlineCount }
let msgs = [];
let unsub = null;
let firstLoad = true;
let lastSentAt = 0;

const MAX_LEN = 300;
const PIX = 128;                       // draw card
const IMG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const IMG_UP_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const AUDIO_RE = /^data:audio\/(mpeg|mp3);base64,[A-Za-z0-9+/=]+$/;
const MP3_LEVEL = 3, MP3_COST = 10, MP3_MAX = 950000;       // ~700KB file
const PIC_LEVEL = 7, PIC_COST = 25, PIC_MAX = 300000;
let drawOpen = false;
let chatPad = null;         // shared drawpad instance
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

const DOODLE_COST = 20;
async function sendDoodle() {
  const cv = document.querySelector("#chat-canvas");
  if (!cv || !api.me()) return;
  if (Date.now() - lastSentAt < 1500) return;
  const img = cv.toDataURL("image/png");
  if (img.length > 28000) { alert("That drawing is too detailed to send — simplify it a bit."); return; }
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
    chatPad?.clear();
    toggleDraw(false);
  } catch (e) {
    api.settle(DOODLE_COST, 0).catch(() => {});          // post failed — refund the fee
    alert(e.message);
  }
}
function toggleDraw(force) {
  drawOpen = force !== undefined ? force : !drawOpen;
  document.querySelector("#chat-draw-panel")?.classList.toggle("hidden", !drawOpen);
  document.querySelector("#chat-draw-btn")?.classList.toggle("on", drawOpen);
}

function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("Could not read that file."));
    r.readAsDataURL(file);
  });
}
async function shrinkImage(file) {
  const url = await fileToDataUrl(file);
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Not a readable image."));
    im.src = url;
  });
  const MAX = 480;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(img.width * scale);
  cv.height = Math.round(img.height * scale);
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.82);
}
async function sendMedia(kind, file) {
  if (!file || !api.me()) return;
  const lvl = api.myDoc()?.level || 0;
  const need = kind === "audio" ? MP3_LEVEL : PIC_LEVEL;
  const cost = kind === "audio" ? MP3_COST : PIC_COST;
  if (lvl < need) { alert(`That unlocks at level ${need}.`); return; }
  if ((api.myDoc()?.cash || 0) < cost) { alert(`Costs ${api.fmt(cost)} — you're short.`); return; }
  let payload;
  try {
    if (kind === "audio") {
      if (!/audio\/(mpeg|mp3)/.test(file.type) && !/\.mp3$/i.test(file.name)) { alert("MP3 files only."); return; }
      payload = await fileToDataUrl(file);
      payload = payload.replace(/^data:audio\/[^;]+/, "data:audio/mpeg");
      if (!AUDIO_RE.test(payload)) { alert("That file doesn't read as an MP3."); return; }
      if (payload.length > MP3_MAX) { alert("Too big — keep MP3 clips under ~700KB."); return; }
    } else {
      payload = await shrinkImage(file);
      if (payload.length > PIC_MAX) { alert("That image compresses too large — try a simpler one."); return; }
    }
  } catch (e) { alert(e.message); return; }
  if (Date.now() - lastSentAt < 1500) return;
  lastSentAt = Date.now();
  try { await api.settle(-cost, cost); }
  catch (e) { alert(e.message); return; }
  try {
    await addDoc(collection(api.db, "chat"), {
      uid: api.me().uid,
      name: api.myDoc()?.name || "Trader",
      text: "",
      ...(kind === "audio" ? { audio: payload } : { img: payload, upload: true }),
      at: Date.now()
    });
  } catch (e) {
    api.settle(cost, 0).catch(() => {});
    alert(e.message);
  }
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
      ${m.audio && AUDIO_RE.test(m.audio) ? `<audio class="chat-audio" controls preload="none" src="${m.audio}"></audio>`
        : m.img && m.upload && IMG_UP_RE.test(m.img) ? `<img class="chat-img big" src="${m.img}" alt="upload">`
        : m.img && IMG_RE.test(m.img) ? `<img class="chat-img" src="${m.img}" alt="doodle">`
        : `<div class="chat-text">${esc(m.text)}</div>`}
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
        <div id="chat-pad-mount" class="chat-pad-mount"></div>
        <div class="chat-draw-actions">
          <button class="ghost" id="chat-clear">Clear</button>
          <button class="btn-spin" id="chat-upload">Upload — ₡20</button>
        </div>
      </div>
      <div class="chat-input-row">
        <button class="ghost" id="chat-draw-btn" title="Draw">✎</button>
        <button class="ghost chat-up-btn" id="chat-mp3-btn" title="Send an MP3 — ₡${MP3_COST}, unlocks at level ${MP3_LEVEL}">♪</button>
        <button class="ghost chat-up-btn" id="chat-pic-btn" title="Send a picture — ₡${PIC_COST}, unlocks at level ${PIC_LEVEL}">▣</button>
        <input type="file" id="chat-mp3-file" accept="audio/mpeg,.mp3" style="display:none">
        <input type="file" id="chat-pic-file" accept="image/*" style="display:none">
        <input id="chat-input" type="text" maxlength="${MAX_LEN}" placeholder="Say something…" autocomplete="off">
        <button class="btn-spin" id="chat-send">Send</button>
      </div>`;
    el.querySelector("#chat-send").addEventListener("click", send);
    el.querySelector("#chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") send();
    });
    el.querySelector("#chat-draw-btn").addEventListener("click", () => toggleDraw());
    el.querySelector("#chat-mp3-btn").addEventListener("click", () => {
      if ((api.myDoc()?.level || 0) < MP3_LEVEL) { alert(`MP3s unlock at level ${MP3_LEVEL}.`); return; }
      el.querySelector("#chat-mp3-file").click();
    });
    el.querySelector("#chat-pic-btn").addEventListener("click", () => {
      if ((api.myDoc()?.level || 0) < PIC_LEVEL) { alert(`Pictures unlock at level ${PIC_LEVEL}.`); return; }
      el.querySelector("#chat-pic-file").click();
    });
    el.querySelector("#chat-mp3-file").addEventListener("change", (e) => { sendMedia("audio", e.target.files[0]); e.target.value = ""; });
    el.querySelector("#chat-pic-file").addEventListener("change", (e) => { sendMedia("pic", e.target.files[0]); e.target.value = ""; });
    chatPad = createDrawPad(el.querySelector("#chat-pad-mount"), { pix: PIX, canvasId: "chat-canvas" });
    el.querySelector("#chat-clear").addEventListener("click", () => chatPad.clear());
    el.querySelector("#chat-upload").addEventListener("click", sendDoodle);
    cv.addEventListener("pointerup", () => { lastPx = null; });
  }
  updateLog();
  api.dotEl()?.classList.add("hidden");
}

export function initChat(apiIn) {
  api = apiIn;
  return { renderChat, subscribeChat, unsubscribeChat };
}
