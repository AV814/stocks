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
      <div class="chat-text">${esc(m.text)}</div>
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
      <div class="chat-input-row">
        <input id="chat-input" type="text" maxlength="${MAX_LEN}" placeholder="Say something…" autocomplete="off">
        <button class="btn-spin" id="chat-send">Send</button>
      </div>`;
    el.querySelector("#chat-send").addEventListener("click", send);
    el.querySelector("#chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") send();
    });
  }
  updateLog();
  api.dotEl()?.classList.add("hidden");
}

export function initChat(apiIn) {
  api = apiIn;
  return { renderChat, subscribeChat, unsubscribeChat };
}
