// docs/SPEC.md §14 —— config 键表的唯一来源。改数值须同步 SPEC。
// 覆盖方式：makeConfig({ ...局部覆盖 })；未知键直接抛错（防拼写错误静默失效）。

// SPEC-0.2（2026-11-06 批次 6）：视野全公开 + 大模型 harness（博弈事实表 / 会话记忆 / 目标队列 / 思考档位）。
// 旧版 SPEC-0.1 的完整配置冻结在 legacy.js（服务器校验旧记录用），这里可以按新方案改。
const DEFAULTS = {
  rulesVersion: 'SPEC-0.2',

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

  // 视野规则（2026-11-06 用户裁定，批次 6）：全公开 —— 所有在场对手的实时位置全公开，意图不公开。
  // entityRadius 不再是「视野」，只作「近身范围」（启发式让行时把这个范围内的人当障碍）。
  // 旧规则（radius / delayed / radar，src/config/vision-modes.js）只留给服务器校验旧记录：
  //   mode: undefined = 旧 radius（configHash 跳过 undefined，所以旧记录的哈希不变）
  vision: { entityRadius: 9, terrainPatch: 15, rememberEntities: true, mode: 'full', delayTurns: undefined, radarEvery: undefined },

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
      // 玩家自己的 AI（决策契约 v2：可带后续目标、放弃条件、≤ 300 字备忘），回答本身的输出预算
      contractMaxTokens: 900,
      // 经服务器中转（05 §7.4）：客户端超时略短于服务器的上游超时（按思考档位：45 / 75 / 150 s）。
      // 游戏在生效回合会等，放宽超时只让节奏变慢，不影响结果；客户端放弃的那次服务器照样计费，所以宁可多等。
      // 思考档位实测（2026-11-06，开局局面一次决策）：Kimi K3 低 2.8 s / 高 27 s；DeepSeek 低 13.6 s / 高 21 s；GLM 低 3.7 s / 高 37 s；HY4 开思考写不出答案，只能关。
      byokTimeoutMs: { off: 40000, low: 70000, high: 145000 },
    },
    // 大模型 harness（批次 6）：一局一个会话，每次决策都带上「本局到目前为止」；跨局经验由模型赛后自己写、超长时自己压缩
    harness: {
      journalWindow: 8, // 会话里原样保留的最近决策条数（更早的折成摘要）
      memoMaxChars: 300, // 模型留给下一次自己的备忘
      thenMax: 2, // 决策可附带的后续目标数
      trendTurns: 6, // 对手动向：比较最近这么多回合的位置变化
      memoryMaxChars: 2000, // 跨局经验上限（超过时让模型压缩）
      memoryTargetChars: 1200, // 写经验 / 压缩时要求的长度
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
  const V = c.vision;
  if (V.mode !== undefined && !['radius', 'full', 'delayed', 'radar'].includes(V.mode)) throw new Error(`unknown vision.mode ${V.mode}`);
  if (V.mode === 'delayed' && !(Number.isInteger(V.delayTurns) && V.delayTurns >= 1)) throw new Error('vision.delayTurns must be an integer >= 1');
  if (V.mode === 'radar' && !(Number.isInteger(V.radarEvery) && V.radarEvery >= 1)) throw new Error('vision.radarEvery must be an integer >= 1');
  return c;
}

export function makeConfig(overrides = {}) {
  return makeConfigFrom(DEFAULTS, overrides);
}

/** 以指定的默认配置为底合并覆盖项（旧规则版本的配置快照用，见 legacy.js）。 */
export function makeConfigFrom(base, overrides = {}) {
  const c = mergeInto(structuredClone(base), overrides, '');
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
