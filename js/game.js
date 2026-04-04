/* ═══════════════════════════════════════════════════════════════
   PlatformerJS — game.js
   Game data:  data/${id}/game.json
   All assets: assets/${id}/
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ── Resolve game ID from URL hash: index.html#id=abc ── */
const getLocHash = function () {
  if (location.hash.length < 2) return {};
  var hash = {};
  var hashParts = location.hash.substr(1).split('&');
  for (var i = 0; i < hashParts.length; i++) {
    var kv = hashParts[i];
    if      (kv.match(/^(.+?)=(\d+)$/))       hash[RegExp.$1] = parseInt(RegExp.$2);
    else if (kv.match(/^(.+?)=(\d+\.\d+)$/))  hash[RegExp.$1] = parseFloat(RegExp.$2);
    else if (kv.match(/^(.+?)=(.*)$/))         hash[RegExp.$1] = decodeURIComponent(RegExp.$2);
    else                                        hash[RegExp.$1] = RegExp.$2;
  }
  return hash;
};

const locHash = getLocHash();
const gameId    = (typeof GAME_ID !== 'undefined') ? GAME_ID : locHash.id;
const ASSET_BASE = `assets/${gameId}/`; // all images, audio etc. live here

/* ── Sprite cache ────────────────────────────────────────────────────────────
   SPRITES[key] = { img, frameWidth, frameHeight, frames }
   img is null until loaded; entities must guard against that.
   frames (optional) maps state names to frame indices, e.g.
     { "idle": 0, "run": [1,2,3,4], "jump": 5, "fall": 6 }
   A spritesheet is laid out as a single horizontal strip:
     frame 0 starts at x=0, frame N starts at x = N * frameWidth.
   ─────────────────────────────────────────────────────────────────────────── */
const SPRITES  = {};
const TILESETS = {}; // key → { img, tileSize }

function loadSprites(spriteDefs) {
  Object.entries(spriteDefs || {}).forEach(([key, def]) => {
    SPRITES[key] = {
      img:           null,
      frameWidth:    def.frameWidth    || null,  // source column width in spritesheet
      frameHeight:   def.frameHeight   || null,  // source row height in spritesheet
      displayWidth:  def.displayWidth  || null,  // drawn pixel width  (falls back to frameWidth)
      displayHeight: def.displayHeight || null,  // drawn pixel height (falls back to frameHeight)
      frames:        def.frames        || {}
    };
    if (!def.url) {
      console.log(`[sprites] "${key}" → procedural (no url)`);
      return;
    }
    const fullUrl = ASSET_BASE + def.url;
    console.log(`[sprites] "${key}" → loading ${fullUrl}`);
    const img = new Image();
    img.onload  = () => { SPRITES[key].img = img; console.log(`[sprites] "${key}" loaded ✓ (${img.width}×${img.height})`); };
    img.onerror = () => { console.error(`[sprites] "${key}" FAILED to load: ${fullUrl}`); };
    img.src = fullUrl;
  });
}

function loadTilesets(tilesetDefs) {
  Object.entries(tilesetDefs || {}).forEach(([key, def]) => {
    TILESETS[key] = { img: null, tileSize: def.tileSize || 32 };
    if (!def.url) return;
    const img = new Image();
    img.onload  = () => { TILESETS[key].img = img; };
    img.onerror = () => { console.warn(`Tileset "${key}" failed to load:`, def.url); };
    img.src = ASSET_BASE + def.url;
  });
}

/* Draw a sprite image scaled to exactly frameWidth × frameHeight.
   - If NO frames are defined in JSON: source = full image, scaled to destW × destH.
   - If frames ARE defined (named states or animate array): frameWidth slices columns
     from the spritesheet and the correct column is drawn at destW × destH.
   - flipX mirrors horizontally. Returns true if drawn, false if not loaded. */
function drawSprite(ctx, key, state, frameIdx, dx, dy, dw, dh, flipX) {
  const sp = SPRITES[key];
  if (!sp || !sp.img) return false;

  const imgW = sp.img.width;
  const imgH = sp.img.height;

  /* Destination size — displayWidth/Height if set, otherwise frameWidth/Height, otherwise full image */
  const destW = sp.displayWidth  || sp.frameWidth  || imgW;
  const destH = sp.displayHeight || sp.frameHeight || imgH;

  /* Decide source rect.
     A spritesheet is indicated by ANY frames definition in the JSON.
     A plain single image has no frames defined at all.                */
  const isSheet = sp.frames && Object.keys(sp.frames).length > 0;

  let srcX = 0;
  let srcW = imgW; // default: full image
  const srcH = imgH;

  if (isSheet && sp.frameWidth) {
    /* Each column in the sheet is sp.frameWidth pixels wide.
       Resolve which column: frameIdx takes priority, then named state. */
    const colW        = sp.frameWidth;
    const totalFrames = Math.max(1, Math.floor(imgW / colW));
    let col = 0;

    if (frameIdx != null) {
      col = frameIdx;
    } else if (state != null && sp.frames[state] != null) {
      const f = sp.frames[state];
      col = Array.isArray(f) ? f[0] : f;
    }
    col  = col % totalFrames;
    srcX = col * colW;
    srcW = colW;
  }

  ctx.save();
  if (flipX) {
    ctx.translate(dx + destW, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(sp.img, srcX, 0, srcW, srcH, 0, 0, destW, destH);
  } else {
    ctx.drawImage(sp.img, srcX, 0, srcW, srcH, dx, dy, destW, destH);
  }
  ctx.restore();
  return true;
}

/* ── Config globals (populated from JSON) ── */
let CFG        = {};
let REWARDS    = {};
let ENEMY_DEFS = {};
let PLAYER_DEF = {};
let LEVELS     = [];
let GAME_TITLE = 'PlatformerJS';

/* ── Fixed internal resolution ── */
const GAME_W = 800;
const GAME_H = 450;

/* ── DOM refs ── */
const canvas  = document.getElementById('gameCanvas');
const overlay = document.getElementById('overlay');
const stage   = document.getElementById('stage');
const ctx     = canvas.getContext('2d');

/* ── Canvas: set ONCE — pixel buffer never changes ── */
canvas.width  = GAME_W;
canvas.height = GAME_H;
overlay.style.width  = GAME_W + 'px';
overlay.style.height = GAME_H + 'px';

/* Scale canvas + overlay to fill stage via CSS transform only */
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
   ENGINE CLASSES
   ═══════════════════════════════════════════════════ */

class Emitter {
  constructor() { this._h = {}; }
  on(e, fn)  { (this._h[e] = this._h[e] || []).push(fn); return this; }
  emit(e, d) { (this._h[e] || []).forEach(fn => fn(d)); }
}

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

class TileMap {
  /* tilesetKey: key into TILESETS (e.g. "default") — optional, falls back to procedural */
  constructor(data, ts, colors, tilesetKey) {
    this.data = data; this.ts = ts || 32;
    this.rows = data.length; this.cols = data[0].length;
    this.width  = this.cols * this.ts;
    this.height = this.rows * this.ts;
    this.color1     = (colors && colors[0]) || '#2e3a6e';
    this.color2     = (colors && colors[1]) || '#1a2448';
    this.tilesetKey = tilesetKey || 'default';
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
    const ts  = this.ts;
    const tsd = TILESETS[this.tilesetKey];
    const img = tsd && tsd.img;           // null until loaded, or if no URL set
    /* Source tile size in the sheet may differ from the world tile size.
       We read it from the tileset def; fall back to world ts if not set. */
    const srcTs = (tsd && tsd.tileSize) || ts;

    const c0 = Math.max(0, Math.floor(cam.x / ts));
    const c1 = Math.min(this.cols - 1, Math.ceil((cam.x + GAME_W) / ts));
    const r0 = Math.max(0, Math.floor(cam.y / ts));
    const r1 = Math.min(this.rows - 1, Math.ceil((cam.y + GAME_H) / ts));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const tileId = this.get(c, r);
        if (!tileId) continue;
        const wx = Math.round(c * ts - cam.x);
        const wy = Math.round(r * ts - cam.y);

        if (img) {
          /* Tileset image: tile ID selects the column in a horizontal strip.
             tileId 1 → column 0 (first tile), tileId 2 → column 1, etc.   */
          const col = tileId - 1;
          ctx.drawImage(img, col * srcTs, 0, srcTs, srcTs, wx, wy, ts, ts);
        } else {
          /* Procedural fallback */
          const g = ctx.createLinearGradient(wx, wy, wx, wy + ts);
          g.addColorStop(0, this.color1); g.addColorStop(1, this.color2);
          ctx.fillStyle = g; ctx.fillRect(wx, wy, ts, ts);
          ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(wx, wy, ts, 2);
          ctx.fillStyle = 'rgba(0,0,0,0.15)';       ctx.fillRect(wx, wy + ts - 2, ts, 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.strokeRect(wx + .5, wy + .5, ts - 1, ts - 1);
        }
      }
    }
  }
}

class Entity {
  constructor(o) {
    o = o || {};
    this.id   = Math.random().toString(36).slice(2);
    this.type = o.type || 'entity';
    this.x = o.x || 0; this.y = o.y || 0;
    this.w = o.w || 32; this.h = o.h || 32;
    this.vx = 0; this.vy = 0;
    this.alive = true; this.onGround = false;
  }
  update() {} draw() {}
}

function moveX(e, map) {
  for (const t of map.solidsFor(e.x, e.y, e.w, e.h)) {
    if      (e.vx > 0 && e.x + e.w > t.x        && e.x < t.x)             { e.x = t.x - e.w;   e.vx = 0; }
    else if (e.vx < 0 && e.x < t.x + t.w && e.x + e.w > t.x + t.w) { e.x = t.x + t.w; e.vx = 0; }
  }
}
function moveY(e, map) {
  for (const t of map.solidsFor(e.x, e.y, e.w, e.h)) {
    if      (e.vy >= 0 && e.y + e.h > t.y && e.y < t.y)             { e.y = t.y - e.h;   e.vy = 0; e.onGround = true; }
    else if (e.vy <  0 && e.y < t.y + t.h && e.y + e.h > t.y + t.h) { e.y = t.y + t.h; e.vy = 0; }
  }
}

/* ── Player ── */
class Player extends Entity {
  constructor(o) {
    const pd  = PLAYER_DEF;
    const sp  = SPRITES['player'];
    /* Hitbox: use player.width/height from JSON if set, otherwise sprite displayWidth/Height,
       otherwise the built-in defaults. This keeps physics aligned with the visual. */
    const hw  = pd.width  || (sp && sp.displayWidth)  || 26;
    const hh  = pd.height || (sp && sp.displayHeight) || 34;
    super(Object.assign({ type: 'player', w: hw, h: hh }, o));
    this.speed     = pd.speed          || 185;
    this.jumpForce = pd.jumpForce      || -490;
    this.gravity   = CFG.gravity       || 960;
    this.coyoteMax = pd.coyoteTime     || 0.1;
    this.jbufMax   = pd.jumpBufferTime || 0.12;
    this.facing = 1; this.coyote = 0; this.jbuf = 0;
    this.invincible = 0;
    this.ftimer = 0;
    this.frame  = 0;         // current run frame index within the run array
    this.animState = 'idle'; // track last state to reset frame on state change
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
      g.emit('jump');
    }
    this.x += this.vx * dt; moveX(this, g.map);
    this.y += this.vy * dt;
    const wasG = this.onGround; this.onGround = false;
    moveY(this, g.map);
    this.vy = Math.min(this.vy + this.gravity * dt, CFG.maxFallSpeed || 600);
    if (this.onGround && !wasG) g.emit('land');
    if (this.onGround) this.coyote = this.coyoteMax;
    this.x = Math.max(0, Math.min(this.x, g.map.width - this.w));
    if (this.y > g.map.height + 100) g.emit('playerDied');
    if (this.invincible > 0) this.invincible -= dt;

    // Use a stable grounded flag — true as long as the player has been
    // on the ground within the coyote window, so it never flickers false
    // for a single frame due to the physics reset cycle.
    const isGrounded = this.coyote > 0;
    const isMoving   = k.left || k.right;
    const nowState   = !isGrounded
                     ? (this.vy < 0 ? 'jump' : 'fall')
                     : isMoving ? 'run' : 'idle';

    // Reset frame index when state changes
    if (nowState !== this.animState) { this.frame = 0; this.ftimer = 0; }
    this.animState = nowState;

    // Only advance frame counter while running
    if (nowState === 'run') {
      const sp       = SPRITES['player'];
      const runFrames = sp && Array.isArray(sp.frames && sp.frames['run']) ? sp.frames['run'] : null;
      const fps       = (PLAYER_DEF.frameRate) || 8;          // frames per second, set in JSON
      this.ftimer += dt;
      if (this.ftimer >= 1 / fps) {
        this.ftimer = 0;
        const len = runFrames ? runFrames.length : 4;
        this.frame = (this.frame + 1) % len;
      }
    }
    this.trail.push({ x: this.x + this.w / 2, y: this.y + this.h / 2, a: 0.25 });
    this.trail = this.trail.map(p => ({ ...p, a: p.a - dt * (PLAYER_DEF.trailFade || 1.5) })).filter(p => p.a > 0);
  }
  draw(ctx, cam) {
    const sx = Math.round(this.x - cam.x), sy = Math.round(this.y - cam.y);
    // Trail — always drawn regardless of sprite
    for (const p of this.trail) {
      ctx.beginPath();
      ctx.arc(Math.round(p.x - cam.x), Math.round(p.y - cam.y), 5 * (p.a / 0.25), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(127,255,110,${p.a * 0.4})`; ctx.fill();
    }
    if (this.invincible > 0 && Math.floor(this.invincible * 10) % 2 === 0) return;

    // Use the state already resolved in update() — no re-computation needed
    const state = this.animState || 'idle';
    const sp    = SPRITES['player'];
    let frameIdx = 0;
    if (sp && sp.frames) {
      const f = sp.frames[state];
      if (state === 'run' && Array.isArray(f)) {
        // Cycle through the run frames using this.frame (advanced by update)
        frameIdx = f[this.frame % f.length];
      } else if (Array.isArray(f)) {
        frameIdx = f[0];       // multi-frame non-run state: always first frame
      } else if (f != null) {
        frameIdx = f;          // single frame index
      }
    }

    // Try sprite first; fall through to procedural if not loaded
    if (drawSprite(ctx, 'player', state, frameIdx, sx, sy, 0, 0, this.facing === -1)) return;

    // Procedural fallback
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
  }
}

/* ── Reward (coin / star / etc.) ── */
class Reward extends Entity {
  constructor(o, def) {
    super(Object.assign({ type: 'reward', w: 18, h: 18 }, o));
    this.def       = def;
    this.rewardKey = o.reward;
    this.points    = def.points || 10;
    this.angle     = Math.random() * Math.PI * 2;
    this.baseY     = this.y;
    this.collected = false;
  }
  update(dt) {
    this.angle += dt * (this.def.floatSpeed || 3);
    this.y = this.baseY + Math.sin(this.angle) * (this.def.floatAmplitude || 4);
  }
  draw(ctx, cam) {
    if (this.collected) return;
    const sx = Math.round(this.x - cam.x), sy = Math.round(this.y - cam.y);
    const cx = sx + 9, cy = sy + 9;
    // Glow ring — drawn regardless of sprite or procedural
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, 13);
    gr.addColorStop(0, this.def.glowColor || 'rgba(255,215,0,0.25)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2); ctx.fill();
    // Only animate if the JSON explicitly defines a frames array for this reward.
    // Without a frames declaration, always show frame 0 (static image).
    const sp = SPRITES[this.rewardKey];
    const frameList = sp && Array.isArray(sp.frames && sp.frames['animate'])
      ? sp.frames['animate']
      : null;
    let frameIdx = 0;
    if (frameList && frameList.length > 1) {
      frameIdx = frameList[Math.floor(this.angle / (Math.PI * 2 / frameList.length)) % frameList.length];
    }
    if (drawSprite(ctx, this.rewardKey, null, frameIdx, sx, sy, 0, 0, false)) return;
    // Procedural fallback
    if (this.rewardKey === 'star') {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(this.angle * 0.5);
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
      ctx.save(); ctx.translate(cx, cy); ctx.scale(Math.abs(Math.cos(this.angle)), 1);
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
    this.speed     = o.speed || def.defaultSpeed || 70;
    this.dir       = 1;
    this.pl        = o.patrolLeft  || this.x - 80;
    this.pr        = o.patrolRight || this.x + 80;
    this.ci        = def.colorInner     || '#ff6eb4';
    this.co        = def.colorOuter     || '#aa1155';
    this.damage    = def.damageToPlayer || 1;
    this.spriteKey = def.spriteKey      || 'enemy_patrol'; // matches assets.sprites key in JSON
  }
  update(dt, g) {
    this.x += this.speed * this.dir * dt;
    if (this.x <= this.pl) { this.x = this.pl; this.dir =  1; }
    if (this.x >= this.pr) { this.x = this.pr; this.dir = -1; }
    this.vy = Math.min((this.vy || 0) + (CFG.gravity || 960) * dt, CFG.maxFallSpeed || 600);
    this.y += this.vy * dt; moveY(this, g.map);
    if (this.y > g.map.height + 100) this.alive = false;
  }
  draw(ctx, cam) {
    const sx = Math.round(this.x - cam.x), sy = Math.round(this.y - cam.y);
    const esp = SPRITES[this.spriteKey];
    if (drawSprite(ctx, this.spriteKey, null, 0, sx, sy, 0, 0, this.dir === -1)) return;
    // Procedural fallback
    const cx = sx + 14, cy = sy + 14;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(this.dir, 1);
    const eg = ctx.createRadialGradient(0, 0, 2, 0, 0, 14);
    eg.addColorStop(0, this.ci); eg.addColorStop(1, this.co);
    ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'white'; ctx.beginPath(); ctx.arc(5, -2, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000';  ctx.beginPath(); ctx.arc(6, -2, 2, 0, Math.PI * 2); ctx.fill();
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
    const fsp = SPRITES['flag'];
    if (drawSprite(ctx, 'flag', null, 0, sx, sy, 0, 0, false)) return;
    // Procedural fallback
    ctx.fillStyle = '#aaa'; ctx.fillRect(sx + 2, sy, 4, this.h);
    ctx.beginPath(); ctx.moveTo(sx + 6, sy + 4);
    for (let i = 0; i <= 8; i++)
      ctx.lineTo(sx + 6 + i * 2.5, sy + 4 + Math.sin(this.wave + i * 0.5) * 4 + i * 3);
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
      this.list.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80,
                       r: 2 + Math.random() * 4, life: 0.7 + Math.random() * 0.3, color });
    }
  }
  update(dt) {
    this.list = this.list
      .map(p => ({ ...p, x: p.x + p.vx * dt, y: p.y + p.vy * dt, vy: p.vy + 300 * dt, life: p.life - dt }))
      .filter(p => p.life > 0);
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
    this.running = false; this.paused = false;
    this.entities  = []; this.particles = new Particles();
    this.camera    = new Camera(); this.map = null;
    this.input     = { left: false, right: false, jump: false, jumpPressed: false };
    this.score     = 0; this.lives = CFG.startingLives || 3;
    this.coins     = 0; this.totalCoins = 0;
    this._lastTs   = 0; this._rafId = null; this._stars = null;
    this._skyTop   = '#070714'; this._skyBot = '#0e0e2a';
    this._bgImg    = null;   // loaded Image object, or null
    this._bgParallax = 0.4;  // how much bg scrolls relative to camera (0 = fixed, 1 = with world)
    this._bindKeys();
  }
  setSky(top, bot) { this._skyTop = top || '#070714'; this._skyBot = bot || '#0e0e2a'; this._stars = null; }
  setBackground(url, parallax) {
    this._bgParallax = (parallax != null) ? parallax : 0.4;
    this._bgImg = null;
    if (!url) return;
    const img = new Image();
    img.onload  = () => { this._bgImg = img; };
    img.onerror = () => { this._bgImg = null; console.warn('Background image failed to load:', url); };
    img.src = ASSET_BASE + url;
  }
  loadMap(data, colors, tilesetKey) { this.map = new TileMap(data, CFG.tileSize || 32, colors, tilesetKey); }
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
    if (!this.paused) this._update(dt);
    this._draw();
    this.emit('frame', {});
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
        this.emit('rewardCollected', { score: this.score, coins: this.coins });
      }

      if (e.type === 'enemy' && p.invincible <= 0) {
        const stomping = p.vy > 80 && (p.y + p.h) < (e.y + e.h * 0.5);
        if (stomping) {
          e.alive = false; p.vy = -300;
          const pts = (REWARDS.enemyStomp && REWARDS.enemyStomp.points) || 25;
          this.score += pts;
          this.particles.burst(e.x + 14, e.y, (REWARDS.enemyStomp && REWARDS.enemyStomp.particleColor) || '#ff6eb4');
          this.emit('enemyKilled', { score: this.score });
        } else {
          this.lives -= (e.damage || 1);
          p.invincible = PLAYER_DEF.invincibleDuration || 2;
          this.emit('playerHurt', { lives: this.lives });
          if (this.lives <= 0) this.emit('playerDied');
        }
      }

      if (e.type === 'flag') {
        this.emit('levelComplete', { score: this.score, coins: this.coins, total: this.totalCoins });
      }
    }
  }

  _draw() {
    const ctx = this.ctx;
    // Sky gradient — always drawn first as the base layer
    const bg = ctx.createLinearGradient(0, 0, 0, GAME_H);
    bg.addColorStop(0, this._skyTop); bg.addColorStop(1, this._skyBot);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, GAME_W, GAME_H);
    // Background: image with parallax if loaded, otherwise procedural stars
    if (this._bgImg) {
      this._drawBgImage(ctx);
    } else {
      this._drawStars(ctx);
    }
    if (!this.map) return;
    this.map.draw(ctx, this.camera);
    [...this.entities].sort((a, b) => a.y - b.y)
      .forEach(e => { if (e.alive) e.draw(ctx, this.camera); });
    this.particles.draw(ctx, this.camera);
    this._hud(ctx);
  }

  /* Tile a seamless PNG horizontally with parallax scrolling */
  _drawBgImage(ctx) {
    const img = this._bgImg;
    // Scale image to fill game height
    const scale  = GAME_H / img.height;
    const drawW  = Math.ceil(img.width * scale);
    const drawH  = GAME_H;
    // Parallax offset: bg moves slower than the world camera
    const offsetX = (this.camera.x * this._bgParallax) % drawW;
    // Tile horizontally to cover full width
    const startX = -((offsetX % drawW) + drawW) % drawW;
    for (let x = startX; x < GAME_W; x += drawW) {
      ctx.drawImage(img, x, 0, drawW, drawH);
    }
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

  /* In-game HUD — drawn on canvas, always visible during play */
  _hud(ctx) {
    // Score / lives / items pill — top left
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.roundRect(10, 10, 244, 36, 8); ctx.fill();
    ctx.font = 'bold 13px "Space Mono",monospace';
    ctx.fillStyle = '#7fff6e'; ctx.fillText(`Score: ${this.score}`, 20, 33);
    ctx.fillStyle = '#ff6eb4'; ctx.fillText(`♥ ${this.lives}`,        152, 33);
    ctx.fillStyle = '#ffd700'; ctx.fillText(`● ${this.coins}/${this.totalCoins}`, 190, 33);

    // Level name — top right
    const lvl = LEVELS[currentLevelIdx];
    if (lvl) {
      const label = `${lvl.id} / ${LEVELS.length}  ${lvl.name}`;
      ctx.font = '11px "Space Mono",monospace';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.roundRect(GAME_W - tw - 26, 10, tw + 20, 28, 6); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(label, GAME_W - tw - 16, 29);
    }

    // Paused banner
    if (this.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, GAME_W, GAME_H);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 32px "Syne",sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('PAUSED', GAME_W / 2, GAME_H / 2);
      ctx.font = '12px "Space Mono",monospace'; ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText('Press P to resume', GAME_W / 2, GAME_H / 2 + 32);
      ctx.textAlign = 'left';
    }
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
   GAME MANAGER
   ═══════════════════════════════════════════════════ */
let game            = null;
let currentLevelIdx = 0;
let levelScores     = [];
let levelUnlocked   = [true];

function initFromJSON(data) {
  CFG        = data.config  || {};
  REWARDS    = data.rewards || {};
  ENEMY_DEFS = data.enemies || {};
  PLAYER_DEF = data.player  || {};
  LEVELS     = data.levels  || [];
  GAME_TITLE = data.title   || 'PlatformerJS';

  /* Debug: log exactly what assets block was received */
  console.log('[init] assets block received:', JSON.stringify(data.assets, null, 2));
  console.log('[init] ASSET_BASE =', ASSET_BASE);

  /* Load all sprite and tileset images defined in assets */
  loadSprites( (data.assets && data.assets.sprites)  || {});
  loadTilesets((data.assets && data.assets.tilesets) || {});

  levelScores   = LEVELS.map(() => 0);
  levelUnlocked = LEVELS.map((_, i) => i === 0);

  /* Set page title and toolbar title from JSON */
  document.title = GAME_TITLE;
  document.getElementById('gameTitle').textContent = GAME_TITLE;

  showStartOverlay();
}

/* ── Level progress HTML — used only inside overlays ── */
function buildLevelProgressHTML() {
  return LEVELS.map((lvl, i) => {
    const done   = levelScores[i] > 0;
    const active = i === currentLevelIdx;
    const locked = !levelUnlocked[i];
    const dotCls = done ? 'done' : active ? 'active' : '';
    const score  = levelScores[i] > 0 ? levelScores[i] + ' pts' : locked ? '🔒' : '';
    return `
      <div class="lp-row">
        <div class="lp-dot ${dotCls}"></div>
        <span class="lp-name${locked ? ' locked' : ''}">${lvl.id}. ${lvl.name}</span>
        <span class="lp-score${score ? '' : ' empty'}">${score}</span>
      </div>`;
  }).join('');
}

/* ── Start a level ── */
function startLevel(idx) {
  if (game) game.stop();
  currentLevelIdx = idx;
  const lvl = LEVELS[idx];
  if (!lvl) return;

  game = new PlatformerGame();
  game.setSky(lvl.skyTop, lvl.skyBottom);
  game.setBackground(lvl.backgroundImage || null, lvl.backgroundParallax);
  game.loadMap(lvl.tilemap, lvl.tileColors, lvl.tileset || 'default');

  game.addEntity(new Player({ x: lvl.playerStart.x, y: lvl.playerStart.y }));

  (lvl.rewards || []).forEach(r => {
    const def = REWARDS[r.reward] || REWARDS['coin'];
    game.addEntity(new Reward({ x: r.x, y: r.y, reward: r.reward }, def));
  });

  (lvl.enemies || []).forEach(en => {
    const def = ENEMY_DEFS[en.enemy] || ENEMY_DEFS['patrol'] || {};
    game.addEntity(new Enemy(en, def));
  });

  if (lvl.flag) game.addEntity(new Flag(lvl.flag));

  game.on('playerDied', () => setTimeout(() => startLevel(currentLevelIdx), 700));

  game.on('levelComplete', d => {
    game.stop();
    let bonus = 0;
    if (d.coins >= d.total && d.total > 0)
      bonus = (REWARDS.allCoins && REWARDS.allCoins.points) || 50;
    const completeBonus = (REWARDS.levelComplete && REWARDS.levelComplete.points) || 100;
    d.score += bonus + completeBonus;

    levelScores[currentLevelIdx] = Math.max(levelScores[currentLevelIdx], d.score);
    const nextIdx = currentLevelIdx + 1;
    if (nextIdx < LEVELS.length) levelUnlocked[nextIdx] = true;

    showLevelCompleteOverlay(lvl, d, bonus, completeBonus, nextIdx);
  });

  game.on('resetRequest', () => startLevel(currentLevelIdx));
  game.start();
}

/* ── Overlays ── */
function showStartOverlay() {
  // Build level picker only if more than one level
  const levelPickerHTML = LEVELS.length > 1 ? `
    <div class="overlay-levels" id="ovlLevels">
      ${LEVELS.map((lvl, i) => {
        const locked = !levelUnlocked[i];
        const score  = levelScores[i] > 0 ? levelScores[i] + ' pts' : locked ? '🔒' : (lvl.subtitle || '');
        return `<button class="ovl-lvl-btn${i === currentLevelIdx ? ' active' : ''}${locked ? ' locked' : ''}"
                        data-idx="${i}">
                  ${lvl.id}. ${lvl.name}
                  <span class="lvl-score">${score}</span>
                </button>`;
      }).join('')}
    </div>` : '';

  overlay.innerHTML = `
    <h2>${GAME_TITLE}</h2>
    <p class="overlay-sub">
      ${LEVELS.length} level${LEVELS.length !== 1 ? 's' : ''} ·
      Collect coins &amp; stars · Stomp enemies · Reach the flag!
    </p>
    <div class="key-row">
      <div class="key">← → <span>Move</span></div>
      <div class="key">↑ / Space <span>Jump</span></div>
      <div class="key">P <span>Pause</span></div>
    </div>
    ${levelPickerHTML}
    <div class="overlay-btns">
      <button class="btn primary" id="ob-start" style="padding:10px 32px;font-size:14px">▶ Start</button>
    </div>
  `;
  overlay.classList.remove('hidden');

  // Wire level picker buttons
  overlay.querySelectorAll('.ovl-lvl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      if (!levelUnlocked[i]) return;
      overlay.querySelectorAll('.ovl-lvl-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentLevelIdx = i;
      document.getElementById('ob-start').textContent = `▶ Play Level ${LEVELS[i].id}`;
    });
  });

  document.getElementById('ob-start').onclick = () => {
    overlay.classList.add('hidden');
    startLevel(currentLevelIdx);
  };
}

function showLevelCompleteOverlay(lvl, d, bonus, completeBonus, nextIdx) {
  const hasNext = nextIdx < LEVELS.length;
  overlay.innerHTML = `
    <h2>Level ${lvl.id} Complete!</h2>
    <div class="overlay-score">${d.score}</div>
    <div class="overlay-detail">
      Items collected: ${d.coins} / ${d.total}
      &nbsp;·&nbsp; Bonus: +${completeBonus}
      ${bonus ? `&nbsp;·&nbsp; All items: +${bonus}` : ''}
    </div>
    <div class="level-progress">${buildLevelProgressHTML()}</div>
    <div class="overlay-btns">
      <button class="btn danger" id="ob-retry">↺ Retry</button>
      <button class="btn"        id="ob-menu">☰ Menu</button>
      ${hasNext
        ? `<button class="btn primary" id="ob-next">Next Level →</button>`
        : `<button class="btn primary" id="ob-again">▶ Play Again</button>`}
    </div>
  `;
  overlay.classList.remove('hidden');

  document.getElementById('ob-retry').onclick = () => { overlay.classList.add('hidden'); startLevel(currentLevelIdx); };
  document.getElementById('ob-menu').onclick  = () => showStartOverlay();
  if (hasNext) {
    document.getElementById('ob-next').onclick  = () => { overlay.classList.add('hidden'); startLevel(nextIdx); };
  } else {
    document.getElementById('ob-again').onclick = () => { overlay.classList.add('hidden'); startLevel(0); };
  }
}

/* ── Toolbar button wiring ── */
document.getElementById('btnPlay').onclick  = () => {
  if (!game || !game.running) startLevel(currentLevelIdx);
  else if (game.paused) game.pause();
};
document.getElementById('btnPause').onclick = () => game?.pause();
document.getElementById('btnReset').onclick = () => {
  overlay.classList.add('hidden');
  startLevel(currentLevelIdx);
};

/* ── Touch controls ── */
function bindBtn(id, dn, up) {
  const el = document.getElementById(id);
  if (!el) return;
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
   BOOT — fetch data/${gameId}/game.json, assets from assets/${gameId}/
   ═══════════════════════════════════════════════════ */
fetch(`data/${gameId}/game.json`)
  .then(r => {
    if (!r.ok) throw new Error(`Could not load game data (HTTP ${r.status})`);
    return r.json();
  })
  .then(data => initFromJSON(data))
  .catch(err => {
    overlay.innerHTML = `
      <h2>Oops!</h2>
      <p class="overlay-sub">Could not load the game.<br>${err.message}</p>
    `;
    overlay.classList.remove('hidden');
    console.error(err);
  });
