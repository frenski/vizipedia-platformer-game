/* ═══════════════════════════════════════════════════════════════
   PlatformerJS — game.js
   All game logic. Loaded after game.json is fetched.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const getLocHash = function () {

    if (location.hash.length < 2) return {};
    var hash = {};
    var hashParts = location.hash.substr(1).split("&");
    for (var i = 0; i < hashParts.length; i++) {
        var kv = hashParts[i];
        if (kv.match(/^(.+?)=(\d+)$/))
            hash[RegExp.$1] = parseInt(RegExp.$2);
        else if (kv.match(/^(.+?)=(\d+\.\d+)$/))
            hash[RegExp.$1] = parseFloat(RegExp.$2);
        else if (kv.match(/^(.+?)=(.*)$/))
            hash[RegExp.$1] = decodeURIComponent(RegExp.$2);
        else
            hash[RegExp.$1] = RegExp.$2;
    }

    return hash;
};

const locHash = getLocHash()
const gameId = (typeof GAME_ID !== 'undefined') ? GAME_ID : locHash.id;

/* ── Config (filled from JSON) ── */
let CFG        = {};   // config block
let REWARDS    = {};   // rewards definitions
let ENEMY_DEFS = {};   // enemy definitions
let PLAYER_DEF = {};   // player definition
let LEVELS     = [];   // level array

const GAME_W = 800;
const GAME_H = 450;

/* ── DOM refs ── */
const canvas  = document.getElementById('gameCanvas');
const overlay = document.getElementById('overlay');
const stage   = document.getElementById('stage');
const ctx     = canvas.getContext('2d');

/* ── Canvas init: set ONCE, never change ── */
canvas.width  = GAME_W;
canvas.height = GAME_H;
overlay.style.width  = GAME_W + 'px';
overlay.style.height = GAME_H + 'px';

function scaleToStage() {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const scale = Math.min(sw / GAME_W, sh / GAME_H);
  const ox = Math.floor((sw - GAME_W * scale) / 2);
  const oy = Math.floor((sh - GAME_H * scale) / 2);
  const tf = `translate(${ox}px,${oy}px) scale(${scale})`;
  canvas.style.transform  = tf;
  overlay.style.transform = tf;
}
scaleToStage();
new ResizeObserver(scaleToStage).observe(stage);

/* ═══════════════════════════════════════════════════
   LIBRARY CLASSES
   ═══════════════════════════════════════════════════ */

/* ── Emitter ── */
class Emitter {
  constructor() { this._h = {}; }
  on(e, fn) { (this._h[e] = this._h[e] || []).push(fn); return this; }
  emit(e, d) { (this._h[e] || []).forEach(fn => fn(d)); }
}

/* ── Camera ── */
class Camera {
  constructor() { this.x = 0; this.y = 0; }
  follow(tx, ty, mw, mh) {
    this.x += (tx - GAME_W / 2 - this.x) * 0.1;
    this.y += (ty - GAME_H / 2 - this.y) * 0.1;
    this.x = Math.max(0, Math.min(this.x, mw - GAME_W));
    this.y = Math.max(0, Math.min(this.y, mh - GAME_H));
  }
  reset() { this.x = 0; this.y = 0; }
}

/* ── TileMap ── */
class TileMap {
  constructor(data, ts, colors) {
    this.data = data; this.ts = ts || 32;
    this.rows = data.length; this.cols = data[0].length;
    this.width = this.cols * this.ts; this.height = this.rows * this.ts;
    this.color1 = (colors && colors[0]) || '#2e3a6e';
    this.color2 = (colors && colors[1]) || '#1a2448';
  }
  get(c, r) {
    return (r >= 0 && r < this.rows && c >= 0 && c < this.cols) ? this.data[r][c] : 1;
  }
  solidsFor(x, y, w, h) {
    const ts = this.ts, out = [];
    for (let r = Math.floor(y / ts); r <= Math.floor((y + h - 1) / ts); r++)
      for (let c = Math.floor(x / ts); c <= Math.floor((x + w - 1) / ts); c++)
        if (this.get(c, r)) out.push({ x: c * ts, y: r * ts, w: ts, h: ts });
    return out;
  }
  draw(ctx, cam) {
    const ts = this.ts;
    const c0 = Math.max(0, Math.floor(cam.x / ts));
    const c1 = Math.min(this.cols - 1, Math.ceil((cam.x + GAME_W) / ts));
    const r0 = Math.max(0, Math.floor(cam.y / ts));
    const r1 = Math.min(this.rows - 1, Math.ceil((cam.y + GAME_H) / ts));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!this.get(c, r)) continue;
        const wx = Math.round(c * ts - cam.x), wy = Math.round(r * ts - cam.y);
        const g = ctx.createLinearGradient(wx, wy, wx, wy + ts);
        g.addColorStop(0, this.color1); g.addColorStop(1, this.color2);
        ctx.fillStyle = g; ctx.fillRect(wx, wy, ts, ts);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(wx, wy, ts, 2);
        ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(wx, wy + ts - 2, ts, 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.strokeRect(wx + .5, wy + .5, ts - 1, ts - 1);
      }
    }
  }
}

/* ── Entity base ── */
class Entity {
  constructor(o) {
    o = o || {};
    this.id = Math.random().toString(36).slice(2);
    this.type = o.type || 'entity';
    this.x = o.x || 0; this.y = o.y || 0;
    this.w = o.w || 32; this.h = o.h || 32;
    this.vx = 0; this.vy = 0;
    this.alive = true; this.onGround = false;
  }
  update() {} draw() {}
}

/* ── Physics helpers ── */
function moveX(e, map) {
  for (const t of map.solidsFor(e.x, e.y, e.w, e.h)) {
    if (e.vx > 0 && e.x + e.w > t.x && e.x < t.x) { e.x = t.x - e.w; e.vx = 0; }
    else if (e.vx < 0 && e.x < t.x + t.w && e.x + e.w > t.x + t.w) { e.x = t.x + t.w; e.vx = 0; }
  }
}
function moveY(e, map) {
  for (const t of map.solidsFor(e.x, e.y, e.w, e.h)) {
    if (e.vy >= 0 && e.y + e.h > t.y && e.y < t.y) { e.y = t.y - e.h; e.vy = 0; e.onGround = true; }
    else if (e.vy < 0 && e.y < t.y + t.h && e.y + e.h > t.y + t.h) { e.y = t.y + t.h; e.vy = 0; }
  }
}

/* ── Player ── */
class Player extends Entity {
  constructor(o) {
    const pd = PLAYER_DEF;
    super(Object.assign({ type: 'player', w: pd.width || 26, h: pd.height || 34 }, o));
    this.speed      = pd.speed      || 185;
    this.jumpForce  = pd.jumpForce  || -490;
    this.gravity    = CFG.gravity   || 960;
    this.coyoteMax  = pd.coyoteTime      || 0.1;
    this.jbufMax    = pd.jumpBufferTime  || 0.12;
    this.invMax     = pd.invincibleDuration || 2;
    this.facing = 1; this.coyote = 0; this.jbuf = 0;
    this.frame = 0; this.ftimer = 0; this.invincible = 0;
    this.trail = [];
    this.c1 = pd.colorBody1 || '#7fff6e';
    this.c2 = pd.colorBody2 || '#3fc23a';
    this.cv = pd.colorVisor || '#0a2a3a';
    this.ce = pd.colorEye   || '#00e5ff';
  }
  update(dt, g) {
    const k = g.input;
    this.coyote -= dt; this.jbuf -= dt;
    if (k.jumpPressed) { this.jbuf = this.jbufMax; k.jumpPressed = false; }
    this.vx = (k.left ? -1 : k.right ? 1 : 0) * this.speed;
    if (k.left)  this.facing = -1;
    if (k.right) this.facing =  1;
    if (this.jbuf > 0 && (this.onGround || this.coyote > 0)) {
      this.vy = this.jumpForce; this.jbuf = -1; this.coyote = -1; this.onGround = false;
      g.emit('jump'); addLog('↑ Jump', 'good');
    }
    this.vy = Math.min(this.vy + this.gravity * dt, CFG.maxFallSpeed || 600);
    this.x += this.vx * dt; moveX(this, g.map);
    this.y += this.vy * dt;
    const wasG = this.onGround; this.onGround = false;
    moveY(this, g.map);
    if (this.onGround && !wasG) g.emit('land');
    if (this.onGround) this.coyote = this.coyoteMax;
    this.x = Math.max(0, Math.min(this.x, g.map.width - this.w));
    if (this.y > g.map.height + 100) g.emit('playerDied');
    this.ftimer += dt; if (this.ftimer > 0.1) { this.ftimer = 0; this.frame = (this.frame + 1) % 4; }
    if (this.invincible > 0) this.invincible -= dt;
    this.trail.push({ x: this.x + this.w / 2, y: this.y + this.h / 2, a: 0.25 });
    this.trail = this.trail.map(p => ({ ...p, a: p.a - dt * (PLAYER_DEF.trailFade || 1.5) })).filter(p => p.a > 0);
  }
  draw(ctx, cam, dbg) {
    const sx = Math.round(this.x - cam.x), sy = Math.round(this.y - cam.y);
    for (const p of this.trail) {
      ctx.beginPath();
      ctx.arc(Math.round(p.x - cam.x), Math.round(p.y - cam.y), 5 * (p.a / 0.25), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(127,255,110,${p.a * 0.4})`; ctx.fill();
    }
    if (this.invincible > 0 && Math.floor(this.invincible * 10) % 2 === 0) return;
    const cx = sx + this.w / 2, cy = sy + this.h / 2;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(this.facing, 1);
    ctx.beginPath(); ctx.ellipse(0, 19, 9, 3, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();
    const bg = ctx.createLinearGradient(-13, -17, 13, 17);
    bg.addColorStop(0, this.c1); bg.addColorStop(1, this.c2);
    ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(-13, -17, 26, 34, 6); ctx.fill();
    ctx.fillStyle = this.cv; ctx.beginPath(); ctx.roundRect(1, -12, 11, 9, 3); ctx.fill();
    ctx.fillStyle = this.ce; ctx.beginPath(); ctx.arc(7, -8, 2.5, 0, Math.PI * 2); ctx.fill();
    const lo = this.onGround ? Math.sin(this.frame * 1.57) * 4 : 0;
    ctx.fillStyle = this.c2;
    ctx.fillRect(-9, 11, 6, 6 + lo); ctx.fillRect(3, 11, 6, 6 - lo);
    ctx.restore();
    if (dbg) { ctx.strokeStyle = 'rgba(127,255,110,0.6)'; ctx.strokeRect(sx, sy, this.w, this.h); }
  }
}

/* ── Reward (Coin / Star / etc) ── */
class Reward extends Entity {
  constructor(o, def) {
    super(Object.assign({ type: 'reward', w: 18, h: 18 }, o));
    this.def = def;
    this.rewardKey = o.reward;
    this.points = def.points || 10;
    this.angle  = Math.random() * Math.PI * 2;
    this.baseY  = this.y;
    this.collected = false;
  }
  update(dt) {
    this.angle += dt * (this.def.floatSpeed || 3);
    this.y = this.baseY + Math.sin(this.angle) * (this.def.floatAmplitude || 4);
  }
  draw(ctx, cam) {
    if (this.collected) return;
    const sx = Math.round(this.x - cam.x) + 9, sy = Math.round(this.y - cam.y) + 9;
    // glow
    const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, 13);
    gr.addColorStop(0, this.def.glowColor || 'rgba(255,215,0,0.25)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(sx, sy, 13, 0, Math.PI * 2); ctx.fill();

    if (this.rewardKey === 'star') {
      // Draw star shape
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(this.angle * 0.5);
      ctx.fillStyle = this.def.color || '#c0c0ff';
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
        const b = ((i * 4 + 2) * Math.PI) / 5 - Math.PI / 2;
        (i === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, Math.cos(a) * 9, Math.sin(a) * 9);
        ctx.lineTo(Math.cos(b) * 4, Math.sin(b) * 4);
      }
      ctx.closePath(); ctx.fill();
      ctx.restore();
    } else {
      // Default: spinning coin
      ctx.save(); ctx.translate(sx, sy); ctx.scale(Math.abs(Math.cos(this.angle)), 1);
      const cg = ctx.createLinearGradient(-9, -9, 9, 9);
      cg.addColorStop(0, '#ffe566'); cg.addColorStop(0.5, '#ffd700'); cg.addColorStop(1, '#b8860b');
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.arc(-2, -2, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
}

/* ── Enemy ── */
class Enemy extends Entity {
  constructor(o, def) {
    def = def || ENEMY_DEFS['patrol'] || {};
    super(Object.assign({ type: 'enemy', w: def.width || 28, h: def.height || 28 }, o));
    this.speed  = o.speed  || def.defaultSpeed || 70;
    this.dir    = 1;
    this.pl     = o.patrolLeft  || this.x - 80;
    this.pr     = o.patrolRight || this.x + 80;
    this.ci     = def.colorInner || '#ff6eb4';
    this.co     = def.colorOuter || '#aa1155';
    this.damage = def.damageToPlayer || 1;
  }
  update(dt, g) {
    this.x += this.speed * this.dir * dt;
    if (this.x <= this.pl) { this.x = this.pl; this.dir = 1; }
    if (this.x >= this.pr) { this.x = this.pr; this.dir = -1; }
    this.vy = Math.min((this.vy || 0) + (CFG.gravity || 960) * dt, CFG.maxFallSpeed || 600);
    this.y += this.vy * dt; moveY(this, g.map);
    if (this.y > g.map.height + 100) this.alive = false;
  }
  draw(ctx, cam) {
    const sx = Math.round(this.x - cam.x) + 14, sy = Math.round(this.y - cam.y) + 14;
    ctx.save(); ctx.translate(sx, sy); ctx.scale(this.dir, 1);
    const eg = ctx.createRadialGradient(0, 0, 2, 0, 0, 14);
    eg.addColorStop(0, this.ci); eg.addColorStop(1, this.co);
    ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'white'; ctx.beginPath(); ctx.arc(5, -2, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(6, -2, 2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(2, -8); ctx.lineTo(9, -5); ctx.stroke();
    ctx.restore();
  }
}

/* ── Flag ── */
class Flag extends Entity {
  constructor(o) { super(Object.assign({ type: 'flag', w: 24, h: 64 }, o)); this.wave = 0; }
  update(dt) { this.wave += dt * 2; }
  draw(ctx, cam) {
    const sx = Math.round(this.x - cam.x), sy = Math.round(this.y - cam.y);
    ctx.fillStyle = '#aaa'; ctx.fillRect(sx + 2, sy, 4, this.h);
    ctx.beginPath(); ctx.moveTo(sx + 6, sy + 4);
    for (let i = 0; i <= 8; i++) ctx.lineTo(sx + 6 + i * 2.5, sy + 4 + Math.sin(this.wave + i * 0.5) * 4 + i * 3);
    ctx.lineTo(sx + 6, sy + 28); ctx.closePath();
    ctx.fillStyle = '#7fff6e'; ctx.fill();
    ctx.font = '14px serif'; ctx.fillStyle = '#ffe566'; ctx.fillText('★', sx - 1, sy + 2);
  }
}

/* ── Particles ── */
class Particles {
  constructor() { this.list = []; }
  burst(x, y, color, n) {
    n = n || 10;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 160;
      this.list.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, r: 2 + Math.random() * 4, life: 0.7 + Math.random() * 0.3, color });
    }
  }
  update(dt) {
    this.list = this.list.map(p => ({ ...p, x: p.x + p.vx * dt, y: p.y + p.vy * dt, vy: p.vy + 300 * dt, life: p.life - dt })).filter(p => p.life > 0);
  }
  draw(ctx, cam) {
    for (const p of this.list) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color || '#fff';
      ctx.beginPath(); ctx.arc(Math.round(p.x - cam.x), Math.round(p.y - cam.y), p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/* ═══════════════════════════════════════════════════
   PlatformerGame — Core Engine
   ═══════════════════════════════════════════════════ */
class PlatformerGame extends Emitter {
  constructor() {
    super();
    this.ctx = ctx;
    this.running = false; this.paused = false; this.debug = false;
    this.entities  = []; this.particles = new Particles();
    this.camera    = new Camera(); this.map = null;
    this.input     = { left: false, right: false, jump: false, jumpPressed: false };
    this.score     = 0; this.lives = CFG.startingLives || 3;
    this.coins     = 0; this.totalCoins = 0;
    this._lastTs   = 0; this._fps = []; this._rafId = null; this._stars = null;
    this._skyTop   = '#070714'; this._skyBot = '#0e0e2a';
    this._bindKeys();
  }
  setSky(top, bot) { this._skyTop = top || '#070714'; this._skyBot = bot || '#0e0e2a'; this._stars = null; }
  loadMap(data, colors) { this.map = new TileMap(data, CFG.tileSize || 32, colors); }
  addEntity(e) {
    this.entities.push(e);
    if (e.type === 'player') this.player = e;
    if (e.type === 'reward') this.totalCoins++;
    return e;
  }
  start() { this.running = true; this.paused = false; this._lastTs = performance.now(); this._loop(this._lastTs); }
  pause() { this.paused = !this.paused; }
  stop()  { this.running = false; if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; } }

  _loop(ts) {
    if (!this.running) return;
    this._rafId = requestAnimationFrame(t => this._loop(t));
    const dt = Math.min((ts - this._lastTs) / 1000, 0.05);
    this._lastTs = ts;
    this._fps.push(1 / dt); if (this._fps.length > 30) this._fps.shift();
    if (!this.paused) this._update(dt);
    this._draw();
    const fps = Math.round(this._fps.reduce((a, b) => a + b) / this._fps.length);
    this.emit('frame', { fps });
  }

  _update(dt) {
    for (const e of this.entities) if (e.alive) e.update(dt, this);
    this.particles.update(dt);
    this._collide();
    if (this.player) this.camera.follow(
      this.player.x + this.player.w / 2, this.player.y + this.player.h / 2,
      this.map.width, this.map.height
    );
    this.entities = this.entities.filter(e => e.alive);
  }

  _collide() {
    if (!this.player) return;
    const p = this.player;
    for (const e of this.entities) {
      if (e === p || !e.alive) continue;
      if (p.x + p.w <= e.x || p.x >= e.x + e.w || p.y + p.h <= e.y || p.y >= e.y + e.h) continue;
      if (e.type === 'reward' && !e.collected) {
        e.collected = true; e.alive = false;
        this.score += e.points; this.coins++;
        this.particles.burst(e.x + 9, e.y + 9, e.def.particleColor || '#ffd700', e.def.particleCount || 10);
        this.emit('rewardCollected', { reward: e.def, score: this.score, coins: this.coins });
        addLog(`${e.def.label} +${e.points} → ${this.score}`, 'good');
      }
      if (e.type === 'enemy' && p.invincible <= 0) {
        if (p.vy > 0 && (p.y + p.h) - e.y < 14) {
          e.alive = false; p.vy = -300;
          const pts = REWARDS.enemyStomp ? REWARDS.enemyStomp.points : 25;
          this.score += pts;
          this.particles.burst(e.x + 14, e.y, REWARDS.enemyStomp ? REWARDS.enemyStomp.particleColor : '#ff6eb4');
          this.emit('enemyKilled', { score: this.score });
          addLog(`Enemy stomped! +${pts}`, 'good');
        } else {
          this.lives -= (e.damage || 1); p.invincible = PLAYER_DEF.invincibleDuration || 2;
          this.emit('playerHurt', { lives: this.lives });
          addLog(`Ouch! Lives: ${this.lives}`, 'warn');
          if (this.lives <= 0) this.emit('playerDied');
        }
      }
      if (e.type === 'flag') this.emit('levelComplete', { score: this.score, coins: this.coins, total: this.totalCoins });
    }
  }

  _draw() {
    const ctx = this.ctx;
    const bg = ctx.createLinearGradient(0, 0, 0, GAME_H);
    bg.addColorStop(0, this._skyTop); bg.addColorStop(1, this._skyBot);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, GAME_W, GAME_H);
    this._drawStars(ctx);
    if (!this.map) return;
    this.map.draw(ctx, this.camera);
    [...this.entities].sort((a, b) => a.y - b.y).forEach(e => { if (e.alive) e.draw(ctx, this.camera, this.debug); });
    this.particles.draw(ctx, this.camera);
    this._hud(ctx);
    if (this.debug) this._dbg(ctx);
  }

  _drawStars(ctx) {
    if (!this._stars) {
      this._stars = Array.from({ length: 55 }, () => ({
        x: Math.random() * GAME_W, y: Math.random() * GAME_H,
        r: 0.5 + Math.random() * 1.5, spd: 0.1 + Math.random() * 0.4, br: 0.2 + Math.random() * 0.7
      }));
    }
    for (const s of this._stars) {
      const px = ((s.x - this.camera.x * s.spd * 0.05) % GAME_W + GAME_W) % GAME_W;
      const py = ((s.y - this.camera.y * s.spd * 0.05) % GAME_H + GAME_H) % GAME_H;
      ctx.fillStyle = `rgba(255,255,255,${s.br})`;
      ctx.beginPath(); ctx.arc(px, py, s.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  _hud(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.roundRect(10, 10, 230, 34, 7); ctx.fill();
    ctx.font = 'bold 12px "Space Mono",monospace';
    ctx.fillStyle = '#7fff6e'; ctx.fillText(`Score: ${this.score}`, 20, 31);
    ctx.fillStyle = '#ff6eb4'; ctx.fillText(`♥ ${this.lives}`, 145, 31);
    ctx.fillStyle = '#ffd700'; ctx.fillText(`● ${this.coins}/${this.totalCoins}`, 180, 31);
    if (this.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, GAME_W, GAME_H);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 30px Syne,sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('PAUSED', GAME_W / 2, GAME_H / 2);
      ctx.font = '12px "Space Mono",monospace'; ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText('Press P to resume', GAME_W / 2, GAME_H / 2 + 28); ctx.textAlign = 'left';
    }
  }

  _dbg(ctx) {
    const ts = this.map.ts;
    ctx.strokeStyle = 'rgba(255,255,0,0.07)'; ctx.lineWidth = 0.5;
    for (let x = -(this.camera.x % ts); x < GAME_W; x += ts) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, GAME_H); ctx.stroke(); }
    for (let y = -(this.camera.y % ts); y < GAME_H; y += ts) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(GAME_W, y); ctx.stroke(); }
  }

  _bindKeys() {
    const held = new Set();
    document.addEventListener('keydown', e => {
      if (!held.has(e.key)) {
        if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ') this.input.jumpPressed = true;
        if (e.key === 'p' || e.key === 'P') this.pause();
        if (e.key === 'r' || e.key === 'R') this.emit('resetRequest');
      }
      held.add(e.key);
      this.input.left  = held.has('ArrowLeft')  || held.has('a');
      this.input.right = held.has('ArrowRight') || held.has('d');
      this.input.jump  = held.has('ArrowUp') || held.has('w') || held.has(' ');
      if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
    });
    document.addEventListener('keyup', e => {
      held.delete(e.key);
      this.input.left  = held.has('ArrowLeft')  || held.has('a');
      this.input.right = held.has('ArrowRight') || held.has('d');
      this.input.jump  = held.has('ArrowUp') || held.has('w') || held.has(' ');
    });
  }
  setLeft(v)  { this.input.left = v; }
  setRight(v) { this.input.right = v; }
  setJump(v)  { if (v) this.input.jumpPressed = true; this.input.jump = v; }
}

/* ═══════════════════════════════════════════════════
   GAME MANAGER — levels, state, UI
   ═══════════════════════════════════════════════════ */
let game = null;
let currentLevelIdx = 0;
let levelScores     = [];   // best score per level
let levelUnlocked   = [true]; // level 0 always unlocked

function initFromJSON(data) {
  CFG        = data.config    || {};
  REWARDS    = data.rewards   || {};
  ENEMY_DEFS = data.enemies   || {};
  PLAYER_DEF = data.player    || {};
  LEVELS     = data.levels    || [];

  // Init progress arrays
  levelScores   = LEVELS.map(() => 0);
  levelUnlocked = LEVELS.map((_, i) => i === 0);

  buildLevelStrip();
  showStartOverlay();
  addLog('Game data loaded — ' + LEVELS.length + ' levels', 'info');
}

/* ── Build level strip ── */
function buildLevelStrip() {
  const strip = document.getElementById('levelStrip');
  strip.innerHTML = '<span class="lvl-label">Level:</span>';
  LEVELS.forEach((lvl, i) => {
    const btn = document.createElement('button');
    btn.className = 'lvl-btn' + (i === 0 ? ' active' : '') + (!levelUnlocked[i] ? ' locked' : '');
    btn.id = `lvl-btn-${i}`;
    btn.textContent = `${lvl.id}. ${lvl.name}`;
    btn.onclick = () => {
      if (!levelUnlocked[i]) { addLog(`Level ${lvl.id} locked — complete previous level first`, 'warn'); return; }
      currentLevelIdx = i;
      document.getElementById('overlay').classList.add('hidden');
      startLevel(i);
    };
    strip.appendChild(btn);
  });
}

function refreshLevelStrip() {
  LEVELS.forEach((_, i) => {
    const btn = document.getElementById(`lvl-btn-${i}`);
    if (!btn) return;
    btn.className = 'lvl-btn'
      + (i === currentLevelIdx ? ' active' : '')
      + (!levelUnlocked[i] ? ' locked' : '');
  });
}

/* ── Start a level ── */
function startLevel(idx) {
  if (game) game.stop();
  currentLevelIdx = idx;
  const lvl = LEVELS[idx];
  if (!lvl) return;

  game = new PlatformerGame();
  game.setSky(lvl.skyTop, lvl.skyBottom);
  game.loadMap(lvl.tilemap, lvl.tileColors);

  // Player
  game.addEntity(new Player({ x: lvl.playerStart.x, y: lvl.playerStart.y }));

  // Rewards
  (lvl.rewards || []).forEach(r => {
    const def = REWARDS[r.reward] || REWARDS['coin'];
    game.addEntity(new Reward({ x: r.x, y: r.y, reward: r.reward }, def));
  });

  // Enemies
  (lvl.enemies || []).forEach(en => {
    const def = ENEMY_DEFS[en.enemy] || ENEMY_DEFS['patrol'] || {};
    game.addEntity(new Enemy(en, def));
  });

  // Flag
  if (lvl.flag) game.addEntity(new Flag(lvl.flag));

  // Events
  game.on('rewardCollected', updateStats);
  game.on('playerHurt',      updateStats);
  game.on('playerDied', () => {
    addLog('☠ Died — restarting level…', 'warn');
    setTimeout(() => startLevel(currentLevelIdx), 700);
  });
  game.on('levelComplete', d => {
    game.stop();
    // Bonus for all items collected
    let bonus = 0;
    if (d.coins >= d.total && d.total > 0) {
      bonus = (REWARDS.allCoins && REWARDS.allCoins.points) || 50;
      d.score += bonus;
    }
    const completeBonus = (REWARDS.levelComplete && REWARDS.levelComplete.points) || 100;
    d.score += completeBonus;
    const totalScore = d.score;

    // Save best
    levelScores[currentLevelIdx] = Math.max(levelScores[currentLevelIdx], totalScore);
    // Unlock next
    const nextIdx = currentLevelIdx + 1;
    if (nextIdx < LEVELS.length) levelUnlocked[nextIdx] = true;

    refreshLevelStrip();
    buildLevelProgress();

    addLog(`★ Level ${LEVELS[currentLevelIdx].id} done! Score: ${totalScore}`, 'good');

    showLevelCompleteOverlay(lvl, d, bonus, completeBonus, nextIdx);
  });
  game.on('resetRequest', () => startLevel(currentLevelIdx));
  game.on('frame', ({ fps }) => { document.getElementById('st-fps').textContent = fps; });

  refreshLevelStrip();
  buildEntityList();
  updateStats();
  game.start();
  addLog(`▶ Level ${lvl.id}: ${lvl.name}`, 'info');
}

/* ── Overlays ── */
function showStartOverlay() {
  const o = document.getElementById('overlay');
  const lvl = LEVELS[0];
  o.innerHTML = `
    <div class="level-badge-overlay">PlatformerJS</div>
    <h2>Ready to Play?</h2>
    <p class="overlay-sub">${LEVELS.length} levels · Collect coins &amp; stars · Stomp enemies · Reach the flag!</p>
    <div class="key-row">
      <div class="key">← → <span>Move</span></div>
      <div class="key">↑ / Space <span>Jump</span></div>
      <div class="key">P <span>Pause</span></div>
    </div>
    <div class="overlay-btns">
      <button class="btn primary" id="ob-start" style="padding:9px 28px;font-size:13px">▶ Start Level 1</button>
    </div>
  `;
  o.classList.remove('hidden');
  document.getElementById('ob-start').onclick = () => { o.classList.add('hidden'); startLevel(0); };
}

function showLevelCompleteOverlay(lvl, d, bonus, completeBonus, nextIdx) {
  const o = document.getElementById('overlay');
  const hasNext = nextIdx < LEVELS.length;
  o.innerHTML = `
    <div class="level-badge-overlay">Level ${lvl.id} Complete!</div>
    <h2>${lvl.name}</h2>
    <div class="overlay-score">${d.score}</div>
    <div class="overlay-detail">
      Coins &amp; Stars: ${d.coins}/${d.total}<br>
      Level Bonus: +${completeBonus}${bonus ? `&nbsp;&nbsp;All Items: +${bonus}` : ''}
    </div>
    <div class="overlay-btns">
      <button class="btn danger" id="ob-retry" style="padding:8px 18px;font-size:12px">↺ Retry</button>
      ${hasNext ? `<button class="btn primary" id="ob-next" style="padding:9px 22px;font-size:13px">Next Level →</button>` : `<button class="btn primary" id="ob-again" style="padding:9px 22px;font-size:13px">▶ Play Again</button>`}
    </div>
  `;
  o.classList.remove('hidden');
  document.getElementById('ob-retry').onclick = () => { o.classList.add('hidden'); startLevel(currentLevelIdx); };
  if (hasNext) {
    document.getElementById('ob-next').onclick = () => { o.classList.add('hidden'); startLevel(nextIdx); };
  } else {
    document.getElementById('ob-again').onclick = () => { o.classList.add('hidden'); startLevel(0); };
  }
}

/* ── Sidebar UI ── */
function updateStats() {
  if (!game) return;
  document.getElementById('st-score').textContent = game.score;
  document.getElementById('st-lives').textContent = game.lives;
  document.getElementById('st-coins').textContent = game.coins + '/' + game.totalCoins;
  const lvl = LEVELS[currentLevelIdx];
  document.getElementById('st-level').textContent = lvl ? `${lvl.id}/${LEVELS.length}` : '--';
}

function buildEntityList() {
  const list = document.getElementById('entityList'); list.innerHTML = '';
  const colors = { player: '#7fff6e', reward: '#ffd700', enemy: '#ff6eb4', flag: '#6eb4ff' };
  const counts = {};
  (game?.entities || []).forEach(e => { counts[e.type] = (counts[e.type] || 0) + 1; });
  Object.entries(counts).forEach(([type, n]) => {
    const row = document.createElement('div'); row.className = 'entity-row';
    row.innerHTML = `<div class="entity-dot" style="background:${colors[type] || '#888'}"></div>
      <span class="entity-name">${type[0].toUpperCase() + type.slice(1)}</span>
      <span class="entity-tag">×${n}</span>`;
    list.appendChild(row);
  });
}

function buildLevelProgress() {
  const wrap = document.getElementById('levelProgress'); if (!wrap) return;
  wrap.innerHTML = '';
  LEVELS.forEach((lvl, i) => {
    const done   = levelScores[i] > 0;
    const active = i === currentLevelIdx;
    const locked = !levelUnlocked[i];
    const row = document.createElement('div'); row.className = 'lp-row';
    row.innerHTML = `
      <div class="lp-dot ${done ? 'done' : active ? 'active' : locked ? 'locked' : ''}"></div>
      <span class="lp-name" style="color:${locked ? 'var(--muted)' : 'var(--text)'}">${lvl.id}. ${lvl.name}</span>
      <span class="lp-score">${levelScores[i] > 0 ? levelScores[i] + ' pts' : locked ? '🔒' : ''}</span>
    `;
    wrap.appendChild(row);
  });
}

/* ── Log helper ── */
function addLog(msg, cls) {
  const log = document.getElementById('log');
  const d = document.createElement('div'); d.className = 'log-line ' + (cls || '');
  const t = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  d.textContent = `[${t}] ${msg}`; log.prepend(d);
  while (log.children.length > 25) log.removeChild(log.lastChild);
}

/* ── Button wiring ── */
document.getElementById('btnPlay').onclick  = () => { if (!game || !game.running) startLevel(currentLevelIdx); else if (game.paused) game.pause(); };
document.getElementById('btnPause').onclick = () => game?.pause();
document.getElementById('btnReset').onclick = () => { document.getElementById('overlay').classList.add('hidden'); startLevel(currentLevelIdx); };
document.getElementById('btnDebug').onclick = function () { if (game) { game.debug = !game.debug; this.classList.toggle('active', game.debug); } };

/* ── Touch controls ── */
function bindBtn(id, dn, up) {
  const el = document.getElementById(id);
  const on  = e => { e.preventDefault(); el.classList.add('pressed');    dn(); };
  const off = e => { e.preventDefault(); el.classList.remove('pressed'); up(); };
  el.addEventListener('touchstart',  on,  { passive: false });
  el.addEventListener('touchend',    off, { passive: false });
  el.addEventListener('touchcancel', off, { passive: false });
  el.addEventListener('mousedown',  on);
  el.addEventListener('mouseup',    off);
  el.addEventListener('mouseleave', off);
}
bindBtn('tc-left',  () => game?.setLeft(true),  () => game?.setLeft(false));
bindBtn('tc-right', () => game?.setRight(true), () => game?.setRight(false));
bindBtn('tc-up',    () => game?.setJump(true),  () => game?.setJump(false));
bindBtn('tc-jump',  () => game?.setJump(true),  () => game?.setJump(false));

/* ═══════════════════════════════════════════════════
   BOOT — fetch game.json then initialise
   ═══════════════════════════════════════════════════ */
fetch(`data/${gameId}/game.json`)
  .then(r => {
    if (!r.ok) throw new Error('Could not load game.json (' + r.status + ')');
    return r.json();
  })
  .then(data => {
    addLog('game.json loaded', 'good');
    initFromJSON(data);
    buildLevelProgress();
  })
  .catch(err => {
    addLog('ERROR: ' + err.message, 'warn');
    console.error(err);
  });
