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
  try {
    const data = await fileToAvatar(file);
    await updateDoc(doc(api.db, "users", uid), { avatar: data });
    api.toast("Profile picture updated.");
  } catch (e) { alert(e.message); }
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
        if (t.kind === "liquidation") api.toast("Liqiudated", `THE HOUSE force-sold your holdings for ${api.fmt(t.amount)}`);
        else if (t.amount >= 0) api.toast("Cash Received", `${t.fromName} sent you ${api.fmt(t.amount)}`);
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
  return { avatarHtml, uploadAvatar, sendMoney, subscribeTransfers, unsubscribeTransfers };
}
