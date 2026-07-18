/* ============================================================
   VAPORSTOCKS — Vapor Industries Employment Office ("Work")
   Three skill games that pay guaranteed wages, no house edge:

     Minesweeper — clear the board, get paid. Speed bonus.
     Snake       — ₡2 per pellet, paid when you crash.
     Hack        — Fallout-style terminal password cracking.
                   Fewer guesses used, bigger payday.

   Wages hit your balance through the same settle transaction as
   everything else, with a per-game daily cap (resets midnight ET)
   tracked on your own user doc so the printer has a governor.
   ============================================================ */

import {
  doc, runTransaction, setDoc, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let api = null;   // { db, fmt, toast, me, myDoc, el }
let mode = "mines";

const DAY_CAP = 200;                                 // per game, per day
const workDay = () => Math.floor((Date.now() - 5 * 3600000) / 86400000);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---- wages: credit with a daily cap, one transaction ---- */
async function payWork(game, amount, what) {
  amount = Math.round(amount * 100) / 100;
  if (amount <= 0 || !api.me()) return 0;
  let paid = 0, capped = false;
  try {
    await runTransaction(api.db, async (tx) => {
      const ref = doc(api.db, "users", api.me().uid);
      const snap = await tx.get(ref);
      const u = snap.data();
      let w = u.work || {};
      if (w.day !== workDay()) w = { day: workDay() };
      const earned = w[game] || 0;
      paid = Math.max(0, Math.min(amount, DAY_CAP - earned));
      capped = paid < amount;
      w[game] = earned + paid;
      tx.update(ref, { cash: Math.round(((u.cash || 0) + paid) * 100) / 100, work: w });
    });
    if (paid > 0) api.toast("SHIFT PAID", `${api.fmt(paid)} for ${what}${capped ? " (daily cap reached)" : ""}`);
    else api.toast("OFF THE CLOCK", `Daily cap reached for this job — resets midnight ET.`);
  } catch (e) { console.error("payWork failed", e); }
  // bump play counters (global + personal), fire-and-forget
  setDoc(doc(api.db, "market", "casinoStats"), { [game]: increment(1) }, { merge: true }).catch(() => {});
  setDoc(doc(api.db, "users", api.me().uid), { gameStats: { [game]: increment(1) } }, { merge: true }).catch(() => {});
  renderWork();
  return paid;
}
function earnedToday(game) {
  const w = api.myDoc()?.work;
  return (w && w.day === workDay()) ? (w[game] || 0) : 0;
}
const capLine = (game) => `<div class="work-cap">Today: ${api.fmt(earnedToday(game))} / ${api.fmt(DAY_CAP)} earned</div>`;

/* ================= MINESWEEPER =================
   9x9, 10 mines. First click is always safe. Clear every safe
   cell: ₡50 base + up to ₡30 speed bonus (full under 60s,
   fading to zero at 240s). */

const MS_W = 9, MS_H = 9, MS_MINES = 10;
let ms = null;   // { mines:Set, open:Set, flags:Set, started, t0, over, won, flagMode }

function msNew() { ms = { mines: null, open: new Set(), flags: new Set(), t0: null, over: false, won: false, flagMode: false }; }
function msIdx(x, y) { return y * MS_W + x; }
function msNeighbors(i) {
  const x = i % MS_W, y = Math.floor(i / MS_W), out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < MS_W && ny >= 0 && ny < MS_H) out.push(msIdx(nx, ny));
  }
  return out;
}
function msPlant(safe) {
  ms.mines = new Set();
  const banned = new Set([safe, ...msNeighbors(safe)]);
  while (ms.mines.size < MS_MINES) {
    const i = Math.floor(Math.random() * MS_W * MS_H);
    if (!banned.has(i)) ms.mines.add(i);
  }
  ms.t0 = Date.now();
}
function msCount(i) { return msNeighbors(i).filter((n) => ms.mines.has(n)).length; }
function msReveal(i) {
  if (ms.over || ms.open.has(i) || ms.flags.has(i)) return;
  if (!ms.mines) msPlant(i);
  if (ms.mines.has(i)) {
    ms.over = true;
    renderWork();
    return;
  }
  const stack = [i];
  while (stack.length) {
    const c = stack.pop();
    if (ms.open.has(c) || ms.mines.has(c) || ms.flags.has(c)) continue;
    ms.open.add(c);
    if (msCount(c) === 0) msNeighbors(c).forEach((n) => stack.push(n));
  }
  if (ms.open.size === MS_W * MS_H - MS_MINES) {
    ms.over = true; ms.won = true;
    const secs = (Date.now() - ms.t0) / 1000;
    const bonus = Math.round(30 * Math.max(0, Math.min(1, (240 - secs) / 180)));
    payWork("mines", 50 + bonus, `clearing the minefield in ${Math.round(secs)}s`);
  }
  renderWork();
}
function msFlag(i) {
  if (ms.over || ms.open.has(i)) return;
  ms.flags.has(i) ? ms.flags.delete(i) : ms.flags.add(i);
  renderWork();
}
const MS_COLORS = ["", "#7ec8e3", "#8bd450", "#e8a33d", "#c88", "#cc7a5a", "#8ff", "#eee", "#aaa"];
function msHtml() {
  if (!ms) msNew();
  const cells = Array.from({ length: MS_W * MS_H }, (_, i) => {
    const open = ms.open.has(i), flag = ms.flags.has(i);
    const boom = ms.over && !ms.won && ms.mines?.has(i);
    let inner = "";
    if (boom) inner = "💥";
    else if (flag) inner = "🚩";
    else if (open) {
      const n = msCount(i);
      inner = n ? `<span style="color:${MS_COLORS[n]}">${n}</span>` : "";
    }
    return `<button class="ms-cell ${open ? "open" : ""}" data-ms="${i}">${inner}</button>`;
  }).join("");
  return `
    ${capLine("mines")}
    <div class="ms-bar">
      <span class="muted" style="font-size:12px">💣 ${MS_MINES - ms.flags.size} left${ms.t0 && !ms.over ? " · " + Math.floor((Date.now() - ms.t0) / 1000) + "s" : ""}</span>
      <button class="ghost ${ms.flagMode ? "on" : ""}" id="ms-flagmode">🚩 Flag mode</button>
      <button class="ghost" id="ms-new">New board</button>
    </div>
    <div class="ms-grid">${cells}</div>
    <div class="casino-msg ${ms.over ? (ms.won ? "up" : "down") : ""}">${
      ms.over ? (ms.won ? "Field cleared. Payroll processed." : "Boom. No hazard pay for that.") :
      "Clear every safe cell. ₡50 + speed bonus. Right-click (or Flag mode) to mark mines."}</div>`;
}

/* ================= SNAKE =================
   15x15, ₡2 a pellet, paid when you crash. Arrows/WASD or the
   on-screen pad. Speeds up as you grow. */

const SN = 15, SNAKE_CELL = 22;
let snake = null;  // { body, dir, nextDir, food, score, dead, iv }
function snStart() {
  snStop();
  snake = { body: [112, 111, 110], dir: 1, nextDir: 1, food: null, score: 0, dead: false, iv: null };
  snFood();
  snake.iv = setInterval(snTick, 140);
  renderWork();
}
function snStop() { if (snake?.iv) { clearInterval(snake.iv); snake.iv = null; } }
function snFood() {
  let f;
  do { f = Math.floor(Math.random() * SN * SN); } while (snake.body.includes(f));
  snake.food = f;
}
function snTurn(d) {  // 0 up, 1 right, 2 down, 3 left
  if (!snake || snake.dead) return;
  if ((d + 2) % 4 !== snake.dir) snake.nextDir = d;
}
function snTick() {
  if (!snake || snake.dead) return;
  snake.dir = snake.nextDir;
  const head = snake.body[0];
  const x = head % SN, y = Math.floor(head / SN);
  let nx = x, ny = y;
  if (snake.dir === 0) ny--; else if (snake.dir === 1) nx++;
  else if (snake.dir === 2) ny++; else nx--;
  const hit = nx < 0 || nx >= SN || ny < 0 || ny >= SN || snake.body.includes(ny * SN + nx);
  if (hit) {
    snake.dead = true;
    snStop();
    if (snake.score > 0) payWork("snake", snake.score * 2, `${snake.score} pellets on the line`);
    else renderWork();
    return;
  }
  const next = ny * SN + nx;
  snake.body.unshift(next);
  if (next === snake.food) {
    snake.score++;
    snFood();
    if (snake.score % 5 === 0 && snake.iv) {
      clearInterval(snake.iv);
      snake.iv = setInterval(snTick, Math.max(70, 140 - snake.score * 4));
    }
  } else snake.body.pop();
  snDraw();
  const sc = document.querySelector("#sn-score");
  if (sc) sc.textContent = snake.score;
}
function snDraw() {
  const cv = document.querySelector("#sn-canvas");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#232920";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "#c4b550";
  const fx = snake.food % SN, fy = Math.floor(snake.food / SN);
  ctx.beginPath();
  ctx.arc(fx * SNAKE_CELL + SNAKE_CELL / 2, fy * SNAKE_CELL + SNAKE_CELL / 2, SNAKE_CELL / 3, 0, 7);
  ctx.fill();
  snake.body.forEach((c, i) => {
    ctx.fillStyle = i === 0 ? "#a8c45c" : "#7a9152";
    ctx.fillRect((c % SN) * SNAKE_CELL + 1, Math.floor(c / SN) * SNAKE_CELL + 1, SNAKE_CELL - 2, SNAKE_CELL - 2);
  });
}
function snHtml() {
  const active = snake && !snake.dead;
  return `
    ${capLine("snake")}
    <div class="ms-bar">
      <span class="muted" style="font-size:12px">🐍 <span id="sn-score">${snake?.score || 0}</span> pellets · ₡2 each, paid on crash</span>
      <button class="btn-spin" id="sn-start">${active ? "Restart" : "Start shift"}</button>
    </div>
    <canvas id="sn-canvas" width="${SN * SNAKE_CELL}" height="${SN * SNAKE_CELL}" class="sn-canvas"></canvas>
    <div class="sn-pad">
      <button data-sd="0">▲</button>
      <div><button data-sd="3">◀</button><button data-sd="2">▼</button><button data-sd="1">▶</button></div>
    </div>
    <div class="casino-msg">${snake?.dead ? `Crashed at ${snake.score} pellets.` : active ? "Arrows / WASD / pad." : "Eat pellets, don't eat walls or yourself."}</div>`;
}
document.addEventListener("keydown", (e) => {
  if (mode !== "snake" || !snake || snake.dead) return;
  const map = { ArrowUp: 0, w: 0, ArrowRight: 1, d: 1, ArrowDown: 2, s: 2, ArrowLeft: 3, a: 3 };
  if (e.key in map) { e.preventDefault(); snTurn(map[e.key]); }
});

/* ================= HACK =================
   Fallout-style terminal. Twelve candidate passwords buried in
   hex noise; four attempts; each wrong guess reports likeness
   (letters correct AND in position). Crack it for ₡30 + ₡20 per
   attempt remaining. */

const HACK_WORDS = ("TRADING,MARKETS,CAPITAL,DIVIDEND,FUTURES,OPTIONS,LEDGER,BROKER,MARGIN,TICKER," +
  "HOLDING,BULLISH,BEARISH,CRASHES,RALLIES,VOLUMES,SPREADS,HEDGING,SHORTED,CORNERS," +
  "NETWORK,SYSTEMS,ACCESS,CIPHERS,ENCRYPT,DECODED,FIREWALL,MONITOR,CONSOLE,UPLINKS," +
  "PROGRAM,ROUTINE,KERNELS,BUFFERS,STACKED,THREADS,SOCKETS,PACKETS,DAEMONS,SCRIPTS").split(",");
const HEX_JUNK = "!@#$%^&*()_+-=[]{};:<>?/\\|~";
let hack = null;  // { pw, words, tries, log[], done, won, locked }

function hkLikeness(a, b) { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) n++; return n; }
function hkNew() {
  const pool = [...HACK_WORDS].sort(() => Math.random() - 0.5).slice(0, 12);
  hack = { pw: pool[Math.floor(Math.random() * pool.length)], words: pool, tries: 4, log: [], done: false };
  hkPrint("VAPOR INDUSTRIES (TM) TERMALINK PROTOCOL");
  hkPrint("ENTER PASSWORD NOW — 4 ATTEMPT(S) LEFT");
  hkPrint("&nbsp;");
}
function hkPrint(line) { hack.log.push(line); }
function hkGuess(word) {
  if (!hack || hack.done) return;
  word = word.toUpperCase().trim();
  if (!hack.words.includes(word)) { hkPrint(`> ${esc(word)}`); hkPrint(">>> UNRECOGNIZED ENTRY"); renderWork(); return; }
  hkPrint(`> ${esc(word)}`);
  if (word === hack.pw) {
    hack.done = true; hack.won = true;
    hkPrint(">>> EXACT MATCH");
    hkPrint(">>> ACCESS GRANTED — TRANSFERRING FUNDS");
    payWork("hack", 30 + 20 * (hack.tries - 1), `cracking the terminal with ${hack.tries - 1} attempt(s) to spare`);
  } else {
    hack.tries--;
    hkPrint(`>>> ENTRY DENIED — LIKENESS = ${hkLikeness(word, hack.pw)}`);
    if (hack.tries <= 0) {
      hack.done = true;
      hkPrint(">>> TERMINAL LOCKED");
      hkPrint(`>>> PASSWORD WAS: ${hack.pw}`);
    } else {
      hkPrint(`>>> ${hack.tries} ATTEMPT(S) LEFT`);
    }
  }
  renderWork();
}
function hkDumpHtml() {
  // words scattered through junk, clickable
  let out = "";
  const junk = () => Array.from({ length: 4 + Math.floor(Math.random() * 8) },
    () => HEX_JUNK[Math.floor(Math.random() * HEX_JUNK.length)]).join("");
  hack.words.forEach((w, i) => {
    const addr = "0x" + (0xF400 + i * 12).toString(16).toUpperCase();
    out += `<div class="hk-line"><span class="hk-addr">${addr}</span> ${esc(junk())}<button class="hk-word" data-hw="${esc(w)}">${esc(w)}</button>${esc(junk())}</div>`;
  });
  return out;
}
function hkHtml() {
  if (!hack) hkNew();
  return `
    ${capLine("hack")}
    <div class="hk-term">
      <div class="hk-cols">
        <div class="hk-dump">${hack.dumpCache || (hack.dumpCache = hkDumpHtml())}</div>
        <div class="hk-log" id="hk-log">${hack.log.map((l) => `<div>${l}</div>`).join("")}
          ${hack.done ? "" : `<div class="hk-input-line">&gt;&nbsp;<input id="hk-input" maxlength="10" autocomplete="off" spellcheck="false"><span class="hk-cursor">█</span></div>`}
        </div>
      </div>
    </div>
    <div class="casino-msg">${hack.done
      ? (hack.won ? "Access granted. Payroll transferred." : "Locked out. The password is burned — reboot for a new terminal.")
      : "Click a password in the dump or type it. LIKENESS = letters correct and in position."}</div>
    ${hack.done ? `<div class="casino-controls"><button class="btn-spin" id="hk-new">Reboot terminal</button></div>` : ""}`;
}

/* ================= RENDER ================= */
export function renderWork() {
  const el = api.el();
  if (!el) return;
  el.innerHTML = `
    <div class="casino-head">
      <h3 class="sec" style="margin:0">Vapor Industries — Employment Office</h3>
      <div class="casino-tabs">
        <button data-wmode="mines" class="${mode === "mines" ? "active" : ""}">💣 Minesweeper</button>
        <button data-wmode="snake" class="${mode === "snake" ? "active" : ""}">🐍 Snake</button>
        <button data-wmode="hack" class="${mode === "hack" ? "active" : ""}">💻 Hack</button>
      </div>
    </div>
    <div class="casino-panel ${mode === "hack" ? "hk-panel" : ""}">
      ${mode === "mines" ? msHtml() : mode === "snake" ? snHtml() : hkHtml()}
    </div>
    <p class="muted" style="font-size:12px;margin-top:12px">Honest wages, no house edge. Each job caps at ${api.fmt(DAY_CAP)} a day, resets midnight ET.</p>`;

  el.querySelectorAll("[data-wmode]").forEach((b) =>
    b.addEventListener("click", () => {
      if (mode === "snake" && b.dataset.wmode !== "snake") snStop();
      mode = b.dataset.wmode;
      renderWork();
    }));

  // minesweeper
  el.querySelectorAll("[data-ms]").forEach((c) => {
    const i = Number(c.dataset.ms);
    c.addEventListener("click", () => (ms.flagMode ? msFlag(i) : msReveal(i)));
    c.addEventListener("contextmenu", (e) => { e.preventDefault(); msFlag(i); });
  });
  el.querySelector("#ms-new")?.addEventListener("click", () => { msNew(); renderWork(); });
  el.querySelector("#ms-flagmode")?.addEventListener("click", () => { ms.flagMode = !ms.flagMode; renderWork(); });

  // snake
  el.querySelector("#sn-start")?.addEventListener("click", snStart);
  el.querySelectorAll("[data-sd]").forEach((b) =>
    b.addEventListener("click", () => snTurn(Number(b.dataset.sd))));
  if (snake) snDraw();

  // hack
  el.querySelectorAll("[data-hw]").forEach((b) =>
    b.addEventListener("click", () => hkGuess(b.dataset.hw)));
  el.querySelector("#hk-new")?.addEventListener("click", () => { hack = null; renderWork(); });
  const hkIn = el.querySelector("#hk-input");
  if (hkIn) {
    hkIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && hkIn.value.trim()) hkGuess(hkIn.value); });
    if (mode === "hack") hkIn.focus();
  }
  const hkLog = el.querySelector("#hk-log");
  if (hkLog) hkLog.scrollTop = hkLog.scrollHeight;
}

export function initWork(apiIn) {
  api = apiIn;
  return { renderWork, stop: snStop };
}
