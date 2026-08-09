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

import { createDrawPad, PAD_PIX } from "./drawpad.js";
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

/* Everyone draws their profile picture on the SAME pad the chat
   uses (shared drawpad module) — photos are a level-10 privilege. */
let pfpPad = null;
function openPfpEditor() {
  if (document.querySelector(".pfp-modal")) return;
  const canPhoto = (api.myDoc()?.level || 0) >= 10;
  const wrap = document.createElement("div");
  wrap.className = "pfp-modal";
  wrap.innerHTML = `
    <div class="pfp-box">
      <h3 class="sec" style="margin-top:0">Draw your profile picture</h3>
      <div id="pfp-pad-mount"></div>
      <div class="pfp-actions">
        <button class="ghost" id="pfp-clear">Clear</button>
        ${canPhoto ? `<button class="ghost" id="pfp-photo">Upload photo (L10 perk)</button>` : `<span class="muted" style="font-size:11px;align-self:center">Photo uploads unlock at level 10</span>`}
        <button class="ghost" id="pfp-cancel">Cancel</button>
        <button class="btn-spin" id="pfp-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  pfpPad = createDrawPad(wrap.querySelector("#pfp-pad-mount"), { pix: PAD_PIX, canvasId: "pfp-canvas" });
  // seed with the current drawn avatar so edits are possible
  const cur = api.myDoc()?.avatar;
  if (cur && /^data:image\/png/.test(cur)) {
    const img = new Image();
    img.onload = () => pfpPad.canvas.getContext("2d").drawImage(img, 0, 0, PAD_PIX, PAD_PIX);
    img.src = cur;
  }
  const close = () => { pfpPad?.destroy(); pfpPad = null; wrap.remove(); };
  wrap.querySelector("#pfp-clear").addEventListener("click", () => pfpPad.clear());
  wrap.querySelector("#pfp-cancel").addEventListener("click", close);
  wrap.querySelector("#pfp-photo")?.addEventListener("click", () => { close(); document.querySelector("#avatar-file")?.click(); });
  wrap.querySelector("#pfp-save").addEventListener("click", async () => {
    const uid = api.me()?.uid;
    if (!uid) return;
    try {
      await updateDoc(doc(api.db, "users", uid), { avatar: pfpPad.toDataURL() });
      api.toast("PROFILE", "Picture updated");
      close();
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
