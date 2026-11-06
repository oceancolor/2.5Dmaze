// 所有「认可的配置」：当前版本（玩家通道 × 地图规格，视野全公开）+ 冻结的旧版本 SPEC-0.1。
// 服务器校验与客户端复盘（由记录的 configHash 找回配置）共用，保证两边认的是同一批配置。

import { DEFAULT_CONFIG, makeConfig } from './default.config.js';
import { MAP_SIZE_IDS, matchOverrides } from './map-sizes.js';
import { spec01Configs } from './legacy.js';
import { configHash } from '../core/hash.js';

let cache = null;

/** @returns {Map<string, {cfg:object, mode:string, mapSize:string, vision:string}>} configHash → 配置 */
export function knownConfigs() {
  if (cache) return cache;
  const m = new Map();
  for (const mode of Object.keys(DEFAULT_CONFIG.rules.staminaByMode)) {
    for (const mapSize of MAP_SIZE_IDS) {
      const cfg = makeConfig(matchOverrides(mode, mapSize));
      m.set(configHash(cfg), { cfg, mode, mapSize, vision: 'full' });
    }
  }
  for (const k of spec01Configs()) m.set(configHash(k.cfg), k);
  cache = m;
  return m;
}

/** 由 configHash 找回配置（不认识返回 null）。 */
export const configByHash = (hash) => knownConfigs().get(hash) || null;
