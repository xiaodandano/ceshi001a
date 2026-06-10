/* ============================================================
 * 《僵尸搜打撤》DEMO
 * 玩法融合:
 *  - 向僵尸开炮: 自动索敌开炮、僵尸潮、局内升级成长
 *  - 三角洲行动(搜打撤): 自动搜索物资箱、带战利品撤离、阵亡掉光
 * 纯 Canvas 实现,无外部依赖。PC: WASD/方向键移动; 手机: 虚拟摇杆。
 * ============================================================ */
'use strict';

// ---------- 基础设置 ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let VW = 0, VH = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  VW = window.innerWidth; VH = window.innerHeight;
  canvas.width = VW * DPR; canvas.height = VH * DPR;
  canvas.style.width = VW + 'px'; canvas.style.height = VH + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const MAP_W = 2600, MAP_H = 2600;
const RAID_TIME = 180;          // 单局时长(秒), 超时进入"尸潮风暴"
const EXTRACT_HOLD = 5;         // 撤离区站立秒数
const rand = (a, b) => a + Math.random() * (b - a);
const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- 简易音效 (WebAudio) ----------
let audioCtx = null;
function beep(freq, dur, type, vol) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type || 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.04, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* 音频不可用时静默 */ }
}
const sfx = {
  shoot:   () => beep(rand(580, 660), 0.05, 'square', 0.018),
  hit:     () => beep(220, 0.06, 'sawtooth', 0.025),
  loot:    () => beep(880, 0.12, 'sine', 0.05),
  rare:    () => { beep(660, 0.1, 'sine', 0.06); setTimeout(() => beep(990, 0.15, 'sine', 0.06), 90); },
  hurt:    () => beep(110, 0.15, 'sawtooth', 0.06),
  upgrade: () => { beep(523, 0.1, 'sine', 0.06); setTimeout(() => beep(784, 0.18, 'sine', 0.06), 100); },
  extract: () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.2, 'sine', 0.07), i * 130)); },
  dead:    () => { [330, 262, 196].forEach((f, i) => setTimeout(() => beep(f, 0.3, 'sawtooth', 0.06), i * 200)); },
};

// ---------- 仓库(跨局持久化) ----------
function loadWarehouse() {
  try { return JSON.parse(localStorage.getItem('zsdc_warehouse')) || { value: 0, raids: 0, extracts: 0 }; }
  catch (e) { return { value: 0, raids: 0, extracts: 0 }; }
}
function saveWarehouse(w) {
  try { localStorage.setItem('zsdc_warehouse', JSON.stringify(w)); } catch (e) {}
}
let warehouse = loadWarehouse();

// ---------- 战利品定义 ----------
const LOOT_TABLE = [
  { name: '罐头食品', tier: 0, value: 30 },
  { name: '医用绷带', tier: 0, value: 45 },
  { name: '老式手表', tier: 1, value: 120 },
  { name: '军用电池', tier: 1, value: 160 },
  { name: '加密硬盘', tier: 2, value: 400 },
  { name: '夜视仪',   tier: 2, value: 520 },
  { name: '金条',     tier: 3, value: 1200 },
  { name: '核芯样本', tier: 3, value: 2000 },
];
const TIER_COLOR = ['#9aa5b1', '#3da9fc', '#a364f0', '#ffb020'];
const TIER_NAME = ['普通', '稀有', '史诗', '传说'];

// 局内升级(搜索军备箱获得)
const UPGRADES = [
  { id: 'dmg',   name: '炮弹强化',  desc: '伤害 +40%' },
  { id: 'rate',  name: '高速装填',  desc: '射速 +30%' },
  { id: 'multi', name: '多管火炮',  desc: '炮管 +1' },
  { id: 'range', name: '观瞄镜',    desc: '射程 +25%' },
  { id: 'heal',  name: '战地医疗',  desc: '回复 50 HP,上限 +20' },
  { id: 'pierce',name: '穿甲弹',    desc: '炮弹穿透 +1' },
];

// ---------- 游戏状态 ----------
let state = 'menu';   // menu | playing | extracted | dead
let game = null;
let last = performance.now();
let shake = 0;

function newGame() {
  const g = {
    t: 0,
    player: {
      x: MAP_W / 2, y: MAP_H / 2, r: 16,
      hp: 100, maxHp: 100, speed: 175,
      angle: 0,
      dmg: 25, fireRate: 2.2, range: 320, barrels: 1, pierce: 0,
      fireCd: 0, hurtFlash: 0,
      loot: [], lootValue: 0, kills: 0,
    },
    zombies: [], bullets: [], crates: [], drops: [], parts: [], floats: [],
    spawnCd: 2, storm: false,
    extract: { x: 0, y: 0, r: 90, hold: 0 },
    cam: { x: 0, y: 0 },
    msg: null, msgT: 0,
  };
  // 撤离点: 随机一个角落
  const corners = [[260, 260], [MAP_W - 260, 260], [260, MAP_H - 260], [MAP_W - 260, MAP_H - 260]];
  const c = corners[(Math.random() * 4) | 0];
  g.extract.x = c[0]; g.extract.y = c[1];

  // 物资箱: 普通箱 + 高级箱(离中心越远越好) + 军备箱(升级)
  for (let i = 0; i < 26; i++) {
    const x = rand(150, MAP_W - 150), y = rand(150, MAP_H - 150);
    if (Math.hypot(x - g.player.x, y - g.player.y) < 220) { i--; continue; }
    const dC = Math.hypot(x - MAP_W / 2, y - MAP_H / 2) / (MAP_W / 2);
    let kind = 'normal';
    const roll = Math.random();
    if (roll < 0.18) kind = 'arms';                       // 军备箱: 局内升级
    else if (roll < 0.18 + 0.28 * dC) kind = 'high';      // 高级箱: 边缘更多
    g.crates.push({
      x, y, r: 26, kind,
      searchTime: kind === 'normal' ? 2.2 : kind === 'high' ? 3.5 : 2.8,
      progress: 0, opened: false,
    });
  }
  // 装饰物(残骸/草丛)
  g.props = [];
  for (let i = 0; i < 60; i++) {
    g.props.push({ x: rand(60, MAP_W - 60), y: rand(60, MAP_H - 60), s: rand(14, 42), k: Math.random() < 0.5 ? 0 : 1 });
  }
  return g;
}

function showMsg(text, color) {
  game.msg = { text, color: color || '#fff' };
  game.msgT = 2.4;
}

// ---------- 输入 ----------
const keys = {};
window.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (state !== 'playing' && (e.code === 'Space' || e.code === 'Enter')) startOrRestart();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

// 触屏虚拟摇杆
const joy = { active: false, id: -1, ox: 0, oy: 0, dx: 0, dy: 0 };
function onTouch(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (e.type === 'touchstart') {
      if (state !== 'playing') { startOrRestart(); return; }
      if (!joy.active) { joy.active = true; joy.id = t.identifier; joy.ox = t.clientX; joy.oy = t.clientY; joy.dx = 0; joy.dy = 0; }
    } else if (t.identifier === joy.id) {
      if (e.type === 'touchmove') {
        joy.dx = t.clientX - joy.ox; joy.dy = t.clientY - joy.oy;
        const m = Math.hypot(joy.dx, joy.dy);
        if (m > 60) { joy.dx *= 60 / m; joy.dy *= 60 / m; }
      } else { joy.active = false; joy.id = -1; joy.dx = 0; joy.dy = 0; }
    }
  }
}
['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(ev => canvas.addEventListener(ev, onTouch, { passive: false }));
canvas.addEventListener('mousedown', () => { if (state !== 'playing') startOrRestart(); });

function startOrRestart() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  game = newGame();
  state = 'playing';
}

// ---------- 僵尸生成 ----------
const ZTYPES = {
  walker:  { r: 15, hp: 50,  speed: 52,  dmg: 8,  color: '#5fb04f', value: 0 },
  runner:  { r: 12, hp: 30,  speed: 105, dmg: 6,  color: '#9ccf3f', value: 0 },
  brute:   { r: 26, hp: 240, speed: 38,  dmg: 18, color: '#3f7f3a', value: 1 },
  elite:   { r: 20, hp: 130, speed: 62,  dmg: 12, color: '#c25ae8', value: 1 }, // 精英: 必掉战利品
};
function spawnZombie(g, nearX, nearY) {
  const t = g.t;
  let type = 'walker';
  const r = Math.random();
  if (t > 30 && r < 0.25) type = 'runner';
  if (t > 60 && r < 0.12) type = 'elite';
  if (t > 90 && r < 0.07) type = 'brute';
  const base = ZTYPES[type];
  const ang = rand(0, Math.PI * 2);
  const d = rand(420, 620);
  const x = clamp((nearX ?? g.player.x) + Math.cos(ang) * d, 40, MAP_W - 40);
  const y = clamp((nearY ?? g.player.y) + Math.sin(ang) * d, 40, MAP_H - 40);
  const scale = 1 + t / 120 * 0.5;   // 随时间增强
  g.zombies.push({
    type, x, y, r: base.r,
    hp: base.hp * scale, maxHp: base.hp * scale,
    speed: base.speed * (g.storm ? 1.3 : 1) * rand(0.9, 1.1),
    dmg: base.dmg, color: base.color,
    hitT: 0, wob: rand(0, 6.28),
  });
}

// ---------- 战利品掉落 ----------
function rollLoot(maxTier) {
  const pool = LOOT_TABLE.filter(l => l.tier <= maxTier);
  // 高品质权重低
  const weights = pool.map(l => [4, 2.4, 1.2, 0.5][l.tier]);
  let sum = weights.reduce((a, b) => a + b, 0), r = Math.random() * sum;
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
  return pool[0];
}
function dropLoot(g, x, y, maxTier, count) {
  for (let i = 0; i < count; i++) {
    const item = rollLoot(maxTier);
    g.drops.push({
      x: x + rand(-24, 24), y: y + rand(-24, 24), r: 11,
      item, t: 0,
    });
  }
}

function applyUpgrade(g) {
  const p = g.player;
  const up = UPGRADES[(Math.random() * UPGRADES.length) | 0];
  switch (up.id) {
    case 'dmg':   p.dmg *= 1.4; break;
    case 'rate':  p.fireRate *= 1.3; break;
    case 'multi': p.barrels = Math.min(p.barrels + 1, 5); break;
    case 'range': p.range *= 1.25; break;
    case 'heal':  p.maxHp += 20; p.hp = Math.min(p.maxHp, p.hp + 50); break;
    case 'pierce':p.pierce += 1; break;
  }
  sfx.upgrade();
  showMsg('军备升级: ' + up.name + ' (' + up.desc + ')', '#7df0c0');
}

// ---------- 粒子 / 飘字 ----------
function burst(g, x, y, color, n, spd) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), s = rand(30, spd || 140);
    g.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.25, 0.6), color, r: rand(1.5, 3.5) });
  }
}
function floatText(g, x, y, text, color, size) {
  g.floats.push({ x, y, text, color, size: size || 14, life: 1.0 });
}

// ---------- 更新逻辑 ----------
function update(dt) {
  if (state !== 'playing') return;
  const g = game, p = g.player;
  g.t += dt;
  if (g.msgT > 0) g.msgT -= dt;

  // 超时 -> 尸潮风暴
  if (!g.storm && g.t >= RAID_TIME) {
    g.storm = true;
    showMsg('!! 尸潮风暴来袭,立即撤离 !!', '#ff5555');
    sfx.hurt();
  }

  // --- 移动 ---
  let mx = 0, my = 0;
  if (keys.KeyW || keys.ArrowUp) my -= 1;
  if (keys.KeyS || keys.ArrowDown) my += 1;
  if (keys.KeyA || keys.ArrowLeft) mx -= 1;
  if (keys.KeyD || keys.ArrowRight) mx += 1;
  if (joy.active && (joy.dx || joy.dy)) { mx = joy.dx / 60; my = joy.dy / 60; }
  const mm = Math.hypot(mx, my);
  if (mm > 0.01) {
    const k = Math.min(mm, 1) / mm;
    p.x = clamp(p.x + mx * k * p.speed * dt, p.r, MAP_W - p.r);
    p.y = clamp(p.y + my * k * p.speed * dt, p.r, MAP_H - p.r);
  }
  p.moving = mm > 0.01;

  // --- 僵尸生成 ---
  g.spawnCd -= dt;
  if (g.spawnCd <= 0) {
    const interval = g.storm ? 0.35 : Math.max(0.5, 2.0 - g.t / 60 * 0.4);
    g.spawnCd = interval;
    spawnZombie(g);
    if (g.storm) spawnZombie(g);
  }

  // --- 自动索敌开炮 (向僵尸开炮核心) ---
  p.fireCd -= dt;
  if (p.fireCd <= 0) {
    // 找射程内最近的僵尸
    let best = null, bd = p.range * p.range;
    for (const z of g.zombies) {
      const d = dist2(p, z);
      if (d < bd) { bd = d; best = z; }
    }
    if (best) {
      p.fireCd = 1 / p.fireRate;
      const baseAng = Math.atan2(best.y - p.y, best.x - p.x);
      p.angle = baseAng;
      const n = p.barrels;
      for (let i = 0; i < n; i++) {
        const off = n === 1 ? 0 : (i - (n - 1) / 2) * 0.16;
        const a = baseAng + off;
        g.bullets.push({
          x: p.x + Math.cos(a) * 20, y: p.y + Math.sin(a) * 20,
          vx: Math.cos(a) * 620, vy: Math.sin(a) * 620,
          dmg: p.dmg, pierce: p.pierce, life: p.range / 620 + 0.15, r: 4,
        });
      }
      sfx.shoot();
    }
  }

  // --- 子弹 ---
  for (let i = g.bullets.length - 1; i >= 0; i--) {
    const b = g.bullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    let dead = b.life <= 0;
    if (!dead) {
      for (const z of g.zombies) {
        const rr = (z.r + b.r) * (z.r + b.r);
        if (dist2(b, z) < rr) {
          z.hp -= b.dmg; z.hitT = 0.1;
          floatText(g, z.x, z.y - z.r - 6, Math.round(b.dmg), '#ffd86b', 13);
          burst(g, b.x, b.y, '#ffd86b', 4, 90);
          sfx.hit();
          if (b.pierce > 0) { b.pierce--; } else { dead = true; }
          break;
        }
      }
    }
    if (dead) g.bullets.splice(i, 1);
  }

  // --- 僵尸 ---
  for (let i = g.zombies.length - 1; i >= 0; i--) {
    const z = g.zombies[i];
    if (z.hitT > 0) z.hitT -= dt;
    z.wob += dt * 6;
    if (z.hp <= 0) {
      p.kills++;
      burst(g, z.x, z.y, z.color, 14, 160);
      // 精英/坦克必掉, 普通小概率掉
      const zd = ZTYPES[z.type];
      if (zd.value > 0) dropLoot(g, z.x, z.y, z.type === 'elite' ? 2 : 1, 1);
      else if (Math.random() < 0.06) dropLoot(g, z.x, z.y, 0, 1);
      g.zombies.splice(i, 1);
      continue;
    }
    const a = Math.atan2(p.y - z.y, p.x - z.x);
    z.x += Math.cos(a) * z.speed * dt;
    z.y += Math.sin(a) * z.speed * dt;
    // 简单分离, 避免重叠成一团
    for (const o of g.zombies) {
      if (o === z) continue;
      const d2 = dist2(z, o), min = (z.r + o.r) * 0.8;
      if (d2 < min * min && d2 > 0.01) {
        const d = Math.sqrt(d2), push = (min - d) / 2;
        const nx = (z.x - o.x) / d, ny = (z.y - o.y) / d;
        z.x += nx * push; z.y += ny * push;
      }
    }
    // 碰到玩家
    const rr = (z.r + p.r) * (z.r + p.r);
    if (dist2(z, p) < rr) {
      p.hp -= z.dmg * dt * 2.2;
      p.hurtFlash = 0.15;
      if (Math.random() < dt * 6) { sfx.hurt(); shake = 6; }
    }
  }
  if (p.hurtFlash > 0) p.hurtFlash -= dt;

  // --- 死亡判定 ---
  if (p.hp <= 0) {
    p.hp = 0;
    state = 'dead';
    warehouse.raids++;
    saveWarehouse(warehouse);
    sfx.dead();
    shake = 14;
    return;
  }

  // --- 自动搜索物资箱 (搜打撤核心) ---
  let searching = null;
  for (const c of g.crates) {
    if (c.opened) continue;
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < c.r + p.r + 26) {
      searching = c;
      c.progress += dt;   // 站在旁边自动搜索, 移动不打断但只搜最近的
      if (c.progress >= c.searchTime) {
        c.opened = true;
        burst(g, c.x, c.y, '#ffe9a3', 16, 150);
        if (c.kind === 'arms') {
          applyUpgrade(g);
        } else {
          const maxTier = c.kind === 'high' ? 3 : 1;
          dropLoot(g, c.x, c.y, maxTier, c.kind === 'high' ? rand(2, 4) | 0 || 2 : 1 + (Math.random() < 0.4 ? 1 : 0));
          sfx.loot();
        }
      }
      break;  // 一次只搜一个
    }
  }
  g.searching = searching;

  // --- 拾取地面战利品 ---
  for (let i = g.drops.length - 1; i >= 0; i--) {
    const d = g.drops[i];
    d.t += dt;
    // 轻微吸附
    const dd = Math.hypot(d.x - p.x, d.y - p.y);
    if (dd < 90) {
      const k = (1 - dd / 90) * 260 * dt;
      d.x += (p.x - d.x) / dd * k; d.y += (p.y - d.y) / dd * k;
    }
    if (dd < p.r + d.r + 4) {
      p.loot.push(d.item);
      p.lootValue += d.item.value;
      floatText(g, p.x, p.y - 30, '+' + d.item.name + ' ¥' + d.item.value, TIER_COLOR[d.item.tier], 14);
      if (d.item.tier >= 2) sfx.rare(); else sfx.loot();
      g.drops.splice(i, 1);
    }
  }

  // --- 撤离判定 ---
  const ex = g.extract;
  const inZone = Math.hypot(p.x - ex.x, p.y - ex.y) < ex.r;
  if (inZone) {
    ex.hold += dt;
    if (ex.hold >= EXTRACT_HOLD) {
      state = 'extracted';
      warehouse.raids++;
      warehouse.extracts++;
      warehouse.value += p.lootValue;
      saveWarehouse(warehouse);
      sfx.extract();
      return;
    }
  } else {
    ex.hold = Math.max(0, ex.hold - dt * 2);
  }

  // --- 粒子 / 飘字 ---
  for (let i = g.parts.length - 1; i >= 0; i--) {
    const pt = g.parts[i];
    pt.x += pt.vx * dt; pt.y += pt.vy * dt;
    pt.vx *= 0.92; pt.vy *= 0.92;
    pt.life -= dt;
    if (pt.life <= 0) g.parts.splice(i, 1);
  }
  for (let i = g.floats.length - 1; i >= 0; i--) {
    const f = g.floats[i];
    f.y -= 36 * dt; f.life -= dt * 0.9;
    if (f.life <= 0) g.floats.splice(i, 1);
  }

  // --- 相机 ---
  g.cam.x = clamp(p.x - VW / 2, 0, MAP_W - VW);
  g.cam.y = clamp(p.y - VH / 2, 0, MAP_H - VH);
  if (MAP_W < VW) g.cam.x = (MAP_W - VW) / 2;
  if (MAP_H < VH) g.cam.y = (MAP_H - VH) / 2;
  if (shake > 0) shake = Math.max(0, shake - dt * 30);
}

// ---------- 渲染 ----------
function draw() {
  ctx.clearRect(0, 0, VW, VH);
  if (state === 'menu') { drawMenu(); return; }
  const g = game, p = g.player;

  ctx.save();
  const sx = shake > 0 ? rand(-shake, shake) : 0;
  const sy = shake > 0 ? rand(-shake, shake) : 0;
  ctx.translate(-g.cam.x + sx, -g.cam.y + sy);

  drawWorld(g);
  drawExtract(g);
  drawCrates(g);
  drawDrops(g);
  drawZombies(g);
  drawBullets(g);
  drawPlayer(g);
  drawParticles(g);
  drawFloats(g);

  ctx.restore();

  drawHUD(g);
  if (state === 'extracted') drawEnd(true);
  if (state === 'dead') drawEnd(false);
}

function drawWorld(g) {
  // 地面
  ctx.fillStyle = '#11161c';
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  const grid = 130;
  const x0 = Math.floor(g.cam.x / grid) * grid, x1 = g.cam.x + VW;
  const y0 = Math.floor(g.cam.y / grid) * grid, y1 = g.cam.y + VH;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += grid) { ctx.moveTo(x, g.cam.y); ctx.lineTo(x, y1); }
  for (let y = y0; y <= y1; y += grid) { ctx.moveTo(g.cam.x, y); ctx.lineTo(x1, y); }
  ctx.stroke();
  // 装饰物
  for (const pr of g.props) {
    if (pr.x < g.cam.x - 50 || pr.x > g.cam.x + VW + 50 || pr.y < g.cam.y - 50 || pr.y > g.cam.y + VH + 50) continue;
    if (pr.k === 0) { // 草丛
      ctx.fillStyle = 'rgba(70,110,70,0.25)';
      ctx.beginPath(); ctx.arc(pr.x, pr.y, pr.s, 0, 6.29); ctx.fill();
    } else { // 残骸
      ctx.fillStyle = 'rgba(90,85,75,0.3)';
      ctx.fillRect(pr.x - pr.s / 2, pr.y - pr.s / 3, pr.s, pr.s / 1.5);
    }
  }
  // 地图边界
  ctx.strokeStyle = 'rgba(255,80,80,0.5)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, MAP_W - 4, MAP_H - 4);
}

function drawExtract(g) {
  const ex = g.extract;
  const pulse = 1 + Math.sin(g.t * 3) * 0.04;
  ctx.save();
  ctx.translate(ex.x, ex.y);
  ctx.strokeStyle = '#39e6a3';
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 10]);
  ctx.beginPath(); ctx.arc(0, 0, ex.r * pulse, 0, 6.29); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(57,230,163,0.08)';
  ctx.beginPath(); ctx.arc(0, 0, ex.r, 0, 6.29); ctx.fill();
  // 撤离进度环
  if (ex.hold > 0) {
    ctx.strokeStyle = '#39e6a3';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, ex.r * 0.6, -Math.PI / 2, -Math.PI / 2 + (ex.hold / EXTRACT_HOLD) * Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#39e6a3';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('撤 离 点', 0, 6);
  ctx.restore();
}

function drawCrates(g) {
  for (const c of g.crates) {
    if (c.x < g.cam.x - 60 || c.x > g.cam.x + VW + 60 || c.y < g.cam.y - 60 || c.y > g.cam.y + VH + 60) continue;
    ctx.save();
    ctx.translate(c.x, c.y);
    const col = c.kind === 'arms' ? '#7df0c0' : c.kind === 'high' ? '#ffb020' : '#b08d57';
    if (c.opened) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#555';
      ctx.fillRect(-c.r, -c.r * 0.7, c.r * 2, c.r * 1.4);
    } else {
      ctx.fillStyle = '#2a2f38';
      ctx.fillRect(-c.r, -c.r * 0.7, c.r * 2, c.r * 1.4);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(-c.r, -c.r * 0.7, c.r * 2, c.r * 1.4);
      ctx.fillStyle = col;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(c.kind === 'arms' ? '军备' : c.kind === 'high' ? '高级' : '物资', 0, 5);
      // 搜索进度
      if (c.progress > 0 && c.progress < c.searchTime) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(-26, -c.r - 16, 52, 8);
        ctx.fillStyle = '#ffe9a3';
        ctx.fillRect(-25, -c.r - 15, 50 * (c.progress / c.searchTime), 6);
      }
    }
    ctx.restore();
  }
}

function drawDrops(g) {
  for (const d of g.drops) {
    const bob = Math.sin(d.t * 4) * 3;
    ctx.save();
    ctx.translate(d.x, d.y + bob);
    const col = TIER_COLOR[d.item.tier];
    // 光圈
    ctx.fillStyle = col + '33';
    ctx.beginPath(); ctx.arc(0, 0, d.r + 6, 0, 6.29); ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, -d.r); ctx.lineTo(d.r, 0); ctx.lineTo(0, d.r); ctx.lineTo(-d.r, 0);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#11161c';
    ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('¥', 0, 3.5);
    ctx.restore();
  }
}

function drawZombies(g) {
  for (const z of g.zombies) {
    if (z.x < g.cam.x - 60 || z.x > g.cam.x + VW + 60 || z.y < g.cam.y - 60 || z.y > g.cam.y + VH + 60) continue;
    ctx.save();
    ctx.translate(z.x, z.y);
    const wob = Math.sin(z.wob) * 0.12;
    ctx.rotate(wob);
    // 身体
    ctx.fillStyle = z.hitT > 0 ? '#ffffff' : z.color;
    ctx.beginPath(); ctx.arc(0, 0, z.r, 0, 6.29); ctx.fill();
    // 手臂(伸向玩家)
    const a = Math.atan2(g.player.y - z.y, g.player.x - z.x) - wob;
    ctx.strokeStyle = z.hitT > 0 ? '#fff' : z.color;
    ctx.lineWidth = z.r * 0.35;
    ctx.lineCap = 'round';
    for (const s of [-0.5, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(Math.cos(a + s) * z.r * 0.7, Math.sin(a + s) * z.r * 0.7);
      ctx.lineTo(Math.cos(a + s * 0.4) * z.r * 1.6, Math.sin(a + s * 0.4) * z.r * 1.6);
      ctx.stroke();
    }
    // 眼睛
    ctx.fillStyle = z.type === 'elite' ? '#ff5af0' : '#d33';
    ctx.beginPath();
    ctx.arc(Math.cos(a - 0.35) * z.r * 0.5, Math.sin(a - 0.35) * z.r * 0.5, z.r * 0.16, 0, 6.29);
    ctx.arc(Math.cos(a + 0.35) * z.r * 0.5, Math.sin(a + 0.35) * z.r * 0.5, z.r * 0.16, 0, 6.29);
    ctx.fill();
    ctx.restore();
    // 血条
    if (z.hp < z.maxHp) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(z.x - z.r, z.y - z.r - 10, z.r * 2, 5);
      ctx.fillStyle = '#e84545';
      ctx.fillRect(z.x - z.r, z.y - z.r - 10, z.r * 2 * (z.hp / z.maxHp), 5);
    }
  }
}

function drawBullets(g) {
  ctx.fillStyle = '#ffd86b';
  for (const b of g.bullets) {
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.29); ctx.fill();
    ctx.fillStyle = 'rgba(255,216,107,0.35)';
    ctx.beginPath(); ctx.arc(b.x - b.vx * 0.012, b.y - b.vy * 0.012, b.r * 0.8, 0, 6.29); ctx.fill();
    ctx.fillStyle = '#ffd86b';
  }
}

function drawPlayer(g) {
  const p = g.player;
  ctx.save();
  ctx.translate(p.x, p.y);
  // 射程圈(淡)
  ctx.strokeStyle = 'rgba(120,180,255,0.10)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, p.range, 0, 6.29); ctx.stroke();
  // 身体
  ctx.fillStyle = p.hurtFlash > 0 ? '#ff7b7b' : '#4f8edb';
  ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 6.29); ctx.fill();
  ctx.strokeStyle = '#bcd9ff'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 6.29); ctx.stroke();
  // 炮管
  ctx.rotate(p.angle);
  ctx.fillStyle = '#2c3e50';
  const n = p.barrels;
  for (let i = 0; i < n; i++) {
    const off = n === 1 ? 0 : (i - (n - 1) / 2) * 8;
    ctx.fillRect(4, -3.5 + off, 26, 7);
  }
  ctx.restore();
  // 搜索提示
  if (g.searching) {
    ctx.fillStyle = '#ffe9a3';
    ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('搜索中...', p.x, p.y - p.r - 14);
  }
}

function drawParticles(g) {
  for (const pt of g.parts) {
    ctx.globalAlpha = clamp(pt.life * 2.5, 0, 1);
    ctx.fillStyle = pt.color;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r, 0, 6.29); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawFloats(g) {
  ctx.textAlign = 'center';
  for (const f of g.floats) {
    ctx.globalAlpha = clamp(f.life, 0, 1);
    ctx.font = 'bold ' + f.size + 'px sans-serif';
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

// ---------- HUD ----------
function drawHUD(g) {
  const p = g.player;
  // 血条
  const bw = Math.min(280, VW * 0.4);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(14, 14, bw + 4, 22, 6); ctx.fill();
  ctx.fillStyle = p.hp / p.maxHp > 0.35 ? '#46d369' : '#e84545';
  roundRect(16, 16, bw * clamp(p.hp / p.maxHp, 0, 1), 18, 5); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('HP ' + Math.ceil(p.hp) + '/' + p.maxHp, 22, 30);

  // 战利品价值 & 击杀
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(14, 42, 190, 52, 6); ctx.fill();
  ctx.fillStyle = '#ffd86b';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText('💰 战利品 ¥' + p.lootValue + ' (' + p.loot.length + '件)', 22, 62);
  ctx.fillStyle = '#aef';
  ctx.font = '13px sans-serif';
  ctx.fillText('☠ 击杀 ' + p.kills, 22, 84);

  // 倒计时
  const remain = Math.max(0, RAID_TIME - g.t);
  const mm = String(Math.floor(remain / 60)).padStart(1, '0');
  const ss = String(Math.floor(remain % 60)).padStart(2, '0');
  ctx.textAlign = 'center';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillStyle = g.storm ? '#ff5555' : remain < 30 ? '#ffb020' : '#fff';
  ctx.fillText(g.storm ? '尸潮风暴' : mm + ':' + ss, VW / 2, 36);

  // 撤离方向指示箭头
  const ex = g.extract;
  const da = Math.atan2(ex.y - p.y, ex.x - p.x);
  const dd = Math.hypot(ex.x - p.x, ex.y - p.y);
  if (dd > ex.r) {
    ctx.save();
    ctx.translate(VW / 2, 64);
    ctx.rotate(da);
    ctx.fillStyle = '#39e6a3';
    ctx.beginPath();
    ctx.moveTo(14, 0); ctx.lineTo(-8, -8); ctx.lineTo(-4, 0); ctx.lineTo(-8, 8);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#39e6a3';
    ctx.font = '12px sans-serif';
    ctx.fillText('撤离点 ' + Math.round(dd / 10) + 'm', VW / 2, 88);
  }

  // 撤离进度提示
  if (ex.hold > 0 && state === 'playing') {
    ctx.fillStyle = '#39e6a3';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('撤离中 ' + (EXTRACT_HOLD - ex.hold).toFixed(1) + 's — 坚持住!', VW / 2, VH * 0.32);
  }

  // 小地图
  const ms = Math.min(150, VW * 0.25), mx = VW - ms - 14, my = 14;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  roundRect(mx, my, ms, ms, 6); ctx.fill();
  const kx = ms / MAP_W, ky = ms / MAP_H;
  for (const c of g.crates) {
    if (c.opened) continue;
    ctx.fillStyle = c.kind === 'arms' ? '#7df0c0' : c.kind === 'high' ? '#ffb020' : '#b08d57';
    ctx.fillRect(mx + c.x * kx - 1.5, my + c.y * ky - 1.5, 3, 3);
  }
  ctx.fillStyle = '#39e6a3';
  ctx.beginPath(); ctx.arc(mx + ex.x * kx, my + ex.y * ky, 4, 0, 6.29); ctx.fill();
  ctx.fillStyle = '#4f8edb';
  ctx.beginPath(); ctx.arc(mx + p.x * kx, my + p.y * ky, 3.5, 0, 6.29); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.strokeRect(mx, my, ms, ms);

  // 中央消息
  if (g.msg && g.msgT > 0) {
    ctx.globalAlpha = clamp(g.msgT, 0, 1);
    ctx.fillStyle = g.msg.color;
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(g.msg.text, VW / 2, VH * 0.22);
    ctx.globalAlpha = 1;
  }

  // 虚拟摇杆
  if (joy.active) {
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(joy.ox, joy.oy, 60, 0, 6.29); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.arc(joy.ox + joy.dx, joy.oy + joy.dy, 26, 0, 6.29); ctx.fill();
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- 菜单 / 结算 ----------
function drawMenu() {
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, VW, VH);
  // 背景装饰僵尸眼睛
  const t = performance.now() / 1000;
  for (let i = 0; i < 8; i++) {
    const x = (Math.sin(i * 13.7) * 0.5 + 0.5) * VW;
    const y = (Math.sin(i * 7.3 + t * 0.2) * 0.5 + 0.5) * VH;
    ctx.fillStyle = 'rgba(95,176,79,0.08)';
    ctx.beginPath(); ctx.arc(x, y, 40 + Math.sin(t + i) * 8, 0, 6.29); ctx.fill();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#39e6a3';
  ctx.font = 'bold ' + Math.min(52, VW * 0.09) + 'px sans-serif';
  ctx.fillText('僵 尸 搜 打 撤', VW / 2, VH * 0.26);
  ctx.fillStyle = '#9aa5b1';
  ctx.font = Math.min(16, VW * 0.035) + 'px sans-serif';
  ctx.fillText('向僵尸开炮 × 三角洲搜打撤 — 玩法融合 DEMO', VW / 2, VH * 0.32);

  ctx.fillStyle = '#cfd8e3';
  ctx.font = Math.min(15, VW * 0.032) + 'px sans-serif';
  const lines = [
    '🎯 火炮自动索敌开火 — 你只管走位',
    '📦 靠近物资箱自动搜索,军备箱可升级火力',
    '🏃 收集战利品后前往绿色撤离点,站立 5 秒撤离',
    '💀 阵亡 = 失去本局全部战利品;撤离成功才能入库',
    '⏱ 3 分钟后尸潮风暴来袭,贪欲还是保命?',
    '',
    '操作: WASD / 方向键移动 (手机: 触屏摇杆)',
  ];
  lines.forEach((l, i) => ctx.fillText(l, VW / 2, VH * 0.42 + i * Math.min(26, VH * 0.04)));

  ctx.fillStyle = '#ffd86b';
  ctx.font = 'bold ' + Math.min(16, VW * 0.035) + 'px sans-serif';
  ctx.fillText('🏦 仓库总资产 ¥' + warehouse.value + ' | 出击 ' + warehouse.raids + ' 次 | 成功撤离 ' + warehouse.extracts + ' 次', VW / 2, VH * 0.74);

  const blink = Math.sin(performance.now() / 300) > -0.2;
  if (blink) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.min(20, VW * 0.045) + 'px sans-serif';
    ctx.fillText('— 点击屏幕 / 按空格 开始行动 —', VW / 2, VH * 0.85);
  }
}

function drawEnd(success) {
  const g = game, p = g.player;
  ctx.fillStyle = 'rgba(5,7,10,0.82)';
  ctx.fillRect(0, 0, VW, VH);
  ctx.textAlign = 'center';
  if (success) {
    ctx.fillStyle = '#39e6a3';
    ctx.font = 'bold ' + Math.min(46, VW * 0.085) + 'px sans-serif';
    ctx.fillText('✅ 撤 离 成 功', VW / 2, VH * 0.24);
    ctx.fillStyle = '#ffd86b';
    ctx.font = 'bold ' + Math.min(22, VW * 0.05) + 'px sans-serif';
    ctx.fillText('战利品入库 ¥' + p.lootValue, VW / 2, VH * 0.32);
  } else {
    ctx.fillStyle = '#e84545';
    ctx.font = 'bold ' + Math.min(46, VW * 0.085) + 'px sans-serif';
    ctx.fillText('💀 行 动 失 败', VW / 2, VH * 0.24);
    ctx.fillStyle = '#9aa5b1';
    ctx.font = Math.min(18, VW * 0.04) + 'px sans-serif';
    ctx.fillText('你阵亡了,本局 ¥' + p.lootValue + ' 战利品全部丢失…', VW / 2, VH * 0.32);
  }
  // 战利品清单
  ctx.font = Math.min(14, VW * 0.032) + 'px sans-serif';
  const summary = {};
  for (const it of p.loot) {
    summary[it.name] = summary[it.name] || { n: 0, tier: it.tier, v: 0 };
    summary[it.name].n++; summary[it.name].v += it.value;
  }
  const names = Object.keys(summary).slice(0, 8);
  names.forEach((nm, i) => {
    const s = summary[nm];
    ctx.fillStyle = TIER_COLOR[s.tier];
    ctx.fillText('[' + TIER_NAME[s.tier] + '] ' + nm + ' ×' + s.n + '  ¥' + s.v, VW / 2, VH * 0.42 + i * 24);
  });
  if (names.length === 0) {
    ctx.fillStyle = '#666';
    ctx.fillText('(两手空空)', VW / 2, VH * 0.44);
  }

  ctx.fillStyle = '#aef';
  ctx.font = Math.min(15, VW * 0.034) + 'px sans-serif';
  ctx.fillText('击杀 ' + p.kills + ' | 存活 ' + Math.floor(g.t) + 's | 仓库总资产 ¥' + warehouse.value, VW / 2, VH * 0.72);

  const blink = Math.sin(performance.now() / 300) > -0.2;
  if (blink) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.min(18, VW * 0.04) + 'px sans-serif';
    ctx.fillText('— 点击屏幕 / 按空格 再次出击 —', VW / 2, VH * 0.84);
  }
}

// ---------- 主循环 ----------
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
