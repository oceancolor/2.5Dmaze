// 旧规则版本 SPEC-0.1 的配置快照（2026-11-06 批次 6 之前的默认配置，逐字照抄）。
// 只用于服务器校验旧记录与复现旧实验：configHash 覆盖整份配置，新版默认配置一改，旧记录的哈希就对不上，
// 所以旧配置单独冻结在这里，与 default.config.js 的演进脱钩。**不要改这个文件里的任何值。**
//
// SPEC-0.1 下出现过的配置：玩家通道 × 地图规格 × 视野规则（radius = 当时默认；full / delayed / radar = 批次 2 实验）。

import { makeConfigFrom } from './default.config.js';
import { MAP_SIZE_IDS, sizeOverrides } from './map-sizes.js';

export const SPEC01_DEFAULTS = Object.freeze({
  rulesVersion: 'SPEC-0.1',
  match: { playerSeat: 0, playerMode: 'manual' },
  maze: {
    size: 128,
    wallDensityTarget: 0.355,
    wallDensityTol: 0.008,
    thinKeep: 0.727,
    growth: { newest: 0.55, random: 0.35, oldest: 0.10 },
    braidRatio: 0.35,
    roomCount: 4,
    roomSize: [6, 14],
    spawnPlazaRadius: 1,
    spawnMinOpenNeighbors: 2,
    attempts: 20,
  },
  spawns: [[2, 2], [125, 2], [125, 125], [2, 125]],
  exits: {
    positions: [[63, 0], [127, 63], [63, 127], [0, 63]],
    spawnExitRange: [68, 108],
    fairnessMaxSpread: 0.35,
  },
  rules: {
    staminaByMode: { manual: 400, prompt: 400, script: 400, byok: 400 },
    moveCost: 1,
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
  vision: { entityRadius: 9, terrainPatch: 15, rememberEntities: true, mode: undefined, delayTurns: undefined, radarEvery: undefined },
  ai: {
    homeFactorX10: 13,
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
      detourMaxExtra: 12,
      detourCommitTurns: 12,
      yieldMaxTurns: 16,
      yieldEscalateAfter: 6,
      yieldPct: 50,
    },
    llm: {
      timeoutMs: 8000,
      retries: 1,
      temperature: 0,
      maxInputTokens: 1500,
      maxOutputTokens: 200,
      repairMaxTokens: 150,
      promptSuffixMaxChars: 2000,
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
});

export const SPEC01_BASE = makeConfigFrom(SPEC01_DEFAULTS, {});

/** SPEC-0.1 时代的视野覆盖（radius = 当时默认，不加覆盖）。 */
const SPEC01_VISION = Object.freeze({
  radius: {},
  full: { vision: { mode: 'full' } },
  delayed: { vision: { mode: 'delayed', delayTurns: 5 } },
  radar: { vision: { mode: 'radar', radarEvery: 15 } },
});
export const SPEC01_VISION_IDS = Object.freeze(Object.keys(SPEC01_VISION));

/** 一份 SPEC-0.1 配置（与当时客户端开局时算出的配置逐字节一致）。 */
export function spec01Config(playerMode, mapSize = 'XL', vision = 'radius') {
  return makeConfigFrom(SPEC01_DEFAULTS, { ...sizeOverrides(mapSize, SPEC01_BASE), ...SPEC01_VISION[vision], match: { playerMode } });
}

/** 枚举 SPEC-0.1 下所有出现过的配置（服务器白名单用）。 */
export function* spec01Configs() {
  for (const mode of Object.keys(SPEC01_DEFAULTS.rules.staminaByMode)) {
    for (const mapSize of MAP_SIZE_IDS) {
      for (const vision of SPEC01_VISION_IDS) yield { cfg: spec01Config(mode, mapSize, vision), mode, mapSize, vision };
    }
  }
}
