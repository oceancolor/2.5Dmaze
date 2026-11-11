import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from './helpers.mjs';
import { makeConfig } from '../src/config/default.config.js';
import { matchOverrides } from '../src/config/map-sizes.js';
import { createMatch } from '../src/core/state.js';
import { observe } from '../src/core/observe.js';
import { cheb } from '../src/core/geom.js';
import { fieldFrom } from '../src/core/nav/bfs.js';
import { runMatch } from '../src/sim/headless.js';

test('视野（批次 6 全公开）：所有在场对手都给实时坐标；已离场的不给', () => {
  const { map } = createMatch(3, CFG);
  let visible = 0;
  runMatch(3, CFG, {
    onTurn(prev) {
      for (let i = 0; i < 4; i++) {
        if (prev.actors[i].status !== 'active') continue;
        const o = observe(map, prev, i, CFG, { patch: false });
        for (const e of o.actors) {
          const a = prev.actors[e.seat];
          assert.equal(e.visible, a.status === 'active');
          if (e.visible) { visible++; assert.deepEqual([e.x, e.y], [a.x, a.y]); }
          else assert.ok(!('x' in e) && !('y' in e));
        }
      }
    },
  });
  assert.ok(visible > 0);
});

test('旧规则（只用于校验旧记录）：只有切比雪夫 R 内的在场对手给出坐标，视野外不泄露当前坐标', () => {
  const OLD = makeConfig(matchOverrides('manual', 'XL', 'radius'));
  const R = OLD.vision.entityRadius;
  const { map } = createMatch(3, OLD);
  let visible = 0;
  let hidden = 0;
  runMatch(3, OLD, {
    onTurn(prev) {
      for (let i = 0; i < 4; i++) {
        if (prev.actors[i].status !== 'active') continue;
        const o = observe(map, prev, i, OLD, { patch: false });
        for (const e of o.actors) {
          const a = prev.actors[e.seat];
          const inRange = a.status === 'active' && cheb(a.x, a.y, prev.actors[i].x, prev.actors[i].y) <= R;
          assert.equal(e.visible, inRange);
          if (e.visible) { visible++; assert.deepEqual([e.x, e.y], [a.x, a.y]); }
          else { hidden++; assert.ok(!('x' in e) && !('y' in e)); }
        }
      }
    },
  });
  assert.ok(visible > 0 && hidden > 0);
});

test('记忆：视野外给出最后目击（含拾取/开箱广播）与经过回合数', () => {
  // 全公开规则下「看不见」只出现在对手已离场、座位 0 还在场时；多跑几个种子保证覆盖到（2026-11-11 宝箱估值改后种子 3 不再出现）
  let checked = 0;
  for (const seed of [3, 5, 7, 9, 11]) {
    const { map } = createMatch(seed, CFG);
    const track = [null, null, null, null];
    runMatch(seed, CFG, {
      onTurn(prev, res) {
        const s = res.state;
        if (s.actors[0].status !== 'active') return;
        for (const e of res.events) {
          if ((e.type === 'pickup' || e.type === 'chest') && e.seat !== 0) track[e.seat] = [e.x, e.y, prev.turn];
        }
        const o = observe(map, s, 0, CFG, { patch: false });
        for (const e of o.actors) {
          if (e.visible) { track[e.seat] = [e.x, e.y, prev.turn]; continue; }
          const t = track[e.seat];
          if (!t) { assert.equal(e.lastSeen, null); continue; }
          assert.deepEqual([e.lastSeen.x, e.lastSeen.y], [t[0], t[1]]);
          assert.equal(e.lastSeen.turnsSince, s.turn - t[2]);
          checked++;
        }
      },
    });
  }
  assert.ok(checked > 0);
});

test('观察：体力告警 lowStamina = 体力 < 到出口距离；终盘区按 homeFactor', () => {
  const { map, state } = createMatch(4, CFG);
  const N = map.size;
  const a = state.actors[0];
  const [ex, ey] = map.exits[0];
  const d = fieldFrom(map, ey * N + ex)[a.y * N + a.x];
  a.stamina = d;
  let o = observe(map, state, 0, CFG);
  assert.equal(o.self.distToExit, d);
  assert.equal(o.self.lowStamina, false);
  a.stamina = d - 1;
  o = observe(map, state, 0, CFG);
  assert.equal(o.self.lowStamina, true);
  assert.equal(o.self.inEndgame, true);
});

test('观察：宝石全局可见带 BFS 距离；地形窗按需给出；改观察不影响对局状态', () => {
  const { map, state } = createMatch(4, CFG);
  const o = observe(map, state, 0, CFG);
  assert.equal(o.gems.length, state.gems.length);
  for (const g of o.gems) assert.ok(g.dist > 0);
  assert.equal(o.terrainPatch.rows.length, CFG.vision.terrainPatch);
  assert.ok(!('terrainPatch' in observe(map, state, 0, CFG, { patch: false })));
  o.self.gems[0] = 99;
  o.gems.length = 0;
  assert.equal(state.actors[0].gems[0], 0);
  assert.ok(state.gems.length > 0);
});
