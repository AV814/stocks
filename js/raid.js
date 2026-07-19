/* ============================================================
   VAPORSTOCKS — VAPOR TOWER (text-adventure roguelike raids)
   Pick a difficulty (entry fee), kit up in the shop (gear is
   per-run and consumed win or lose), then fight through four
   floors of corporate security, loot chests between fights, and
   take the boss for a payout. Death or fleeing forfeits the run.
   Repeatable forever — the economics are the roguelike: every
   run demands fresh spend on entry and equipment.

   Runs persist in localStorage so a reload resumes mid-fight.
   Money moves through api.settle: one transaction for entry +
   gear at mission start, one for the reward at the boss kill
   (with crash-safe pending recovery).
   ============================================================ */

import {
  doc, setDoc, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let api = null;   // { db, fmt, toast, me, myDoc, settle, el }

const RAID_KEY = "vapor-raid-run";
const RAID_PENDING = "vapor-raid-pending";

const DIFFS = [
  { id: "d1", name: "Junior Associate", entry: 50,  reward: 160,  color: "#8bd450",
    fights: [[26, 34, 6, 8], [28, 36, 6, 8], [30, 40, 7, 9], [32, 44, 7, 10]], boss: [70, 10, "THE MIDDLE MANAGER"] },
  { id: "d2", name: "Senior Raider",    entry: 150, reward: 520,  color: "#e8a33d",
    fights: [[40, 52, 10, 12], [44, 56, 10, 13], [48, 60, 11, 13], [52, 64, 12, 14]], boss: [115, 16, "THE COMPLIANCE ENGINE"] },
  { id: "d3", name: "Hostile Takeover", entry: 400, reward: 1500, color: "#cc7a5a",
    fights: [[60, 75, 15, 17], [66, 80, 15, 18], [72, 86, 16, 19], [78, 92, 17, 20]], boss: [170, 24, "THE CHAIRMAN"] }
];
const WEAPONS = [
  { id: "w0", name: "Bare Hands",     cost: 0,   atk: 2 },
  { id: "w1", name: "Ergonomic Keyboard", cost: 30,  atk: 4 },
  { id: "w2", name: "Fire Axe",       cost: 80,  atk: 6 },
  { id: "w3", name: "Ceremonial Chainsword", cost: 200, atk: 9 }
];
const ARMORS = [
  { id: "a0", name: "Business Casual", cost: 0,   def: 0 },
  { id: "a1", name: "Thick Cardigan",  cost: 25,  def: 1 },
  { id: "a2", name: "Kevlar Blazer",   cost: 70,  def: 3 },
  { id: "a3", name: "Exo-Suit",        cost: 180, def: 5 }
];
const POTION_COST = 20, POTION_HEAL = 35, POTION_MAX = 5;

const GRUNTS = [
  "Security Intern", "Rogue Trading Algorithm", "HR Enforcement Drone", "Armed Auditor",
  "Synergy Golem", "Attack Consultant", "Feral Middle Manager", "KPI Hound",
  "Blockchain Evangelist", "Repossession Unit", "Motivational Poster (Animate)", "Severance Reaper"
];

let lobby = { diff: "d1", weapon: "w0", armor: "a0", potions: 0 };
let run = null;   // { diffId, hp, maxHp, atk, def, potions, stage, phase, enemy, log[], chest, over }

/* ---------- persistence ---------- */
function save() {
  if (run) localStorage.setItem(RAID_KEY, JSON.stringify(run));
  else localStorage.removeItem(RAID_KEY);
}
function load() {
  try {
    const r = JSON.parse(localStorage.getItem(RAID_KEY) || "null");
    if (r && r.hp !== undefined && r.diffId) run = r;
  } catch { localStorage.removeItem(RAID_KEY); }
}
function recoverRaid() {
  if (!api.me?.()) return;
  let p = null;
  try { p = JSON.parse(localStorage.getItem(RAID_PENDING) || "null"); }
  catch { localStorage.removeItem(RAID_PENDING); return; }
  if (!p || !(p.win > 0)) return;
  api.settle(p.win, 0)
    .then(() => { localStorage.removeItem(RAID_PENDING); api.toast("VAPOR TOWER", `Recovered an unpaid reward of ${api.fmt(p.win)}.`); })
    .catch(() => {});
}

/* ---------- helpers ---------- */
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const diffOf = (id) => DIFFS.find((d) => d.id === id);
function say(line, cls) { run.log.push(cls ? `<span class="${cls}">${line}</span>` : line); if (run.log.length > 60) run.log.shift(); }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- mission start ---------- */
function lobbyCost() {
  const d = diffOf(lobby.diff);
  const w = WEAPONS.find((x) => x.id === lobby.weapon);
  const a = ARMORS.find((x) => x.id === lobby.armor);
  return d.entry + w.cost + a.cost + lobby.potions * POTION_COST;
}
async function startRun() {
  const cost = lobbyCost();
  if (cost > (api.myDoc()?.cash || 0)) { alert("Not enough credits for that loadout."); return; }
  try { await api.settle(-cost, cost); }
  catch (e) { alert(e.message); return; }
  setDoc(doc(api.db, "market", "casinoStats"), { raid: increment(1) }, { merge: true }).catch(() => {});
  setDoc(doc(api.db, "users", api.me().uid), { gameStats: { raid: increment(1) } }, { merge: true }).catch(() => {});
  const w = WEAPONS.find((x) => x.id === lobby.weapon);
  const a = ARMORS.find((x) => x.id === lobby.armor);
  run = {
    diffId: lobby.diff, hp: 100, maxHp: 100,
    atk: w.atk, def: a.def, weaponName: w.name, armorName: a.name,
    potions: lobby.potions, spent: cost,
    stage: 0, phase: "combat", enemy: null, chest: null, log: []
  };
  say(`>>> VAPOR TOWER — ${diffOf(run.diffId).name.toUpperCase()} CONTRACT`, "rd-sys");
  say(`You sign the waiver. ${w.name} in hand, ${a.name.toLowerCase()} buttoned. The elevator doors close.`);
  nextEncounter();
}

/* ---------- encounters ---------- */
function nextEncounter() {
  const d = diffOf(run.diffId);
  if (run.stage < 4) {
    const [h1, h2, a1, a2] = d.fights[run.stage];
    run.enemy = { name: GRUNTS[rnd(0, GRUNTS.length - 1)], hp: rnd(h1, h2), atk: rnd(a1, a2), boss: false };
    run.enemy.maxHp = run.enemy.hp;
    run.phase = "combat";
    say(`— Floor ${run.stage + 1} —`, "rd-sys");
    say(`A ${run.enemy.name} blocks the corridor. (${run.enemy.hp} HP)`);
  } else {
    const [bh, ba, bn] = d.boss;
    run.enemy = { name: bn, hp: bh, maxHp: bh, atk: ba, boss: true };
    run.phase = "combat";
    say(`— The Top Floor —`, "rd-sys");
    say(`${bn} rises from behind an obsidian desk. (${bh} HP)`, "rd-boss");
  }
  save();
  renderRaid();
}

function enemyTurn() {
  if (!run.enemy || run.enemy.hp <= 0) return;
  const dmg = Math.max(1, run.enemy.atk + rnd(0, 3) - run.def);
  run.hp -= dmg;
  say(`${run.enemy.name} hits you for ${dmg}. (You: ${Math.max(0, run.hp)}/${run.maxHp} HP)`, "rd-hurt");
  if (run.hp <= 0) {
    run.phase = "dead";
    say(`>>> You crumple onto the carpet. The Tower keeps your ${api.fmt(run.spent)}.`, "rd-boss");
    say(`>>> Severance package: none.`, "rd-sys");
  }
}

function playerAttack(heavy) {
  if (run.phase !== "combat") return;
  const e = run.enemy;
  if (heavy && Math.random() < 0.25) {
    say(`You wind up a heavy swing… and whiff entirely.`);
  } else {
    let dmg = run.atk + rnd(0, 4);
    if (heavy) dmg = Math.round(dmg * 1.8);
    e.hp -= dmg;
    say(`You hit the ${e.name} for ${dmg}.${e.hp > 0 ? ` (${e.hp}/${e.maxHp} HP left)` : ""}`, "rd-hit");
  }
  if (e.hp <= 0) return defeatEnemy();
  enemyTurn();
  save();
  renderRaid();
}
function usePotion() {
  if (run.phase !== "combat" || run.potions <= 0 || run.hp >= run.maxHp) return;
  run.potions--;
  const heal = Math.min(POTION_HEAL, run.maxHp - run.hp);
  run.hp += heal;
  say(`You down a Vitality Smoothie. +${heal} HP (${run.hp}/${run.maxHp}). ${run.potions} left.`, "rd-heal");
  enemyTurn();
  save();
  renderRaid();
}
function flee() {
  if (run.phase !== "combat") return;
  if (!confirm(`Abandon the mission? Your ${api.fmt(run.spent)} in entry and gear is gone.`)) return;
  run = null;
  save();
  renderRaid();
}

function defeatEnemy() {
  const e = run.enemy;
  say(`The ${e.name} goes down.`, "rd-hit");
  if (e.boss) {
    const d = diffOf(run.diffId);
    run.phase = "won";
    say(`>>> CONTRACT COMPLETE. The vault door swings open.`, "rd-sys");
    say(`>>> Payout: ${api.fmt(d.reward)} (you invested ${api.fmt(run.spent)}).`, "rd-heal");
    localStorage.setItem(RAID_PENDING, JSON.stringify({ win: d.reward }));
    api.settle(d.reward, 0)
      .then(() => localStorage.removeItem(RAID_PENDING))
      .catch((err) => console.error("raid payout failed, recovery will retry", err));
    api.toast("VAPOR TOWER CLEARED", `${d.name}: ${api.fmt(d.reward)} paid out.`);
  } else if (run.stage < 3) {
    // a chest waits between fights
    run.phase = "chest";
    say(`Behind the wreckage: a supply crate stenciled VAPOR INDUSTRIES.`);
  } else {
    run.stage++;
    say(`The elevator dings. Going up.`);
    nextEncounter();
    return;
  }
  save();
  renderRaid();
}

async function openChest(take) {
  if (run.phase !== "chest") return;
  if (take) {
    const roll = Math.random();
    if (roll < 0.55) {
      const cash = rnd(10, 25) + diffOf(run.diffId).entry / 5;
      say(`Inside: petty cash. +${api.fmt(cash)} wired to your account.`, "rd-heal");
      api.settle(cash, 0).catch(() => {});
    } else if (roll < 0.75) {
      if (run.potions < POTION_MAX) { run.potions++; say(`Inside: a Vitality Smoothie. (${run.potions} carried)`, "rd-heal"); }
      else say(`Inside: a Vitality Smoothie, but your pockets are full. You leave it.`);
    } else if (roll < 0.9) {
      run.atk++;
      say(`Inside: an Aggression Seminar pamphlet. Permanent +1 attack this run.`, "rd-hit");
    } else {
      const dmg = rnd(8, 16);
      run.hp = Math.max(1, run.hp - dmg);
      say(`The crate was trapped. A stapler-turret takes ${dmg} HP. (${run.hp}/${run.maxHp})`, "rd-hurt");
    }
  } else {
    say(`You don't trust it. You move on.`);
  }
  run.stage++;
  nextEncounter();
}

/* ---------- render ---------- */
export function renderRaid() {
  const el = api.el();
  if (!el) return;

  if (!run) {
    const d = diffOf(lobby.diff);
    el.innerHTML = `
      <h3 class="sec">Vapor Tower — Mercenary Contracts</h3>
      <div class="adm-form">
        <div class="rd-shop-h">Contract</div>
        <div class="rd-diffs">
          ${DIFFS.map((x) => `<button class="rd-diff ${lobby.diff === x.id ? "on" : ""}" data-rdd="${x.id}" style="border-color:${x.color}">
            <b style="color:${x.color}">${x.name}</b>
            <span>entry ${api.fmt(x.entry)} · pays ${api.fmt(x.reward)}</span>
          </button>`).join("")}
        </div>
        <div class="rd-shop-h">Weapon</div>
        <div class="rd-gear">${WEAPONS.map((w) => `<button class="rd-item ${lobby.weapon === w.id ? "on" : ""}" data-rdw="${w.id}">${w.name}<span>ATK ${w.atk} · ${w.cost ? api.fmt(w.cost) : "free"}</span></button>`).join("")}</div>
        <div class="rd-shop-h">Armor</div>
        <div class="rd-gear">${ARMORS.map((a) => `<button class="rd-item ${lobby.armor === a.id ? "on" : ""}" data-rda="${a.id}">${a.name}<span>DEF ${a.def} · ${a.cost ? api.fmt(a.cost) : "free"}</span></button>`).join("")}</div>
        <div class="rd-shop-h">Vitality Smoothies (+${POTION_HEAL} HP, ${api.fmt(POTION_COST)} each)</div>
        <div class="rd-gear">
          <button class="ghost" id="rd-pminus">−</button>
          <span class="rd-pcount">${lobby.potions}</span>
          <button class="ghost" id="rd-pplus">+</button>
        </div>
        <div class="adm-form-actions" style="margin-top:14px">
          <button class="btn-spin" id="rd-start">Sign contract — ${api.fmt(lobbyCost())}</button>
        </div>
        <p class="muted" style="font-size:12px">Four floors of security, crates on the way up, a boss in the penthouse. Gear lasts one run, win or lose. Die or flee and the Tower keeps everything. Repeatable — if you can afford to keep kitting up.</p>
      </div>`;
    el.querySelectorAll("[data-rdd]").forEach((b) => b.addEventListener("click", () => { lobby.diff = b.dataset.rdd; renderRaid(); }));
    el.querySelectorAll("[data-rdw]").forEach((b) => b.addEventListener("click", () => { lobby.weapon = b.dataset.rdw; renderRaid(); }));
    el.querySelectorAll("[data-rda]").forEach((b) => b.addEventListener("click", () => { lobby.armor = b.dataset.rda; renderRaid(); }));
    el.querySelector("#rd-pplus").addEventListener("click", () => { if (lobby.potions < POTION_MAX) { lobby.potions++; renderRaid(); } });
    el.querySelector("#rd-pminus").addEventListener("click", () => { if (lobby.potions > 0) { lobby.potions--; renderRaid(); } });
    el.querySelector("#rd-start").addEventListener("click", startRun);
    return;
  }

  const d = diffOf(run.diffId);
  const e = run.enemy;
  const hpPct = Math.max(0, run.hp / run.maxHp * 100);
  const ePct = e ? Math.max(0, e.hp / e.maxHp * 100) : 0;
  el.innerHTML = `
    <h3 class="sec">Vapor Tower — ${d.name}</h3>
    <div class="rd-hud">
      <div class="rd-stat">
        <div class="rd-stat-l">YOU · ATK ${run.atk} · DEF ${run.def} · 🥤${run.potions}</div>
        <div class="rd-bar"><div class="rd-fill you" style="width:${hpPct}%"></div></div>
        <div class="rd-stat-l">${Math.max(0, run.hp)}/${run.maxHp} HP</div>
      </div>
      <div class="rd-prog">${run.phase === "won" ? "CLEARED" : run.stage < 4 ? `Floor ${run.stage + 1}/4` : "PENTHOUSE"}</div>
      ${e && run.phase === "combat" ? `<div class="rd-stat">
        <div class="rd-stat-l" style="text-align:right">${esc(e.name)}${e.boss ? " ☠" : ""}</div>
        <div class="rd-bar"><div class="rd-fill foe" style="width:${ePct}%"></div></div>
        <div class="rd-stat-l" style="text-align:right">${Math.max(0, e.hp)}/${e.maxHp} HP</div>
      </div>` : `<div class="rd-stat"></div>`}
    </div>
    <div class="rd-log" id="rd-log">${run.log.map((l) => `<div>${l}</div>`).join("")}</div>
    <div class="casino-controls" style="margin-top:12px">
      ${run.phase === "combat" ? `
        <button class="btn-bj" id="rd-atk">Attack</button>
        <button class="btn-bj ghost-bj" id="rd-heavy" title="1.8x damage, 25% miss">Heavy swing</button>
        ${run.potions > 0 ? `<button class="ghost" id="rd-potion">🥤 Smoothie (${run.potions})</button>` : ""}
        <button class="ghost danger" id="rd-flee">Flee</button>
      ` : run.phase === "chest" ? `
        <button class="btn-spin" id="rd-open">Open the crate</button>
        <button class="ghost" id="rd-skip">Leave it</button>
      ` : `
        <button class="btn-spin" id="rd-again">${run.phase === "won" ? "Take another contract" : "Back to the lobby"}</button>
      `}
    </div>`;
  el.querySelector("#rd-atk")?.addEventListener("click", () => playerAttack(false));
  el.querySelector("#rd-heavy")?.addEventListener("click", () => playerAttack(true));
  el.querySelector("#rd-potion")?.addEventListener("click", usePotion);
  el.querySelector("#rd-flee")?.addEventListener("click", flee);
  el.querySelector("#rd-open")?.addEventListener("click", () => openChest(true));
  el.querySelector("#rd-skip")?.addEventListener("click", () => openChest(false));
  el.querySelector("#rd-again")?.addEventListener("click", () => { run = null; save(); renderRaid(); });
  const log = el.querySelector("#rd-log");
  if (log) log.scrollTop = log.scrollHeight;
  recoverRaid();
}

export function initRaid(apiIn) {
  api = apiIn;
  load();
  return { renderRaid };
}
