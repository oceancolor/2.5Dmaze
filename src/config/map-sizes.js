// 地图规格（SPEC §14.1）：XS 16 / S 32 / M 64 / L 96 / XL 128（默认）。
// sizeOverrides(id) 返回给 makeConfig 的覆盖项；XL = {}，配置哈希与引入规格前完全一致（旧记录照常校验）。
//
// 两类参数：
//   1. 生成校验阈值（墙密度、出生→出口步数、公平性）—— 按实测分布逐档定（.cache/calib-size.mjs，每档 60 种子）：
//      小图边框墙占比高、密度偏高；出生→出口步数约随边长线性；小图上四人步数的相对差更大，公平性放宽。
//   2. 规则数值（体力、回合、宝物间距、重生距离、宝箱体力）—— 按边长比例 f = N/128 缩放。
//      视野半径不缩：它是手感，不是地图比例（XS 上 9 格视野几乎全图可见，属预期）。
//      AI 调用预算不缩：它只是上限，回合少了自然用得少。

import { DEFAULT_CONFIG } from './default.config.js';
import { DEFAULT_VISION, visionOverrides } from './vision-modes.js';

const BASE = DEFAULT_CONFIG; // MAP_SIZES 的显示值用当前默认配置

/** 逐档表：只放需要逐档定的值，其余由 f 推导。 */
const TABLE = Object.freeze({
  XS: { size: 16, stamina: 50, maxTurns: 100, rooms: [0, [2, 3]], density: [0.43, 0.03], spawnExit: [7, 18], spread: 0.6, attempts: 40 },
  S: { size: 32, stamina: 100, maxTurns: 150, rooms: [0, [2, 4]], density: [0.408, 0.016], spawnExit: [15, 34], spread: 0.45, attempts: 30 },
  M: { size: 64, stamina: 200, maxTurns: 300, rooms: [1, [3, 7]], density: [0.38, 0.009], spawnExit: [30, 58], spread: 0.35, attempts: 20 },
  L: { size: 96, stamina: 300, maxTurns: 450, rooms: [2, [5, 11]], density: [0.365, 0.008], spawnExit: [46, 82], spread: 0.35, attempts: 20 },
  XL: { size: 128 },
});

export const MAP_SIZE_IDS = Object.freeze(['XS', 'S', 'M', 'L', 'XL']);
export const DEFAULT_MAP_SIZE = 'XL';

export const MAP_SIZES = Object.freeze(Object.fromEntries(MAP_SIZE_IDS.map((id) => [id, Object.freeze({
  id,
  size: TABLE[id].size,
  label: `${id} · ${TABLE[id].size}×${TABLE[id].size}`,
  stamina: TABLE[id].stamina ?? BASE.rules.staminaByMode.manual,
  maxTurns: TABLE[id].maxTurns ?? BASE.rules.maxTurns,
})])));

export function isMapSize(id) {
  return Object.prototype.hasOwnProperty.call(TABLE, id);
}

const scaled = (v, f, min) => Math.max(min, Math.round(v * f));

/**
 * @param {string} id XS|S|M|L|XL
 * @param {object} [BASE] 按哪份默认配置推导（旧规则版本的快照传自己的底，见 legacy.js）
 * @returns {object} makeConfig 覆盖项（不含 match）
 */
export function sizeOverrides(id = DEFAULT_MAP_SIZE, BASE = DEFAULT_CONFIG) {
  if (!isMapSize(id)) throw new Error(`unknown map size ${id}`);
  if (id === 'XL') return {};
  const t = TABLE[id];
  const N = t.size;
  const f = N / BASE.maze.size;
  const m = N / 2 - 1;
  const modes = Object.keys(BASE.rules.staminaByMode);
  const P = BASE.treasure.placement;
  const C = BASE.treasure.chest;
  return {
    maze: {
      size: N,
      wallDensityTarget: t.density[0],
      wallDensityTol: t.density[1],
      roomCount: t.rooms[0],
      roomSize: t.rooms[1],
      attempts: t.attempts,
    },
    spawns: [[2, 2], [N - 3, 2], [N - 3, N - 3], [2, N - 3]],
    exits: {
      positions: [[m, 0], [N - 1, m], [m, N - 1], [0, m]],
      spawnExitRange: t.spawnExit,
      fairnessMaxSpread: t.spread,
    },
    rules: {
      staminaByMode: Object.fromEntries(modes.map((k) => [k, t.stamina])),
      maxTurns: t.maxTurns,
    },
    treasure: {
      gemRespawnMinActorDist: scaled(BASE.treasure.gemRespawnMinActorDist, f, 3),
      placement: {
        minSeparation: scaled(P.minSeparation, f, 4),
        respawnSepSchedule: P.respawnSepSchedule.map((v) => (v === 0 ? 0 : scaled(v, f, 1))),
      },
      chest: {
        staminaRange: C.staminaRange.map((v, i) => scaled(v, t.stamina / BASE.rules.staminaByMode.manual, i ? 6 : 3)),
        respawnTurns: scaled(C.respawnTurns, t.maxTurns / BASE.rules.maxTurns, 10),
        respawnMinActorDist: scaled(C.respawnMinActorDist, f, 4),
      },
    },
    ai: {
      heuristic: {
        chestLowStamina: Math.round(BASE.ai.heuristic.chestLowStamina * (t.stamina / BASE.rules.staminaByMode.manual)),
      },
    },
  };
}

/**
 * 合并玩家模式、地图规格与视野规则的覆盖项（客户端开局与服务器白名单共用，保证同一份配置 → 同一个哈希）。
 * vision 缺省 full（批次 6 起唯一的对局规则，即默认配置本身）→ 不加覆盖；其他值只用于实验工具。
 */
export function matchOverrides(playerMode, mapSize = DEFAULT_MAP_SIZE, vision = DEFAULT_VISION) {
  const size = sizeOverrides(mapSize);
  const vis = visionOverrides(vision);
  return { ...size, ...vis, match: { playerMode } };
}
