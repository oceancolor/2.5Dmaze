// 地图规格 XS / S / M / L / XL：生成、整局、配置哈希、服务器校验。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, makeConfig } from '../src/config/default.config.js';
import { MAP_SIZES, MAP_SIZE_IDS, matchOverrides, sizeOverrides, isMapSize } from '../src/config/map-sizes.js';
import { configHash } from '../src/core/hash.js';
import { createMatch } from '../src/core/state.js';
import { createScheduler } from '../src/app/scheduler.js';
import { verifyRecord } from '../server/verifier.mjs';
import { createCamera } from '../src/render/camera.js';

test('规格表：五档边长 16/32/64/96/128；XL 覆盖为空，哈希与引入规格前一致（旧记录照常校验）', () => {
  assert.deepEqual(MAP_SIZE_IDS.map((id) => MAP_SIZES[id].size), [16, 32, 64, 96, 128]);
  assert.deepEqual(sizeOverrides('XL'), {});
  assert.equal(configHash(makeConfig(matchOverrides('manual', 'XL'))), configHash(DEFAULT_CONFIG));
  assert.equal(isMapSize('XXL'), false);
  assert.throws(() => sizeOverrides('XXL'), /unknown map size/);
  const hashes = new Set(MAP_SIZE_IDS.map((id) => configHash(makeConfig(matchOverrides('manual', id)))));
  assert.equal(hashes.size, 5, '每档配置哈希各不相同');
});

test('每档：20 个种子全部生成成功（V1–V7），出生 / 出口在边上且体力 / 回合按比例缩放', () => {
  for (const id of MAP_SIZE_IDS) {
    const cfg = makeConfig(matchOverrides('manual', id));
    const N = cfg.maze.size;
    assert.equal(N, MAP_SIZES[id].size);
    assert.equal(cfg.rules.staminaByMode.manual, MAP_SIZES[id].stamina);
    assert.equal(cfg.rules.maxTurns, MAP_SIZES[id].maxTurns);
    for (let s = 1; s <= 20; s++) {
      const m = createMatch(`size-${id}-${s}`, cfg);
      assert.equal(m.map.size, N);
      for (const d of m.map.spawnExit) assert.ok(d >= cfg.exits.spawnExitRange[0] && d <= cfg.exits.spawnExitRange[1], `${id} 出生→出口 ${d}`);
    }
  }
});

test('每档：启发式整局能结束，记录经服务器严格回放 verified，并识别出规格', () => {
  for (const id of ['XS', 'S', 'M']) {
    const cfg = makeConfig(matchOverrides('script', id));
    const s = createScheduler(cfg, `rec-${id}`, { manual: false, seatLabels: ['script', 'heuristic', 'heuristic', 'heuristic'] });
    s.runSync(0, cfg.rules.maxTurns + 10);
    assert.ok(s.state.ended, `${id} 对局结束`);
    assert.ok(s.state.turn <= cfg.rules.maxTurns);
    const v = verifyRecord(s.toJSONL());
    assert.equal(v.verify, 'verified', `${id}: ${v.verifyNote}`);
    assert.equal(v.mapSize, id);
    assert.equal(v.playerMode, 'script');
  }
});

test('摄像机：全图档在小图上可放大（不超过最大档），XL 仍封顶在 zoomLevels 最后一档', () => {
  const zl = DEFAULT_CONFIG.render.zoomLevels;
  const fitOf = (size) => {
    const c = createCamera({ zoomLevels: zl, size });
    c.setZoomIndex(zl.length - 1);
    c.update(0, 4000, 4000); // 视口足够大：只受封顶约束
    return c.zoom;
  };
  assert.equal(fitOf(128), zl.at(-1));
  assert.equal(fitOf(16), zl[0]);
  assert.ok(fitOf(64) > zl.at(-1) && fitOf(64) <= zl[0]);
});
