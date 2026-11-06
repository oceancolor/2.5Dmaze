// 视野规则（SPEC §6.1）。2026-11-06 批次 6 裁定：全公开（full）是唯一的对局规则，已直接写进默认配置。
// 其余规则只为服务器校验旧记录保留（radius = 批次 6 之前的默认；delayed / radar = 批次 2 的实验预设），
// 以及视野实验工具（tools/vision-experiment.mjs）复现当时的对比。界面不再提供选择。

export const VISION_IDS = Object.freeze(['full', 'radius', 'delayed', 'radar']);
/** 对局规则（唯一）。 */
export const DEFAULT_VISION = 'full';
/** 只用于校验旧记录 / 实验的规则。 */
export const LEGACY_VISION_IDS = Object.freeze(['radius', 'delayed', 'radar']);

export const VISION_PRESETS = Object.freeze({
  full: Object.freeze({ id: 'full', label: '全公开', short: '所有对手的实时位置全公开；他们要去哪不知道', mode: 'full' }),
  radius: Object.freeze({ id: 'radius', label: '视野半径（旧）', short: '对手只在 9 格内实时可见，视野外只知道最后目击位置', mode: undefined }),
  delayed: Object.freeze({ id: 'delayed', label: '延迟全图（实验）', short: '9 格内实时；更远的对手显示 5 回合前的位置', mode: 'delayed', delayTurns: 5 }),
  radar: Object.freeze({ id: 'radar', label: '定期雷达（实验）', short: '9 格内实时；每 15 回合全员位置广播一次', mode: 'radar', radarEvery: 15 }),
});

export const isVision = (id) => Object.prototype.hasOwnProperty.call(VISION_PRESETS, id);

/**
 * makeConfig 覆盖项片段。全公开 = 默认配置，覆盖为空；旧规则显式把 mode 改回去（radius 设为 undefined，与旧配置逐字节一致）。
 * 也接受自定义 {mode, delayTurns, radarEvery}（实验扫描用）。
 */
export function visionOverrides(v = DEFAULT_VISION) {
  const p = typeof v === 'string' ? VISION_PRESETS[v] : v;
  if (!p) throw new Error(`unknown vision preset ${v}`);
  const mode = p.mode === 'radius' ? undefined : p.mode;
  if (mode === 'full') return {};
  const o = { mode };
  if (mode === 'delayed') o.delayTurns = p.delayTurns;
  if (mode === 'radar') o.radarEvery = p.radarEvery;
  return { vision: o };
}

/** 配置 → 规则 id（不是预设里的组合返回 null）。 */
export function visionIdOf(cfg) {
  const V = cfg.vision;
  const mode = V.mode ?? 'radius';
  for (const p of Object.values(VISION_PRESETS)) {
    if ((p.mode ?? 'radius') !== mode) continue;
    if (mode === 'delayed' && p.delayTurns !== V.delayTurns) continue;
    if (mode === 'radar' && p.radarEvery !== V.radarEvery) continue;
    return p.id;
  }
  return null;
}

/** 给人 / 大模型看的一句话规则说明。 */
export function visionText(cfg) {
  const V = cfg.vision;
  const R = V.entityRadius;
  switch (V.mode ?? 'radius') {
    case 'full': return '所有在场对手的实时位置全公开（他们的目标 / 意图不公开，要你自己推断）';
    case 'delayed': return `对手在切比雪夫距离 ${R} 内实时可见；更远的对手给 ${V.delayTurns} 回合前的真实位置（lastSeen，turnsSince 约 ${V.delayTurns + 1}）`;
    case 'radar': return `对手在切比雪夫距离 ${R} 内实时可见；每 ${V.radarEvery} 回合全员位置广播一次，其余时间视野外只给最后已知位置（lastSeen）`;
    default: return `对手只在切比雪夫距离 ${R} 内实时可见；视野外只给最后目击位置（lastSeen）`;
  }
}
