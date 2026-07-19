/* ============================================================
   VAPORSTOCKS — VAPOR TOWER (deep-combat roguelike raids)

   The loop: sign a contract (entry fee), buy per-run gear and
   items, climb four floors + a boss. Between floors: supply
   crates or a Supply Office perk draft (pick 1 of 3). Combat is
   intent-based: every enemy telegraphs its next move, so Block,
   items, and timing are real decisions, not flavor.

   Player actions:
     Strike      — weapon damage, can crit
     Heavy swing — 1.8x, 25% miss
     Block       — 70% damage reduction + riposte counter;
                   the answer to telegraphed nukes
     Items       — Health Potion, Adrenaline, EMP Grenade
     Flee        — forfeit the run

   Weapons carry traits (crit, armor-pierce, bleed). Enemies come
   in archetypes (brute, twin, guard, leech, bomber) with distinct
   patterns. Bosses enrage at half health. Gear lasts one run.
   Runs persist in localStorage; payouts are crash-safe.
   ============================================================ */

import {
  doc, setDoc, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let api = null;

const RAID_KEY = "vapor-raid-run";
const RAID_PENDING = "vapor-raid-pending";

const DIFFS = [
  { id: "d1", name: "Junior Associate", entry: 50,  reward: 180,  color: "#8bd450",
    hp: [26, 40], atk: [6, 9],  boss: { hp: 80,  atk: 10, name: "THE MIDDLE MANAGER", arch: "brute" } },
  { id: "d2", name: "Senior Raider",    entry: 150, reward: 560,  color: "#e8a33d",
    hp: [42, 60], atk: [10, 14], boss: { hp: 130, atk: 16, name: "THE COMPLIANCE ENGINE", arch: "bomber" } },
  { id: "d3", name: "Hostile Takeover", entry: 400, reward: 1600, color: "#cc7a5a",
    hp: [62, 88], atk: [15, 20], boss: { hp: 190, atk: 24, name: "THE CHAIRMAN", arch: "leech" } }
];
const WEAPONS = [
  { id: "w0", name: "Bare Hands",             cost: 0,   atk: 2, trait: null,    blurb: "ATK 2" },
  { id: "w1", name: "Ergonomic Keyboard",     cost: 30,  atk: 4, trait: "crit",  blurb: "ATK 4 · +10% crit" },
  { id: "w2", name: "Fire Axe",               cost: 80,  atk: 6, trait: "pierce", blurb: "ATK 6 · ignores half DEF" },
  { id: "w3", name: "Taser Lance",            cost: 130, atk: 6, trait: "stun",  blurb: "ATK 6 · 15% stun" },
  { id: "w4", name: "Ceremonial Chainsword",  cost: 200, atk: 8, trait: "bleed", blurb: "ATK 8 · inflicts bleed" }
];
const ARMORS = [
  { id: "a0", name: "Business Casual", cost: 0,   def: 0, blurb: "DEF 0" },
  { id: "a1", name: "Thick Cardigan",  cost: 25,  def: 1, blurb: "DEF 1" },
  { id: "a2", name: "Kevlar Blazer",   cost: 70,  def: 3, blurb: "DEF 3" },
  { id: "a3", name: "Exo-Suit",        cost: 180, def: 5, blurb: "DEF 5" }
];
const ITEMS = [
  { id: "potion",    name: "Health Potion",  cost: 20, cap: 5, blurb: "+35 HP" },
  { id: "adrenaline", name: "Adrenaline",    cost: 35, cap: 2, blurb: "next Strike/Heavy deals double" },
  { id: "emp",       name: "EMP Grenade",    cost: 45, cap: 2, blurb: "10 dmg + stuns 1 turn" }
];
const POTION_HEAL = 35;

const PERKS = [
  { id: "vital",   name: "Corner Office Nap",   blurb: "+15 max HP, heal 15",       apply: (r) => { r.maxHp += 15; r.hp = Math.min(r.maxHp, r.hp + 15); } },
  { id: "atk",     name: "Aggression Seminar",  blurb: "+2 attack",                  apply: (r) => { r.atk += 2; } },
  { id: "def",     name: "Liability Waiver",    blurb: "+2 defense",                 apply: (r) => { r.def += 2; } },
  { id: "crit",    name: "Killer Instinct",     blurb: "+12% crit chance",           apply: (r) => { r.crit += 0.12; } },
  { id: "thorns",  name: "Passive Aggression",  blurb: "attackers take 4 back",      apply: (r) => { r.thorns += 4; } },
  { id: "vamp",    name: "Predatory Lending",   blurb: "heal 25% of damage you deal", apply: (r) => { r.vamp = true; } },
  { id: "restock", name: "Vending Machine Key", blurb: "+2 Health Potions",          apply: (r) => { r.items.potion = Math.min(5, r.items.potion + 2); } },
  { id: "bounty",  name: "Performance Bonus",   blurb: "+15% contract payout",       apply: (r) => { r.bounty += 0.15; } }
];

const GRUNTS = {
  brute:  ["Armed Auditor", "Synergy Golem", "Repossession Unit"],
  twin:   ["HR Enforcement Drones", "Interns (Feral, Pair)", "KPI Hounds"],
  guard:  ["Riot Compliance Officer", "Motivational Poster (Animate)", "Firewall Made Flesh"],
  leech:  ["Blockchain Evangelist", "Consultant (Billable)", "Severance Reaper"],
  bomber: ["Rogue Trading Algorithm", "Printer (Possessed)", "Quarterly Projection"]
};
const ARCHES = Object.keys(GRUNTS);

let lobby = { diff: "d1", weapon: "w0", armor: "a0", items: { potion: 0, adrenaline: 0, emp: 0 } };
let run = null;

/* ---------- persistence & recovery ---------- */
function save() { run ? localStorage.setItem(RAID_KEY, JSON.stringify(run)) : localStorage.removeItem(RAID_KEY); }
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

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const diffOf = (id) => DIFFS.find((d) => d.id === id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function say(line, cls) { run.log.push(cls ? `<span class="${cls}">${line}</span>` : line); if (run.log.length > 80) run.log.shift(); }

/* ---------- mission start ---------- */
function lobbyCost() {
  const d = diffOf(lobby.diff);
  const w = WEAPONS.find((x) => x.id === lobby.weapon);
  const a = ARMORS.find((x) => x.id === lobby.armor);
  const items = ITEMS.reduce((s, it) => s + lobby.items[it.id] * it.cost, 0);
  return d.entry + w.cost + a.cost + items;
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
    atk: w.atk, def: a.def, crit: 0.08 + (w.trait === "crit" ? 0.10 : 0),
    trait: w.trait, weaponName: w.name, armorName: a.name,
    items: { ...lobby.items }, spent: cost,
    thorns: 0, vamp: false, bounty: 0, adrenalized: false,
    stage: 0, phase: "combat", enemy: null, perkOffer: null, log: []
  };
  say(`>>> VAPOR TOWER — ${diffOf(run.diffId).name.toUpperCase()} CONTRACT`, "rd-sys");
  say(`You sign the waiver. ${w.name} in hand, ${a.name.toLowerCase()} buttoned. The elevator doors close.`);
  nextEncounter();
}

/* ---------- enemies & intents ---------- */
function makeEnemy(bossSpec) {
  const d = diffOf(run.diffId);
  let e;
  if (bossSpec) {
    e = { name: bossSpec.name, hp: bossSpec.hp, maxHp: bossSpec.hp, atk: bossSpec.atk,
          arch: bossSpec.arch, boss: true, enraged: false };
  } else {
    const arch = ARCHES[rnd(0, ARCHES.length - 1)];
    const names = GRUNTS[arch];
    const scale = 1 + run.stage * 0.08;
    e = { name: names[rnd(0, names.length - 1)],
          hp: Math.round(rnd(d.hp[0], d.hp[1]) * scale), atk: Math.round(rnd(d.atk[0], d.atk[1]) * scale),
          arch, boss: false, enraged: false };
    e.maxHp = e.hp;
  }
  e.guard = 0;          // temporary defense from "guard" intent
  e.bleed = 0;
  e.stunned = false;
  e.charge = false;     // bomber wind-up
  e.intent = rollIntent(e);
  return e;
}
function rollIntent(e) {
  if (e.charge) return { kind: "nuke", label: `☢ UNLEASH ~${Math.round(e.atk * 2.2)} — BLOCK THIS` };
  const r = Math.random();
  switch (e.arch) {
    case "brute":
      return r < 0.35 ? { kind: "heavy", label: `HEAVY SLAM ~${Math.round(e.atk * 1.6)}` }
                      : { kind: "strike", label: `strike ~${e.atk}` };
    case "twin":
      return r < 0.6 ? { kind: "double", label: `double hit ~${Math.ceil(e.atk * 0.65)} x2` }
                     : { kind: "strike", label: `strike ~${e.atk}` };
    case "guard":
      return r < 0.4 && e.guard < 6 ? { kind: "guard", label: "raising guard (+DEF)" }
                                    : { kind: "strike", label: `strike ~${e.atk}` };
    case "leech":
      return r < 0.45 ? { kind: "leech", label: `siphon ~${e.atk} (heals itself)` }
                      : { kind: "strike", label: `strike ~${e.atk}` };
    case "bomber":
      return r < 0.4 ? { kind: "charge", label: "CHARGING… (nuke next turn)" }
                     : { kind: "strike", label: `strike ~${e.atk}` };
    default:
      return { kind: "strike", label: `strike ~${e.atk}` };
  }
}

function nextEncounter() {
  const d = diffOf(run.diffId);
  if (run.stage < 4) {
    run.enemy = makeEnemy(null);
    run.phase = "combat";
    say(`— Floor ${run.stage + 1} —`, "rd-sys");
    say(`A ${run.enemy.name} blocks the corridor. (${run.enemy.hp} HP · ${run.enemy.arch})`);
  } else {
    run.enemy = makeEnemy(d.boss);
    run.phase = "combat";
    say(`— The Top Floor —`, "rd-sys");
    say(`${run.enemy.name} rises from behind an obsidian desk. (${run.enemy.hp} HP)`, "rd-boss");
  }
  save();
  renderRaid();
}

/* ---------- combat resolution ---------- */
function tickBleed(e) {
  if (e.bleed > 0) {
    const dmg = e.bleed * 2;
    e.hp -= dmg;
    say(`${e.name} bleeds for ${dmg}. (${Math.max(0, e.hp)}/${e.maxHp})`, "rd-hit");
    e.bleed = Math.max(0, e.bleed - 1);
  }
}
function hurtPlayer(raw, tag) {
  const dmg = Math.max(1, raw - run.def);
  const final = run.blocking ? Math.max(1, Math.round(dmg * 0.3)) : dmg;
  run.hp -= final;
  say(`${run.enemy.name} ${tag} for ${final}${run.blocking ? " (blocked!)" : ""}. (You: ${Math.max(0, run.hp)}/${run.maxHp})`, run.blocking ? "rd-heal" : "rd-hurt");
  if (run.thorns > 0 && run.enemy.hp > 0) {
    run.enemy.hp -= run.thorns;
    say(`Your passive aggression stings back for ${run.thorns}.`, "rd-hit");
  }
}
function enemyAct() {
  const e = run.enemy;
  if (!e || e.hp <= 0) return;
  tickBleed(e);
  if (e.hp <= 0) return;
  if (e.boss && !e.enraged && e.hp <= e.maxHp / 2) {
    e.enraged = true;
    e.atk = Math.round(e.atk * 1.3);
    say(`${e.name} ENRAGES. Its attacks intensify.`, "rd-boss");
  }
  if (e.stunned) {
    e.stunned = false;
    say(`${e.name} is stunned and loses its turn.`, "rd-hit");
    e.intent = rollIntent(e);
    return;
  }
  const it = e.intent;
  if (it.kind === "strike") hurtPlayer(e.atk + rnd(0, 3), "hits you");
  else if (it.kind === "heavy") hurtPlayer(Math.round(e.atk * 1.6) + rnd(0, 3), "slams you");
  else if (it.kind === "double") { hurtPlayer(Math.ceil(e.atk * 0.65) + rnd(0, 2), "hits you"); if (run.hp > 0) hurtPlayer(Math.ceil(e.atk * 0.65) + rnd(0, 2), "hits you again"); }
  else if (it.kind === "guard") { e.guard = Math.min(8, e.guard + 3); say(`${e.name} raises its guard. (+3 DEF, now ${e.guard})`); }
  else if (it.kind === "leech") {
    const before = run.hp;
    hurtPlayer(e.atk + rnd(0, 3), "siphons you");
    const drained = Math.max(0, before - run.hp);
    const heal = Math.ceil(drained / 2);
    e.hp = Math.min(e.maxHp, e.hp + heal);
    say(`${e.name} drinks deep, healing ${heal}.`, "rd-hurt");
  }
  else if (it.kind === "charge") { e.charge = true; say(`${e.name} is CHARGING something enormous.`, "rd-boss"); }
  else if (it.kind === "nuke") { e.charge = false; hurtPlayer(Math.round(e.atk * 2.2) + rnd(0, 4), "UNLEASHES"); }
  e.intent = rollIntent(e);
}
function afterPlayerAction() {
  const e = run.enemy;
  if (e.hp <= 0) return defeatEnemy();
  enemyAct();
  run.blocking = false;
  if (run.hp <= 0) {
    run.phase = "dead";
    say(`>>> You crumple onto the carpet. The Tower keeps your ${api.fmt(run.spent)}.`, "rd-boss");
    say(`>>> Severance package: none.`, "rd-sys");
  }
  save();
  renderRaid();
}

function dmgRoll(mult) {
  let dmg = run.atk + rnd(0, 4);
  const e = run.enemy;
  const effDef = run.trait === "pierce" ? Math.floor(e.guard / 2) : e.guard;
  let crit = false;
  if (Math.random() < run.crit) { crit = true; dmg = Math.round(dmg * 1.5); }
  if (run.adrenalized) { dmg *= 2; run.adrenalized = false; say(`Adrenaline surges.`, "rd-hit"); }
  return { dmg: Math.max(1, Math.round(dmg * mult) - effDef), crit };
}
function landHit(dmg, crit) {
  const e = run.enemy;
  e.hp -= dmg;
  say(`You hit the ${e.name} for ${dmg}${crit ? " — CRITICAL" : ""}.${e.hp > 0 ? ` (${e.hp}/${e.maxHp})` : ""}`, "rd-hit");
  if (run.trait === "bleed") { e.bleed = Math.min(3, e.bleed + 1); say(`It's bleeding. (${e.bleed} stacks)`); }
  if (run.trait === "stun" && Math.random() < 0.15 && e.hp > 0) { e.stunned = true; say(`The taser bites — ${e.name} seizes up.`, "rd-hit"); }
  if (run.vamp) { const h = Math.min(run.maxHp - run.hp, Math.ceil(dmg * 0.25)); if (h > 0) { run.hp += h; say(`You leech ${h} HP.`, "rd-heal"); } }
}
function actStrike() { if (run.phase !== "combat") return; const { dmg, crit } = dmgRoll(1); landHit(dmg, crit); afterPlayerAction(); }
function actHeavy() {
  if (run.phase !== "combat") return;
  if (Math.random() < 0.25) { say(`You wind up a heavy swing… and whiff entirely.`); if (run.adrenalized) { run.adrenalized = false; say("The adrenaline burns off uselessly.", "rd-hurt"); } }
  else { const { dmg, crit } = dmgRoll(1.8); landHit(dmg, crit); }
  afterPlayerAction();
}
function actBlock() {
  if (run.phase !== "combat") return;
  run.blocking = true;
  say(`You brace behind your ${run.weaponName.toLowerCase()}.`);
  const e = run.enemy;
  const riposte = Math.max(1, Math.round((run.atk + rnd(0, 2)) * 0.5) - e.guard);
  e.hp -= riposte;
  say(`Riposte: ${riposte} damage.${e.hp > 0 ? ` (${e.hp}/${e.maxHp})` : ""}`, "rd-hit");
  afterPlayerAction();
}
function actItem(id) {
  if (run.phase !== "combat" || run.items[id] <= 0) return;
  run.items[id]--;
  if (id === "potion") {
    const heal = Math.min(POTION_HEAL, run.maxHp - run.hp);
    run.hp += heal;
    say(`You quaff a Health Potion. +${heal} HP (${run.hp}/${run.maxHp}). ${run.items.potion} left.`, "rd-heal");
  } else if (id === "adrenaline") {
    run.adrenalized = true;
    say(`You slam the Adrenaline. Your next swing will hit twice as hard.`, "rd-hit");
  } else if (id === "emp") {
    const e = run.enemy;
    const wasCharging = e.charge;
    e.hp -= 10;
    e.stunned = true;
    e.charge = false;
    if (wasCharging) e.intent = rollIntent(e);
    say(`EMP Grenade: 10 damage, systems seized${wasCharging ? ", charge dissipated" : ""}. (${Math.max(0, e.hp)}/${e.maxHp})`, "rd-hit");
    if (e.hp <= 0) return defeatEnemy();
  }
  afterPlayerAction();
}
function flee() {
  if (run.phase !== "combat") return;
  if (!confirm(`Abandon the mission? Your ${api.fmt(run.spent)} in entry and gear is gone.`)) return;
  run = null;
  save();
  renderRaid();
}

/* ---------- rooms between fights ---------- */
function defeatEnemy() {
  const e = run.enemy;
  say(`The ${e.name} goes down.`, "rd-hit");
  if (e.boss) {
    const d = diffOf(run.diffId);
    const reward = Math.round(d.reward * (1 + run.bounty) * 100) / 100;
    run.phase = "won";
    say(`>>> CONTRACT COMPLETE. The vault door swings open.`, "rd-sys");
    say(`>>> Payout: ${api.fmt(reward)}${run.bounty ? ` (incl. +${Math.round(run.bounty * 100)}% bonus)` : ""} — you invested ${api.fmt(run.spent)}.`, "rd-heal");
    localStorage.setItem(RAID_PENDING, JSON.stringify({ win: reward }));
    api.settle(reward, 0)
      .then(() => localStorage.removeItem(RAID_PENDING))
      .catch((err) => console.error("raid payout failed, recovery will retry", err));
    api.toast("VAPOR TOWER CLEARED", `${d.name}: ${api.fmt(reward)} paid out.`);
  } else if (run.stage < 3) {
    if (Math.random() < 0.5) {
      run.phase = "chest";
      say(`Behind the wreckage: a supply crate stenciled VAPOR INDUSTRIES.`);
    } else {
      run.phase = "perk";
      const pool = [...PERKS].sort(() => Math.random() - 0.5).slice(0, 3);
      run.perkOffer = pool.map((p) => p.id);
      say(`A Supply Office. Three requisition forms on the desk — you may sign one.`, "rd-sys");
    }
  } else {
    run.stage++;
    say(`The elevator dings. Going up.`);
    nextEncounter();
    return;
  }
  save();
  renderRaid();
}
function pickPerk(id) {
  if (run.phase !== "perk") return;
  const p = PERKS.find((x) => x.id === id);
  p.apply(run);
  say(`Signed: ${p.name} — ${p.blurb}.`, "rd-heal");
  run.perkOffer = null;
  run.stage++;
  nextEncounter();
}
async function openChest(take) {
  if (run.phase !== "chest") return;
  if (take) {
    const roll = Math.random();
    if (roll < 0.5) {
      const cash = rnd(10, 25) + diffOf(run.diffId).entry / 5;
      say(`Inside: petty cash. +${api.fmt(cash)} wired to your account.`, "rd-heal");
      api.settle(cash, 0).catch(() => {});
    } else if (roll < 0.72) {
      if (run.items.potion < 5) { run.items.potion++; say(`Inside: a Health Potion. (${run.items.potion} carried)`, "rd-heal"); }
      else say(`Inside: a Health Potion, but your pockets are full. You leave it.`);
    } else if (roll < 0.88) {
      run.atk++;
      say(`Inside: an espresso so strong it counts as a weapon upgrade. Permanent +1 attack this run.`, "rd-hit");
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
        <div class="rd-gear">${WEAPONS.map((w) => `<button class="rd-item ${lobby.weapon === w.id ? "on" : ""}" data-rdw="${w.id}">${w.name}<span>${w.blurb} · ${w.cost ? api.fmt(w.cost) : "free"}</span></button>`).join("")}</div>
        <div class="rd-shop-h">Armor</div>
        <div class="rd-gear">${ARMORS.map((a) => `<button class="rd-item ${lobby.armor === a.id ? "on" : ""}" data-rda="${a.id}">${a.name}<span>${a.blurb} · ${a.cost ? api.fmt(a.cost) : "free"}</span></button>`).join("")}</div>
        <div class="rd-shop-h">Items</div>
        <div class="rd-gear">
          ${ITEMS.map((it) => `<div class="rd-itemrow">
            <span>${it.name} <span class="muted" style="font-size:11px">(${it.blurb}, ${api.fmt(it.cost)})</span></span>
            <button class="ghost" data-rdim="${it.id}">−</button>
            <span class="rd-pcount">${lobby.items[it.id]}</span>
            <button class="ghost" data-rdip="${it.id}">+</button>
          </div>`).join("")}
        </div>
        <div class="adm-form-actions" style="margin-top:14px">
          <button class="btn-spin" id="rd-start">Sign contract — ${api.fmt(lobbyCost())}</button>
        </div>
        <p class="muted" style="font-size:12px">Every enemy telegraphs its next move — Block cuts a hit by 70% and ripostes, which is how you survive the big telegraphed slams. Four floors, crates and perk drafts between fights, a boss that enrages at half health. Gear lasts one run, win or lose.</p>
      </div>`;
    el.querySelectorAll("[data-rdd]").forEach((b) => b.addEventListener("click", () => { lobby.diff = b.dataset.rdd; renderRaid(); }));
    el.querySelectorAll("[data-rdw]").forEach((b) => b.addEventListener("click", () => { lobby.weapon = b.dataset.rdw; renderRaid(); }));
    el.querySelectorAll("[data-rda]").forEach((b) => b.addEventListener("click", () => { lobby.armor = b.dataset.rda; renderRaid(); }));
    el.querySelectorAll("[data-rdip]").forEach((b) => b.addEventListener("click", () => {
      const it = ITEMS.find((x) => x.id === b.dataset.rdip);
      if (lobby.items[it.id] < it.cap) { lobby.items[it.id]++; renderRaid(); }
    }));
    el.querySelectorAll("[data-rdim]").forEach((b) => b.addEventListener("click", () => {
      if (lobby.items[b.dataset.rdim] > 0) { lobby.items[b.dataset.rdim]--; renderRaid(); }
    }));
    el.querySelector("#rd-start").addEventListener("click", startRun);
    recoverRaid();
    return;
  }

  const d = diffOf(run.diffId);
  const e = run.enemy;
  const hpPct = Math.max(0, run.hp / run.maxHp * 100);
  const ePct = e ? Math.max(0, e.hp / e.maxHp * 100) : 0;
  const inCombat = run.phase === "combat";
  el.innerHTML = `
    <h3 class="sec">Vapor Tower — ${d.name}</h3>
    <div class="rd-hud">
      <div class="rd-stat">
        <div class="rd-stat-l">YOU · ATK ${run.atk} · DEF ${run.def} · CRIT ${Math.round(run.crit * 100)}%${run.adrenalized ? " · ⚡" : ""}</div>
        <div class="rd-bar"><div class="rd-fill you" style="width:${hpPct}%"></div></div>
        <div class="rd-stat-l">${Math.max(0, run.hp)}/${run.maxHp} HP · 🧪${run.items.potion} ⚡${run.items.adrenaline} 💥${run.items.emp}</div>
      </div>
      <div class="rd-prog">${run.phase === "won" ? "CLEARED" : run.stage < 4 ? `Floor ${run.stage + 1}/4` : "PENTHOUSE"}</div>
      ${e && inCombat ? `<div class="rd-stat">
        <div class="rd-stat-l" style="text-align:right">${esc(e.name)}${e.boss ? " ☠" : ""}${e.enraged ? " · ENRAGED" : ""}${e.guard ? ` · 🛡${e.guard}` : ""}${e.bleed ? ` · 🩸${e.bleed}` : ""}${e.stunned ? " · STUNNED" : ""}</div>
        <div class="rd-bar"><div class="rd-fill foe" style="width:${ePct}%"></div></div>
        <div class="rd-stat-l rd-intent" style="text-align:right">intends: ${e.intent.label}</div>
      </div>` : `<div class="rd-stat"></div>`}
    </div>
    <div class="rd-log" id="rd-log">${run.log.map((l) => `<div>${l}</div>`).join("")}</div>
    <div class="casino-controls" style="margin-top:12px;flex-wrap:wrap">
      ${inCombat ? `
        <button class="btn-bj" id="rd-atk">Strike</button>
        <button class="btn-bj ghost-bj" id="rd-heavy" title="1.8x damage, 25% miss">Heavy</button>
        <button class="btn-bj ghost-bj" id="rd-block" title="70% damage reduction + riposte">Block</button>
        ${run.items.potion > 0 ? `<button class="ghost" data-rduse="potion">🧪 Potion</button>` : ""}
        ${run.items.adrenaline > 0 ? `<button class="ghost" data-rduse="adrenaline">⚡ Adrenaline</button>` : ""}
        ${run.items.emp > 0 ? `<button class="ghost" data-rduse="emp">💥 EMP</button>` : ""}
        <button class="ghost danger" id="rd-flee">Flee</button>
      ` : run.phase === "chest" ? `
        <button class="btn-spin" id="rd-open">Open the crate</button>
        <button class="ghost" id="rd-skip">Leave it</button>
      ` : run.phase === "perk" ? `
        ${run.perkOffer.map((id) => {
          const p = PERKS.find((x) => x.id === id);
          return `<button class="rd-item" data-rdperk="${id}">${p.name}<span>${p.blurb}</span></button>`;
        }).join("")}
      ` : `
        <button class="btn-spin" id="rd-again">${run.phase === "won" ? "Take another contract" : "Back to the lobby"}</button>
      `}
    </div>`;
  el.querySelector("#rd-atk")?.addEventListener("click", actStrike);
  el.querySelector("#rd-heavy")?.addEventListener("click", actHeavy);
  el.querySelector("#rd-block")?.addEventListener("click", actBlock);
  el.querySelectorAll("[data-rduse]").forEach((b) => b.addEventListener("click", () => actItem(b.dataset.rduse)));
  el.querySelector("#rd-flee")?.addEventListener("click", flee);
  el.querySelector("#rd-open")?.addEventListener("click", () => openChest(true));
  el.querySelector("#rd-skip")?.addEventListener("click", () => openChest(false));
  el.querySelectorAll("[data-rdperk]").forEach((b) => b.addEventListener("click", () => pickPerk(b.dataset.rdperk)));
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
