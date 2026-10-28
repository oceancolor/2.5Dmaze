import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from './helpers.mjs';
import { runMatch } from '../src/sim/headless.js';
import { createMatch } from '../src/core/state.js';
import { bfsField } from '../src/core/nav/bfs.js';

// 第 7a 阶段重生时在场的角色 = 结算后仍在场 + 本回合刚达成（达成判定在重生之后）
const presentAtRespawn = (res, turn) =>
  res.state.actors.filter((a) => a.status === 'active' || (a.status === 'escaped' && a.escapedTurn === turn));

test('重生：一套全被拿光后才重生；新宝石距每个在场角色 ≥ gemRespawnMinActorDist；代数不超上限', () => {
  const T = CFG.treasure;
  const N = CFG.maze.size;
  let respawns = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const { map } = createMatch(seed, CFG);
    runMatch(seed, CFG, {
      onTurn(prev, res) {
        for (const e of res.events) {
          if (e.type !== 'gemRespawn') continue;
          respawns++;
          const picked = res.events.filter((x) => x.type === 'pickup').length;
          assert.equal(prev.gems.length - picked, 0, '重生前场上宝石应已拿光');
          assert.equal(res.state.gems.length, T.gemColors.length * T.gemsPerColor);
          assert.deepEqual(res.state.gems.map((g) => g.c).sort(), [0, 1, 2, 3, 4]);
          assert.ok(res.state.gemGeneration <= 1 + T.gemRespawnMax);
          const f = bfsField(map.grid, N, presentAtRespawn(res, prev.turn).map((a) => a.y * N + a.x));
          for (const g of res.state.gems) assert.ok(f[g.y * N + g.x] >= T.gemRespawnMinActorDist);
        }
      },
    });
  }
  assert.ok(respawns > 0, '12 局里至少应有一次重生');
});

test('宝箱重生：开箱后 respawnTurns 回合起才重生，距在场角色 ≥ respawnMinActorDist，次数不超上限', () => {
  const C = CFG.treasure.chest;
  const N = CFG.maze.size;
  let seen = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const { map } = createMatch(seed, CFG);
    let respawned = 0;
    runMatch(seed, CFG, {
      onTurn(prev, res) {
        for (const e of res.events) {
          if (e.type !== 'chestRespawn') continue;
          seen++;
          respawned++;
          assert.ok(prev.turn >= prev.chest.openedTurn + C.respawnTurns);
          const f = bfsField(map.grid, N, presentAtRespawn(res, prev.turn).map((a) => a.y * N + a.x));
          assert.ok(f[e.y * N + e.x] >= C.respawnMinActorDist);
        }
      },
    });
    assert.ok(respawned <= C.respawnMax);
  }
  assert.ok(seen > 0);
});
