// 视野规则预设（2026-11-06 实验，SPEC §6.1、附录 C）。默认 radius = 现行规则，覆盖为空 → 配置哈希不变。
// 游戏设置页、服务器白名单、命令行评测、视野实验工具都用这里的预设，保证同一规则 → 同一个配置哈希。

export const VISION_IDS = Object.freeze(['radius', 'full', 'delayed', 'radar']);
export const DEFAULT_VISION = 'radius';

/** 预设参数（实验用的扫描值见 tools/vision-experiment.mjs，可以不在预设里）。 */
export const VISION_PRESETS = Object.freeze({
  radius: Object.freeze({ id: 'radius', label: '视野半径（现行）', short: '对手只在 9 格内实时可见，视野外只知道最后目击位置' }),
  full: Object.freeze({ id: 'full', label: '全公开', short: '所有对手的实时位置全公开；他们要去哪仍然不知道', mode: 'full' }),
  delayed: Object.freeze({ id: 'delayed', label: '延迟全图', short: '9 格内实时；更远的对手显示 5 回合前的位置', mode: 'delayed', delayTurns: 5 }),
  radar: Object.freeze({ id: 'radar', label: '定期雷达', short: '9 格内实时；每 15 回合全员位置广播一次', mode: 'radar', radarEvery: 15 }),
});

export const isVision = (id) => Object.prototype.hasOwnProperty.call(VISION_PRESETS, id);

/** makeConfig 覆盖项片段：{} 或 { vision: {...} }。也接受自定义 {mode, delayTurns, radarEvery}（实验扫描用）。 */
export function visionOverrides(v = DEFAULT_VISION) {
  const p = typeof v === 'string' ? VISION_PRESETS[v] : v;
  if (!p) throw new Error(`unknown vision preset ${v}`);
  if (!p.mode || p.mode === 'radius') return {};
  const o = { mode: p.mode };
  if (p.mode === 'delayed') o.delayTurns = p.delayTurns;
  if (p.mode === 'radar') o.radarEvery = p.radarEvery;
  return { vision: o };
}

/** 配置 → 预设 id（不是预设里的组合返回 null）。 */
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
    case 'full': return '所有在场对手的实时位置全公开（他们的目标 / 意图不公开）';
    case 'delayed': return `对手在切比雪夫距离 ${R} 内实时可见；更远的对手给 ${V.delayTurns} 回合前的真实位置（lastSeen，turnsSince 约 ${V.delayTurns + 1}）`;
    case 'radar': return `对手在切比雪夫距离 ${R} 内实时可见；每 ${V.radarEvery} 回合全员位置广播一次，其余时间视野外只给最后已知位置（lastSeen）`;
    default: return `对手只在切比雪夫距离 ${R} 内实时可见；视野外只给最后目击位置（lastSeen）`;
  }
}
