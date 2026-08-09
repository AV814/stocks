/* ============================================================
   LWSTOCKS — LW Industries Employment Office ("Work")
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
import { nyDay } from "./lottery.js";

let api = null;   // { db, fmt, toast, me, myDoc, el }
let mode = "mines";

const DAY_CAP = 200;                                 // per game, per day
const workDay = () => nyDay();   // true midnight America/New_York, DST-proof
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---- wages: credit with a daily cap, one transaction ---- */
let workLocal = null;   // freshest work{} we know of, ahead of the doc snapshot
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
      workLocal = w;
    });
    if (paid > 0) api.toast(JOB[game] || "WORK", `+${api.fmt(paid)} received${capped ? " (daily cap reached)" : ""}`);
    else api.toast("Limit Hit", `Daily max profit already reached`);
  } catch (e) { console.error("payWork failed", e); }
  // bump play counters (global + personal), fire-and-forget
  setDoc(doc(api.db, "market", "casinoStats"), { [game]: increment(1) }, { merge: true }).catch(() => {});
  setDoc(doc(api.db, "users", api.me().uid), { gameStats: { [game]: increment(1) } }, { merge: true }).catch(() => {});
  renderWork();
  return paid;
}
function earnedToday(game) {
  const w = api.myDoc()?.work;
  const fromDoc = (w && w.day === workDay()) ? (w[game] || 0) : 0;
  const fromLocal = (workLocal && workLocal.day === workDay()) ? (workLocal[game] || 0) : 0;
  return Math.max(fromDoc, fromLocal);
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
    if (boom) inner = "✱";
    else if (flag) inner = "⚑";
    else if (open) {
      const n = msCount(i);
      inner = n ? `<span style="color:${MS_COLORS[n]}">${n}</span>` : "";
    }
    return `<button class="ms-cell ${open ? "open" : ""}" data-ms="${i}">${inner}</button>`;
  }).join("");
  return `
    ${capLine("mines")}
    <div class="ms-bar">
      <span class="muted" style="font-size:12px">Mines: ${MS_MINES - ms.flags.size}${ms.t0 && !ms.over ? " · " + Math.floor((Date.now() - ms.t0) / 1000) + "s" : ""}</span>
      <button class="ghost ${ms.flagMode ? "on" : ""}" id="ms-flagmode">⚑ Flag mode</button>
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

const SN = 22, SNAKE_CELL = 22;   // original cell size, 50% more grid
let snake = null;  // { body, dir, nextDir, food, score, dead, iv }
function snStart() {
  snStop();
  const mid = Math.floor(SN / 2) * SN + Math.floor(SN / 2);
  snake = { body: [mid, mid - 1, mid - 2], dir: 1, queue: [], food: null, score: 0, dead: false, iv: null, waiting: true };
  snFood();
  snake.iv = setInterval(snTick, snSpeed());
  renderWork();
}
function snSpeed() { return Math.max(70, 140 - (snake?.score || 0) * 4); }
function snStop() { if (snake?.iv) { clearInterval(snake.iv); snake.iv = null; } }
function snResume() {
  if (snake && !snake.dead && !snake.iv) snake.iv = setInterval(snTick, snSpeed());
}
function snFood() {
  let f;
  do { f = Math.floor(Math.random() * SN * SN); } while (snake.body.includes(f));
  snake.food = f;
}
function snTurn(d) {  // 0 up, 1 right, 2 down, 3 left
  if (!snake || snake.dead) return;
  if (snake.waiting) {
    if ((d + 2) % 4 === snake.dir) return;   // can't start by reversing into yourself
    snake.waiting = false;
    if (d !== snake.dir) snake.queue.push(d);
    const msg = document.querySelector("#sn-msg");
    if (msg) msg.textContent = "Go!";
    return;
  }
  // queue up to 3 turns; each must not reverse the one before it
  const last = snake.queue.length ? snake.queue[snake.queue.length - 1] : snake.dir;
  if (d !== last && (d + 2) % 4 !== last && snake.queue.length < 3) snake.queue.push(d);
}
function snTick() {
  if (!snake || snake.dead || snake.waiting) return;
  if (snake.queue.length) snake.dir = snake.queue.shift();
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
      snake.iv = setInterval(snTick, snSpeed());
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
  const fs = SNAKE_CELL - 10;                        // apple: square, a bit smaller than the snake
  ctx.fillRect(fx * SNAKE_CELL + (SNAKE_CELL - fs) / 2, fy * SNAKE_CELL + (SNAKE_CELL - fs) / 2, fs, fs);
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
      <span class="muted" style="font-size:12px">Pellets: <span id="sn-score">${snake?.score || 0}</span> · ₡2 each, paid on crash</span>
      <button class="btn-spin" id="sn-start">${active ? "Restart" : "Start shift"}</button>
    </div>
    <canvas id="sn-canvas" width="${SN * SNAKE_CELL}" height="${SN * SNAKE_CELL}" class="sn-canvas"></canvas>
    <div class="sn-pad">
      <button data-sd="0">▲</button>
      <div><button data-sd="3">◀</button><button data-sd="2">▼</button><button data-sd="1">▶</button></div>
    </div>
    <div class="casino-msg" id="sn-msg">${snake?.dead ? `Game over — ${snake.score} pellets.` : snake?.waiting ? "Press a direction to begin." : active ? "Arrows / WASD / pad." : "Eat pellets to earn. Avoid walls and your own tail."}</div>`;
}
document.addEventListener("keydown", (e) => {
  if (mode !== "snake" || !snake || snake.dead) return;
  const map = { ArrowUp: 0, w: 0, ArrowRight: 1, d: 1, ArrowDown: 2, s: 2, ArrowLeft: 3, a: 3 };
  if (e.key in map) { e.preventDefault(); snTurn(map[e.key]); }
});

/* ================= PIPES =================
   BioShock-style hack, swap edition. The board is dealt from a
   guaranteed-solvable inventory: a hidden solution path is built
   first, then its pieces are shuffled across the grid. Drag a
   tile onto another (or tap one, then the other) to swap them.
   No rotation — find the piece you need and move it. Fluid
   starts after a grace period, advances one tile at a time, and
   locks every pipe it fills. Directions: U=1 R=2 D=4 L=8. */

const PIPE_W = 9, PIPE_H = 9;
const PIPE_GRACE = 12000, PIPE_FLOW = 1500, PIPE_FAST = 220;
const PIPE_BLOCKED = 26;
const oppDir = (d) => ((d << 2) | (d >> 2)) & 15;
let pipes = null;

// draw a tile: thick stubs from the center to each open side
function ppSvg(m, blocked) {
  if (blocked) return `<svg viewBox="0 0 46 46"><rect x="6" y="6" width="34" height="34" fill="currentColor" opacity="0.35"/></svg>`;
  const seg = [];
  if (m & 1) seg.push('<line x1="23" y1="23" x2="23" y2="0"/>');
  if (m & 2) seg.push('<line x1="23" y1="23" x2="46" y2="23"/>');
  if (m & 4) seg.push('<line x1="23" y1="23" x2="23" y2="46"/>');
  if (m & 8) seg.push('<line x1="23" y1="23" x2="0" y2="23"/>');
  return `<svg viewBox="0 0 46 46" stroke="currentColor" stroke-width="11" stroke-linecap="round">
    ${seg.join("")}<circle cx="23" cy="23" r="6.5" fill="currentColor" stroke="none"/></svg>`;
}

// random solution walk from inlet to outlet; returns [{i, mask}]
function ppSolutionPath(inRow, outRow) {
  for (let attempt = 0; attempt < 300; attempt++) {
    let x = 0, y = inRow, inSide = 8;
    const visited = new Set([y * PIPE_W]);
    const path = [];
    let ok = false;
    for (let steps = 0; steps < 220; steps++) {
      if (x === PIPE_W - 1 && y === outRow) {
        path.push({ i: y * PIPE_W + x, mask: inSide | 2 });   // exit right
        ok = true;
        break;
      }
      const cands = [];
      const tryDir = (d, dx, dy, w) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= PIPE_W || ny < 0 || ny >= PIPE_H) return;
        if (visited.has(ny * PIPE_W + nx)) return;
        if (nx === PIPE_W - 1 && ny !== outRow && d === 2) w *= 0.25;  // discourage early last-column entry
        cands.push({ d, nx, ny, w });
      };
      tryDir(2, 1, 0, 5);
      tryDir(4, 0, 1, y < outRow ? 3 : 1);
      tryDir(1, 0, -1, y > outRow ? 3 : 1);
      tryDir(8, -1, 0, 0.4);
      if (!cands.length) break;
      let r = Math.random() * cands.reduce((a, c) => a + c.w, 0);
      let pick = cands[0];
      for (const c of cands) { r -= c.w; if (r <= 0) { pick = c; break; } }
      path.push({ i: y * PIPE_W + x, mask: inSide | pick.d });
      x = pick.nx; y = pick.ny;
      inSide = oppDir(pick.d);
      visited.add(y * PIPE_W + x);
    }
    if (ok) return path;
  }
  // fallback: straight shot along the inlet row then vertical to outlet (always representable)
  const path = [];
  for (let x = 0; x < PIPE_W - 1; x++) path.push({ i: inRow * PIPE_W + x, mask: 10 });
  const down = outRow > inRow;
  path.push({ i: inRow * PIPE_W + PIPE_W - 1, mask: 8 | (inRow === outRow ? 2 : down ? 4 : 1) });
  for (let y = inRow + (down ? 1 : -1); y !== outRow; y += down ? 1 : -1)
    path.push({ i: y * PIPE_W + PIPE_W - 1, mask: 5 });
  if (inRow !== outRow) path.push({ i: outRow * PIPE_W + PIPE_W - 1, mask: (down ? 1 : 4) | 2 });
  return path;
}

function ppNew() {
  ppStop();
  const inRow = Math.floor(Math.random() * PIPE_H);
  const outRow = Math.floor(Math.random() * PIPE_H);
  const sol = ppSolutionPath(inRow, outRow);
  const solCells = new Set(sol.map((p) => p.i));

  // blocked cells stay off the solution path so it's always rebuildable
  const blocked = new Set();
  let guard = 0;
  while (blocked.size < PIPE_BLOCKED && guard++ < 2000) {
    const i = Math.floor(Math.random() * PIPE_W * PIPE_H);
    if (!solCells.has(i) && i !== inRow * PIPE_W && i !== outRow * PIPE_W + PIPE_W - 1) blocked.add(i);
  }

  // inventory: solution pieces + random filler, shuffled over open cells
  const openCells = [];
  for (let i = 0; i < PIPE_W * PIPE_H; i++) if (!blocked.has(i)) openCells.push(i);
  const inventory = sol.map((p) => p.mask);
  const fillerPool = [3, 6, 12, 9, 3, 6, 12, 9, 5, 10, 5, 10];
  while (inventory.length < openCells.length)
    inventory.push(fillerPool[Math.floor(Math.random() * fillerPool.length)]);
  for (let i = inventory.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [inventory[i], inventory[j]] = [inventory[j], inventory[i]];
  }
  const grid = new Array(PIPE_W * PIPE_H).fill(0);
  openCells.forEach((c, k) => { grid[c] = inventory[k]; });

  pipes = {
    grid, blocked, filled: new Set(),
    inRow, outRow,
    fluidAt: null, fluidIn: null, sel: null,
    t0: Date.now(), timer: null, uiIv: null, phase: "build"
  };
  pipes.timer = setTimeout(ppFlowStart, PIPE_GRACE);
  ppTickUi();
  renderWork();
}
function ppStop() {
  if (pipes?.timer) { clearTimeout(pipes.timer); clearInterval(pipes.timer); pipes.timer = null; }
  if (pipes?.uiIv) { clearInterval(pipes.uiIv); pipes.uiIv = null; }
}
function ppTickUi() {
  pipes.uiIv = setInterval(() => {
    const el = document.querySelector("#pp-status");
    if (el && pipes.phase === "build") {
      const left = Math.max(0, Math.ceil((pipes.t0 + PIPE_GRACE - Date.now()) / 1000));
      el.textContent = `Fluid in ${left}s — swap pipes into place!`;
    }
  }, 250);
}
function ppFlowStart() {
  if (!pipes || pipes.phase !== "build") return;
  if (pipes.timer) { clearTimeout(pipes.timer); pipes.timer = null; }
  pipes.phase = "flowing";
  pipes.fluidAt = pipes.inRow * PIPE_W;
  pipes.fluidIn = 8;
  ppAdvance(true);
  pipes.timer = setInterval(() => ppAdvance(false), pipes.fast ? PIPE_FAST : PIPE_FLOW);
}
function ppValve() {
  if (!pipes || (pipes.phase !== "build" && pipes.phase !== "flowing")) return;
  pipes.fast = true;
  if (pipes.phase === "build") { ppFlowStart(); }
  else if (pipes.timer) {
    clearInterval(pipes.timer);
    pipes.timer = setInterval(() => ppAdvance(false), PIPE_FAST);
  }
  renderWork();
}
function ppAdvance(entering) {
  if (!pipes || pipes.phase !== "flowing") return;
  const i = pipes.fluidAt, inSide = pipes.fluidIn, m = pipes.grid[i];
  if (entering) {
    if (!(m & inSide) || pipes.blocked.has(i)) return ppBurst();
    pipes.filled.add(i);
    renderWork();
    return;
  }
  let out;
  if (m === 15) out = oppDir(inSide);
  else out = m & ~inSide;
  if (!out || (out & (out - 1))) return ppBurst();
  const x = i % PIPE_W, y = Math.floor(i / PIPE_W);
  let nx = x, ny = y;
  if (out === 1) ny--; else if (out === 2) nx++; else if (out === 4) ny++; else nx--;
  if (nx >= PIPE_W && y === pipes.outRow && out === 2) return ppWin();
  if (nx < 0 || nx >= PIPE_W || ny < 0 || ny >= PIPE_H) return ppBurst();
  const ni = ny * PIPE_W + nx;
  if (pipes.blocked.has(ni) || !(pipes.grid[ni] & oppDir(out)) || pipes.filled.has(ni)) return ppBurst();
  pipes.fluidAt = ni;
  pipes.fluidIn = oppDir(out);
  pipes.filled.add(ni);
  renderWork();
}
function ppWin() {
  ppStop();
  pipes.phase = "won";
  const secs = (Date.now() - pipes.t0) / 1000;
  const bonus = Math.round(40 * Math.max(0, Math.min(1, (150 - secs) / 110)));
  payWork("pipes", 60 + bonus, `routing the flow in ${Math.round(secs)}s`);
}
function ppBurst() {
  ppStop();
  pipes.phase = "burst";
  renderWork();
}
const ppSwappable = (i) =>
  pipes && (pipes.phase === "build" || pipes.phase === "flowing")
  && !pipes.blocked.has(i) && !pipes.filled.has(i);
function ppSwap(a, b) {
  if (a === b || !ppSwappable(a) || !ppSwappable(b)) { pipes.sel = null; renderWork(); return; }
  [pipes.grid[a], pipes.grid[b]] = [pipes.grid[b], pipes.grid[a]];
  pipes.sel = null;
  renderWork();
}
function ppTap(i) {
  if (!ppSwappable(i)) { pipes.sel = null; renderWork(); return; }
  if (pipes.sel === null) { pipes.sel = i; renderWork(); }
  else ppSwap(pipes.sel, i);
}
function ppHtml() {
  if (!pipes) ppNew();
  const rows = [];
  for (let y = 0; y < PIPE_H; y++) {
    let row = `<div class="pp-edge">${y === pipes.inRow ? "▶" : ""}</div>`;
    for (let x = 0; x < PIPE_W; x++) {
      const i = y * PIPE_W + x;
      const cls = pipes.blocked.has(i) ? "blocked" : pipes.filled.has(i) ? "filled" : "";
      const sel = pipes.sel === i ? "sel" : "";
      const draggable = ppSwappable(i) ? 'draggable="true"' : "";
      row += `<button class="pp-cell ${cls} ${sel}" data-pp="${i}" ${draggable}>${ppSvg(pipes.grid[i], pipes.blocked.has(i))}</button>`;
    }
    row += `<div class="pp-edge">${y === pipes.outRow ? "▶" : ""}</div>`;
    rows.push(`<div class="pp-row">${row}</div>`);
  }
  const status = pipes.phase === "build" ? "" :
    pipes.phase === "flowing" ? "FLUID FLOWING — stay ahead of it" :
    pipes.phase === "won" ? "Flow routed. The machine hums approvingly." :
    "BURST. Fluid everywhere. Janitorial has been notified.";
  return `
    ${capLine("pipes")}
    <div class="ms-bar">
      <span class="muted" style="font-size:12px" id="pp-status">${status || "Swap pipes to connect inlet to outlet before the fluid arrives."}</span>
      ${(pipes.phase === "build" || pipes.phase === "flowing") && !pipes.fast ? `<button class="btn-spin" id="pp-valve" title="Confident? Send the fluid through at full pressure.">Open the valve</button>` : ""}
      <button class="ghost" id="pp-new">New board</button>
    </div>
    <div class="pp-grid">${rows.join("")}</div>
    <div class="casino-msg ${pipes.phase === "won" ? "up" : pipes.phase === "burst" ? "down" : ""}">${
      pipes.phase === "won" ? "₡60 + speed bonus, paid." :
      pipes.phase === "burst" ? "No pay for flooded floors. New board to try again." :
      "Drag a tile onto another to swap them (or tap one, then the other). A pipe's arms show exactly where fluid can enter and leave. Route ▶ to ▶ — every piece you need is on the board somewhere. Filled pipes lock."}</div>`;
}


/* ================= RENDER ================= */
export function renderWork() {
  const el = api.el();
  if (!el) return;
  el.innerHTML = `
    <div class="casino-head">
      <h3 class="sec" style="margin:0">LW Industries — Employment Office</h3>
      <div class="casino-tabs">
        <button data-wmode="mines" class="${mode === "mines" ? "active" : ""}">Minesweeper</button>
        <button data-wmode="snake" class="${mode === "snake" ? "active" : ""}">Snake</button>
        <button data-wmode="pipes" class="${mode === "pipes" ? "active" : ""}">Pipes</button>
      </div>
    </div>
    <div class="casino-panel">
      ${mode === "mines" ? msHtml() : mode === "snake" ? snHtml() : ppHtml()}
    </div>
    <p class="muted" style="font-size:12px;margin-top:12px">Honest wages, no house edge. Each job caps at ${api.fmt(DAY_CAP)} a day, resets midnight ET.</p>`;

  el.querySelectorAll("[data-wmode]").forEach((b) =>
    b.addEventListener("click", () => {
      if (mode === "snake" && b.dataset.wmode !== "snake") snStop();
      if (mode === "pipes" && b.dataset.wmode !== "pipes" && pipes && pipes.phase !== "won" && pipes.phase !== "burst") { ppStop(); pipes = null; }
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
  const snCv = el.querySelector("#sn-canvas");
  if (snCv) {
    let sx = 0, sy = 0;
    snCv.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    snCv.addEventListener("touchend", (e) => {
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return;
      snTurn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
    }, { passive: true });
  }
  if (mode === "snake") snResume();
  if (snake) snDraw();

  el.querySelectorAll("[data-pp]").forEach((c) => {
    const i = Number(c.dataset.pp);
    c.addEventListener("click", () => ppTap(i));
    c.addEventListener("dragstart", (e) => {
      if (!ppSwappable(i)) { e.preventDefault(); return; }
      pipes.sel = i;
      e.dataTransfer.setData("text/plain", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    c.addEventListener("dragover", (e) => { if (ppSwappable(i)) e.preventDefault(); });
    c.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      if (!isNaN(from)) ppSwap(from, i);
    });
  });
  el.querySelector("#pp-new")?.addEventListener("click", ppNew);
  el.querySelector("#pp-valve")?.addEventListener("click", ppValve);

}

export function initWork(apiIn) {
  api = apiIn;
  return {
    renderWork,
    stop: () => {
      snStop();
      if (pipes && pipes.phase !== "won" && pipes.phase !== "burst") { ppStop(); pipes = null; }
    }
  };
}
