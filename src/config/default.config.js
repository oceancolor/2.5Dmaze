// docs/SPEC.md §14 —— config 键表的唯一来源。改数值须同步 SPEC。
// 覆盖方式：makeConfig({ ...局部覆盖 })；未知键直接抛错（防拼写错误静默失效）。

const DEFAULTS = {
  rulesVersion: 'SPEC-0.1',

  match: { playerSeat: 0, playerMode: 'manual' }, // manual | prompt | script | byok（05 模式 B：接入玩家自己的大模型）

  maze: {
    size: 128,
    wallDensityTarget: 0.355,
    wallDensityTol: 0.008,
    thinKeep: 0.727, // 标定值（tools/calibrate.mjs，400 种子 → 封边后密度均值 0.355），非规格；换生成器必须重标
    growth: { newest: 0.55, random: 0.35, oldest: 0.10 },
    braidRatio: 0.35,
    roomCount: 4,
    roomSize: [6, 14],
    spawnPlazaRadius: 1,
    spawnMinOpenNeighbors: 2,
    attempts: 20,
  },

  // 座位 0..3，顺时针；exits.positions 与之同序配对（座位 i 的出口 = positions[i]）
  spawns: [[2, 2], [125, 2], [125, 125], [2, 125]],
  exits: {
    positions: [[63, 0], [127, 63], [63, 127], [0, 63]],
    spawnExitRange: [68, 108],
    fairnessMaxSpread: 0.35,
  },

  rules: {
    staminaByMode: { manual: 400, prompt: 400, script: 400, byok: 400 },
    moveCost: 1, // 唯一的体力消耗（SPEC §2.2 不扣分原则）
    maxTurns: 600,
  },

  treasure: {
    gemColors: ['red', 'yellow', 'green', 'blue', 'purple'],
    gemsPerColor: 1,
    gemScore: 1,
    setBonus: 5,
    gemRespawnMax: 2,
    gemRespawnMinActorDist: 15,
    placement: {
      minSeparation: 30,
      rejectTries: 30,
      restartMax: 4,
      fairMaxSpread: 0.35,
      spawnExclusion: 3,
      exitExclusion: 2,
      fallbackSets: 64,
      respawnSepSchedule: [30, 20, 10, 0],
    },
    chest: {
      count: 1,
      pScore: 0.5,
      scoreRange: [1, 5],
      staminaRange: [25, 50],
      respawnTurns: 60,
      respawnMax: 2,
      respawnMinActorDist: 30,
    },
  },

  vision: { entityRadius: 9, terrainPatch: 15, rememberEntities: true },

  ai: {
    homeFactorX10: 13, // 终盘区 / 回家阈值：stamina*10 <= dist*13
    replanInterval: 8,
    replanIntervalMax: 10,
    replanIntervalEndgame: 6,
    eventCooldownTurns: 3,
    eventBudgetPerAgent: 10,
    maxCallsPerGame: 360,
    poolNormal: 240,
    poolEndgame: 120,
    normalSoftCapPerAgent: 60,
    endgameBudgetPerAgent: 10,
    planLatencyTurns: 2,
    heuristic: {
      returnMarginX10: 13,
      wProgress: 0.5,
      wChestLow: 1.2,
      wChestHigh: 0.6,
      chestLowStamina: 300,
      unblockAfter: 2,
      detourMaxExtra: 12, // 绕路比原路多出的步数上限，超过则让行
      detourCommitTurns: 12, // 选定绕路后，避让格在这么多回合内持续当墙（防止走一步又折回）
      yieldMaxTurns: 16, // 让行模式最长持续回合
      yieldEscalateAfter: 6, // 有路权者连续受阻到此值也让（对方退无可退）
      yieldPct: 50, // 连续受阻且目标格被争夺时让行的概率（%），打破同格冲突对称僵局
    },
    llm: {
      timeoutMs: 8000,
      retries: 1,
      temperature: 0,
      maxInputTokens: 1500,
      maxOutputTokens: 200,
      repairMaxTokens: 150,
      promptSuffixMaxChars: 2000,
      // 经服务器中转（05 §7.4）：客户端超时略短于服务器的上游超时（45 s / 90 s），由客户端判超时并修复一次。
      // HY4 关闭思考实测（2026-10-29，经中转两局 39 次）：P50 ≈ 2.9 s、P90 ≈ 4.5 s，最慢 24.9 s、20.8 s。
      // 客户端放弃的那次服务器照样等到上游回来、服务商照样计费；20 s 时那两次各补发一次修复，总等待反而更长（27–29 s）。
      // 所以宁可多等：游戏在生效回合会等，放宽超时只让节奏变慢，不影响结果。
      byokTimeoutMs: 40000,
      byokReasoningTimeoutMs: 85000,
    },
  },

  script: {
    decisionTimeoutMs: 100,
    warmupCall: true,
    navCallBudget: 8,
    stateBagKB: 16,
    l2ConsecutiveHard: 10,
    l1CumulativeSoft: 5,
    l1Action: 'auto-home',
  },

  motion: {
    moveMs: 200,
    bumpMs: 180,
    pickMs: 320,
    endMs: 600,
    pickOverlaps: true,
    speeds: [1, 2, 4],
    defaultSpeed: 2,
    spectateSpeed: 4,
  },

  render: {
    tileW: 64,
    tileH: 32,
    wallHeight: 48,
    chunk: 8,
    lruMax: 64,
    zoomLevels: [1.0, 0.6, 0.234],
    wallPalette: 'A',
    outline: true,
  },

  record: { keepRecent: 20 },
  proxy: { host: '127.0.0.1', port: 8787 },
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function mergeInto(base, over, path) {
  for (const k of Object.keys(over)) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in base)) throw new Error(`unknown config key: ${p}`);
    const bv = base[k];
    const ov = over[k];
    if (isPlainObject(bv)) {
      if (!isPlainObject(ov)) throw new Error(`config key ${p} expects an object`);
      mergeInto(bv, ov, p);
    } else {
      base[k] = structuredClone(ov);
    }
  }
  return base;
}

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function onBorderNotCorner([x, y], size) {
  const onV = x === 0 || x === size - 1;
  const onH = y === 0 || y === size - 1;
  return onV !== onH && x >= 0 && y >= 0 && x < size && y < size;
}

export function validateConfig(c) {
  const N = c.maze.size;
  if (c.spawns.length !== c.exits.positions.length) throw new Error('spawns / exits.positions length mismatch');
  for (const e of c.exits.positions) {
    if (!onBorderNotCorner(e, N)) throw new Error(`exit ${JSON.stringify(e)} must lie on the border (not a corner)`);
  }
  for (const [x, y] of c.spawns) {
    const r = c.maze.spawnPlazaRadius;
    if (x - r < 1 || y - r < 1 || x + r > N - 2 || y + r > N - 2) throw new Error(`spawn ${x},${y} plaza leaves the interior`);
  }
  if (!(c.maze.thinKeep > 0 && c.maze.thinKeep < 1)) throw new Error('maze.thinKeep must be in (0,1)');
  if (!(c.match.playerMode in c.rules.staminaByMode)) throw new Error(`unknown playerMode ${c.match.playerMode}`);
  if (c.treasure.gemsPerColor < 1) throw new Error('treasure.gemsPerColor >= 1');
  return c;
}

export function makeConfig(overrides = {}) {
  const c = mergeInto(structuredClone(DEFAULTS), overrides, '');
  validateConfig(c);
  return deepFreeze(c);
}

export const DEFAULT_CONFIG = makeConfig();

/** 本局四人共用的体力初值 / 上限（SPEC §2.1：由玩家座位的控制通道决定） */
export function staminaFor(cfg) {
  const v = cfg.rules.staminaByMode[cfg.match.playerMode];
  if (!Number.isInteger(v) || v <= 0) throw new Error(`invalid stamina for mode ${cfg.match.playerMode}`);
  return v;
}
