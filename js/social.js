/* ============================================================
   LWSTOCKS — social module
   1) Profile pictures: resized client-side to a 96px square
      JPEG data URL and stored on the user doc (no Firebase
      Storage needed — Spark tier friendly, ~5-10KB per avatar).
   2) Transfers: a single transaction debits the sender and
      credits the recipient. Rules only allow writing someone
      else's doc if the one and only change is cash increasing.
      Every transfer is logged to /transfers for auditing, and
      recipients get a live toast.
   ============================================================ */

import {
  doc, collection, runTransaction, updateDoc, addDoc,
  onSnapshot, query, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let api = null;             // { db, me, myDoc, fmt, toast }
let unsubTransfers = null;
let watchStart = 0;

const AVATAR_PX = 96;
const AVATAR_MAX_BYTES = 45000;
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- avatars ---------------- */

// Render an avatar (or an initial fallback). Only data-URL images that
// match the strict pattern are rendered, so a hand-edited avatar field
// can't smuggle markup into the page.
function avatarHtml(u, size = 28) {
  const name = (u?.name || "?").trim();
  const av = u?.avatar;
  if (av && AVATAR_RE.test(av)) {
    return `<img class="avatar" style="width:${size}px;height:${size}px" src="${av}" alt="">`;
  }
  return `<span class="avatar avatar-fallback" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${esc(name[0]?.toUpperCase() || "?")}</span>`;
}

// Center-crop to a square, scale to AVATAR_PX, compress until it fits.
async function fileToAvatar(file) {
  if (!file.type.startsWith("image/")) throw new Error("Not an image file");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("Cannot read image"));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
    const cv = document.createElement("canvas");
    cv.width = cv.height = AVATAR_PX;
    cv.getContext("2d").drawImage(img, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      const data = cv.toDataURL("image/jpeg", q);
      if (data.length <= AVATAR_MAX_BYTES) return data;
    }
    throw new Error("Image cannot compress well");
  } finally { URL.revokeObjectURL(url); }
}

async function uploadAvatar(file) {
  const uid = api.me()?.uid;
  if (!uid || !file) return;
  if ((api.myDoc()?.level || 0) < 10) { alert("Photo profile pictures unlock at level 10 — until then, you draw it."); return; }
  try {
    const data = await fileToAvatar(file);
    await updateDoc(doc(api.db, "users", uid), { avatar: data });
    api.toast("PROFILE", "Picture updated");
  } catch (e) { alert(e.message); }
}

/* Everyone draws their profile picture on a 50x50 card (photos are a
   level-10 privilege). Same pixel tools as the chat pad, in a modal. */
const PFP_PIX = 50;
const PFP_PALETTE = ["#000000", "#ffffff", "#c0392b", "#e8a33d", "#e8d44d", "#5aa03c",
  "#3aa6a6", "#3a6ea5", "#7d4fa5", "#d976a8", "#7a5230", "#8a9280"];
let pfpColor = "#000000", pfpLast = null;

function openPfpEditor() {
  if (document.querySelector(".pfp-modal")) return;
  const canPhoto = (api.myDoc()?.level || 0) >= 10;
  const wrap = document.createElement("div");
  wrap.className = "pfp-modal";
  wrap.innerHTML = `
    <div class="pfp-box">
      <h3 class="sec" style="margin-top:0">Draw your profile picture</h3>
      <canvas id="pfp-canvas" width="${PFP_PIX}" height="${PFP_PIX}"></canvas>
      <div class="pfp-tools">
        ${PFP_PALETTE.map((c) => `<button class="chat-swatch ${c === pfpColor ? "on" : ""}" data-pfpc="${c}" style="background:${c}"></button>`).join("")}
        <input type="color" id="pfp-custom" value="${pfpColor}" title="Any color">
      </div>
      <div class="pfp-actions">
        <button class="ghost" id="pfp-clear">Clear</button>
        ${canPhoto ? `<button class="ghost" id="pfp-photo">Upload photo (L10 perk)</button>` : `<span class="muted" style="font-size:11px;align-self:center">Photo uploads unlock at level 10</span>`}
        <button class="ghost" id="pfp-cancel">Cancel</button>
        <button class="btn-spin" id="pfp-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const cv = wrap.querySelector("#pfp-canvas");
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PFP_PIX, PFP_PIX);
  // seed with the current drawn avatar so edits are possible
  const cur = api.myDoc()?.avatar;
  if (cur && /^data:image\/png/.test(cur)) {
    const img = new Image();
    img.onload = () => { if (img.width === PFP_PIX) ctx.drawImage(img, 0, 0); };
    img.src = cur;
  }
  const px = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: Math.floor((e.clientX - r.left) / r.width * PFP_PIX), y: Math.floor((e.clientY - r.top) / r.height * PFP_PIX) };
  };
  const plot = (x, y) => { if (x >= 0 && x < PFP_PIX && y >= 0 && y < PFP_PIX) { ctx.fillStyle = pfpColor; ctx.fillRect(x, y, 1, 1); } };
  const line = (a, b) => {
    let { x: x0, y: y0 } = a; const { x: x1, y: y1 } = b;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      plot(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  cv.addEventListener("pointerdown", (e) => { e.preventDefault(); cv.setPointerCapture(e.pointerId); pfpLast = null; const p = px(e); plot(p.x, p.y); pfpLast = p; });
  cv.addEventListener("pointermove", (e) => {
    if (!(e.buttons & 1)) return;
    const pts = (e.getCoalescedEvents?.() || [e]).map((ev) => px(ev));
    for (const p of pts) { if (pfpLast) line(pfpLast, p); else plot(p.x, p.y); pfpLast = p; }
  });
  cv.addEventListener("pointerup", () => { pfpLast = null; });
  wrap.querySelectorAll("[data-pfpc]").forEach((b) => b.addEventListener("click", () => {
    pfpColor = b.dataset.pfpc;
    wrap.querySelector("#pfp-custom").value = pfpColor;
    wrap.querySelectorAll(".chat-swatch").forEach((x) => x.classList.toggle("on", x === b));
  }));
  wrap.querySelector("#pfp-custom").addEventListener("input", (e) => {
    pfpColor = e.target.value;
    wrap.querySelectorAll(".chat-swatch").forEach((x) => x.classList.remove("on"));
  });
  wrap.querySelector("#pfp-clear").addEventListener("click", () => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, PFP_PIX, PFP_PIX); });
  wrap.querySelector("#pfp-cancel").addEventListener("click", () => wrap.remove());
  wrap.querySelector("#pfp-photo")?.addEventListener("click", () => { wrap.remove(); document.querySelector("#avatar-file")?.click(); });
  wrap.querySelector("#pfp-save").addEventListener("click", async () => {
    const uid = api.me()?.uid;
    if (!uid) return;
    try {
      await updateDoc(doc(api.db, "users", uid), { avatar: cv.toDataURL("image/png") });
      api.toast("PROFILE", "Picture updated");
      wrap.remove();
    } catch (e) { alert(e.message); }
  });
}

/* ---------------- transfers ---------------- */

async function sendMoney(toUid, toName, amount) {
  const uid = api.me()?.uid;
  amount = Math.round(Number(amount) * 100) / 100;
  if (!(amount > 0)) { alert("Enter an amount above zero."); return false; }
  if (toUid === uid) { alert("You cannot send cash to yourself"); return false; }
  try {
    await runTransaction(api.db, async (tx) => {
      const fromRef = doc(api.db, "users", uid);
      const toRef = doc(api.db, "users", toUid);
      const [fromSnap, toSnap] = [await tx.get(fromRef), await tx.get(toRef)];
      if (!toSnap.exists()) throw new Error("That player no longer exists.");
      const from = fromSnap.data();
      if ((from.cash || 0) < amount) throw new Error("Not enough cash.");
      tx.update(fromRef, { cash: Math.round((from.cash - amount) * 100) / 100 });
      tx.update(toRef, { cash: Math.round(((toSnap.data().cash || 0) + amount) * 100) / 100 });
    });
    addDoc(collection(api.db, "transfers"), {
      from: uid, fromName: api.myDoc()?.name || "Trader",
      to: toUid, toName, amount, at: Date.now()
    });
    api.toast("Credits sent", `${api.fmt(amount)} to ${toName}`);
    return true;
  } catch (e) { alert(e.message); return false; }
}

// Live toast when someone sends *me* credits.
function subscribeTransfers() {
  const uid = api.me()?.uid;
  if (!uid || unsubTransfers) return;
  watchStart = Date.now();
  unsubTransfers = onSnapshot(
    query(collection(api.db, "transfers"), where("to", "==", uid)),
    (qs) => {
      qs.docChanges().forEach((ch) => {
        if (ch.type !== "added") return;
        const t = ch.doc.data();
        if (t.at <= watchStart) return;
        if (t.kind === "liquidation") api.toast("LIQUIDATION", `+${api.fmt(t.amount)} received`);
        else if (t.amount >= 0) api.toast(`${t.fromName.toUpperCase()}`, `+${api.fmt(t.amount)} received`);
        else api.toast("Admin", `${t.fromName} removed ${api.fmt(-t.amount)} from your account`);
      });
    },
    (e) => console.error("transfer failed", e)
  );
}
function unsubscribeTransfers() {
  if (unsubTransfers) { unsubTransfers(); unsubTransfers = null; }
}

export function initSocial(apiIn) {
  api = apiIn;
  return { avatarHtml, uploadAvatar, openPfpEditor, sendMoney, subscribeTransfers, unsubscribeTransfers };
}
