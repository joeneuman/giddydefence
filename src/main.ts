import {
  Board,
  BoardContactPhase,
  type BoardContact,
} from "@board.fun/web-sdk";

// Piece Defense — a tower defense game for Board.
//
// There is no fixed road: enemies spawn at the LEFT edge and path-find to
// the RIGHT edge, flowing around your towers. The towers themselves are the
// maze — build walls, funnels, and kill boxes. A purchase that would seal
// the path completely is refused.
//
// The spaceship Pieces are BUILDERS: setting one down proposes a tower
// (✓ BUY / ✗ CANCEL — nothing is charged until BUY). Towers are permanent
// structures that stay when the ship lifts; a 2-second SELL window opens on
// lift. Seat the matching ship on a tower and TURN it clockwise to upgrade.
// Farms make money during waves. The wave Piece pushes enemies back with a
// directional shockwave. Tap a targeted tower to cycle FIRST/LAST/TANK.
//
// In a desktop browser (no Board hardware) clicks simulate pieces: click
// empty space to propose (cycles all types), click a tower to cycle its
// targeting, right-click a bare tower to seat a ship, right-click a seated
// ship to turn it. The dev hook lets tooling drive the game headlessly.

// ---------------------------------------------------------------- rendering

const COLOR_BG = "#152432"; // GIDDY DIGS deep navy
const COLOR_ENEMY = "#ff6b6b";
const COLOR_ENEMY_TOUGH = "#ffa94d";
const COLOR_ENEMY_SLOWED = "#7ad4ff";
const COLOR_BASE = "#74c0fc";
const COLOR_SPAWN = "#63e6be";
const COLOR_TEXT = "#e9ecf5";
const COLOR_HINT = "#99a6bf";
const COLOR_BUTTON = "#3b82f6";
const COLOR_MONEY = "#ecb84a"; // brand gold
const COLOR_WARN = "#ff8787";
const TOWER_RADIUS = 30; // tower footprint (visual + path blocking)
const PIECE_RADIUS = 84; // physical Piece footprint — governs seating reach
const ENEMY_RADIUS = 11;
// How far creep paths stay off a tower's edge: exactly a creep's radius
// plus 1px, so they brush right along towers (melee reach!) and take any
// gap of ~a quarter tower-width or more.
const CREEP_CLEARANCE = ENEMY_RADIUS + 1;

// The playfield: creeps and towers live between these margins; the strips
// above and below belong to the HUD and are fenced off by a jagged border.
// The side walls are half as thick, pierced only by the IN/OUT gates.
const PLAY_TOP = 80;
const PLAY_LEFT = 40;
function playBottom(): number {
  return canvas.height - 120;
}
function playRight(): number {
  return canvas.width - 40;
}

// ------------------------------------------------------------------- tuning

const START_LIVES = 10;
const START_MONEY = 40;
const BEAM_LIFETIME = 0.14;

const MAX_LEVEL = 3;

// The bank: one per game, upgrades FOREVER (each level doubles in price).
// Pays (level + 2)% of held gold at the end of every wave — 3% at level 1,
// 4% at level 2, and so on with no cap. It also physically grows.
function bankInterest(level: number): number {
  return (level + 2) / 100;
}
function bankVisualRadius(level: number): number {
  return Math.min(TOWER_RADIUS + 5 * (level - 1), TOWER_RADIUS * 2);
}
function maxLevel(type: TowerType): number {
  return type === "farm" ? Infinity : MAX_LEVEL;
}
function activeBank(): Tower | null {
  for (const t of towers.values()) {
    if (t.type === "farm" && t.state === "active") return t;
  }
  return null;
}

// Upgrading costs twice the tower's purchase price, doubling per level.
function upgradeCost(type: TowerType, currentLevel: number): number {
  return TOWER_SPECS[type].cost * Math.pow(2, currentLevel);
}

type TowerType =
  | "laser" | "splash" | "sniper" | "frost" | "farm" | "surge" | "wall" | "bolt" | "mgun"
  | "poison" | "power" | "haste" | "scope" | "militia" | "crop";

interface TowerSpec {
  cost: number;
  range: number;
  fireInterval: number; // seconds; 0 = passive aura, never fires
  damageByLevel: [number, number, number]; // level 1..3 (bank: interest fraction/tick)
  color: string;
  label: string;
}

const TOWER_SPECS: Record<TowerType, TowerSpec> = {
  laser: { cost: 100, range: 240, fireInterval: 0.55, damageByLevel: [0.25, 0.5, 0.75], color: "#fcc419", label: "LASER LOFT" },
  splash: { cost: 80, range: 195, fireInterval: 0.9, damageByLevel: [1, 2, 3], color: "#f06595", label: "SPLASH PAD" },
  // Sniper sees ~90% of the board; each shot strips a % of the target's
  // CURRENT hp (damageByLevel holds the percentages).
  sniper: { cost: 60, range: 1730, fireInterval: 7, damageByLevel: [0.05, 0.1, 0.15], color: "#ff922b", label: "SNIPER CONDO" },
  frost: { cost: 70, range: 150, fireInterval: 0, damageByLevel: [0, 0, 0], color: "#4263eb", label: "FROST CABIN" },
  farm: { cost: 500, range: 0, fireInterval: 0, damageByLevel: [0, 0, 0], color: "#e8b339", label: "BANK" },
  // Farm: steady trickle of gold while a wave runs; damageByLevel is g/tick.
  crop: { cost: 100, range: 0, fireInterval: 2, damageByLevel: [1, 4, 8], color: "#51cf66", label: "FARMHOUSE" },
  // The wave: a directional shockwave every 7s that strips a percentage of
  // each caught enemy's CURRENT life and shoves them back toward the spawn.
  surge: { cost: 1000, range: 390, fireInterval: 5, damageByLevel: [0, 0, 0], color: "#e599f7", label: "WAVE MANOR" },
  // Walls don't fight — they just direct traffic. No upgrades.
  wall: { cost: 5, range: 0, fireInterval: 0, damageByLevel: [0, 0, 0], color: "#adb5bd", label: "WALL" },
  // Lightning: every 2s a bolt chains through up to 4 enemies.
  bolt: { cost: 150, range: 225, fireInterval: 2, damageByLevel: [3, 4, 5], color: "#22d3ee", label: "LIGHTNING LODGE" },
  // Machine gun: pinpricks, but LOTS of them.
  mgun: { cost: 30, range: 60, fireInterval: 0.08, damageByLevel: [0.15, 0.25, 0.4], color: "#94d82d", label: "MELEE MOTEL" },
  // Poison dart: damageByLevel is the TOTAL venom, dripped over 5 seconds.
  poison: { cost: 90, range: 90, fireInterval: 0, damageByLevel: [2, 4, 6], color: "#9775fa", label: "POISON POOL" },
  // Aura buffs: boost every shooting tower inside their circle.
  power: { cost: 120, range: 135, fireInterval: 0, damageByLevel: [0, 0, 0], color: "#e03131", label: "POWER PLANT" },
  haste: { cost: 120, range: 135, fireInterval: 0, damageByLevel: [0, 0, 0], color: "#f59f00", label: "HASTE HUT" },
  scope: { cost: 120, range: 135, fireInterval: 0, damageByLevel: [0, 0, 0], color: "#12b886", label: "SCOPE STUDIO" },
  // Militia: spawns a squad of soldiers; damageByLevel is each soldier's dps.
  militia: { cost: 300, range: 0, fireInterval: 0, damageByLevel: [1, 2, 3], color: "#63e6be", label: "GUARD HOUSE" },
};
const TOWER_TYPE_ORDER: TowerType[] = [
  "laser", "splash", "sniper", "frost", "farm", "surge", "wall", "bolt", "mgun",
  "poison", "power", "haste", "scope",
];

// Menu categories: shooters vs everything that shapes the field.
// Each page lists its towers cheapest-first.
const MENU_CATEGORIES: Record<"damage" | "effect", TowerType[]> = {
  damage: ["mgun", "sniper", "splash", "poison", "laser", "bolt", "militia", "surge"],
  effect: ["wall", "frost", "crop", "power", "haste", "scope", "farm"],
};

// Splash is the one shooter whose reach grows with level.
const SPLASH_RANGE_BY_LEVEL: [number, number, number] = [195, 240, 285];

function splashRangeAt(level: number): number {
  return SPLASH_RANGE_BY_LEVEL[Math.min(level, 3) - 1];
}

// Militia: each tower fields a squad of soldiers that rally where you tap.
// Creeps in contact with a soldier stop marching and fight him instead.
const MILITIA_COUNT = 4;
const MILITIA_HP_BY_LEVEL: [number, number, number] = [15, 30, 60];
const MILITIA_RESPAWN = 10; // seconds until a fallen soldier is replaced
const MILITIA_SPEED = 120; // px/s
const MILITIA_RADIUS = 8;
const MILITIA_AGGRO = 130; // a soldier charges any creep this close

interface Militia {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  towerId: number;
  slot: number; // 0..3, picks a standing spot around the rally flag
  powered: boolean; // POWER PLANT aura: bigger, meaner, recolored
  ranged: boolean; // SCOPE STUDIO aura: fights at a distance
  shotCd: number; // ranged only: seconds until the next shot
}
const militias: Militia[] = [];

const POISON_DURATION = 5; // seconds the venom drips
const POWER_MUL_BY_LEVEL: [number, number, number] = [1.25, 1.4, 1.6];
const HASTE_MUL_BY_LEVEL: [number, number, number] = [1.2, 1.35, 1.5];
const SCOPE_MUL_BY_LEVEL: [number, number, number] = [1.15, 1.25, 1.4];

const BOLT_CHAIN_BY_LEVEL: [number, number, number] = [3, 4, 5]; // creeps per bolt
const BOLT_CHAIN_RADIUS = 200; // px hop distance between chained targets

// Frost aura slow multiplier by level (lower = slower enemies).
const FROST_FACTOR_BY_LEVEL: [number, number, number] = [0.65, 0.5, 0.35];
// Surge fires a straight wave down a LANE: knockback distance, lane
// half-width (the lane is 2/4/8 tower-widths across), and % of current
// life stripped.
const SURGE_PUSH_BY_LEVEL: [number, number, number] = [160, 250, 350];
const SURGE_HALF_WIDTH_BY_LEVEL: [number, number, number] = [60, 120, 240]; // px
const SURGE_PCT_BY_LEVEL: [number, number, number] = [0.1, 0.15, 0.2];

// Piece glyph ids for the THRASOS set (model: thrasos_v2.4.3). Fixed
// assignments could go here; instead the game LEARNS them: the first time a
// piece is placed, the player picks its tower from a menu, and that choice
// sticks to the glyph forever (saved on the device). Note the set has twin
// pieces sharing a glyph — twins share an assignment.
const SPACESHIP_GLYPHS: Record<number, TowerType> = {};

const ASSIGNMENTS_KEY = "pieceDefense.glyphAssignments";

function loadAssignments(): Record<number, TowerType> {
  try {
    const raw = localStorage.getItem(ASSIGNMENTS_KEY);
    if (raw) return JSON.parse(raw) as Record<number, TowerType>;
  } catch {
    // storage unavailable — assignments just won't survive relaunch
  }
  return {};
}

const glyphAssignments: Record<number, TowerType> = loadAssignments();

function saveAssignments(): void {
  try {
    localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(glyphAssignments));
  } catch {
    // best effort
  }
}

function assignGlyph(glyphId: number, type: TowerType): void {
  glyphAssignments[glyphId] = type;
  saveAssignments();
}

function towerTypeForGlyph(glyphId: number): TowerType | null {
  const mapped = SPACESHIP_GLYPHS[glyphId] ?? glyphAssignments[glyphId];
  if (mapped) return mapped;
  if (!Board.isOnDevice && glyphId >= 60) {
    // Desktop preview fake glyphs: 60 + index into TOWER_TYPE_ORDER.
    return TOWER_TYPE_ORDER[glyphId % TOWER_TYPE_ORDER.length];
  }
  return null;
}

const LASER_BEAM_HALF_WIDTH = 28; // px each side of the beam line

function waveEnemyCount(wave: number): number {
  return 4 + Math.min(wave, 30) * 2; // creep count stops growing past wave 30
}
// Game modes: OPEN FIELD (towers form the maze) or FIXED PATH (creeps march
// a set road; towers build only around it). Locked in once wave 1 starts.
type GameMode = "open" | "path";
const GAME_MODES: GameMode[] = ["open", "path"];
const GAME_MODE_LABEL: Record<GameMode, string> = { open: "OPEN FIELD", path: "FIXED PATH" };
let gameMode: GameMode = "open";

// In FIXED PATH mode there's no melee tower — it reverts to the original
// machine gun (same price and speed, real range).
function applyGameMode(): void {
  TOWER_SPECS.mgun.range = gameMode === "path" ? 150 : 60;
  TOWER_SPECS.mgun.label = gameMode === "path" ? "GUN GARAGE" : "MELEE MOTEL";
  rebuildFlow();
}

// Difficulty scales creep hit points only — locked in once wave 1 starts.
type Difficulty = "easy" | "normal" | "impossible";
const DIFFICULTIES: Difficulty[] = ["easy", "normal", "impossible"];
// Waves 1-2 are identical on every difficulty (1 and 2 hp); from wave 3 hp
// starts at ~3 and COMPOUNDS per wave — the growth rate is what difficulty
// buys you.
// Hp compounds (1/2/3 opening, ×1.6 kick at wave 4) exactly as tuned —
// then eases off a little after wave 35 so the late game doesn't run away.
const DIFFICULTY_HP_GROWTH: Record<Difficulty, number> = {
  easy: 1.13,
  normal: 1.17,
  impossible: 1.21,
};
// After wave 35 the curve bends over: it drifts toward a ceiling of
// `late mult` × the wave-35 hp, flattening a little more every wave.
const DIFFICULTY_HP_LATE_MULT: Record<Difficulty, number> = {
  easy: 2.5,
  normal: 3.3,
  impossible: 4,
};
const HP_LATE_TAU = 12; // waves to cover ~2/3 of the remaining climb
// ...and the ceiling itself keeps sliding up — flat-ish, never flat.
const DIFFICULTY_HP_LATE_DRIFT: Record<Difficulty, number> = {
  easy: 4,
  normal: 8,
  impossible: 16,
};
const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: "EASY", normal: "NORMAL", impossible: "IMPOSSIBLE" };
let difficulty: Difficulty = "normal";

function waveEnemyHp(wave: number): number {
  if (wave <= 2) return wave;
  const kick = wave >= 4 ? 1.6 : 1;
  let hp = 2.5 * Math.pow(DIFFICULTY_HP_GROWTH[difficulty], Math.min(wave, 35) - 3) * kick;
  if (wave > 35) {
    hp *= Math.pow(DIFFICULTY_HP_LATE_MULT[difficulty], 1 - Math.exp(-(wave - 35) / HP_LATE_TAU));
    hp += DIFFICULTY_HP_LATE_DRIFT[difficulty] * (wave - 35);
  }
  return Math.max(1, Math.round(hp));
}
function waveEnemySpeed(wave: number): number {
  return 90 + wave * 8; // px/s
}
// The first waves pay a little extra so the early build isn't starved —
// tuned so waves 1 and 2 land exactly 32g and 59g on every difficulty.
const EARLY_WAVE_BONUS: Record<number, number> = { 1: 6, 2: 18 };
// Waves 4-20 are the LEAN years: bonuses (and bounties) pay reduced rates.
// Late-game wealth comes from farms and the compounding bank instead.
const LEAN_BONUS_SCALE = 0.6;
const LEAN_BOUNTY_SCALE = 0.7;

function leanWave(w: number): boolean {
  return w >= 4 && w <= 20;
}

function waveClearBonus(wave: number): number {
  const base = 15 + wave * 5 + (EARLY_WAVE_BONUS[wave] ?? 0);
  return leanWave(wave) ? Math.round(base * LEAN_BONUS_SCALE) : base;
}
const SPAWN_INTERVAL = 0.8; // seconds between spawns within a wave

// ------------------------------------------------------------------- canvas

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

// The game world is ALWAYS the Board's native 1920×1080 — identical
// geometry everywhere. Off-device the canvas letterboxes to fit the
// window, and pointer input maps back through the scale.
const GAME_W = 1920;
const GAME_H = 1080;

function resize(): void {
  canvas.width = GAME_W;
  canvas.height = GAME_H;
  const scale = Math.min(window.innerWidth / GAME_W, window.innerHeight / GAME_H);
  const cssW = Math.round(GAME_W * scale);
  const cssH = Math.round(GAME_H * scale);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.style.marginLeft = `${Math.round((window.innerWidth - cssW) / 2)}px`;
  canvas.style.marginTop = `${Math.round((window.innerHeight - cssH) / 2)}px`;
  rebuildFlow();
}

// Window/client coordinates -> game coordinates.
function toGame(clientX: number, clientY: number): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [
    ((clientX - r.left) / r.width) * GAME_W,
    ((clientY - r.top) / r.height) * GAME_H,
  ];
}

// ------------------------------------------------------------- flow field

// The board is a grid; active towers block cells; a BFS from the right edge
// gives every cell its distance-to-exit. Enemies walk downhill on that
// field. CELL is small enough for corridors between adjacent towers.
// Fine pathing grid: half a creep's width per cell, so routes hug tower
// edges and slip through any gap a creep physically fits.
const CELL = 14;
// Placement snaps in quarter-tower steps — fine enough to butt towers up
// tight, coarse enough to stay predictable.
const SNAP = Math.round((TOWER_RADIUS * 2) / 4); // 15px

function snapX(x: number): number {
  const q = Math.round(x / SNAP) * SNAP;
  const minC = Math.ceil((PLAY_LEFT + TOWER_RADIUS) / SNAP) * SNAP;
  const maxC = Math.floor((playRight() - TOWER_RADIUS) / SNAP) * SNAP;
  return Math.max(minC, Math.min(maxC, q));
}

function snapY(y: number): number {
  // Towers stay fully inside the playfield, clear of the HUD strips.
  const q = Math.round(y / SNAP) * SNAP;
  const minC = Math.ceil((PLAY_TOP + TOWER_RADIUS) / SNAP) * SNAP;
  const maxC = Math.floor((playBottom() - TOWER_RADIUS) / SNAP) * SNAP;
  return Math.max(minC, Math.min(maxC, q));
}

// A spot is free when no ACTIVE tower overlaps it.
function spotIsFree(x: number, y: number, selfId?: number): boolean {
  for (const [id, o] of towers) {
    if (id === selfId || o.state !== "active") continue;
    if (Math.hypot(o.x - x, o.y - y) < TOWER_RADIUS * 2 - 1) return false;
  }
  return true;
}

// Nearest snapped, in-bounds, unoccupied spot to (x, y).
function nearestFreeSpot(x: number, y: number, selfId?: number): [number, number] {
  const sx = snapX(x);
  const sy = snapY(y);
  if (spotIsFree(sx, sy, selfId)) return [sx, sy];
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const nx = snapX(sx + dx * SNAP);
      const ny = snapY(sy + dy * SNAP);
      if (!spotIsFree(nx, ny, selfId)) continue;
      const d = Math.hypot(nx - x, ny - y);
      if (d < bestD) {
        bestD = d;
        best = [nx, ny];
      }
    }
  }
  return best ?? [sx, sy];
}

let cols = 0;
let rows = 0;
let blocked: Uint8Array = new Uint8Array(0);
let flowDist: Float64Array = new Float64Array(0);

function cellIndex(cx: number, cy: number): number {
  return cy * cols + cx;
}

function cellAt(x: number, y: number): [number, number] {
  return [
    Math.max(0, Math.min(cols - 1, Math.floor(x / CELL))),
    Math.max(0, Math.min(rows - 1, Math.floor(y / CELL))),
  ];
}

// FIXED PATH mode: the serpentine road creeps march along, as grid cells.
let pathCellSet: Set<number> = new Set();

function buildPathCells(): Set<number> {
  const set = new Set<number>();
  const W = canvas.width;
  const gates = gateRows();
  const midY = gates[Math.floor(gates.length / 2)] * CELL + CELL / 2;
  const top = PLAY_TOP + 70;
  const bot = playBottom() - 70;
  const pts: Array<[number, number]> = [
    [0, midY], [W * 0.28, midY], [W * 0.28, top], [W * 0.55, top],
    [W * 0.55, bot], [W * 0.8, bot], [W * 0.8, midY], [W, midY],
  ];
  const HALF = 45; // corridor half-width in px (~90px road)
  for (let s = 0; s < pts.length - 1; s++) {
    const [x0, y0] = pts[s];
    const [x1, y1] = pts[s + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 2)));
    for (let i = 0; i <= steps; i++) {
      const px = x0 + ((x1 - x0) * i) / steps;
      const py = y0 + ((y1 - y0) * i) / steps;
      const [c0, r0] = cellAt(px - HALF, py - HALF);
      const [c1, r1] = cellAt(px + HALF, py + HALF);
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) set.add(cellIndex(cx, cy));
      }
    }
  }
  return set;
}

function computeBlocked(extra?: { x: number; y: number }): Uint8Array {
  const grid = new Uint8Array(cols * rows);
  if (gameMode === "path") {
    // Everything off the road is out of bounds for creeps; towers never
    // block, because they can never stand on the road.
    for (let i = 0; i < grid.length; i++) grid[i] = pathCellSet.has(i) ? 0 : 1;
    return grid;
  }
  // The HUD strips above/below and the side walls are out of bounds for
  // creeps — except the gate rows, which pierce the side walls.
  const gates = gateRows();
  for (let cy = 0; cy < rows; cy++) {
    const centerY = cy * CELL + CELL / 2;
    const isGateRow = gates.includes(cy);
    for (let cx = 0; cx < cols; cx++) {
      const centerX = cx * CELL + CELL / 2;
      if (
        centerY < PLAY_TOP ||
        centerY > playBottom() ||
        ((centerX < PLAY_LEFT || centerX > playRight()) && !isGateRow)
      ) {
        grid[cellIndex(cx, cy)] = 1;
      }
    }
  }
  const obstacles: Array<{ x: number; y: number }> = [];
  for (const t of towers.values()) {
    // Poison is an ooze puddle on the ground — creeps walk through it.
    if (t.state === "active" && t.type !== "poison") obstacles.push({ x: t.x, y: t.y });
  }
  if (extra) obstacles.push(extra);
  // Circular blocking at the true physical radius — a square box casts a
  // far fatter shadow than the tower's round footprint.
  const blockR = TOWER_RADIUS + CREEP_CLEARANCE;
  for (const o of obstacles) {
    const [c0, r0] = cellAt(o.x - blockR, o.y - blockR);
    const [c1, r1] = cellAt(o.x + blockR, o.y + blockR);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const dx = cx * CELL + CELL / 2 - o.x;
        const dy = cy * CELL + CELL / 2 - o.y;
        if (Math.hypot(dx, dy) <= blockR) grid[cellIndex(cx, cy)] = 1;
      }
    }
  }
  return grid;
}

// Creeps enter through a gate at the middle of the left edge and leave
// through a gate at the middle of the right edge (~84px tall regardless of
// grid resolution).
function gateRows(): number[] {
  const mid = Math.floor(rows / 2);
  const span = Math.max(3, Math.round(84 / CELL));
  const first = mid - Math.floor(span / 2);
  const out: number[] = [];
  for (let r = first; r < first + span; r++) {
    if (r >= 0 && r < rows) out.push(r);
  }
  return out;
}

function computeFlow(grid: Uint8Array): Float64Array {
  const dist = new Float64Array(cols * rows).fill(Infinity);
  const queue: number[] = [];
  for (const cy of gateRows()) {
    const i = cellIndex(cols - 1, cy);
    if (!grid[i]) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const cx = i % cols;
    const cy = (i - cx) / cols;
    const d = dist[i] + 1;
    for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]] as const) {
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const ni = cellIndex(nx, ny);
      if (grid[ni] || dist[ni] <= d) continue;
      dist[ni] = d;
      queue.push(ni);
    }
  }
  return dist;
}

function rebuildFlow(): void {
  cols = Math.max(1, Math.ceil(canvas.width / CELL));
  rows = Math.max(1, Math.ceil(canvas.height / CELL));
  if (gameMode === "path") pathCellSet = buildPathCells();
  blocked = computeBlocked();
  flowDist = computeFlow(blocked);
}

// Would adding a tower at (x, y) leave a path from spawn to exit, for the
// spawn edge and for every living enemy?
function placementLegal(x: number, y: number): boolean {
  if (gameMode === "path") {
    // Towers stay clear of the road; they can never wall it off.
    const [c0, r0] = cellAt(x - TOWER_RADIUS - CREEP_CLEARANCE, y - TOWER_RADIUS - CREEP_CLEARANCE);
    const [c1, r1] = cellAt(x + TOWER_RADIUS + CREEP_CLEARANCE, y + TOWER_RADIUS + CREEP_CLEARANCE);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        if (pathCellSet.has(cellIndex(cx, cy))) return false;
      }
    }
    return true;
  }
  const grid = computeBlocked({ x, y });
  const dist = computeFlow(grid);
  let spawnOk = false;
  for (const cy of gateRows()) {
    const i = cellIndex(0, cy);
    if (!grid[i] && dist[i] !== Infinity) {
      spawnOk = true;
      break;
    }
  }
  if (!spawnOk) return false;
  for (const e of enemies) {
    const [cx, cy] = cellAt(e.x, e.y);
    if (dist[cellIndex(cx, cy)] === Infinity) return false;
  }
  return true;
}

// Remaining px to the exit for an enemy (for FIRST/LAST targeting).
function remainingFor(x: number, y: number): number {
  const [cx, cy] = cellAt(x, y);
  const d = flowDist[cellIndex(cx, cy)];
  return d === Infinity ? Number.MAX_SAFE_INTEGER : d * CELL + (canvas.width - x) * 0.001;
}

// Direction an enemy at (x, y) should walk: toward the best 8-neighbor.
function flowDirection(x: number, y: number): [number, number] {
  const [cx, cy] = cellAt(x, y);
  const here = flowDist[cellIndex(cx, cy)];
  if (here === Infinity) return [1, 0]; // trapped/unknown: shamble right
  if (here === 0) return [1, 0]; // on the exit column: walk off the edge
  let best = here;
  let bx = cx + 1;
  let by = cy;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      if (blocked[cellIndex(nx, ny)]) continue;
      // Diagonals only when both orthogonal neighbors are open (no corner
      // clipping through a tower).
      if (dx !== 0 && dy !== 0) {
        if (blocked[cellIndex(cx + dx, cy)] || blocked[cellIndex(cx, cy + dy)]) continue;
      }
      const nd = flowDist[cellIndex(nx, ny)] + (dx !== 0 && dy !== 0 ? 0.4 : 0);
      if (nd < best) {
        best = nd;
        bx = nx;
        by = ny;
      }
    }
  }
  const tx = bx * CELL + CELL / 2 - x;
  const ty = by * CELL + CELL / 2 - y;
  const len = Math.hypot(tx, ty) || 1;
  return [tx / len, ty / len];
}

function nearestWalkable(x: number, y: number): [number, number] {
  const [cx, cy] = cellAt(x, y);
  if (!blocked[cellIndex(cx, cy)]) return [x, y];
  for (let r = 1; r < Math.max(cols, rows); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        if (!blocked[cellIndex(nx, ny)]) {
          return [nx * CELL + CELL / 2, ny * CELL + CELL / 2];
        }
      }
    }
  }
  return [x, y];
}

// ------------------------------------------------------------------ sound

// All effects are synthesized — nothing to download, nothing to license.
let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
const lastPlayed = new Map<string, number>();

function ensureAudio(): void {
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.5;
      masterGain.connect(audioCtx.destination);
    } catch {
      return; // no audio support — play silently
    }
  }
  if (audioCtx.state === "suspended") void audioCtx.resume();
}

function setMasterVolume(v: number): void {
  if (masterGain) masterGain.gain.value = Math.max(0, Math.min(1, v));
}

interface Tone {
  freq: number;
  endFreq?: number;
  type?: OscillatorType;
  dur: number;
  vol?: number;
  delay?: number;
}

function playTones(name: string, tones: Tone[], minGapMs = 60): void {
  if (!audioCtx || !masterGain) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < minGapMs) return;
  lastPlayed.set(name, now);
  const t0 = audioCtx.currentTime;
  for (const tone of tones) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const start = t0 + (tone.delay ?? 0);
    osc.type = tone.type ?? "square";
    osc.frequency.setValueAtTime(tone.freq, start);
    if (tone.endFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, tone.endFreq), start + tone.dur);
    }
    gain.gain.setValueAtTime(tone.vol ?? 0.15, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + tone.dur);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(start);
    osc.stop(start + tone.dur + 0.02);
  }
}

const SFX = {
  sniper: () => playTones("sniper", [{ freq: 880, endFreq: 220, type: "square", dur: 0.09, vol: 0.08 }]),
  laser: () => playTones("laser", [{ freq: 1400, endFreq: 400, type: "sawtooth", dur: 0.12, vol: 0.06 }]),
  splash: () => playTones("splash", [{ freq: 140, endFreq: 60, type: "sine", dur: 0.25, vol: 0.14 }], 200),
  farm: () => playTones("farm", [
    { freq: 880, type: "triangle", dur: 0.07, vol: 0.1 },
    { freq: 1320, type: "triangle", dur: 0.09, vol: 0.1, delay: 0.07 },
  ], 300),
  surge: () => playTones("surge", [{ freq: 90, endFreq: 500, type: "sawtooth", dur: 0.5, vol: 0.16 }], 400),
  bolt: () => playTones("bolt", [
    // Silent flash — only the thunder, rolling in a second later.
    { freq: 85, endFreq: 40, type: "sawtooth", dur: 0.9, vol: 0.22, delay: 1.0 },
    { freq: 55, endFreq: 35, type: "sine", dur: 1.2, vol: 0.18, delay: 1.15 },
  ], 250),
  die: () => playTones("die", [{ freq: 300, endFreq: 60, type: "triangle", dur: 0.12, vol: 0.1 }], 40),
  mgun: () => playTones("mgun", [{ freq: 480, endFreq: 240, type: "square", dur: 0.03, vol: 0.05 }], 80),
  leak: () => playTones("leak", [{ freq: 220, endFreq: 110, type: "sawtooth", dur: 0.35, vol: 0.18 }], 150),
  buy: () => playTones("buy", [
    { freq: 520, type: "triangle", dur: 0.08, vol: 0.14 },
    { freq: 780, type: "triangle", dur: 0.12, vol: 0.14, delay: 0.08 },
  ]),
  sell: () => playTones("sell", [
    { freq: 780, type: "triangle", dur: 0.08, vol: 0.14 },
    { freq: 520, type: "triangle", dur: 0.12, vol: 0.14, delay: 0.08 },
  ]),
  cancel: () => playTones("cancel", [{ freq: 260, type: "triangle", dur: 0.1, vol: 0.1 }]),
  upgrade: () => playTones("upgrade", [
    { freq: 523, type: "square", dur: 0.07, vol: 0.09 },
    { freq: 659, type: "square", dur: 0.07, vol: 0.09, delay: 0.07 },
    { freq: 784, type: "square", dur: 0.12, vol: 0.09, delay: 0.14 },
  ]),
  denied: () => playTones("denied", [
    { freq: 220, type: "square", dur: 0.09, vol: 0.12 },
    { freq: 185, type: "square", dur: 0.14, vol: 0.12, delay: 0.09 },
  ]),
  tap: () => playTones("tap", [{ freq: 660, type: "triangle", dur: 0.04, vol: 0.07 }]),
  waveStart: () => playTones("waveStart", [
    { freq: 392, type: "square", dur: 0.1, vol: 0.12 },
    { freq: 523, type: "square", dur: 0.16, vol: 0.12, delay: 0.1 },
  ]),
  waveClear: () => playTones("waveClear", [
    { freq: 523, type: "triangle", dur: 0.09, vol: 0.14 },
    { freq: 659, type: "triangle", dur: 0.09, vol: 0.14, delay: 0.09 },
    { freq: 784, type: "triangle", dur: 0.09, vol: 0.14, delay: 0.18 },
    { freq: 1047, type: "triangle", dur: 0.2, vol: 0.14, delay: 0.27 },
  ]),
  boss: () => playTones("boss", [{ freq: 65, endFreq: 45, type: "sawtooth", dur: 0.8, vol: 0.22 }]),
  gameOver: () => playTones("gameOver", [
    { freq: 392, type: "triangle", dur: 0.18, vol: 0.16 },
    { freq: 330, type: "triangle", dur: 0.18, vol: 0.16, delay: 0.18 },
    { freq: 262, type: "triangle", dur: 0.4, vol: 0.16, delay: 0.36 },
  ]),
};

// --------------------------------------------------------------- game state

type EnemyKind = "grub" | "runt" | "boss" | "ranger" | "brute";

interface Enemy {
  x: number;
  y: number;
  kind: EnemyKind;
  hp: number;
  maxHp: number;
  speed: number;
  radius: number;
  slowFactor: number; // 1 = full speed; <1 inside a frost aura
  poisonDps: number; // venom damage per second while poisoned
  poisonUntil: number; // sim-clock time the venom wears off
  remaining: number; // px to the exit, from the flow field
  attackCd?: number; // rangers: seconds until the next arrow
  variant: number; // cosmetic: picks the body style within a kind
}

interface SpawnEntry {
  kind: EnemyKind;
  hp: number;
  speed: number;
  radius: number;
  gap: number;
}

function isSwarmWave(w: number): boolean {
  return w >= 6 && w % 3 === 0;
}

function buildWave(w: number): SpawnEntry[] {
  // Every 10th wave is a boss: one huge, slow sack of hit points.
  if (w % 10 === 0) {
    // Wave 10: one boss. Wave 20: two. Wave 30: three...
    const queue: SpawnEntry[] = [];
    for (let b = 0; b < w / 10; b++) {
      queue.push({
        kind: "boss",
        hp: waveEnemyHp(w) * 20,
        speed: waveEnemySpeed(w) * 0.35,
        radius: 20,
        gap: 2.5,
      });
    }
    return queue;
  }
  const queue: SpawnEntry[] = [];
  const hp = waveEnemyHp(w);
  const speed = waveEnemySpeed(w);
  for (let i = 0; i < waveEnemyCount(w); i++) {
    queue.push({ kind: "grub", hp, speed, radius: ENEMY_RADIUS, gap: SPAWN_INTERVAL });
    if (isSwarmWave(w)) {
      for (let r = 0; r < 2; r++) {
        queue.push({
          kind: "runt",
          hp: Math.max(1, Math.round(hp / 3)),
          speed: speed * 1.8,
          radius: 6,
          gap: 0.3,
        });
      }
    }
  }
  // From wave 5 the militia hunters march: rangers pick soldiers off from a
  // distance.
  if (w > 4) {
    const rangers = Math.min(8, 2 + Math.floor((w - 4) / 5));
    for (let i = 0; i < rangers; i++) {
      queue.push({
        kind: "ranger",
        hp: Math.max(1, Math.round(hp * 0.8)),
        speed: speed * 1.1,
        radius: 9,
        gap: 1.1,
      });
    }
  }
  return queue;
}

// How a targeted tower picks its victim: FIRST = closest to the exit,
// LAST = furthest from the exit (back of the pack), TANK = most hit points.
type TargetMode = "first" | "last" | "tank";
const TARGET_MODE_ORDER: TargetMode[] = ["first", "last", "tank"];
const TARGET_MODE_LABEL: Record<TargetMode, string> = {
  first: "◎ FIRST",
  last: "◎ LAST",
  tank: "◎ TANK",
};

interface Tower {
  x: number;
  y: number;
  type: TowerType;
  level: number; // 1..MAX_LEVEL
  state: "active" | "proposed";
  // Proposals from a piece with no preset type open a type-picker menu
  // first; choosing a chip closes the menu and shows BUY/CANCEL. The menu
  // is two-level: a category page (DAMAGE / EFFECT), then that page's towers.
  menuOpen: boolean;
  menuCategory: "root" | "damage" | "effect";
  // Touch-created proposals (no piece holding them) expire if ignored.
  expireAt: number; // realClock; 0 = never
  hasShip: boolean; // created by a physical piece (vs a screen tap)
  invested: number; // gold actually paid (purchase + upgrades) — sell refunds 60%
  rallyX?: number; // militia only: where the squad stands
  rallyY?: number;
  // Action buttons (⬆ / mode / SELL) show only while this is in the future.
  actionsUntil: number;
  targetMode: TargetMode;
  facing: number; // degrees; surge fires this way (seated ship's heading)
  cooldown: number;
  // Selling is two-tap: the small SELL tag opens a ✓/✗ confirmation that
  // stays until this realClock time (or ✗ / elsewhere closes it).
  sellConfirmUntil: number;
}

// A piece is a pure aiming dial. It never builds and never touches towers —
// a finger tap LINKS a tower to the dial, then rotating the piece (sitting
// anywhere on the table) steers that tower.
interface Ship {
  x: number;
  y: number;
  glyphId: number;
  lastOrientation: number; // raw sensor reading, previous frame
  heading: number; // trusted heading — transient misreads rejected
  outlierCount: number; // consecutive frames of a consistent new reading
  lastSeen: number; // realClock of the last sensor report for this piece
}

interface Beam {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  age: number;
  color: string;
  width: number;
}

interface Burst {
  x: number;
  y: number;
  radius: number;
  age: number;
  color: string;
}

interface SurgeWave {
  x: number;
  y: number;
  angle: number; // radians
  halfWidth: number; // px — half the lane's width
  range: number;
  age: number;
}

type Phase = "idle" | "wave" | "gameover" | "victory";

const WIN_GOLD = 1_000_000;

// Fireworks for the winners.
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}
const sparks: Spark[] = [];
let nextFirework = 0;

let phase: Phase = "idle";
let wave = 0;
let lives = START_LIVES;
let kills = 0;
let money = START_MONEY;
let clock = 0; // sim time — scaled by the speed control
let realClock = 0; // wall time — UI windows (sell button) use this
let speedFactor: 1 | 3 | 6 = 1;
let enemies: Enemy[] = [];
let spawnQueue: SpawnEntry[] = [];
let spawnTimer = 0;
let spawnCounter = 0;
let nextTowerId = 1;
let warning: { text: string; until: number } | null = null;
const towers = new Map<number, Tower>();
const ships = new Map<number, Ship>();
const beams: Beam[] = [];
const bursts: Burst[] = [];
const surgeWaves: SurgeWave[] = [];
const boltStrikes: Beam[] = []; // chain-lightning hops, drawn jagged
const boltFlashes: Array<{ x: number; y: number; age: number }> = []; // sky glow

function warn(text: string): void {
  warning = { text, until: realClock + 5 };
  SFX.denied();
}

// One-shot gift coupon: 10,000g the first time a game gets going after this
// build lands — resume or fresh start, whichever comes first — then it
// burns itself.
function redeemGrant(): void {
  try {
    if (!localStorage.getItem("pd.grant.b")) {
      money += 10000;
      localStorage.setItem("pd.grant.b", "used");
      warn("+$10,000");
    }
  } catch {
    // no storage, no gift
  }
}

// Income ledger for the running wave, itemized for the wave-end popup.
let waveKillGold = 0;
let waveFarmGold = 0;
interface WaveSummary {
  wave: number;
  kills: number;
  bonus: number;
  farm: number;
  bank: number;
  until: number; // realClock when the popup fades
}
let waveSummary: WaveSummary | null = null;

// Rolling snapshots: state as of the last two wave clears, so "Previous
// Wave" can rewind one wave at any moment (OS save covers app restarts).
let lastClearSnap: SavedGame | null = null;
let prevClearSnap: SavedGame | null = null;

function previousWave(): void {
  const snap =
    prevClearSnap && wave > 0 && prevClearSnap.wave < wave
      ? prevClearSnap
      : lastClearSnap ?? prevClearSnap;
  if (snap) {
    restoreGame(snap);
    lastClearSnap = snap;
    prevClearSnap = null;
    SFX.buy();
  } else {
    void loadLatestSave(); // cold boot: fall back to the OS save
  }
}

function startWave(): void {
  hideProfileSwitcher();
  redeemGrant();
  waveKillGold = 0;
  waveFarmGold = 0;
  waveSummary = null;
  wave += 1;
  spawnQueue = buildWave(wave);
  spawnTimer = 0;
  phase = "wave";
  if (wave % 10 === 0) SFX.boss();
  else SFX.waveStart();
}

function restart(): void {
  phase = "idle";
  wave = 0;
  lives = START_LIVES;
  kills = 0;
  money = START_MONEY;
  enemies = [];
  spawnQueue = [];
  beams.length = 0;
  bursts.length = 0;
  surgeWaves.length = 0;
  towers.clear();
  militias.length = 0;
  aimLinkTowerId = null;
  rebuildFlow();
}

// ----------------------------------------------------------- save & resume

// One save slot per game, auto-written after every cleared wave. On the
// device it lives in the OS save service (tied to the active profile);
// in the browser preview it falls back to localStorage.
const GAME_VERSION = "1.0.0";
let saveId: string | null = null;
let playedMs = 0;
let resumeAvailable = false; // a save exists that we could load
let saveBusy = false;

interface SavedTower {
  x: number; y: number; type: TowerType; level: number;
  facing: number; targetMode: TargetMode; invested: number;
  rallyX?: number; rallyY?: number;
}
interface SavedGame {
  wave: number; money: number; lives: number; kills: number;
  difficulty: Difficulty; gameMode?: GameMode; playedMs: number; towers: SavedTower[];
}

function serializeGame(): SavedGame {
  return {
    wave, money, lives, kills, difficulty, gameMode, playedMs,
    towers: [...towers.values()]
      .filter((t) => t.state === "active")
      .map((t) => ({
        x: t.x, y: t.y, type: t.type, level: t.level,
        facing: t.facing, targetMode: t.targetMode, invested: t.invested,
        rallyX: t.rallyX, rallyY: t.rallyY,
      })),
  };
}

function restoreGame(s: SavedGame): void {
  restart();
  wave = s.wave;
  money = s.money;
  lives = s.lives;
  kills = s.kills;
  difficulty = s.difficulty;
  gameMode = s.gameMode ?? "open";
  applyGameMode();
  playedMs = s.playedMs ?? 0;
  redeemGrant();
  for (const st of s.towers) {
    const id = proposeTower(st.x, st.y, st.type, undefined, false, false);
    const t = towers.get(id)!;
    t.state = "active";
    t.level = st.level;
    t.facing = st.facing;
    t.targetMode = st.targetMode;
    t.invested = st.invested;
    t.expireAt = 0;
    if (st.type === "militia") {
      t.rallyX = st.rallyX;
      t.rallyY = st.rallyY;
      spawnSquad(id, t);
    }
  }
  rebuildFlow();
}

function saveDescription(): string {
  return `Wave ${wave} · $${money.toLocaleString()} · ${DIFFICULTY_LABEL[difficulty]}`;
}

async function autoSave(): Promise<void> {
  if (saveBusy || wave === 0) return;
  saveBusy = true;
  try {
    const payload = serializeGame();
    if (Board.isOnDevice) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      if (saveId === null) {
        const meta = await Board.save.create(saveDescription(), bytes, playedMs, GAME_VERSION);
        saveId = meta.id;
      } else {
        await Board.save.update(saveId, saveDescription(), bytes, playedMs, GAME_VERSION);
      }
    } else {
      localStorage.setItem("pd-save", JSON.stringify(payload));
    }
    resumeAvailable = true;
  } catch (err) {
    console.error("save failed", err);
  } finally {
    saveBusy = false;
  }
}

async function loadLatestSave(): Promise<void> {
  try {
    if (Board.isOnDevice) {
      const saves = await Board.save.list();
      if (saves.length === 0) return;
      const latest = saves.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
      const data = await Board.save.load(latest.id);
      saveId = latest.id;
      restoreGame(JSON.parse(new TextDecoder().decode(data)) as SavedGame);
    } else {
      const raw = localStorage.getItem("pd-save");
      if (!raw) return;
      restoreGame(JSON.parse(raw) as SavedGame);
    }
    SFX.buy();
  } catch (err) {
    console.error("load failed", err);
    warn("Couldn't load the save");
  }
}

// A deliberate reset abandons the run AND its save. The OS deletes a save
// once the game's players are removed from it.
async function wipeSave(): Promise<void> {
  const id = saveId;
  saveId = null;
  resumeAvailable = false;
  playedMs = 0;
  try {
    if (Board.isOnDevice) {
      if (id !== null) {
        await Board.save.removePlayersFromSave(id);
      } else {
        for (const meta of await Board.save.list()) {
          await Board.save.removePlayersFromSave(meta.id);
        }
      }
    } else {
      localStorage.removeItem("pd-save");
    }
  } catch (err) {
    console.error("wiping save failed", err);
  }
}

async function checkForSaves(): Promise<void> {
  try {
    if (Board.isOnDevice) {
      resumeAvailable = (await Board.save.list()).length > 0;
    } else {
      resumeAvailable = localStorage.getItem("pd-save") !== null;
    }
  } catch {
    resumeAvailable = false;
  }
}
void checkForSaves();

// ------------------------------------------------- pre-game (wave 0) UI

// Difficulty picker, resume, and player selection only exist before wave 1.
function preGame(): boolean {
  return phase === "idle" && wave === 0;
}

function difficultyButtonRect(i: number): [number, number, number, number] {
  const w = 220;
  const h = 52;
  const gap = 18;
  const total = 3 * w + 2 * gap;
  const [, by] = buttonRect();
  return [(canvas.width - total) / 2 + i * (w + gap), by - h - 22, w, h];
}

function modeButtonRect(i: number): [number, number, number, number] {
  const w = 280;
  const h = 52;
  const gap = 18;
  const total = 2 * w + gap;
  const [, dy] = difficultyButtonRect(0);
  return [(canvas.width - total) / 2 + i * (w + gap), dy - h - 14, w, h];
}

function resumeButtonRect(): [number, number, number, number] {
  const [bx, by, , bh] = buttonRect();
  const w = 180;
  return [bx - w - 24, by, w, bh];
}

function playerButtonRect(): [number, number, number, number] {
  const [bx, by, bw, bh] = buttonRect();
  return [bx + bw + 24, by, 200, bh];
}

// Player selection: the OS session selector adds (or swaps) the player for
// this game's session — that roster is what the button displays. Each
// player keeps their OWN save: switching banks the current run under the
// outgoing player, then loads (or freshly starts) the incoming player's.
let lastProfileName = "—";
let playerPickBusy = false;

function currentPlayerId(): string | null {
  if (!Board.isOnDevice) return null;
  try {
    return Board.session.getPlayers()[0]?.playerId ?? null;
  } catch {
    return null;
  }
}

async function findSaveIdForPlayer(pid: string): Promise<string | null> {
  const saves = await Board.save.list();
  let best: (typeof saves)[number] | null = null;
  for (const m of saves) {
    if (m.players.some((pl) => pl.playerId === pid)) {
      if (!best || m.updatedAt > best.updatedAt) best = m;
    }
  }
  return best?.id ?? null;
}

async function switchToPlayer(pid: string): Promise<void> {
  try {
    const theirs = await findSaveIdForPlayer(pid);
    saveId = theirs;
    resumeAvailable = theirs !== null;
    if (theirs !== null) {
      const data = await Board.save.load(theirs);
      restoreGame(JSON.parse(new TextDecoder().decode(data)) as SavedGame);
      SFX.buy();
    } else {
      restart(); // fresh board for a fresh player
    }
  } catch (err) {
    console.error("player switch failed", err);
    warn("Couldn't load that player's save");
  }
}

function pickPlayer(): void {
  if (!Board.isOnDevice) {
    warn("Profiles only exist on the Board");
    return;
  }
  if (playerPickBusy) return;
  playerPickBusy = true;
  const done = () => {
    playerPickBusy = false;
  };
  try {
    const before = currentPlayerId();
    const players = Board.session.getPlayers();
    const request =
      players.length === 0
        ? Board.session.presentAddPlayer()
        : Board.session.presentReplacePlayer(players[0].sessionId);
    request
      .then(async (ok) => {
        const after = currentPlayerId();
        if (ok && after && after !== before) {
          // Bank the outgoing player's run (roster on their save is
          // already recorded — update only rewrites the payload).
          if (wave > 0 && saveId !== null) await autoSave();
          await switchToPlayer(after);
        }
        done();
      })
      .catch((err) => {
        console.error("player select failed", err);
        done();
      });
  } catch (err) {
    console.error("player select failed", err);
    done();
  }
}

function hideProfileSwitcher(): void {
  if (!Board.isOnDevice) return;
  try {
    Board.application.hideProfileSwitcher();
  } catch {
    // nothing to hide
  }
}

function activePlayerName(): string {
  if (!Board.isOnDevice) return "—";
  try {
    const name =
      Board.session.getPlayers()[0]?.name ??
      Board.session.getActiveProfile()?.name;
    if (name) lastProfileName = name;
  } catch {
    // keep the cached name
  }
  return lastProfileName;
}

// ------------------------------------------------------------ piece logic

// Generous tap targets: buttons accept presses a bit outside their box.
function inRect(
  x: number,
  y: number,
  rect: readonly [number, number, number, number],
  pad = 14,
): boolean {
  const [rx, ry, rw, rh] = rect;
  return x >= rx - pad && x <= rx + rw + pad && y >= ry - pad && y <= ry + rh + pad;
}

function sellValue(t: Tower): number {
  if (t.type === "wall") return 1; // flat — not worth 60% of $5
  return Math.floor(t.invested * 0.6);
}

// Default heading: straight at the IN gate, where the creeps pour from —
// a fresh laser/wave is already staring down the arrivals.
function facingTowardInGate(x: number, y: number): number {
  const gates = gateRows();
  const gy = (gates[0] + gates.length / 2) * CELL;
  const ang = (Math.atan2(gy - y, PLAY_LEFT - x) * 180) / Math.PI;
  return (ang + 360) % 360;
}

function proposeTower(
  x: number,
  y: number,
  type: TowerType,
  facing?: number,
  menuOpen = false,
  hasShip = true,
): number {
  const id = nextTowerId++;
  const [fx, fy] = nearestFreeSpot(x, y);
  facing = facing ?? facingTowardInGate(fx, fy);
  towers.set(id, {
    x: fx,
    y: fy,
    type,
    level: 1,
    state: "proposed",
    menuOpen,
    menuCategory: "root",
    expireAt: hasShip ? 0 : realClock + 8,
    hasShip,
    invested: 0,
    actionsUntil: 0,
    targetMode: "first",
    facing,
    cooldown: 0,
    sellConfirmUntil: 0,
  });
  return id;
}

// Shared by the touch ⬆ button and the seat-a-piece-and-turn gesture.
function tryUpgrade(tower: Tower): void {
  if (tower.type === "wall" || tower.level >= maxLevel(tower.type)) return;
  const price = upgradeCost(tower.type, tower.level);
  if (money < price) {
    warn(`Need $${price}`);
    return;
  }
  money -= price;
  tower.invested += price;
  tower.level += 1;
  SFX.upgrade();
  bursts.push({
    x: tower.x,
    y: tower.y,
    radius: TOWER_RADIUS + 30,
    age: 0,
    color: TOWER_SPECS[tower.type].color,
  });
}

function cancelTower(id: number): void {
  const t = towers.get(id);
  if (!t || t.state !== "proposed") return;
  towers.delete(id);
  SFX.cancel();
}

// Pieces never build and never touch towers. The piece is an aiming DIAL:
// tap a laser/wave tower with a finger to LINK it to the dial, then rotate
// the piece — sitting anywhere on the table — to steer that tower.
let aimLinkTowerId: number | null = null;

// The dial is the OLDEST tracked piece: sensor ghosts are young and die
// fast, so they never get to steer.
function dialKey(): number | null {
  const first = ships.keys().next();
  return first.done ? null : first.value;
}

function steerLinkedTower(ship: Ship): void {
  if (aimLinkTowerId === null) return;
  const t = towers.get(aimLinkTowerId);
  if (!t || t.state !== "active") {
    aimLinkTowerId = null;
    return;
  }
  // Piece nose is opposite the sensor heading; keep facing in [0, 360).
  t.facing = (((ship.heading + 180) % 360) + 360) % 360;
}

function placePiece(
  contactId: number,
  x: number,
  y: number,
  glyphId: number,
  orientation: number,
): void {
  const ship: Ship = {
    x,
    y,
    glyphId,
    lastOrientation: orientation,
    heading: orientation,
    outlierCount: 0,
    lastSeen: realClock,
  };
  ships.set(contactId, ship);

  // Auto-link: setting the piece down near an aimable tower grabs it; if
  // the board has exactly one aimable tower, grab that one from anywhere.
  if (dialKey() === contactId) {
    const aimable = [...towers.entries()].filter(
      ([, t]) => t.state === "active" && (t.type === "laser" || t.type === "surge"),
    );
    let nearest: number | null = null;
    let bestDist = 200;
    for (const [id, t] of aimable) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < bestDist) {
        bestDist = d;
        nearest = id;
      }
    }
    if (nearest !== null) aimLinkTowerId = nearest;
    else if (aimable.length === 1) aimLinkTowerId = aimable[0][0];
    steerLinkedTower(ship);
  }
}

function movePiece(
  contactId: number,
  x: number,
  y: number,
  orientation: number,
): void {
  const ship = ships.get(contactId);
  if (!ship) return;
  ship.x = x;
  ship.y = y;
  ship.lastSeen = realClock;

  // The sensor sometimes emits a second GHOST reading for the same piece
  // (different spot under the footprint, garbage orientation) — those merge
  // into this ship by position. Defense: trust continuity. Small changes
  // track exactly; a big new heading must persist ~1.5s to be believed.
  const wrap180 = (d: number) => ((d % 360) + 540) % 360 - 180;
  const diff = wrap180(orientation - ship.heading);
  const stepFromLast = wrap180(orientation - ship.lastOrientation);
  ship.lastOrientation = orientation;
  if (Math.abs(diff) <= 30) {
    ship.heading = orientation; // steady tracking — exact, no drift
    ship.outlierCount = 0;
  } else if (Math.abs(stepFromLast) <= 15) {
    // A self-consistent challenger (genuine fast turn, or the real reading
    // after the trusted one died) — adopt only after ~1.5s of agreement.
    if (++ship.outlierCount >= 90) {
      ship.heading = orientation;
      ship.outlierCount = 0;
    }
  } else {
    ship.outlierCount = 0; // scattered noise — ignore entirely
  }

  if (dialKey() === contactId) steerLinkedTower(ship);
}

// Where pieces recently sat — a finger "appearing" there is almost always
// the sensor stuttering on a piece, not a real build press.
const recentShipSpots: Array<{ x: number; y: number; time: number }> = [];

function liftPiece(contactId: number): void {
  const ship = ships.get(contactId);
  if (ship) {
    while (recentShipSpots.length > 0 && realClock - recentShipSpots[0].time > 1.5) {
      recentShipSpots.shift();
    }
    recentShipSpots.push({ x: ship.x, y: ship.y, time: realClock });
  }
  ships.delete(contactId); // the tower keeps its aim; nothing else happens
}

// Is (x, y) ON a piece (or where one just was)? Hands holding pieces
// produce finger contacts there — they must never build. Kept tight to
// the piece's physical footprint so it doesn't eat taps beside it.
function nearAnyShip(x: number, y: number): boolean {
  const zone = PIECE_RADIUS * 1.05;
  for (const ship of ships.values()) {
    if (Math.hypot(ship.x - x, ship.y - y) < zone) return true;
  }
  for (const spot of recentShipSpots) {
    if (realClock - spot.time < 1.5 && Math.hypot(spot.x - x, spot.y - y) < zone) {
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ buttons

function buttonRect(): [number, number, number, number] {
  const w = 240;
  const h = 56;
  return [(canvas.width - w) / 2, canvas.height - h - 32, w, h];
}

function pointInButton(x: number, y: number): boolean {
  return inRect(x, y, buttonRect());
}

function resetButtonRect(): [number, number, number, number] {
  const w = 110;
  const h = 44;
  return [canvas.width - w - 28, canvas.height - h - 38, w, h];
}

function pointInResetButton(x: number, y: number): boolean {
  return inRect(x, y, resetButtonRect(), 8);
}

// Reset asks for confirmation — one stray tap must not wipe a run. The
// confirm is a centered modal, on top of everything, and swallows every
// tap while it's up.
let resetConfirmOpen = false;

function resetModalRect(): [number, number, number, number] {
  const w = 620;
  const h = 210;
  return [(canvas.width - w) / 2, (canvas.height - h) / 2, w, h];
}

function resetConfirmRect(): [number, number, number, number] {
  const [mx, my, mw, mh] = resetModalRect();
  return [mx + mw / 2 - 250, my + mh - 76, 230, 56];
}

function resetAbortRect(): [number, number, number, number] {
  const [mx, my, mw, mh] = resetModalRect();
  return [mx + mw / 2 + 20, my + mh - 76, 230, 56];
}

function speedButtonRect(): [number, number, number, number] {
  const w = 84;
  const h = 44;
  const [rx] = resetButtonRect();
  return [rx - w - 14, canvas.height - h - 38, w, h];
}

function pointInSpeedButton(x: number, y: number): boolean {
  return inRect(x, y, speedButtonRect(), 8);
}

// The action row a tower shows when tapped: ⬆ upgrade, ◎ mode (sniper),
// SELL. Hidden otherwise to keep the board clean.
interface ActionTag {
  key: "upgrade" | "mode" | "sell" | "aimL" | "aimR";
  label: string;
  color: string;
  rect: [number, number, number, number];
}

function actionTags(t: Tower): ActionTag[] {
  const spec = TOWER_SPECS[t.type];
  const defs: Array<{ key: ActionTag["key"]; label: string; color: string; w: number }> = [];
  if (t.type !== "wall" && t.level < maxLevel(t.type)) {
    defs.push({ key: "upgrade", label: `⬆ $${upgradeCost(t.type, t.level)}`, color: spec.color, w: 150 });
  }
  if (t.type === "sniper" || t.type === "mgun") {
    defs.push({ key: "mode", label: TARGET_MODE_LABEL[t.targetMode], color: spec.color, w: 140 });
  }
  if (t.type === "laser" || t.type === "surge") {
    // Precision aim: one degree per tap, piece optional.
    defs.push({ key: "aimL", label: "◀ 1°", color: spec.color, w: 80 });
    defs.push({ key: "aimR", label: "1° ▶", color: spec.color, w: 80 });
  }
  defs.push({ key: "sell", label: "SELL", color: COLOR_HINT, w: 100 });
  const h = 44;
  const gap = 8;
  const total = defs.reduce((s, d) => s + d.w, 0) + gap * (defs.length - 1);
  let x0 = uiX(t) - total / 2;
  const y = uiRowY(t, 26, h);
  return defs.map((d) => {
    const tag: ActionTag = { key: d.key, label: d.label, color: d.color, rect: [x0, y, d.w, h] };
    x0 += d.w + gap;
    return tag;
  });
}

// The ✓/✗ pair the tag expands into.
function sellConfirmRect(t: Tower): [number, number, number, number] {
  const w = 180;
  const h = 56;
  return [uiX(t) - w - 6, uiRowY(t, 34, h), w, h];
}

function sellAbortRect(t: Tower): [number, number, number, number] {
  const w = 56;
  const h = 56;
  return [uiX(t) + 6, uiRowY(t, 34, h), w, h];
}

// Tower UI (menus, buttons) sits below a piece in the top half of the board
// and above it in the bottom half, so nothing lands off the bottom edge.
function uiIsBelow(t: Tower): boolean {
  return t.y < canvas.height / 2;
}

// Horizontal anchor for a tower's UI: shifted inward so menus never slide
// behind the side walls (widest row spans ±215px around the anchor).
function uiX(t: Tower): number {
  return Math.max(PLAY_LEFT + 220, Math.min(playRight() - 220, t.x));
}

// y for a UI row: `offset` px beyond the tower ring on the UI side.
function uiRowY(t: Tower, offset: number, h: number): number {
  return uiIsBelow(t)
    ? t.y + TOWER_RADIUS + offset
    : t.y - TOWER_RADIUS - offset - h;
}

// Type-picker chips: 2 columns × 4 rows on the UI side of the proposal.
function typeChipRect(t: Tower, i: number): [number, number, number, number] {
  const w = 200;
  const h = 50;
  const col = i % 2;
  const row = Math.floor(i / 2);
  return [uiX(t) - w - 5 + col * (w + 10), uiRowY(t, 30 + row * (h + 8), h), w, h];
}

// BUY sits centered now — cancel is just "tap somewhere else".
// One menu at a time: close every open tower menu/action row and drop any
// unheld proposal (except the given tower's — and never one a finger is
// still holding, so a second finger can't wipe the first finger's ghost).
function closeAllMenus(exceptId?: number): void {
  for (const [tid, tw] of [...towers]) {
    if (tid === exceptId) continue;
    tw.actionsUntil = 0;
    tw.sellConfirmUntil = 0;
    if (tw.state === "proposed" && !tw.hasShip && ![...fingerDrags.values()].includes(tid)) {
      cancelTower(tid);
    }
  }
  towerKeyOpen = false;
  towerKeyPage = null;
}

// The last tower bought — offered as a quick-repeat chip in the root menu.
let lastPlacedType: TowerType | null = null;

// Root menu: ⚔ DAMAGE / ✦ EFFECT, plus a repeat chip once there's history.
function rootChipCount(): number {
  return lastPlacedType === null ? 2 : 3;
}

function rootChipRect(t: Tower, i: number): [number, number, number, number] {
  const h = 50;
  const y = uiRowY(t, 30, h);
  if (rootChipCount() === 2) {
    const w = 200;
    return [uiX(t) - w - 5 + i * (w + 10), y, w, h];
  }
  const w = 138;
  const gap = 8;
  const total = 3 * w + gap * 2;
  return [uiX(t) - total / 2 + i * (w + gap), y, w, h];
}

// Buy `type` for the proposal — shared by the category chips and the
// repeat chip. Handles every warn/cancel path itself.
function buyProposal(id: number, t: Tower, type: TowerType): void {
  const spec = TOWER_SPECS[type];
  if (type === "farm" && activeBank()) {
    warn("Only one bank per game");
    return;
  }
  if (money < spec.cost) {
    warn(`Need $${spec.cost}`);
    return; // menu stays open
  }
  t.type = type;
  if (type !== "poison" && !placementLegal(t.x, t.y)) {
    warn(gameMode === "path" ? "Can't build on the creeps' road!" : "That would wall off the path!");
    cancelTower(id);
    return;
  }
  money -= spec.cost;
  t.invested = spec.cost;
  t.state = "active";
  t.menuOpen = false;
  t.menuCategory = "root";
  lastPlacedType = type;
  if (type === "militia") spawnSquad(id, t);
  rebuildFlow();
  SFX.buy();
  bursts.push({ x: t.x, y: t.y, radius: TOWER_RADIUS + 30, age: 0, color: spec.color });
}

// Tower Key: bottom-left button toggling a reference directory; tapping a
// row opens that tower's detail page.
let towerKeyOpen = false;
let towerKeyPage: TowerType | null = null;

function towerKeyButtonRect(): [number, number, number, number] {
  return [28, canvas.height - 44 - 38, 150, 44];
}

function handleTap(x: number, y: number): boolean {
  ensureAudio();
  if (resetConfirmOpen) {
    // Modal: the top element — it swallows every tap on the board.
    if (inRect(x, y, resetConfirmRect(), 8)) {
      resetConfirmOpen = false;
      void wipeSave();
      lastClearSnap = null;
      prevClearSnap = null;
      restart();
      SFX.tap();
    } else {
      resetConfirmOpen = false;
      SFX.cancel();
    }
    return true;
  }
  if (phase === "gameover" || phase === "victory") {
    sparks.length = 0;
    restart();
    SFX.tap();
    return true;
  }
  if (waveSummary !== null && realClock < waveSummary.until) {
    // Any tap dismisses the wave report; taps ON it are consumed, taps
    // elsewhere still do whatever they were aimed at.
    const inside = inRect(x, y, waveSummaryRect(), 8);
    waveSummary = null;
    if (inside) {
      SFX.tap();
      return true;
    }
  }
  if (towerKeyOpen) {
    if (towerKeyPage === null) {
      // Directory: a row opens that tower's page, anything else closes.
      const rows = towerKeyRows();
      for (let i = 0; i < rows.length; i++) {
        if (inRect(x, y, towerKeyRowRect(i), 0)) {
          towerKeyPage = rows[i].type;
          SFX.tap();
          return true;
        }
      }
      towerKeyOpen = false;
      SFX.tap();
      return true;
    }
    // Detail page: BACK returns to the directory, anything else closes.
    if (inRect(x, y, towerKeyBackRect(), 8)) {
      towerKeyPage = null;
      SFX.tap();
      return true;
    }
    towerKeyOpen = false;
    towerKeyPage = null;
    SFX.tap();
    return true;
  }
  for (const [id, t] of towers) {
    if (t.state !== "proposed") continue;
    if (t.menuOpen) {
      if (t.menuCategory === "root") {
        // Category chips + quick-repeat — no cancel; tapping elsewhere
        // replaces the proposal, lifting the piece removes it.
        for (let i = 0; i < rootChipCount(); i++) {
          if (!inRect(x, y, rootChipRect(t, i), 4)) continue;
          if (i === 2 && lastPlacedType !== null) {
            buyProposal(id, t, lastPlacedType);
            return true;
          }
          t.menuCategory = i === 0 ? "damage" : "effect";
          if (t.expireAt > 0) t.expireAt = realClock + 20;
          SFX.tap();
          return true;
        }
        continue;
      }
      // Category page: its towers, then ◀ BACK.
      const list = MENU_CATEGORIES[t.menuCategory];
      for (let i = 0; i <= list.length; i++) {
        if (!inRect(x, y, typeChipRect(t, i), 4)) continue;
        if (i === list.length) {
          t.menuCategory = "root";
          SFX.tap();
          return true;
        }
        // Picking a tower buys it on the spot — no separate BUY step.
        buyProposal(id, t, list[i]);
        return true;
      }
      continue;
    }
  }
  // Menus float above everything: check EVERY open menu's buttons before any
  // tower body, so a button covering a tower wins the tap.
  for (const [id, t] of towers) {
    if (t.state !== "active") continue;
    if (realClock < t.sellConfirmUntil) {
      // Confirmation open: ✓ sells, ✗ closes.
      if (inRect(x, y, sellConfirmRect(t), 5)) {
        money += sellValue(t);
        towers.delete(id);
        for (let i = militias.length - 1; i >= 0; i--) {
          if (militias[i].towerId === id) militias.splice(i, 1);
        }
        if (aimLinkTowerId === id) aimLinkTowerId = null;
        rebuildFlow();
        SFX.sell();
        return true;
      }
      if (inRect(x, y, sellAbortRect(t), 5)) {
        t.sellConfirmUntil = 0;
        SFX.cancel();
        return true;
      }
    } else if (realClock < t.actionsUntil) {
      for (const tag of actionTags(t)) {
        if (!inRect(x, y, tag.rect, 4)) continue;
        if (tag.key === "sell") {
          t.sellConfirmUntil = realClock + 3;
        } else if (tag.key === "upgrade") {
          tryUpgrade(t);
          t.actionsUntil = realClock + 4;
        } else if (tag.key === "aimL" || tag.key === "aimR") {
          t.facing = (t.facing + (tag.key === "aimL" ? -1 : 1) + 360) % 360;
          t.actionsUntil = realClock + 6; // keep it selected for fine-tuning
        } else {
          const i = TARGET_MODE_ORDER.indexOf(t.targetMode);
          t.targetMode = TARGET_MODE_ORDER[(i + 1) % TARGET_MODE_ORDER.length];
          t.actionsUntil = realClock + 4;
        }
        SFX.tap();
        return true;
      }
    }
  }
  // HUD buttons sit UNDER floating tower UI — a menu drawn over them wins
  // the tap, matching what the eye sees.
  if (pointInResetButton(x, y)) {
    closeAllMenus();
    resetConfirmOpen = true;
    SFX.tap();
    return true;
  }
  if (pointInSpeedButton(x, y)) {
    speedFactor = speedFactor === 1 ? 3 : speedFactor === 3 ? 6 : 1;
    SFX.tap();
    return true;
  }
  if (inRect(x, y, towerKeyButtonRect(), 8)) {
    closeAllMenus();
    towerKeyOpen = true;
    towerKeyPage = null;
    SFX.tap();
    return true;
  }
  if (preGame()) {
    for (let i = 0; i < GAME_MODES.length; i++) {
      if (inRect(x, y, modeButtonRect(i), 6)) {
        gameMode = GAME_MODES[i];
        applyGameMode();
        SFX.tap();
        return true;
      }
    }
    for (let i = 0; i < DIFFICULTIES.length; i++) {
      if (inRect(x, y, difficultyButtonRect(i), 6)) {
        difficulty = DIFFICULTIES[i];
        SFX.tap();
        return true;
      }
    }
  }
  // Previous Wave: rewind one wave — available any time there's history.
  if (
    (lastClearSnap !== null || prevClearSnap !== null || resumeAvailable) &&
    inRect(x, y, resumeButtonRect(), 8)
  ) {
    previousWave();
    SFX.tap();
    return true;
  }
  // The player switcher works between waves too — each player has their
  // own save, and switching swaps the whole game to theirs.
  if (phase === "idle" && inRect(x, y, playerButtonRect(), 8)) {
    pickPlayer();
    SFX.tap();
    return true;
  }
  // Tower bodies, only after every floating button has had its chance.
  for (const [id, t] of towers) {
    if (t.state !== "active") continue;
    if (realClock < t.sellConfirmUntil) continue; // answer the confirm first
    const tapR = t.type === "farm" ? bankVisualRadius(t.level) : TOWER_RADIUS;
    if (Math.hypot(x - t.x, y - t.y) <= tapR) {
      // Tap the tower to open (or close) its action row. Aimable towers
      // also link to the aiming piece.
      if (t.type === "laser" || t.type === "surge") {
        aimLinkTowerId = id;
      }
      const wasOpen = realClock < t.actionsUntil;
      closeAllMenus(id);
      t.actionsUntil = wasOpen ? 0 : realClock + 4;
      SFX.tap();
      return true;
    }
  }
  if (phase === "idle" && pointInButton(x, y)) {
    startWave();
    return true;
  }
  // A selected militia tower claims any open-ground tap as a rally order.
  for (const [, t] of towers) {
    if (t.state === "active" && t.type === "militia" && realClock < t.actionsUntil) {
      t.rallyX = Math.max(PLAY_LEFT + 20, Math.min(playRight() - 20, x));
      t.rallyY = Math.max(PLAY_TOP + 20, Math.min(playBottom() - 20, y));
      t.actionsUntil = realClock + 4; // stay selected for follow-up orders
      SFX.tap();
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------- touch placement

// Press on open ground: a proposal appears and follows the finger (snapped
// to the grid) until the finger lifts — then the type menu opens.
const fingerDrags = new Map<number | string, number>(); // fingerId -> towerId

function touchDown(x: number, y: number, fingerId: number | string): void {
  if (handleTap(x, y)) return;
  if (phase === "gameover" || phase === "victory") return;
  // Fingers gripping a piece are not build presses.
  if (nearAnyShip(x, y)) return;
  // One menu at a time: a new ground-press replaces any unbought touch
  // proposal and closes every open menu.
  closeAllMenus();
  // The ghost wears the last-placed tower's look (and radius) so a second
  // finger can confirm an instant repeat buy.
  const id = proposeTower(x, y, lastPlacedType ?? "wall", undefined, false, false);
  const t = towers.get(id)!;
  t.expireAt = 0; // no expiry while held
  fingerDrags.set(fingerId, id);
  SFX.tap();
}

function touchMove(x: number, y: number, fingerId: number | string): void {
  const id = fingerDrags.get(fingerId);
  if (id === undefined) return;
  const t = towers.get(id);
  if (!t || t.state !== "proposed") {
    fingerDrags.delete(fingerId);
    return;
  }
  // The ghost refuses to enter occupied space OR a spot that would choke
  // off the creeps' path — it waits at its last good spot, so the player
  // learns "too close" while dragging, not at the moment of purchase.
  const nx = snapX(x);
  const ny = snapY(y);
  if ((nx !== t.x || ny !== t.y) && spotIsFree(nx, ny, id) && ghostSpotLegal(t, nx, ny)) {
    t.x = nx;
    t.y = ny;
  }
}

// placementLegal runs a full flow rebuild — cache the last answer so a
// held finger doesn't recompute it every input frame.
let ghostLegalKey = "";
let ghostLegalVal = true;

function ghostSpotLegal(t: Tower, x: number, y: number): boolean {
  if (t.type === "poison") return true; // walkable ooze sits anywhere
  const key = `${x}|${y}|${towers.size}|${gameMode}`;
  if (key === ghostLegalKey) return ghostLegalVal;
  ghostLegalKey = key;
  ghostLegalVal = placementLegal(x, y);
  return ghostLegalVal;
}

function touchUp(fingerId: number | string): void {
  const id = fingerDrags.get(fingerId);
  fingerDrags.delete(fingerId);
  if (id === undefined) return;
  const t = towers.get(id);
  if (!t || t.state !== "proposed") return;
  t.menuOpen = true;
  t.expireAt = realClock + 8;
}

// --------------------------------------------------------------- simulation

function activeTowers(): Tower[] {
  return [...towers.values()].filter((t) => t.state === "active");
}

// Aggregate aura bonuses a shooting tower receives from nearby buff towers.
// Same-type buffs don't stack — the strongest wins per stat.
function buffMultipliers(t: Tower, live: Tower[]): { dmg: number; rate: number; rng: number } {
  let dmg = 1;
  let rate = 1;
  let rng = 1;
  for (const b of live) {
    if (b.type !== "power" && b.type !== "haste" && b.type !== "scope") continue;
    if (Math.hypot(b.x - t.x, b.y - t.y) > TOWER_SPECS[b.type].range) continue;
    if (b.type === "power") dmg = Math.max(dmg, POWER_MUL_BY_LEVEL[b.level - 1]);
    else if (b.type === "haste") rate = Math.max(rate, HASTE_MUL_BY_LEVEL[b.level - 1]);
    else rng = Math.max(rng, SCOPE_MUL_BY_LEVEL[b.level - 1]);
  }
  return { dmg, rate, rng };
}

function spawnEnemy(entry: SpawnEntry): void {
  // Single file out of the left gate: prefer its middle row.
  const gates = gateRows();
  let row = gates[Math.floor(gates.length / 2)];
  for (const cy of gates) {
    const i = cellIndex(0, cy);
    if (!blocked[i] && flowDist[i] !== Infinity) {
      row = cy;
      break;
    }
  }
  spawnCounter++;
  enemies.push({
    x: CELL / 2,
    y: row * CELL + CELL / 2,
    kind: entry.kind,
    hp: entry.hp,
    maxHp: entry.hp,
    speed: entry.speed,
    radius: entry.radius,
    slowFactor: 1,
    poisonDps: 0,
    poisonUntil: 0,
    remaining: Number.MAX_SAFE_INTEGER,
    variant: spawnCounter % 3,
  });
}

function updateFireworks(dt: number): void {
  nextFirework -= dt;
  if (nextFirework <= 0) {
    nextFirework = 0.3 + Math.random() * 0.4;
    const cx = canvas.width * (0.1 + Math.random() * 0.8);
    const cy = canvas.height * (0.15 + Math.random() * 0.5);
    const hue = Math.floor(Math.random() * 360);
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2;
      const speed = 90 + Math.random() * 220;
      sparks.push({
        x: cx,
        y: cy,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 1.1 + Math.random() * 0.7,
        color: `hsl(${hue + Math.floor(Math.random() * 40)} 90% 65%)`,
      });
    }
  }
  for (const s of sparks) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy += 130 * dt; // gravity
    s.life -= dt;
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    if (sparks[i].life <= 0) sparks.splice(i, 1);
  }
}

// ------------------------------------------------------------------ militia

function rallyPoint(t: Tower): [number, number] {
  return [t.rallyX ?? t.x, t.rallyY ?? t.y - TOWER_RADIUS - 20];
}

function rallySlot(t: Tower, slot: number): [number, number] {
  const [rx, ry] = rallyPoint(t);
  const offs = [[0, -14], [14, 0], [0, 14], [-14, 0]] as const;
  return [rx + offs[slot % 4][0], ry + offs[slot % 4][1]];
}

function spawnSquad(id: number, t: Tower): void {
  for (let s = 0; s < MILITIA_COUNT; s++) {
    const hp = MILITIA_HP_BY_LEVEL[t.level - 1];
    militias.push({ x: t.x, y: t.y, hp, maxHp: hp, towerId: id, slot: s, powered: false, ranged: false, shotCd: 0 });
  }
  t.cooldown = MILITIA_RESPAWN;
}

function updateMilitias(dt: number): void {
  const live = activeTowers();
  // Respawns: each guard house refills one fallen soldier per timer tick.
  // HASTE HUT speeds production.
  for (const [id, t] of towers) {
    if (t.state !== "active" || t.type !== "militia") continue;
    const buff = buffMultipliers(t, live);
    const alive = militias.reduce((n, m) => n + (m.towerId === id ? 1 : 0), 0);
    if (alive < MILITIA_COUNT) {
      t.cooldown -= dt * buff.rate;
      if (t.cooldown <= 0) {
        t.cooldown = MILITIA_RESPAWN;
        const hp = MILITIA_HP_BY_LEVEL[t.level - 1];
        const slots = new Set(militias.filter((m) => m.towerId === id).map((m) => m.slot));
        let slot = 0;
        while (slots.has(slot)) slot++;
        militias.push({ x: t.x, y: t.y, hp, maxHp: hp, towerId: id, slot, powered: false, ranged: false, shotCd: 0 });
      }
    } else {
      t.cooldown = MILITIA_RESPAWN;
    }
  }
  // Soldiers: charge the nearest creep in aggro range, else hold the rally.
  // POWER PLANT makes them hit harder (and look it); SCOPE STUDIO turns
  // them into ranged fighters.
  for (const m of militias) {
    const t = towers.get(m.towerId);
    if (!t) continue;
    const buff = buffMultipliers(t, live);
    m.powered = buff.dmg > 1.001;
    m.ranged = buff.rng > 1.001;
    const dmg = TOWER_SPECS.militia.damageByLevel[t.level - 1] * buff.dmg;
    let target: Enemy | null = null;
    let td = MILITIA_AGGRO;
    for (const e of enemies) {
      const d = Math.hypot(e.x - m.x, e.y - m.y);
      if (d < td) {
        target = e;
        td = d;
      }
    }
    if (target) {
      const standoff = m.ranged ? 110 : MILITIA_RADIUS + target.radius + 4;
      if (td > standoff) {
        m.x += ((target.x - m.x) / td) * MILITIA_SPEED * dt;
        m.y += ((target.y - m.y) / td) * MILITIA_SPEED * dt;
      } else if (m.ranged) {
        m.shotCd -= dt;
        if (m.shotCd <= 0) {
          m.shotCd = 0.5;
          target.hp -= dmg * 0.5; // same dps as melee, delivered in shots
          beams.push({ x1: m.x, y1: m.y, x2: target.x, y2: target.y, color: TOWER_SPECS.scope.color, age: 0, width: 2 });
        }
      } else {
        target.hp -= dmg * dt; // sword work; the central death sweep pays out
      }
    } else {
      const [rx, ry] = rallySlot(t, m.slot);
      const d = Math.hypot(rx - m.x, ry - m.y);
      if (d > 4) {
        m.x += ((rx - m.x) / d) * MILITIA_SPEED * dt;
        m.y += ((ry - m.y) / d) * MILITIA_SPEED * dt;
      }
    }
    m.y = Math.max(PLAY_TOP + MILITIA_RADIUS, Math.min(playBottom() - MILITIA_RADIUS, m.y));
  }
  // Soldiers can't stack: overlapping pairs push apart, so a squad fans out
  // and SURROUNDS its target instead of piling onto one pixel.
  for (let i = 0; i < militias.length; i++) {
    for (let j = i + 1; j < militias.length; j++) {
      const a = militias[i];
      const b = militias[j];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const min = MILITIA_RADIUS * 2 + 2;
      if (d === 0) {
        b.x += 2;
      } else if (d < min) {
        const push = (min - d) / 2;
        const ux = (b.x - a.x) / d;
        const uy = (b.y - a.y) / d;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
    }
  }
  // The fallen leave the field.
  for (let i = militias.length - 1; i >= 0; i--) {
    if (militias[i].hp <= 0) militias.splice(i, 1);
  }
}

function update(dt: number): void {
  clock += dt;

  if (phase === "victory") {
    updateFireworks(dt);
    return;
  }
  if (money >= WIN_GOLD) {
    phase = "victory";
    enemies = [];
    spawnQueue = [];
    SFX.waveClear();
    return;
  }

  // Ignored touch proposals evaporate.
  for (const [id, t] of [...towers]) {
    if (t.state === "proposed" && t.expireAt > 0 && realClock > t.expireAt) {
      towers.delete(id);
    }
  }

  // Spawning.
  if (phase === "wave" && spawnQueue.length > 0) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      const entry = spawnQueue.shift()!;
      spawnTimer = entry.gap;
      spawnEnemy(entry);
    }
  }

  // Frost + poison fields, then the pathfinding march.
  const live = activeTowers();
  const frosts = live.filter((t) => t.type === "frost");
  const poisons = live.filter((t) => t.type === "poison");
  for (const e of enemies) {
    e.slowFactor = 1;
    for (const f of frosts) {
      if (Math.hypot(e.x - f.x, e.y - f.y) <= TOWER_SPECS.frost.range) {
        e.slowFactor = Math.min(e.slowFactor, FROST_FACTOR_BY_LEVEL[f.level - 1]);
      }
    }
    for (const p of poisons) {
      if (Math.hypot(e.x - p.x, e.y - p.y) <= TOWER_SPECS.poison.range) {
        // Walking through the field coats them in venom for 5 seconds.
        const dps = TOWER_SPECS.poison.damageByLevel[p.level - 1] / POISON_DURATION;
        e.poisonDps = Math.max(e.poisonDps, dps);
        e.poisonUntil = clock + POISON_DURATION;
      }
    }
    // Rangers stop and shoot the nearest soldier from a distance.
    if (e.kind === "ranger") {
      let mark: Militia | null = null;
      let md = 120;
      for (const m of militias) {
        const d = Math.hypot(e.x - m.x, e.y - m.y);
        if (d < md) {
          mark = m;
          md = d;
        }
      }
      if (mark) {
        e.attackCd = (e.attackCd ?? 0) - dt;
        if (e.attackCd <= 0) {
          e.attackCd = 0.6;
          mark.hp -= 1 + e.maxHp * 0.06;
          beams.push({ x1: e.x, y1: e.y, x2: mark.x, y2: mark.y, color: "#ffa94d", age: 0, width: 2 });
        }
        e.remaining = remainingFor(e.x, e.y);
        if (clock < e.poisonUntil) e.hp -= e.poisonDps * dt;
        continue;
      }
    }
    // A soldier in contact stops the creep cold — it turns and fights him.
    // Brutes swing wide: their blows cleave EVERY soldier near them.
    let foe: Militia | null = null;
    for (const m of militias) {
      if (Math.hypot(e.x - m.x, e.y - m.y) <= MILITIA_RADIUS + e.radius + 6) {
        foe = m;
        break;
      }
    }
    if (foe) {
      const dps = (1 + e.maxHp * 0.04) * dt;
      if (e.kind === "brute") {
        for (const m of militias) {
          if (Math.hypot(e.x - m.x, e.y - m.y) <= e.radius + 45) m.hp -= dps;
        }
      } else {
        foe.hp -= dps;
      }
      e.remaining = remainingFor(e.x, e.y);
      if (clock < e.poisonUntil) e.hp -= e.poisonDps * dt;
      continue;
    }
    const [dx, dy] = flowDirection(e.x, e.y);
    const v = e.speed * e.slowFactor * dt;
    e.x += dx * v;
    e.y += dy * v;
    e.y = Math.max(PLAY_TOP + e.radius, Math.min(playBottom() - e.radius, e.y));
    e.remaining = remainingFor(e.x, e.y);
    if (clock < e.poisonUntil) e.hp -= e.poisonDps * dt; // venom drips
  }

  // Leaks: walked off the right edge.
  const leaked = enemies.filter((e) => e.x >= canvas.width - CELL / 4).length;
  if (leaked > 0) {
    lives -= leaked;
    enemies = enemies.filter((e) => e.x < canvas.width - CELL / 4);
    SFX.leak();
  }
  if (lives <= 0) {
    lives = 0;
    phase = "gameover";
    enemies = [];
    spawnQueue = [];
    SFX.gameOver();
    return;
  }

  updateMilitias(dt);

  // Towers act.
  for (const t of live) {
    const spec = TOWER_SPECS[t.type];
    if (spec.fireInterval === 0) continue; // frost/wall/buffs: passive
    const buff = buffMultipliers(t, live);

    if (t.type === "crop") {
      // Farm: a trickle of gold while a wave is running. POWER PLANT
      // fattens the payout; HASTE HUT speeds the harvest.
      if (phase !== "wave") continue;
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      t.cooldown = spec.fireInterval / buff.rate;
      const payout = Math.round(spec.damageByLevel[t.level - 1] * buff.dmg);
      money += payout;
      waveFarmGold += payout;
      bursts.push({ x: t.x, y: t.y, radius: TOWER_RADIUS + 12, age: 0, color: spec.color });
      continue;
    }

    if (t.type === "surge") {
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      const angle = (t.facing * Math.PI) / 180;
      const halfW = SURGE_HALF_WIDTH_BY_LEVEL[t.level - 1];
      const push = SURGE_PUSH_BY_LEVEL[t.level - 1];
      const surgeRange = spec.range * buff.rng;
      const pct = Math.min(0.8, SURGE_PCT_BY_LEVEL[t.level - 1] * buff.dmg);
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      // Hold fire until a creep is within the NEAR half of the lane — no
      // wasting waves on stragglers at the far end.
      let triggered = false;
      for (const e of enemies) {
        const along = (e.x - t.x) * ux + (e.y - t.y) * uy;
        const across = Math.abs(ux * (e.y - t.y) - uy * (e.x - t.x));
        if (along > 0 && along <= surgeRange * 0.5 && across <= halfW) {
          triggered = true;
          break;
        }
      }
      if (!triggered) continue;
      let hit = false;
      for (const e of enemies) {
        const px = e.x - t.x;
        const py = e.y - t.y;
        // Straight lane: forward along the facing, and sideways off the
        // lane's center line. Nothing beside or behind the tower is touched.
        const along = px * ux + py * uy;
        const across = Math.abs(ux * py - uy * px);
        if (along <= 0 || along > surgeRange || across > halfW) continue;
        hit = true;
        // Strip a percentage of CURRENT life — never an outright kill.
        e.hp = Math.max(0.2, e.hp * (1 - pct));
        // Shove along the wave direction — clear OVER towers and walls,
        // landing on the nearest walkable ground. That launch is the whole
        // point of the price tag.
        const nx = e.x + ux * push;
        const ny = e.y + uy * push;
        [e.x, e.y] = nearestWalkable(
          Math.max(e.radius, Math.min(canvas.width - CELL, nx)),
          Math.max(e.radius, Math.min(canvas.height - e.radius, ny)),
        );
      }
      if (hit) {
        t.cooldown = spec.fireInterval / buff.rate;
        surgeWaves.push({ x: t.x, y: t.y, angle, halfWidth: halfW, range: surgeRange, age: 0 });
        SFX.surge();
      }
      continue;
    }

    if (t.type === "bolt") {
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      const damage = spec.damageByLevel[t.level - 1] * buff.dmg;
      // Strike the furthest-along enemy in range, then chain to the nearest
      // unhit neighbor, hop by hop, up to 4 victims.
      let first: Enemy | null = null;
      for (const e of enemies) {
        if (Math.hypot(e.x - t.x, e.y - t.y) > spec.range * buff.rng) continue;
        if (!first || e.remaining < first.remaining) first = e;
      }
      if (!first) continue;
      t.cooldown = spec.fireInterval / buff.rate;
      const chain: Enemy[] = [first];
      while (chain.length < BOLT_CHAIN_BY_LEVEL[t.level - 1]) {
        const last = chain[chain.length - 1];
        let next: Enemy | null = null;
        let nd = Infinity;
        for (const e of enemies) {
          if (chain.includes(e)) continue;
          const d = Math.hypot(e.x - last.x, e.y - last.y);
          if (d <= BOLT_CHAIN_RADIUS && d < nd) {
            next = e;
            nd = d;
          }
        }
        if (!next) break;
        chain.push(next);
      }
      let fromX = t.x;
      let fromY = t.y;
      for (const e of chain) {
        e.hp -= damage;
        boltStrikes.push({
          x1: fromX, y1: fromY, x2: e.x, y2: e.y,
          age: 0, color: spec.color, width: 3,
        });
        fromX = e.x;
        fromY = e.y;
      }
      const cx = chain.reduce((s, e) => s + e.x, 0) / chain.length;
      const cy = chain.reduce((s, e) => s + e.y, 0) / chain.length;
      boltFlashes.push({ x: cx, y: cy, age: 0 });
      SFX.bolt();
      continue;
    }

    if (t.type === "splash") {
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      const damage = spec.damageByLevel[t.level - 1] * buff.dmg;
      const splashRange = splashRangeAt(t.level) * buff.rng;
      let hit = false;
      for (const e of enemies) {
        if (Math.hypot(e.x - t.x, e.y - t.y) <= splashRange) {
          e.hp -= damage;
          hit = true;
        }
      }
      if (hit) {
        t.cooldown = spec.fireInterval / buff.rate;
        SFX.splash();
        bursts.push({ x: t.x, y: t.y, radius: splashRange, age: 0, color: spec.color });
      }
      continue;
    }


    if (t.type === "laser") {
      // Fixed direction: the beam goes exactly where the piece points and
      // fires whenever anything is standing in the line.
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      const damage = spec.damageByLevel[t.level - 1];
      const angle = (t.facing * Math.PI) / 180;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const victims: Enemy[] = [];
      for (const e of enemies) {
        const px = e.x - t.x;
        const py = e.y - t.y;
        if (px * ux + py * uy < 0) continue;
        const perp = Math.abs(px * uy - py * ux);
        if (perp <= LASER_BEAM_HALF_WIDTH) victims.push(e);
      }
      if (victims.length === 0) continue;
      t.cooldown = spec.fireInterval / buff.rate;
      for (const e of victims) e.hp -= damage * buff.dmg;
      SFX.laser();
      const beamLength = canvas.width + canvas.height;
      beams.push({
        x1: t.x,
        y1: t.y,
        x2: t.x + ux * beamLength,
        y2: t.y + uy * beamLength,
        age: 0,
        color: spec.color,
        width: 4 + t.level * 2,
      });
      continue;
    }

    // Sniper & machine gun: single target, picked per target mode.
    t.cooldown -= dt;
    if (t.cooldown > 0) continue;
    const damage = spec.damageByLevel[t.level - 1] * buff.dmg;
    let target: Enemy | null = null;
    let bestScore = -Infinity;
    for (const e of enemies) {
      const d = Math.hypot(e.x - t.x, e.y - t.y);
      if (d > spec.range * buff.rng) continue;
      const score =
        t.targetMode === "first" ? -e.remaining :
        t.targetMode === "last" ? e.remaining :
        e.hp;
      if (!target || score > bestScore) {
        target = e;
        bestScore = score;
      }
    }
    if (!target) continue;
    t.cooldown = spec.fireInterval / buff.rate;
    if (t.type === "sniper") {
      // Strips a % of the target's CURRENT hp (5/10/15% by level).
      const pct = Math.min(0.5, spec.damageByLevel[t.level - 1] * buff.dmg);
      target.hp -= target.hp * pct;
    } else {
      target.hp -= damage;
    }
    if (t.type === "mgun") SFX.mgun();
    else SFX.sniper();
    beams.push({
      x1: t.x, y1: t.y, x2: target.x, y2: target.y,
      age: 0, color: spec.color, width: t.type === "mgun" ? 2 : 3,
    });
  }

  // Deaths pay out. Bounty grows with the square root of toughness so the
  // late game doesn't drown in gold; bosses pay half their bulk.
  let died = false;
  for (const e of enemies) {
    if (e.hp <= 0) {
      kills += 1;
      // Bounties grow with the square root of hp — hp compounds every wave,
      // so a linear cut of it would flood the game with gold.
      const lean = leanWave(wave) ? LEAN_BOUNTY_SCALE : 1;
      const bounty =
        e.kind === "boss"
          ? Math.round(Math.sqrt(e.maxHp) * 6 * lean)
          : Math.ceil(Math.sqrt(e.maxHp) * lean);
      money += bounty;
      waveKillGold += bounty;
      died = true;
    }
  }
  if (died) SFX.die();
  enemies = enemies.filter((e) => e.hp > 0);

  // Effect fade.
  for (const b of beams) b.age += dt;
  while (beams.length > 0 && beams[0].age > BEAM_LIFETIME) beams.shift();
  for (const b of bursts) b.age += dt;
  while (bursts.length > 0 && bursts[0].age > 0.25) bursts.shift();
  for (const s of surgeWaves) s.age += dt;
  while (surgeWaves.length > 0 && surgeWaves[0].age > 0.45) surgeWaves.shift();
  for (const b of boltStrikes) b.age += dt;
  while (boltStrikes.length > 0 && boltStrikes[0].age > 0.22) boltStrikes.shift();
  for (const f of boltFlashes) f.age += dt;
  while (boltFlashes.length > 0 && boltFlashes[0].age > 0.35) boltFlashes.shift();

  // Wave cleared.
  if (phase === "wave" && spawnQueue.length === 0 && enemies.length === 0) {
    const bonus = waveClearBonus(wave);
    money += bonus;
    // The bank pays its interest on whatever you're holding at wave's end.
    let interest = 0;
    const bank = activeBank();
    if (bank && money > 0) {
      interest = Math.round(money * bankInterest(bank.level));
      money += interest;
      SFX.farm();
      bursts.push({ x: bank.x, y: bank.y, radius: bankVisualRadius(bank.level) + 24, age: 0, color: TOWER_SPECS.farm.color });
    }
    waveSummary = {
      wave,
      kills: waveKillGold,
      bonus,
      farm: waveFarmGold,
      bank: interest,
      until: realClock + 7,
    };
    phase = "idle";
    SFX.waveClear();
    prevClearSnap = lastClearSnap;
    lastClearSnap = serializeGame();
    void autoSave();
  }
}

// ---------------------------------------------------------------- drawing

// Warcraft-style button: dark stone slab, gold trim, corner studs.
function fancyButton(
  rect: readonly [number, number, number, number],
  label: string,
  opts: { accent?: string; labelColor?: string; font?: string; alpha?: number } = {},
): void {
  const [x, y, w, h] = rect;
  const accent = opts.accent ?? "#eaaf33";
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  // Chamfered plate — cut corners, no curves.
  const cham = (px: number, py: number, pw: number, ph: number, c: number) => {
    ctx.beginPath();
    ctx.moveTo(px + c, py);
    ctx.lineTo(px + pw - c, py);
    ctx.lineTo(px + pw, py + c);
    ctx.lineTo(px + pw, py + ph - c);
    ctx.lineTo(px + pw - c, py + ph);
    ctx.lineTo(px + c, py + ph);
    ctx.lineTo(px, py + ph - c);
    ctx.lineTo(px, py + c);
    ctx.closePath();
  };
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "#2b4a68");
  g.addColorStop(0.5, "#1c3144");
  g.addColorStop(1, "#0e1927");
  ctx.fillStyle = g;
  cham(x, y, w, h, 9);
  ctx.fill();
  ctx.strokeStyle = "#05070d";
  ctx.lineWidth = 2;
  ctx.stroke();
  cham(x + 3, y + 3, w - 6, h - 6, 7);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Rivets.
  ctx.fillStyle = accent;
  for (const [sx, sy] of [
    [x + 5, y + 5], [x + w - 10, y + 5], [x + 5, y + h - 10], [x + w - 10, y + h - 10],
  ] as const) {
    ctx.fillRect(sx, sy, 5, 5);
  }
  // Label with a hard shadow.
  ctx.font = opts.font ?? "bold 17px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillText(label, x + w / 2 + 1, y + h / 2 + 3);
  ctx.fillStyle = opts.labelColor ?? COLOR_TEXT;
  ctx.fillText(label, x + w / 2, y + h / 2 + 1);
  ctx.restore();
}

const ACCENT_DIM = "#5a6172"; // muted steel accent for secondary buttons

// Hard angular filigree: a Greek-key meander strip plus corner chevrons,
// filling the dead space in the HUD strips. Geometric, not ornate.
function drawFiligree(): void {
  ctx.strokeStyle = "#2b4a66";
  ctx.lineWidth = 2;
  const meander = (y: number, size: number) => {
    ctx.beginPath();
    for (let x = 30; x < canvas.width - 30 - size * 2; x += size * 2) {
      ctx.moveTo(x, y + size);
      ctx.lineTo(x, y);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x + size, y + size * 0.6);
      ctx.lineTo(x + size * 1.6, y + size * 0.6);
      ctx.lineTo(x + size * 1.6, y + size);
      ctx.lineTo(x + size * 2, y + size);
    }
    ctx.stroke();
  };
  meander(60, 12); // under the HUD line, above the top wall
  meander(canvas.height - 22, 12); // along the very bottom edge

  // Corner chevron stacks, pointing into the field.
  const chevrons = (cx: number, cy: number, dx: number, dy: number) => {
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const o = i * 9;
      ctx.moveTo(cx + dx * o, cy + dy * (o + 18));
      ctx.lineTo(cx + dx * (o + 18), cy + dy * (o + 18));
      ctx.lineTo(cx + dx * (o + 18), cy + dy * o);
    }
    ctx.stroke();
  };
  chevrons(8, 8, 1, 1);
  chevrons(canvas.width - 8, 8, -1, 1);
  chevrons(8, canvas.height - 8, 1, -1);
  chevrons(canvas.width - 8, canvas.height - 8, -1, -1);
}

function drawJaggedBorder(): void {
  // Rocky rim fencing the playfield: thick strips top/bottom, half-thick
  // walls left/right with openings at the gates.
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(0, 0, canvas.width, PLAY_TOP);
  ctx.fillRect(0, playBottom(), canvas.width, canvas.height - playBottom());
  const gates = gateRows();
  const gateTop = gates[0] * CELL - 10;
  const gateBottom = (gates[gates.length - 1] + 1) * CELL + 10;
  for (const gx of [0, playRight()]) {
    ctx.fillRect(gx, PLAY_TOP, PLAY_LEFT, Math.max(0, gateTop - PLAY_TOP));
    ctx.fillRect(gx, gateBottom, PLAY_LEFT, Math.max(0, playBottom() - gateBottom));
  }

  ctx.strokeStyle = "#39658c";
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  const jag = (v: number) => Math.sin(v * 0.13) * 4 + Math.sin(v * 0.041 + 2) * 5;
  // Jagged between its endpoints, but pinned EXACTLY to them — so segments
  // meet flush at the corners and the gate mouths.
  const strokeJag = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    if (y0 === y1) {
      const step = 26 * Math.sign(x1 - x0);
      for (let x = x0 + step; Math.abs(x1 - x) > 26; x += step) {
        ctx.lineTo(x, y0 + jag(x));
      }
    } else {
      const step = 26 * Math.sign(y1 - y0);
      for (let y = y0 + step; Math.abs(y1 - y) > 26; y += step) {
        ctx.lineTo(x0 + jag(y), y);
      }
    }
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  const L = PLAY_LEFT;
  const R = playRight();
  const T = PLAY_TOP;
  const B = playBottom();
  strokeJag(L, T, R, T); // top
  strokeJag(R, T, R, gateTop); // right, above the OUT gate
  strokeJag(R, gateBottom, R, B); // right, below
  strokeJag(R, B, L, B); // bottom
  strokeJag(L, B, L, gateBottom); // left, below the IN gate
  strokeJag(L, gateTop, L, T); // left, above

  // Gate mouths: jagged caps across the wall thickness, same stone as the
  // rim — the openings read as carved doorways, no labels needed.
  strokeJag(0, gateTop, L, gateTop);
  strokeJag(0, gateBottom, L, gateBottom);
  strokeJag(R, gateTop, canvas.width, gateTop);
  strokeJag(R, gateBottom, canvas.width, gateBottom);
}

function drawField(): void {
  drawJaggedBorder();
  drawFiligree();
  const gates = gateRows();

  if (gameMode === "path") {
    // The road itself: a faintly lit corridor with a hard edge.
    ctx.fillStyle = "rgba(153,166,191,0.07)";
    for (const i of pathCellSet) {
      const cx = i % cols;
      const cy = (i - cx) / cols;
      ctx.fillRect(cx * CELL, cy * CELL, CELL + 0.5, CELL + 0.5);
    }
  }

  // Dotted preview of the route enemies take from the IN gate.
  const row = gates[Math.floor(gates.length / 2)];
  let x = CELL / 2;
  let y = row * CELL + CELL / 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  for (let steps = 0; steps < 900 && x < canvas.width - CELL; steps++) {
    const [dx, dy] = flowDirection(x, y);
    x += dx * CELL * 0.6;
    y += dy * CELL * 0.6;
    ctx.lineTo(x, y);
  }
  // The route preview doubles as the road's painted center line.
  ctx.strokeStyle = "rgba(236,184,74,0.3)";
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 16]);
  ctx.stroke();
  ctx.setLineDash([]);
}

// A tower's body: every type is a DIFFERENT building on the block.
function drawHouseBody(
  type: TowerType,
  x: number,
  y: number,
  r: number,
  color: string,
  level: number,
  proposed: boolean,
): void {
  ctx.save();
  // The building stays INSIDE its circular footprint (hitbox, blocking,
  // and taps all live on that circle) — but the circle itself isn't drawn.
  ctx.translate(x, y);
  ctx.scale(0.68, 0.68);
  ctx.translate(-x, -y);
  ctx.setLineDash(proposed ? [7, 6] : []);
  ctx.lineWidth = 3 + Math.min(level, MAX_LEVEL) * 1.2;
  ctx.strokeStyle = color;
  ctx.fillStyle = "rgba(14,25,39,0.88)";
  const box = (bx: number, by: number, bw: number, bh: number) => {
    ctx.beginPath();
    ctx.rect(x + bx * r, y + by * r, bw * r, bh * r);
    ctx.fill();
    ctx.stroke();
  };
  const tri = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    ctx.beginPath();
    ctx.moveTo(x + x1 * r, y + y1 * r);
    ctx.lineTo(x + x2 * r, y + y2 * r);
    ctx.lineTo(x + x3 * r, y + y3 * r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  };
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(x + x1 * r, y + y1 * r);
    ctx.lineTo(x + x2 * r, y + y2 * r);
    ctx.stroke();
  };
  switch (type) {
    case "wall": // low garden wall
      box(-0.95, -0.45, 1.9, 1.25);
      break;
    case "mgun": // long low motel with a canopy
      box(-1.0, -0.05, 2.0, 0.9);
      box(-1.0, -0.32, 2.0, 0.2);
      break;
    case "crop": // farmhouse with a silo
      box(-0.85, -0.15, 1.15, 1.0);
      tri(-0.95, -0.15, -0.27, -0.85, 0.4, -0.15);
      box(0.5, -0.6, 0.4, 1.45);
      tri(0.42, -0.6, 0.7, -0.95, 0.98, -0.6);
      break;
    case "sniper": // tall condo block
      box(-0.5, -1.05, 1.0, 1.9);
      line(-0.5, -0.4, 0.5, -0.4);
      line(-0.5, 0.25, 0.5, 0.25);
      break;
    case "frost": // steep A-frame cabin
      tri(-0.9, 0.85, 0, -1.0, 0.9, 0.85);
      break;
    case "splash": // poolside pavilion
      box(-0.9, -0.62, 1.8, 0.26);
      line(-0.72, -0.36, -0.72, 0.85);
      line(0.72, -0.36, 0.72, 0.85);
      break;
    case "poison": // backyard pool (the ooze lives here)
      ctx.beginPath();
      ctx.roundRect(x - r * 0.85, y - r * 0.4, r * 1.7, r * 1.2, r * 0.45);
      ctx.fill();
      ctx.stroke();
      break;
    case "laser": // modern loft, single-slope roof
      box(-0.7, -0.1, 1.4, 0.95);
      tri(-0.85, -0.1, 0.85, -0.8, 0.85, -0.1);
      break;
    case "power": // plant with twin stacks
      box(-0.85, -0.3, 1.7, 1.15);
      box(-0.5, -0.95, 0.24, 0.65);
      box(0.16, -0.95, 0.24, 0.65);
      break;
    case "haste": // tiny hut, steep roof
      box(-0.45, 0.05, 0.9, 0.8);
      tri(-0.6, 0.05, 0, -0.8, 0.6, 0.05);
      break;
    case "scope": // studio with an antenna mast
      box(-0.6, -0.1, 1.2, 0.95);
      line(0, -0.1, 0, -1.05);
      line(-0.22, -0.85, 0.22, -0.85);
      line(-0.14, -0.6, 0.14, -0.6);
      break;
    case "bolt": // wide lodge with a lightning rod
      box(-0.8, -0.1, 1.6, 0.95);
      tri(-1.0, -0.1, 0, -0.85, 1.0, -0.1);
      line(0, -0.85, 0, -1.1);
      break;
    case "militia": // guard booth with a barrier arm
      box(-0.75, -0.75, 0.85, 1.6);
      tri(-0.85, -0.75, -0.32, -1.05, 0.2, -0.75);
      line(0.1, 0.45, 1.0, 0.3);
      break;
    case "surge": // grand manor, center hall + two wings
      box(-0.5, -0.7, 1.0, 1.55);
      box(-0.98, -0.15, 0.48, 1.0);
      box(0.5, -0.15, 0.48, 1.0);
      break;
    case "farm": // the bank: classical pediment
      box(-0.8, -0.35, 1.6, 1.2);
      tri(-0.95, -0.35, 0, -1.0, 0.95, -0.35);
      break;
    default: // generic gable house
      box(-0.78, -0.2, 1.56, 1.05);
      tri(-0.98, -0.2, 0, -1.02, 0.98, -0.2);
      break;
  }
  ctx.restore();
}

// A small vector emblem in the tower's disc, unique per type.
function drawTowerGlyph(t: Tower, spec: TowerSpec): void {
  const r = TOWER_RADIUS;
  ctx.strokeStyle = spec.color;
  ctx.fillStyle = spec.color;
  ctx.lineWidth = 3;
  const a = (t.facing * Math.PI) / 180;
  switch (t.type) {
    case "laser": {
      // Barrel pointing along the aim line + core.
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x + Math.cos(a) * r * 0.85, t.y + Math.sin(a) * r * 0.85);
      ctx.stroke();
      break;
    }
    case "splash": {
      // Bomb: filled core with radiating dashes.
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 8; i++) {
        const b = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(t.x + Math.cos(b) * r * 0.45, t.y + Math.sin(b) * r * 0.45);
        ctx.lineTo(t.x + Math.cos(b) * r * 0.65, t.y + Math.sin(b) * r * 0.65);
        ctx.stroke();
      }
      break;
    }
    case "sniper": {
      // Crosshair.
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * 0.45, 0, Math.PI * 2);
      ctx.stroke();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        ctx.beginPath();
        ctx.moveTo(t.x + dx * r * 0.3, t.y + dy * r * 0.3);
        ctx.lineTo(t.x + dx * r * 0.65, t.y + dy * r * 0.65);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * 0.08, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "frost": {
      // Snowflake.
      for (let i = 0; i < 6; i++) {
        const b = (i / 6) * Math.PI * 2 + clock * 0.4;
        ctx.beginPath();
        ctx.moveTo(t.x, t.y);
        ctx.lineTo(t.x + Math.cos(b) * r * 0.6, t.y + Math.sin(b) * r * 0.6);
        ctx.stroke();
      }
      break;
    }
    case "crop": {
      // Farm: sprout — stem + leaves.
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y + r * 0.5);
      ctx.lineTo(t.x, t.y - r * 0.3);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(t.x - r * 0.28, t.y - r * 0.32, r * 0.3, r * 0.14, -0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(t.x + r * 0.28, t.y - r * 0.32, r * 0.3, r * 0.14, 0.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "farm": {
      // Bank: pediment roof over three columns on a base slab.
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(t.x - r * 0.6, t.y - r * 0.2);
      ctx.lineTo(t.x, t.y - r * 0.6);
      ctx.lineTo(t.x + r * 0.6, t.y - r * 0.2);
      ctx.closePath();
      ctx.stroke();
      for (const xx of [-0.38, 0, 0.38]) {
        ctx.beginPath();
        ctx.moveTo(t.x + r * xx, t.y - r * 0.08);
        ctx.lineTo(t.x + r * xx, t.y + r * 0.38);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(t.x - r * 0.6, t.y + r * 0.52);
      ctx.lineTo(t.x + r * 0.6, t.y + r * 0.52);
      ctx.stroke();
      break;
    }
    case "surge": {
      // Nested arcs rippling toward the facing.
      for (const rr of [0.3, 0.5, 0.7]) {
        ctx.beginPath();
        ctx.arc(t.x, t.y, r * rr, a - 0.7, a + 0.7);
        ctx.stroke();
      }
      break;
    }
    case "wall": {
      // Brickwork.
      ctx.lineWidth = 2;
      for (const yy of [-0.3, 0.1, 0.5]) {
        ctx.beginPath();
        ctx.moveTo(t.x - r * 0.6, t.y + r * yy);
        ctx.lineTo(t.x + r * 0.6, t.y + r * yy);
        ctx.stroke();
      }
      for (const [xx, yy] of [[-0.2, -0.1], [0.25, -0.1], [0, 0.3], [-0.35, 0.3]] as const) {
        ctx.beginPath();
        ctx.moveTo(t.x + r * xx, t.y + r * yy);
        ctx.lineTo(t.x + r * xx, t.y + r * (yy - 0.2));
        ctx.stroke();
      }
      break;
    }
    case "militia": {
      // Shield with a sword slashed across it.
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(t.x - r * 0.4, t.y - r * 0.45);
      ctx.lineTo(t.x + r * 0.4, t.y - r * 0.45);
      ctx.lineTo(t.x + r * 0.4, t.y + r * 0.1);
      ctx.lineTo(t.x, t.y + r * 0.55);
      ctx.lineTo(t.x - r * 0.4, t.y + r * 0.1);
      ctx.closePath();
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(t.x - r * 0.55, t.y + r * 0.5);
      ctx.lineTo(t.x + r * 0.55, t.y - r * 0.6);
      ctx.stroke();
      break;
    }
    case "bolt": {
      // Lightning zigzag.
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(t.x + r * 0.15, t.y - r * 0.6);
      ctx.lineTo(t.x - r * 0.2, t.y + r * 0.05);
      ctx.lineTo(t.x + r * 0.1, t.y + r * 0.05);
      ctx.lineTo(t.x - r * 0.15, t.y + r * 0.6);
      ctx.stroke();
      break;
    }
    case "mgun": {
      if (gameMode === "path") {
        // Machine gun: twin barrels + muzzle dots.
        ctx.lineWidth = 4;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(t.x - r * 0.5, t.y + s * r * 0.18);
          ctx.lineTo(t.x + r * 0.55, t.y + s * r * 0.18);
          ctx.stroke();
        }
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(t.x + r * 0.68, t.y + s * r * 0.18, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      // Melee: crossed blades.
      ctx.lineWidth = 4;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(t.x - s * r * 0.55, t.y - r * 0.55);
        ctx.lineTo(t.x + s * r * 0.55, t.y + r * 0.55);
        ctx.stroke();
      }
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(t.x + s * r * 0.55, t.y + r * 0.55, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "poison": {
      // Venom droplet.
      ctx.beginPath();
      ctx.moveTo(t.x, t.y - r * 0.55);
      ctx.quadraticCurveTo(t.x + r * 0.4, t.y + r * 0.15, t.x, t.y + r * 0.45);
      ctx.quadraticCurveTo(t.x - r * 0.4, t.y + r * 0.15, t.x, t.y - r * 0.55);
      ctx.fill();
      break;
    }
    case "power": {
      // Starburst.
      for (let i = 0; i < 4; i++) {
        const b = (i / 4) * Math.PI * 2 + Math.PI / 4;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(t.x, t.y);
        ctx.lineTo(t.x + Math.cos(b) * r * 0.55, t.y + Math.sin(b) * r * 0.55);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "haste": {
      // Double chevrons.
      ctx.lineWidth = 4;
      for (const off of [-0.25, 0.15]) {
        ctx.beginPath();
        ctx.moveTo(t.x + r * (off - 0.2), t.y - r * 0.35);
        ctx.lineTo(t.x + r * (off + 0.2), t.y);
        ctx.lineTo(t.x + r * (off - 0.2), t.y + r * 0.35);
        ctx.stroke();
      }
      break;
    }
    case "scope": {
      // Expanding circles.
      for (const rr of [0.25, 0.45, 0.65]) {
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(t.x, t.y, r * rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
  }
}

// Poison renders as an irregular ooze puddle covering its whole effect
// area — ground hazard, not a building.
function drawPuddle(t: Tower): void {
  const R = TOWER_SPECS.poison.range;
  const phase = (t.x * 0.7 + t.y * 1.3) % (Math.PI * 2);
  ctx.beginPath();
  for (let i = 0; i <= 44; i++) {
    const a = (i / 44) * Math.PI * 2;
    const r =
      R *
      (0.72 +
        0.16 * Math.sin(3 * a + phase) +
        0.1 * Math.sin(5 * a + phase * 2) +
        0.03 * Math.sin(clock * 0.8 + a * 2));
    const px = t.x + Math.cos(a) * r;
    const py = t.y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(151,117,250,0.22)";
  ctx.fill();
  ctx.strokeStyle = "rgba(151,117,250,0.65)";
  ctx.lineWidth = 3;
  ctx.stroke();
  // Slow bubbles.
  for (let b = 0; b < 5; b++) {
    const ba = phase + b * 1.3;
    const br = R * (0.2 + 0.35 * (((b * 37) % 10) / 10));
    const pulse = 2.5 + Math.sin(clock * 2 + b) * 1.5;
    ctx.beginPath();
    ctx.arc(t.x + Math.cos(ba) * br, t.y + Math.sin(ba) * br, pulse, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(183,151,252,0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawTowers(): void {
  ctx.textAlign = "center";
  const live = activeTowers();
  for (const t of towers.values()) {
    const spec = TOWER_SPECS[t.type];
    // Shooters show their EFFECTIVE range, including SCOPE aura boosts.
    const isShooter =
      t.type === "splash" || t.type === "sniper" || t.type === "mgun" ||
      t.type === "bolt" || t.type === "surge";
    const rngMul = isShooter && t.state === "active" ? buffMultipliers(t, live).rng : 1;

    // Ranges stay hidden unless the tower is selected (or being placed) —
    // a full board of rings is noise.
    const rangeVisible =
      t.state === "proposed" ||
      realClock < t.actionsUntil ||
      realClock < t.sellConfirmUntil ||
      (aimLinkTowerId !== null && towers.get(aimLinkTowerId) === t);

    if (t.type === "laser" && rangeVisible) {
      // Aim guide: a dashed line showing exactly where the beam will go —
      // visible while proposed too, so it can be aimed before buying.
      const a = (t.facing * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(
        t.x + Math.cos(a) * (canvas.width + canvas.height),
        t.y + Math.sin(a) * (canvas.width + canvas.height),
      );
      ctx.strokeStyle = "rgba(252,196,25,0.35)";
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 14]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (rangeVisible && !t.menuOpen && spec.range > 0 && !(t.type === "poison" && t.state === "active")) {
      // Range preview — for active towers AND proposals being placed (a
      // proposal's ring is brighter so the reach is obvious before buying).
      const proposed = t.state === "proposed";
      const pulse = t.type === "frost" ? 1 + Math.sin(clock * 3) * 0.04 : 1;
      ctx.beginPath();
      if (t.type === "surge") {
        // The lane: a straight band from the tower along its facing.
        const a = (t.facing * Math.PI) / 180;
        const halfW = SURGE_HALF_WIDTH_BY_LEVEL[t.level - 1];
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        const L = spec.range * rngMul;
        ctx.moveTo(t.x - uy * halfW, t.y + ux * halfW);
        ctx.lineTo(t.x - uy * halfW + ux * L, t.y + ux * halfW + uy * L);
        ctx.lineTo(t.x + uy * halfW + ux * L, t.y - ux * halfW + uy * L);
        ctx.lineTo(t.x + uy * halfW, t.y - ux * halfW);
        ctx.closePath();
        ctx.strokeStyle = proposed ? "rgba(229,153,247,0.6)" : "rgba(229,153,247,0.25)";
      } else {
        const baseRange = t.type === "splash" ? splashRangeAt(t.level) : spec.range;
        ctx.arc(t.x, t.y, baseRange * rngMul * pulse, 0, Math.PI * 2);
        const isAura =
          t.type === "frost" || t.type === "power" || t.type === "haste" || t.type === "scope";
        ctx.strokeStyle = proposed
          ? "rgba(255,255,255,0.35)"
          : isAura ? spec.color + "55" : "rgba(255,255,255,0.07)";
      }
      ctx.lineWidth = 2;
      ctx.setLineDash(proposed ? [8, 8] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Body: poison is a ground puddle; everything else is a disc building.
    if (t.type === "poison" && t.state === "active") {
      drawPuddle(t);
      drawTowerGlyph(t, spec); // droplet marker at the center
    } else {
      // Every tower is a HOUSE in the neighborhood; the bank grows with
      // its level. Emblem sits on the front wall.
      const bodyR = t.type === "farm" ? bankVisualRadius(t.level) : TOWER_RADIUS;
      drawHouseBody(t.type, t.x, t.y, bodyR, spec.color, t.level, t.state === "proposed");
      ctx.save();
      ctx.translate(t.x, t.y + bodyR * 0.3);
      const k = (bodyR / TOWER_RADIUS) * 0.5;
      ctx.scale(k, k);
      ctx.translate(-t.x, -t.y);
      drawTowerGlyph(t, spec);
      ctx.restore();
    }

    // The tower linked to the aiming piece wears a slowly turning halo.
    if (aimLinkTowerId !== null && towers.get(aimLinkTowerId) === t) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, TOWER_RADIUS + 7, clock, clock + Math.PI * 1.4);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 8]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

  }
}

// Menus, action rows, and sell confirms draw in their own pass on the very
// top of the frame — nothing may cover an open menu.
function drawTowerMenus(): void {
  ctx.textAlign = "center";
  for (const t of towers.values()) {
    if (t.state === "proposed" && t.menuOpen) {
      // Two-level type picker; picking a tower buys it on the spot.
      if (t.menuCategory === "root") {
        const three = rootChipCount() === 3;
        const catFont = three ? "bold 16px sans-serif" : "bold 20px sans-serif";
        fancyButton(rootChipRect(t, 0), "⚔ DAMAGE", { labelColor: COLOR_ENEMY, font: catFont });
        fancyButton(rootChipRect(t, 1), "✦ EFFECT", { labelColor: COLOR_BASE, font: catFont });
        if (three && lastPlacedType !== null) {
          const spec = TOWER_SPECS[lastPlacedType];
          fancyButton(rootChipRect(t, 2), `✓ ${spec.label} $${spec.cost}`, {
            labelColor: "#69db7c",
            font: "bold 13px sans-serif",
            alpha: money >= spec.cost ? 1 : 0.4,
          });
        }
      } else {
        const list = MENU_CATEGORIES[t.menuCategory];
        for (let i = 0; i < list.length; i++) {
          const chipSpec = TOWER_SPECS[list[i]];
          const owned = list[i] === "farm" && activeBank() !== null;
          fancyButton(typeChipRect(t, i), owned ? `${chipSpec.label} OWNED` : `${chipSpec.label} $${chipSpec.cost}`, {
            labelColor: chipSpec.color,
            font: "bold 18px sans-serif",
            alpha: !owned && money >= chipSpec.cost ? 1 : 0.4,
          });
        }
        fancyButton(typeChipRect(t, list.length), "◀ BACK", { labelColor: COLOR_HINT, accent: ACCENT_DIM, font: "bold 20px sans-serif" });
      }
    } else if (t.state === "active" && realClock < t.sellConfirmUntil) {
      fancyButton(sellConfirmRect(t), `✓ SELL $${sellValue(t)}`, {
        labelColor: COLOR_MONEY,
        font: "bold 22px sans-serif",
      });
      fancyButton(sellAbortRect(t), "✗", { labelColor: COLOR_HINT, accent: ACCENT_DIM, font: "bold 22px sans-serif" });
    } else if (t.state === "active" && realClock < t.actionsUntil) {
      // Action row, shown only while the tower is selected.
      for (const tag of actionTags(t)) {
        fancyButton(tag.rect, tag.label, {
          labelColor: tag.color,
          font: "bold 18px sans-serif",
          alpha:
            tag.key === "upgrade" && money < upgradeCost(t.type, t.level) ? 0.45 : 1,
        });
      }
      drawAuraBadges(t);
    }
  }
}

// Which tower types actually benefit from auras — badges only where true.
const AURA_AFFECTED = new Set<TowerType>([
  "mgun", "sniper", "splash", "bolt", "laser", "surge", "crop", "militia",
]);

// Under a selected tower's action row: which auras are boosting it.
function drawAuraBadges(t: Tower): void {
  if (!AURA_AFFECTED.has(t.type)) return;
  const buff = buffMultipliers(t, activeTowers());
  const parts: Array<[string, string]> = [];
  if (buff.dmg > 1.001) parts.push([`▲ POWER +${Math.round((buff.dmg - 1) * 100)}%`, TOWER_SPECS.power.color]);
  if (buff.rate > 1.001) parts.push([`≫ HASTE +${Math.round((buff.rate - 1) * 100)}%`, TOWER_SPECS.haste.color]);
  if (buff.rng > 1.001) parts.push([`◎ RANGE +${Math.round((buff.rng - 1) * 100)}%`, TOWER_SPECS.scope.color]);
  if (parts.length === 0) return;
  ctx.save();
  ctx.font = "bold 15px sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const y = uiRowY(t, 26 + 44 + 12, 20) + 10;
  const widths = parts.map(([s]) => ctx.measureText(s).width);
  const gap = 18;
  const total = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1);
  let x = uiX(t) - total / 2;
  for (let i = 0; i < parts.length; i++) {
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillText(parts[i][0], x + 1, y + 2);
    ctx.fillStyle = parts[i][1];
    ctx.fillText(parts[i][0], x, y);
    x += widths[i] + gap;
  }
  ctx.restore();
}

// Values per level 1/2/3, computed from the live specs so the key can't drift.
function perLevel(nums: readonly number[], f: (n: number) => number = (n) => n): string {
  return nums.map((n) => `${Math.round(f(n) * 100) / 100}`).join("/");
}

interface TowerKeyRow {
  type: TowerType;
  brief: string;
  range: string;
  dmg: string;
  dps: string;
  detail: string;
}

function towerKeyRows(): TowerKeyRow[] {
  const S = TOWER_SPECS;
  // Listed cheapest-first, whatever the prices are tuned to.
  return rowsByCost([
    { type: "wall", brief: "blocks the path, nothing more",
      range: "—", dmg: "no damage", dps: "—",
      detail: "Cheap brickwork. Creeps cannot cross it — lay these to build the maze and steer the flow into your killers. No upgrades." },
    { type: "mgun",
      brief: gameMode === "path" ? "rapid pinprick shots, short range" : "whirling blades, arm's-length reach",
      range: `${S.mgun.range}`, dmg: `${perLevel(S.mgun.damageByLevel)} per hit`,
      dps: perLevel(S.mgun.damageByLevel, (d) => d / S.mgun.fireInterval),
      detail: gameMode === "path"
        ? "Twin barrels spraying a shot every 0.08 seconds. Weak alone, brutal in nests along the road. Tap it to switch FIRST / LAST / TANK targeting."
        : "Whirling blades striking every 0.08 seconds — but only what walks within arm's reach. Cheap, vicious in tight corridors where creeps must brush past it. Tap it to switch FIRST / LAST / TANK targeting." },
    { type: "farm", brief: "interest on cash in hand, upgrades forever",
      range: "—", dmg: "3% of held cash per wave · +1% per level, no cap", dps: "—",
      detail: "One per game, and the only tower that upgrades FOREVER — each level doubles in price and adds +1% interest (3%, 4%, 5%...). When a wave is cleared it pays that cut of every coin you're holding, and the building itself grows with each level. Compounding is how you reach 1,000,000." },
    { type: "crop", brief: "steady rent while a wave runs",
      range: "—", dmg: `$${perLevel(S.crop.damageByLevel)} every ${S.crop.fireInterval}s in waves`,
      dps: perLevel(S.crop.damageByLevel, (d) => d / S.crop.fireInterval),
      detail: "Collects $1/4/8 of rent every 2 seconds while a wave is running. Flat, dependable income for the lean middle waves — and POWER PLANT / HASTE HUT auras fatten and quicken the rent. It does nothing for defense — fence it in." },
    { type: "sniper", brief: "% of current hp, anywhere on the board",
      range: "whole board",
      dmg: `${perLevel(S.sniper.damageByLevel, (d) => d * 100)}% of current hp per ${S.sniper.fireInterval}s`,
      dps: `${perLevel(S.sniper.damageByLevel, (d) => (d * 100) / S.sniper.fireInterval)} %/s`,
      detail: "Hits anything on the board every 7 seconds, taking a cut of the target's CURRENT hp — a monster opener on bosses, a weak finisher. Tap it to switch FIRST / LAST / TANK targeting." },
    { type: "frost", brief: "slows creeps inside its aura",
      range: `${S.frost.range}`,
      dmg: `slows ${perLevel(FROST_FACTOR_BY_LEVEL, (f) => (1 - f) * 100)}%`, dps: "—",
      detail: "No damage — pure control. Everything inside the aura trudges at reduced speed while your towers grind it down." },
    { type: "splash", brief: "pulse hits everything in its circle",
      range: SPLASH_RANGE_BY_LEVEL.join("/"),
      dmg: `${perLevel(S.splash.damageByLevel)} to ALL in circle`,
      dps: `${perLevel(S.splash.damageByLevel, (d) => d / S.splash.fireInterval)} each`,
      detail: "Pulses every 0.9 seconds and hits EVERY creep inside its circle at once. Small numbers that multiply against packed crowds." },
    { type: "poison", brief: "walkable ooze — damage over time",
      range: `${S.poison.range}`,
      dmg: `${perLevel(S.poison.damageByLevel)} over ${POISON_DURATION}s`,
      dps: perLevel(S.poison.damageByLevel, (d) => d / POISON_DURATION),
      detail: "An ooze puddle on open ground — creeps walk straight through and drip damage for 5 seconds after touching it. Does not block the path." },
    { type: "laser", brief: "fixed beam across the whole board",
      range: "whole board",
      dmg: `${perLevel(S.laser.damageByLevel)} per ${S.laser.fireInterval}s`,
      dps: `${perLevel(S.laser.damageByLevel, (d) => d / S.laser.fireInterval)} per creep in the beam`,
      detail: "Burns a fixed line across the entire board, hitting every creep in the beam. Tap the tower to link the aiming piece, then turn the piece to steer the beam." },
    { type: "power", brief: "nearby towers deal more damage",
      range: `${S.power.range}`,
      dmg: `+${perLevel(POWER_MUL_BY_LEVEL, (m) => (m - 1) * 100)}% damage`, dps: "—",
      detail: "An aura that makes every tower inside it hit harder. Also fattens farm rent and empowers guard-house soldiers. Plant it in the middle of your damage nest." },
    { type: "haste", brief: "nearby towers fire faster",
      range: `${S.haste.range}`,
      dmg: `+${perLevel(HASTE_MUL_BY_LEVEL, (m) => (m - 1) * 100)}% fire rate`, dps: "—",
      detail: "An aura that makes every tower inside it fire faster. Also quickens farm rent and guard-house respawns." },
    { type: "scope", brief: "nearby towers reach further",
      range: `${S.scope.range}`,
      dmg: `+${perLevel(SCOPE_MUL_BY_LEVEL, (m) => (m - 1) * 100)}% range`, dps: "—",
      detail: "An aura that stretches the range of every tower inside it. Guard-house soldiers under it become ranged fighters. The range rings on the field show the boosted reach." },
    { type: "bolt", brief: "chains lightning through creeps",
      range: `${S.bolt.range}`,
      dmg: `${perLevel(S.bolt.damageByLevel)} chained to ${BOLT_CHAIN_BY_LEVEL.join("/")} creeps per ${S.bolt.fireInterval}s`,
      dps: `${perLevel(S.bolt.damageByLevel, (d) => d / S.bolt.fireInterval)} ×${BOLT_CHAIN_BY_LEVEL.join("/")}`,
      detail: `Every 2 seconds a bolt arcs through up to 3/4/5 creeps by level, hopping up to ${BOLT_CHAIN_RADIUS}px between targets. The thunder arrives a second late.` },
    { type: "militia", brief: "four soldiers, rally them anywhere",
      range: "rally anywhere",
      dmg: `${perLevel(S.militia.damageByLevel)} dps per soldier · ${MILITIA_HP_BY_LEVEL.join("/")} hp each`,
      dps: `${perLevel(S.militia.damageByLevel, (d) => d * MILITIA_COUNT)} combined`,
      detail: `Fields ${MILITIA_COUNT} soldiers. Select the tower, then tap anywhere on the map — the squad rallies there, and creeps that run into a soldier stop marching to fight him. Fallen soldiers respawn at the tower after ${MILITIA_RESPAWN} seconds. Auras matter: POWER PLANT makes the squad bigger and meaner, HASTE HUT speeds respawns, SCOPE STUDIO turns them into ranged fighters.` },
    { type: "surge", brief: "straight wave + knockback",
      range: `${S.surge.range} lane, 2/4/8 towers wide`,
      dmg: `${perLevel(SURGE_PCT_BY_LEVEL, (p) => p * 100)}% of hp + knockback per ${S.surge.fireInterval}s`,
      dps: `${perLevel(SURGE_PCT_BY_LEVEL, (p) => (p * 100) / S.surge.fireInterval)} %/s`,
      detail: "Every 5 seconds it sends a straight wave down its lane — 2/4/8 tower-widths wide by level — cutting a percent of each creep's hp and shoving them back. It holds fire until a creep enters the near half of the lane. Tap the tower to link the aiming piece and steer it." },
  ]);
}

function rowsByCost(rows: TowerKeyRow[]): TowerKeyRow[] {
  return rows.sort((a, b) => TOWER_SPECS[a.type].cost - TOWER_SPECS[b.type].cost);
}

// Panel geometry shared by drawing and tap handling.
const KEY_ROW_H = 46;
const KEY_PAD = 26;

const KEY_ROW_COUNT = 15; // one per tower type

function towerKeyPanelRect(): [number, number, number, number] {
  const w = 780;
  const h = KEY_PAD * 2 + 46 + KEY_ROW_COUNT * KEY_ROW_H;
  return [(canvas.width - w) / 2, (canvas.height - h) / 2, w, h];
}

function towerKeyRowRect(i: number): [number, number, number, number] {
  const [x, y, w] = towerKeyPanelRect();
  return [x + 14, y + KEY_PAD + 46 + i * KEY_ROW_H, w - 28, KEY_ROW_H];
}

function towerKeyDetailRect(): [number, number, number, number] {
  const w = 880;
  const h = 620;
  return [(canvas.width - w) / 2, (canvas.height - h) / 2, w, h];
}

function towerKeyBackRect(): [number, number, number, number] {
  const [x, y, w] = towerKeyDetailRect();
  return [x + w - 156, y + 20, 130, 44];
}

// Chamfered stone panel matching the button slabs.
function drawKeyPanel(x: number, y: number, w: number, h: number): void {
  const c = 16;
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "#2b4a68");
  g.addColorStop(0.5, "#1c3144");
  g.addColorStop(1, "#0e1927");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = "#05070d";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = "#eaaf33";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 5, y + 5, w - 10, h - 10);
  ctx.fillStyle = "#eaaf33";
  for (const [sx, sy] of [
    [x + 9, y + 9], [x + w - 15, y + 9], [x + 9, y + h - 15], [x + w - 15, y + h - 15],
  ] as const) {
    ctx.fillRect(sx, sy, 6, 6);
  }
}

// The tower's field building + emblem at an arbitrary spot and scale.
function drawKeyDisc(type: TowerType, cx: number, cy: number, scale: number): void {
  const spec = TOWER_SPECS[type];
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  const fake = { x: 0, y: 0, type, level: 1, facing: 0 } as Tower;
  drawHouseBody(type, 0, 0, TOWER_RADIUS, spec.color, 1, false);
  ctx.save();
  ctx.translate(0, TOWER_RADIUS * 0.3);
  ctx.scale(0.5, 0.5);
  drawTowerGlyph(fake, spec);
  ctx.restore();
  ctx.restore();
}

function wrapText(text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    const trial = cur ? `${cur} ${word}` : word;
    if (cur && ctx.measureText(trial).width > maxW) {
      lines.push(cur);
      cur = word;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawTowerKey(): void {
  fancyButton(towerKeyButtonRect(), "TOWER KEY", {
    labelColor: towerKeyOpen ? COLOR_MONEY : COLOR_TEXT,
    font: "bold 18px sans-serif",
  });
  if (!towerKeyOpen) return;
  if (towerKeyPage === null) drawTowerKeyDirectory();
  else drawTowerKeyDetail(towerKeyPage);
}

function drawTowerKeyDirectory(): void {
  const rows = towerKeyRows();
  const [x, y, w] = towerKeyPanelRect();
  const h = towerKeyPanelRect()[3];

  ctx.save();
  drawKeyPanel(x, y, w, h);

  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.font = "30px Impact, sans-serif";
  ctx.fillStyle = COLOR_TEXT;
  ctx.fillText("TOWER KEY", x + w / 2, y + KEY_PAD + 12);

  ctx.textAlign = "left";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const spec = TOWER_SPECS[row.type];
    const [, ry] = towerKeyRowRect(i);
    const midY = ry + KEY_ROW_H / 2;
    drawKeyDisc(row.type, x + KEY_PAD + 26, midY, 0.6);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "bold 19px sans-serif";
    ctx.fillStyle = spec.color;
    ctx.fillText(`${spec.label} $${spec.cost}`, x + KEY_PAD + 60, midY);
    ctx.font = "16px sans-serif";
    ctx.fillStyle = COLOR_HINT;
    ctx.fillText(row.brief, x + KEY_PAD + 330, midY);
    // Tap affordance.
    ctx.fillStyle = "#eaaf33";
    ctx.fillText("▸", x + w - KEY_PAD - 16, midY);
  }
  ctx.restore();
}

function drawTowerKeyDetail(type: TowerType): void {
  const row = towerKeyRows().find((r) => r.type === type)!;
  const spec = TOWER_SPECS[type];
  const [x, y, w, h] = towerKeyDetailRect();

  ctx.save();
  drawKeyPanel(x, y, w, h);
  fancyButton(towerKeyBackRect(), "◀ BACK", { labelColor: COLOR_HINT, accent: ACCENT_DIM, font: "bold 18px sans-serif" });

  // Header: big disc + name.
  drawKeyDisc(type, x + KEY_PAD + 44, y + KEY_PAD + 44, 1.3);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "34px Impact, sans-serif";
  ctx.fillStyle = spec.color;
  ctx.fillText(spec.label, x + KEY_PAD + 100, y + KEY_PAD + 44);

  // Stat table. Upgrades double each level; selling refunds 60% of everything
  // spent (walls always sell for 1g).
  const sellAt = (lvl: number): number => {
    if (type === "wall") return 1;
    let invested = spec.cost;
    for (let l = 1; l < lvl; l++) invested += upgradeCost(type, l);
    return Math.floor(invested * 0.6);
  };
  const stats: Array<[string, string]> = [
    ["COST", `$${spec.cost}`],
    ["UPGRADES", type === "wall" ? "none"
      : type === "farm" ? `level 2: $${upgradeCost(type, 1)} · level 3: $${upgradeCost(type, 2)} · doubles forever`
      : `level 2: $${upgradeCost(type, 1)} · level 3: $${upgradeCost(type, 2)}`],
    ["SELLS FOR", type === "wall" ? "$1"
      : type === "farm" ? "60% of everything invested"
      : `$${sellAt(1)} / $${sellAt(2)} / $${sellAt(3)} by level`],
    ["RANGE", row.range],
    ["DAMAGE (level 1/2/3)", row.dmg],
    ["DMG / SEC", row.dps],
  ];
  let lineY = y + KEY_PAD + 110;
  for (const [label, value] of stats) {
    ctx.font = "bold 15px sans-serif";
    ctx.fillStyle = "#eaaf33";
    ctx.fillText(label, x + KEY_PAD + 8, lineY);
    ctx.font = "19px sans-serif";
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(value, x + KEY_PAD + 280, lineY);
    lineY += 44;
  }

  // Divider + description.
  ctx.strokeStyle = ACCENT_DIM;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + KEY_PAD, lineY - 10);
  ctx.lineTo(x + w - KEY_PAD, lineY - 10);
  ctx.stroke();
  ctx.font = "19px sans-serif";
  ctx.fillStyle = COLOR_HINT;
  let descY = lineY + 24;
  for (const line of wrapText(row.detail, w - KEY_PAD * 2 - 16)) {
    ctx.fillText(line, x + KEY_PAD + 8, descY);
    descY += 28;
  }
  ctx.restore();
}

function drawMilitias(): void {
  // Rally flag + tether while a militia tower is selected.
  for (const t of towers.values()) {
    if (t.state !== "active" || t.type !== "militia" || realClock >= t.actionsUntil) continue;
    const [rx, ry] = rallyPoint(t);
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.lineTo(rx, ry);
    ctx.strokeStyle = "rgba(99,230,190,0.4)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = TOWER_SPECS.militia.color;
    ctx.fillStyle = TOWER_SPECS.militia.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(rx, ry + 12);
    ctx.lineTo(rx, ry - 16);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rx, ry - 16);
    ctx.lineTo(rx + 14, ry - 11);
    ctx.lineTo(rx, ry - 6);
    ctx.closePath();
    ctx.fill();
  }
  for (const m of militias) {
    // POWER PLANT soldiers are bigger and wear the plant's red.
    const mr = m.powered ? MILITIA_RADIUS * 1.4 : MILITIA_RADIUS;
    const tint = m.powered ? TOWER_SPECS.power.color : TOWER_SPECS.militia.color;
    ctx.beginPath();
    ctx.arc(m.x, m.y, mr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(14,25,39,0.92)";
    ctx.fill();
    ctx.strokeStyle = tint;
    ctx.lineWidth = m.powered ? 3.5 : 2.5;
    ctx.stroke();
    if (m.ranged) {
      // SCOPE STUDIO snipers wear a scope-green bead.
      ctx.beginPath();
      ctx.arc(m.x, m.y, mr * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = TOWER_SPECS.scope.color;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(
      m.x,
      m.y,
      mr + 3.5,
      -Math.PI / 2,
      -Math.PI / 2 + (Math.PI * 2 * Math.max(0, m.hp)) / m.maxHp,
    );
    ctx.strokeStyle = COLOR_TEXT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawEnemies(): void {
  for (const e of enemies) {
    const r = e.radius;
    const poisoned = clock < e.poisonUntil;
    const color =
      e.slowFactor < 1 ? COLOR_ENEMY_SLOWED :
      poisoned ? "#b197fc" :
      e.kind === "grub" ? COLOR_ENEMY : COLOR_ENEMY_TOUGH;
    // Cars steer along their route and idle-bounce on their suspension.
    const [fdx, fdy] = flowDirection(e.x, e.y);
    const bounce = Math.sin(clock * 9 + e.y * 0.03) * r * 0.05;
    ctx.save();
    ctx.translate(e.x, e.y + bounce);
    ctx.rotate(Math.atan2(fdy, fdx));
    drawCar(e.kind, r, color, e.variant);
    ctx.restore();

    // Health bar under the vehicle — only once it's taken a scratch.
    const pct = Math.max(0, e.hp) / e.maxHp;
    if (pct < 1) {
      const bw = r * 2.4;
      const bh = 4;
      const bx = e.x - bw / 2;
      const by = e.y + r + 6;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = pct > 0.5 ? "#69db7c" : pct > 0.25 ? "#ecb84a" : "#ff6b6b";
      ctx.fillRect(bx, by, bw * pct, bh);
    }
  }
}

// Top-down car pointing +x, drawn at the origin. Each creep kind is its
// own vehicle class, and `variant` mixes body styles within it.
function drawCar(kind: EnemyKind, r: number, color: string, variant: number): void {
  const wheel = (wx: number, half: number) => {
    ctx.fillRect(wx - r * 0.22, -half - r * 0.14, r * 0.44, r * 0.14);
    ctx.fillRect(wx - r * 0.22, half, r * 0.44, r * 0.14);
  };
  ctx.fillStyle = "#0e1927";
  if (kind === "boss") {
    // Semi truck: long trailer + cab.
    wheel(-r * 1.1, r * 0.62);
    wheel(r * 0.1, r * 0.62);
    wheel(r * 1.0, r * 0.62);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-r * 1.5, -r * 0.62, r * 2.3, r * 1.24, r * 0.12);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(r * 0.9, -r * 0.55, r * 0.65, r * 1.1, r * 0.18);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(r * 1.28, -r * 0.45, r * 0.14, r * 0.9); // windshield
  } else if (kind === "ranger") {
    // Pickup: cab up front, open bed behind.
    wheel(-r * 0.7, r * 0.68);
    wheel(r * 0.7, r * 0.68);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-r * 1.2, -r * 0.68, r * 2.4, r * 1.36, r * 0.3);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 2;
    ctx.strokeRect(-r * 1.0, -r * 0.48, r * 0.95, r * 0.96); // bed
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(r * 0.28, -r * 0.55, r * 0.18, r * 1.1); // windshield
  } else if (kind === "brute") {
    // Box van.
    wheel(-r * 0.75, r * 0.72);
    wheel(r * 0.75, r * 0.72);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-r * 1.15, -r * 0.72, r * 2.3, r * 1.44, r * 0.14);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(r * 0.6, -r * 0.6, r * 0.16, r * 1.2);
  } else if (kind === "runt") {
    // Minis: hatchback or open dune buggy, by variant.
    const len = 1.05;
    wheel(-r * 0.58, r * 0.66);
    wheel(r * 0.58, r * 0.66);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-r * len, -r * 0.66, r * len * 2, r * 1.32, r * 0.4);
    ctx.fill();
    if (variant % 2 === 0) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.roundRect(-r * 0.55, -r * 0.5, r * 0.9, r, r * 0.22); // boxy cabin
      ctx.fill();
    } else {
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 2.5;
      ctx.beginPath(); // buggy roll bar
      ctx.moveTo(-r * 0.15, -r * 0.6);
      ctx.lineTo(-r * 0.15, r * 0.6);
      ctx.stroke();
    }
  } else {
    // Sedans: three body styles by variant — sedan, coupe, hatchback.
    const len = 1.3;
    wheel(-r * 0.72, r * 0.66);
    wheel(r * 0.72, r * 0.66);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-r * len, -r * 0.66, r * len * 2, r * 1.32, r * 0.45);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    if (variant === 0) {
      ctx.roundRect(-r * 0.45, -r * 0.5, r, r, r * 0.25); // sedan cabin
    } else if (variant === 1) {
      ctx.roundRect(-r * 0.7, -r * 0.5, r * 0.85, r, r * 0.35); // coupe, cab-back
    } else {
      ctx.roundRect(-r * 0.5, -r * 0.5, r * 1.35, r, r * 0.2); // hatchback, long roof
    }
    ctx.fill();
    ctx.fillStyle = "#fff3bf";
    ctx.fillRect(r * len - r * 0.14, -r * 0.5, r * 0.14, r * 0.24); // headlights
    ctx.fillRect(r * len - r * 0.14, r * 0.26, r * 0.14, r * 0.24);
  }
}

function drawEffects(): void {
  for (const b of beams) {
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    ctx.lineTo(b.x2, b.y2);
    ctx.strokeStyle = b.color;
    ctx.globalAlpha = 1 - b.age / BEAM_LIFETIME;
    ctx.lineWidth = b.width;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const b of bursts) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius * (b.age / 0.25), 0, Math.PI * 2);
    ctx.strokeStyle = b.color;
    ctx.globalAlpha = 1 - b.age / 0.25;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const s of surgeWaves) {
    // A straight wavefront sweeping down the lane.
    const p = s.age / 0.45;
    const ux = Math.cos(s.angle);
    const uy = Math.sin(s.angle);
    const cx = s.x + ux * s.range * p;
    const cy = s.y + uy * s.range * p;
    ctx.beginPath();
    ctx.moveTo(cx - uy * s.halfWidth, cy + ux * s.halfWidth);
    ctx.lineTo(cx + uy * s.halfWidth, cy - ux * s.halfWidth);
    ctx.strokeStyle = TOWER_SPECS.surge.color;
    ctx.globalAlpha = 1 - p;
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const f of boltFlashes) {
    // The sky lights up: a huge soft glow around the strike.
    const alpha = (1 - f.age / 0.35) * 0.35;
    const radius = canvas.width * 0.45;
    const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, radius);
    grad.addColorStop(0, `rgba(220,245,255,${alpha})`);
    grad.addColorStop(0.4, `rgba(140,220,245,${alpha * 0.5})`);
    grad.addColorStop(1, "rgba(140,220,245,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(f.x - radius, f.y - radius, radius * 2, radius * 2);
  }
  for (const b of boltStrikes) {
    // Jagged zigzag between the endpoints.
    const dx = b.x2 - b.x1;
    const dy = b.y2 - b.y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    const SEGMENTS = 5;
    for (let i = 1; i < SEGMENTS; i++) {
      const f = i / SEGMENTS;
      const off = (i % 2 === 0 ? 1 : -1) * len * 0.08;
      ctx.lineTo(b.x1 + dx * f + nx * off, b.y1 + dy * f + ny * off);
    }
    ctx.lineTo(b.x2, b.y2);
    ctx.strokeStyle = b.color;
    ctx.globalAlpha = 1 - b.age / 0.22;
    ctx.lineWidth = b.width;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawHud(): void {
  // Embossed serif HUD text, twice the old size, stats in one line.
  const emboss = (
    text: string,
    x: number,
    y: number,
    color: string,
    font: string,
    align: CanvasTextAlign = "left",
  ) => {
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.fillText(text, x + 2, y + 2);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  const hudFont = "34px Impact, 'Arial Black', sans-serif";
  // Lives, gold, and the win goal on a single line.
  emboss(`❤ ${lives}`, 28, 20, "#ff8787", hudFont);
  const livesW = ctx.measureText(`❤ ${lives}`).width;
  emboss(`$${money.toLocaleString()}`, 28 + livesW + 34, 20, COLOR_MONEY, hudFont);
  const goldW = ctx.measureText(`$${money.toLocaleString()}`).width;
  emboss(
    `/ $1,000,000`,
    28 + livesW + 34 + goldW + 14,
    30,
    "#8d99b8",
    "bold 20px sans-serif",
  );
  emboss(
    wave > 0 ? `Wave ${wave}` : "GIDDY DIGS DEFENSE",
    canvas.width / 2,
    20,
    "#e8d9a0",
    hudFont,
    "center",
  );
  // One tower-width clear of the system menu button.
  emboss(`Looky Loos ${kills}`, canvas.width - 38 - TOWER_RADIUS * 2, 20, "#e8d9a0", hudFont, "right");

  if (warning && realClock < warning.until) {
    emboss(warning.text, canvas.width / 2, 96, "#ffd43b", "bold 66px sans-serif", "center");
  }


  if (phase === "idle") {
    fancyButton(buttonRect(), `Start Wave ${wave + 1}`, {
      labelColor: "#9ec5ff",
      font: "bold 22px sans-serif",
    });
  }
  if (preGame()) {
    // Mode + difficulty pickers, resume, player — gone once wave 1 starts.
    for (let i = 0; i < GAME_MODES.length; i++) {
      const m = GAME_MODES[i];
      const chosen = m === gameMode;
      fancyButton(modeButtonRect(i), GAME_MODE_LABEL[m], {
        labelColor: chosen ? "#9ec5ff" : COLOR_HINT,
        accent: chosen ? "#eaaf33" : ACCENT_DIM,
        font: "bold 19px sans-serif",
        alpha: chosen ? 1 : 0.7,
      });
    }
    for (let i = 0; i < DIFFICULTIES.length; i++) {
      const d = DIFFICULTIES[i];
      const chosen = d === difficulty;
      fancyButton(difficultyButtonRect(i), DIFFICULTY_LABEL[d], {
        labelColor: chosen ? COLOR_MONEY : COLOR_HINT,
        accent: chosen ? "#eaaf33" : ACCENT_DIM,
        font: "bold 19px sans-serif",
        alpha: chosen ? 1 : 0.7,
      });
    }
  }
  if (
    phase !== "gameover" &&
    phase !== "victory" &&
    (lastClearSnap !== null || prevClearSnap !== null || resumeAvailable)
  ) {
    fancyButton(resumeButtonRect(), "◀ PREV WAVE", {
      labelColor: "#69db7c",
      font: "bold 17px sans-serif",
    });
  }
  if (phase === "idle") {
    fancyButton(playerButtonRect(), `☗ ${activePlayerName()}`, {
      labelColor: COLOR_HINT,
      accent: ACCENT_DIM,
      font: "bold 17px sans-serif",
    });
  }

  if (phase !== "gameover" && phase !== "victory") {
    fancyButton(resetButtonRect(), "⟲ Reset", {
      labelColor: COLOR_HINT,
      accent: ACCENT_DIM,
    });
    fancyButton(speedButtonRect(), `▶ ${speedFactor}×`, {
      labelColor: speedFactor === 1 ? COLOR_HINT : COLOR_MONEY,
      accent: speedFactor === 1 ? ACCENT_DIM : "#eaaf33",
    });
  }

  if (phase === "gameover") {
    ctx.fillStyle = "rgba(10,12,20,0.75)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = COLOR_TEXT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 84px sans-serif";
    ctx.fillText("Game Over", canvas.width / 2, canvas.height / 2 - 60);
    ctx.font = "34px sans-serif";
    ctx.fillText(
      `You survived ${wave} wave${wave === 1 ? "" : "s"} — ${kills} kills`,
      canvas.width / 2,
      canvas.height / 2 + 24,
    );
    ctx.fillStyle = COLOR_HINT;
    ctx.fillText("Tap anywhere to play again", canvas.width / 2, canvas.height / 2 + 84);
  }

  if (phase === "victory") {
    ctx.fillStyle = "rgba(10,12,20,0.6)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const s of sparks) {
      ctx.globalAlpha = Math.max(0, Math.min(1, s.life));
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLOR_MONEY;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 96px sans-serif";
    ctx.fillText("YOU WIN!", canvas.width / 2, canvas.height / 2 - 60);
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = "38px sans-serif";
    ctx.fillText("$1,000,000 — SOLD!", canvas.width / 2, canvas.height / 2 + 24);
    ctx.fillStyle = COLOR_HINT;
    ctx.font = "30px sans-serif";
    ctx.fillText(
      `${wave} waves — ${kills} kills — tap to play again`,
      canvas.width / 2,
      canvas.height / 2 + 84,
    );
  }
}

function draw(): void {
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawField();
  drawTowers();
  drawEnemies();
  drawMilitias();
  drawEffects();
  drawHud();
  // Selection UI always renders on the very top.
  drawTowerMenus();
  drawTowerKey();
  drawWaveSummary();
  drawResetModal(); // above absolutely everything
}

function waveSummaryRect(): [number, number, number, number] {
  if (waveSummary === null) return [0, 0, 0, 0];
  const rows =
    2 + (waveSummary.farm > 0 ? 1 : 0) + (waveSummary.bank > 0 ? 1 : 0);
  const w = 460;
  const h = 26 * 2 + 44 + rows * 34 + 44; // pads + title + rows + total
  return [(canvas.width - w) / 2, (canvas.height - h) / 2 - 40, w, h];
}

function drawWaveSummary(): void {
  if (waveSummary === null || realClock >= waveSummary.until) return;
  const s = waveSummary;
  const [x, y, w, h] = waveSummaryRect();
  ctx.save();
  // Fade out over the last second.
  const left = s.until - realClock;
  ctx.globalAlpha = Math.max(0, Math.min(1, left));
  drawKeyPanel(x, y, w, h);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.font = "28px Impact, sans-serif";
  ctx.fillStyle = COLOR_TEXT;
  ctx.fillText(`WAVE ${s.wave} CLEARED`, x + w / 2, y + 26 + 10);
  const rows: Array<[string, number, string]> = [["LOOKY LOOS RUN OFF", s.kills, COLOR_ENEMY], ["WAVE BONUS", s.bonus, "#9ec5ff"]];
  if (s.farm > 0) rows.push(["RENTAL INCOME", s.farm, TOWER_SPECS.crop.color]);
  if (s.bank > 0) rows.push(["BANK INTEREST", s.bank, TOWER_SPECS.farm.color]);
  let rowY = y + 26 + 44 + 17;
  for (const [label, amount, color] of rows) {
    ctx.font = "bold 17px sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = color;
    ctx.fillText(label, x + 34, rowY);
    ctx.textAlign = "right";
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(`+$${amount.toLocaleString()}`, x + w - 34, rowY);
    rowY += 34;
  }
  ctx.strokeStyle = "#eaaf33";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 26, rowY - 8);
  ctx.lineTo(x + w - 26, rowY - 8);
  ctx.stroke();
  ctx.font = "bold 20px sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = COLOR_MONEY;
  ctx.fillText("TOTAL", x + 34, rowY + 14);
  ctx.textAlign = "right";
  ctx.fillText(`+$${(s.kills + s.bonus + s.farm + s.bank).toLocaleString()}`, x + w - 34, rowY + 14);
  ctx.restore();
}

function drawResetModal(): void {
  if (!resetConfirmOpen) return;
  ctx.save();
  ctx.fillStyle = "rgba(10,12,20,0.65)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const [x, y, w, h] = resetModalRect();
  drawKeyPanel(x, y, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "34px Impact, sans-serif";
  ctx.fillStyle = COLOR_TEXT;
  ctx.fillText("RESET GAME?", x + w / 2, y + 52);
  ctx.font = "18px sans-serif";
  ctx.fillStyle = COLOR_HINT;
  ctx.fillText("This abandons the run and deletes the saved game.", x + w / 2, y + 96);
  fancyButton(resetConfirmRect(), "✓ RESET", {
    labelColor: COLOR_WARN,
    font: "bold 22px sans-serif",
  });
  fancyButton(resetAbortRect(), "✗ KEEP PLAYING", {
    labelColor: COLOR_HINT,
    accent: ACCENT_DIM,
    font: "bold 20px sans-serif",
  });
  ctx.restore();
}

// -------------------------------------------------------------- game loop

resize();
window.addEventListener("resize", resize);

let lastTime = performance.now();
function frame(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  realClock += dt;
  if (phase === "wave") playedMs += dt * 1000;
  // Fixed sub-steps: fast-forward multiplies the COUNT of steps, never the
  // size of one — so creeps can't tunnel through walls at 6×.
  let sim = dt * speedFactor;
  while (sim > 1e-6) {
    const step = Math.min(sim, 1 / 30);
    update(step);
    sim -= step;
  }
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------- input

if (Board.isOnDevice) {
  const fingerWasTouched = new Map<number, boolean>();

  // The device recreates piece contacts constantly (a fresh contactId every
  // report), so identity by contactId is useless. Match each report to the
  // nearest tracked piece BY POSITION instead — physical pieces can't
  // teleport — and lift a piece only after it's gone quiet for a moment.
  // Wide enough that a sensor GHOST candidate elsewhere under the same
  // physical footprint merges into the same tracked piece.
  const PIECE_MATCH_RADIUS = PIECE_RADIUS * 2; // 168px
  const PIECE_LOST_AFTER = 0.35; // seconds of silence = actually lifted
  let nextShipKey = 1;

  Board.input.subscribe((contacts: ReadonlyArray<BoardContact>) => {
    const seenFingers = new Set<number>();

    for (const c of contacts) {
      if (c.phase === BoardContactPhase.Ended || c.phase === BoardContactPhase.Canceled) {
        continue;
      }
      if (c.glyphId > 0) {
        // Find the tracked piece nearest this report.
        let key: number | null = null;
        let best = PIECE_MATCH_RADIUS;
        for (const [k, ship] of ships) {
          const d = Math.hypot(ship.x - c.x, ship.y - c.y);
          if (d < best) {
            best = d;
            key = k;
          }
        }
        if (key !== null) {
          movePiece(key, c.x, c.y, c.orientation);
        } else {
          placePiece(nextShipKey++, c.x, c.y, c.glyphId, c.orientation);
        }
      } else {
        seenFingers.add(c.contactId);
        const was = fingerWasTouched.get(c.contactId) ?? false;
        if (c.isTouched && !was) touchDown(c.x, c.y, c.contactId);
        else if (c.isTouched && was) touchMove(c.x, c.y, c.contactId);
        else if (!c.isTouched && was) touchUp(c.contactId);
        fingerWasTouched.set(c.contactId, c.isTouched);
      }
    }

    for (const [k, ship] of [...ships]) {
      if (realClock - ship.lastSeen > PIECE_LOST_AFTER) liftPiece(k);
    }
    for (const id of [...fingerWasTouched.keys()]) {
      if (!seenFingers.has(id)) {
        if (fingerWasTouched.get(id)) touchUp(id);
        fingerWasTouched.delete(id);
      }
    }
  });

  // The OS profile chip survives an app restart; start from a known state.
  try {
    Board.application.hideProfileSwitcher();
  } catch {
    // service not up yet — the chip toggle will sort itself out
  }

  // Log the save shelf at boot so game progress is visible in device logs.
  void Board.save
    .list()
    .then((saves) => {
      for (const s of saves) {
        console.log(
          `[save] "${s.description}" updated=${new Date(s.updatedAt).toLocaleString()} played=${Math.round(s.playedTime / 60000)}min players=${s.playerCount}`,
        );
      }
      if (saves.length === 0) console.log("[save] none");
    })
    .catch((err) => console.log(`[save] list failed: ${String(err)}`));



  Board.pause.setContext({
    gameName: "GIDDY DIGS Defense",
    offerSaveOption: true,
    customButtons: [{ id: "restart", title: "Restart", icon: "circulararrow" }],
    audioTracks: [{ id: "sfx", name: "Sound Effects", value: 50 }],
  });
  Board.pause.onResult((result) => {
    if (result.action === "save_and_quit") {
      void autoSave().finally(() => Board.application.quit());
    } else if (result.action === "quit") {
      Board.application.quit();
    } else if (result.action === "custom_button" && result.customButtonId === "restart") {
      void wipeSave();
      restart();
    }
    for (const track of result.audioTracks ?? []) {
      if (track.id === "sfx") setMasterVolume(track.value / 100);
    }
  });
} else {
  let nextFakeId = 1_000_000;
  window.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    ensureAudio();
    touchDown(...toGame(e.clientX, e.clientY), "mouse");
  });
  window.addEventListener("pointermove", (e) => {
    if (e.buttons & 1) touchMove(...toGame(e.clientX, e.clientY), "mouse");
  });
  window.addEventListener("pointerup", (e) => {
    if (e.button === 0) touchUp("mouse");
  });
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const [gx, gy] = toGame(e.clientX, e.clientY);
    for (const [cid, ship] of ships) {
      if (Math.hypot(ship.x - gx, ship.y - gy) <= TOWER_RADIUS) {
        // 30° per right-click — stays under the 45° ambiguity fold.
        movePiece(cid, ship.x, ship.y, ship.lastOrientation + 30);
        return;
      }
    }
    for (const t of towers.values()) {
      if (Math.hypot(t.x - gx, t.y - gy) <= TOWER_RADIUS) {
        placePiece(nextFakeId++, t.x, t.y, 60 + TOWER_TYPE_ORDER.indexOf(t.type), 0);
        return;
      }
    }
  });

  // Dev-only hook: lets tooling step the simulation and inspect state even
  // when the tab is hidden (rAF throttled). Never present on the device.
  (window as unknown as Record<string, unknown>).__pieceDefense = {
    step(seconds: number): void {
      const ticks = Math.round(seconds * 60);
      for (let i = 0; i < ticks; i++) {
        realClock += 1 / 60;
        update(1 / 60);
      }
      draw();
    },
    tap: (x: number, y: number) => {
      touchDown(x, y, "hook");
      touchUp("hook");
    },
    touchDown,
    touchMove,
    touchUp,
    piece: placePiece,
    slide: movePiece,
    lift: liftPiece,
    wavePreview: (w: number) => buildWave(w),
    grant(n: number): void {
      money += n;
    },
    pathOpen: () => {
      for (const cy of gateRows()) {
        const i = cellIndex(0, cy);
        if (!blocked[i] && flowDist[i] !== Infinity) return true;
      }
      return false;
    },
    state: () => ({
      phase,
      wave,
      lives,
      kills,
      money,
      speed: speedFactor,
      clock: Math.round(clock * 100) / 100,
      enemies: enemies.map((e) => ({
        x: Math.round(e.x),
        y: Math.round(e.y),
        hp: Math.round(e.hp * 100) / 100,
        remaining: Math.round(e.remaining),
      })),
      towers: [...towers.entries()].map(([id, t]) => ({
        id,
        x: t.x,
        y: t.y,
        menuOpen: t.menuOpen,
        type: t.type,
        level: t.level,
        state: t.state,
        targetMode: t.targetMode,
        facing: t.facing,
        sellConfirmOpen: realClock < t.sellConfirmUntil,
        sell: sellValue(t),
      })),
      aimLink: aimLinkTowerId,
      ships: [...ships.entries()].map(([cid, s]) => ({
        cid,
        heading: Math.round(s.heading),
      })),
    }),
  };
}
