#!/usr/bin/env node
// 视野规则对比实验（2026-11-06，SPEC 附录 C）。对每个地图规格 × 视野规则跑三组对局（同一批种子）：
//   X 四个「预判对手」脚本互打     → 遭遇回合占比、白跑步数、争抢次数、运气占比、到达率
//   Y 座位 0「预判对手」+ 3 启发式  ┐→ 技巧分：会用对手信息的脚本比启发式多拿多少（座位 0 平均分 / 冠军率之差）
//   Z 4 个启发式                     ┘
// 指标定义：
//   遭遇回合占比  每个在场角色、每回合，是否有其他在场角色在切比雪夫 9 格内（物理距离，与规则无关）
//   白跑步数      朝某颗宝石走，被别人先拿走 → 这段路的步数（每人每局）
//   争抢次数      有人拿到宝石的那一刻，至少还有一个其他角色正朝它走（每局）
//   运气占比      开局几何优势（出生点到最近 3 颗宝石的平均步数，取负）与最终得分的相关系数（越高越靠运气）
// 用法：node tools/vision-experiment.mjs [--seeds 40] [--sizes XS,S,M,L,XL] [--format md|json]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeConfig } from '../src/config/default.config.js';
import { MAP_SIZE_IDS, matchOverrides } from '../src/config/map-sizes.js';
import { createScheduler } from '../src/app/scheduler.js';
import { createHeuristic } from '../src/ai/heuristic.js';
import { createNodeScriptController } from '../src/player/node-adapter.mjs';
import { createMatch } from '../src/core/state.js';
import { fieldFrom } from '../src/core/nav/bfs.js';
import { rankActors } from '../src/core/scoring.js';

const AWARE = readFileSync(new URL('../src/player/builtin/aware.js', import.meta.url), 'utf8');

/** 实验的视野规则（含扫描值；游戏预设是其中的 radius / full / delayed5 / radar15）。 */
export const RULES = [
  { key: 'A 现行', vision: 'radius' },
  { key: 'B 全公开', vision: 'full' },
  { key: 'E 延迟 3', vision: { mode: 'delayed', delayTurns: 3 } },
  { key: 'E 延迟 5', vision: 'delayed' },
  { key: 'E 延迟 10', vision: { mode: 'delayed', delayTurns: 10 } },
  { key: 'D 雷达 15', vision: 'radar' },
  { key: 'D 雷达 30', vision: { mode: 'radar', radarEvery: 30 } },
];

function parseArgs(argv) {
  const o = { seeds: 40, sizes: MAP_SIZE_IDS.slice(), format: 'md' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seeds') o.seeds = Number(argv[++i]);
    else if (a === '--sizes') o.sizes = argv[++i].split(',').map((s) => s.trim().toUpperCase());
    else if (a === '--format') o.format = argv[++i];
    else if (a === '--help') o.help = true;
    else throw new Error(`未知参数 ${a}`);
  }
  return o;
}

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const targetOf = (d) => (d && typeof d === 'object' ? d.intent || d.target || null : null);

/** 跑一局并采集指标。kinds：每座位 'aware' | 'heuristic'。 */
function playOne(cfg, seed, kinds) {
  const match = createMatch(seed, cfg);
  const ctrls = kinds.map((k, i) => (k === 'aware'
    ? createNodeScriptController({ code: AWARE, map: match.map, seat: i, cfg, seed: match.seed, mode: 'measure' })
    : createHeuristic(match.map, i, cfg, match.seed)));
  const sched = createScheduler(cfg, seed, { match, controllers: ctrls });
  const n = kinds.length;
  const enc = new Array(n).fill(0);
  const act = new Array(n).fill(0);
  const wasted = new Array(n).fill(0);
  const cur = new Array(n).fill(null); // {x, y, steps}
  let contests = 0;
  sched.on('turn', (l) => {
    const P = l.prev.actors;
    for (let i = 0; i < n; i++) {
      if (P[i].status !== 'active') continue;
      act[i]++;
      if (P.some((b, j) => j !== i && b.status === 'active' && cheb(P[i], b) <= 9)) enc[i]++;
      const t = targetOf(l.decisions[i]);
      if (t && t.type === 'gem') {
        if (cur[i] && cur[i].x === t.x && cur[i].y === t.y) cur[i].steps += l.moved[i] ? 1 : 0;
        else cur[i] = { x: t.x, y: t.y, steps: l.moved[i] ? 1 : 0 };
      } else cur[i] = null;
    }
    for (const e of l.events) {
      if (e.type !== 'pickup') continue;
      let chased = false;
      for (let i = 0; i < n; i++) {
        if (i === e.seat || !cur[i] || cur[i].x !== e.x || cur[i].y !== e.y) continue;
        wasted[i] += cur[i].steps;
        cur[i] = null;
        chased = true;
      }
      if (chased) contests++;
      if (cur[e.seat] && cur[e.seat].x === e.x && cur[e.seat].y === e.y) cur[e.seat] = null;
    }
  });
  sched.runSync(0, cfg.rules.maxTurns + 10);
  if (!sched.state.ended) throw new Error(`种子 ${seed} 没结束`);
  const ranking = rankActors(sched.state.actors, cfg);
  const by = new Map(ranking.map((r) => [r.seat, r]));
  // 开局几何优势：出生点到最近 3 颗初代宝石的平均步数（越小越占便宜）
  const N = match.map.size;
  const adv = match.map.spawns.map(([sx, sy]) => {
    const f = fieldFrom(match.map, sy * N + sx);
    const ds = match.state.gems.map((g) => f[g.y * N + g.x]).filter((d) => d >= 0).sort((a, b) => a - b).slice(0, 3);
    return -(ds.reduce((a, b) => a + b, 0) / Math.max(1, ds.length));
  });
  return {
    seed, turns: sched.state.endTurn, contests,
    seats: sched.state.actors.map((a, i) => ({
      escaped: a.status === 'escaped', score: by.get(i).score, champion: by.get(i).champion, place: by.get(i).place,
      enc: act[i] ? enc[i] / act[i] : 0, wasted: wasted[i], adv: adv[i],
    })),
  };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function corr(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sx += (xs[i] - mx) ** 2;
    sy += (ys[i] - my) ** 2;
  }
  return sx && sy ? sxy / Math.sqrt(sx * sy) : 0;
}

export function runCell(size, rule, seeds) {
  const cfg = makeConfig(matchOverrides('script', size, rule.vision));
  const X = seeds.map((s) => playOne(cfg, s, ['aware', 'aware', 'aware', 'aware']));
  const Y = seeds.map((s) => playOne(cfg, s, ['aware', 'heuristic', 'heuristic', 'heuristic']));
  const Z = seeds.map((s) => playOne(cfg, s, ['heuristic', 'heuristic', 'heuristic', 'heuristic']));
  const xs = X.flatMap((g) => g.seats);
  const seat0 = (G) => G.map((g) => g.seats[0]);
  const y0 = seat0(Y);
  const z0 = seat0(Z);
  const scoreOf = (s) => (s.escaped ? s.score : 0);
  return {
    size, rule: rule.key,
    encounter: mean(xs.map((s) => s.enc)),
    wasted: mean(xs.map((s) => s.wasted)),
    contests: mean(X.map((g) => g.contests)),
    escape: mean(xs.map((s) => (s.escaped ? 1 : 0))),
    luck: corr(xs.map((s) => s.adv), xs.map(scoreOf)),
    skillScore: mean(y0.map(scoreOf)) - mean(z0.map(scoreOf)),
    skillWin: mean(y0.map((s) => (s.champion ? 1 : 0))) - mean(z0.map((s) => (s.champion ? 1 : 0))),
    heurWasted: mean(Z.flatMap((g) => g.seats).map((s) => s.wasted)),
    heurContests: mean(Z.map((g) => g.contests)),
    turns: mean(X.map((g) => g.turns)),
  };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const f1 = (v) => v.toFixed(1);
const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

export function renderMarkdown(rows, seedsN) {
  const L = [];
  L.push(`每格：同一批 ${seedsN} 个种子 × 3 组对局（4 预判 / 1 预判 + 3 启发式 / 4 启发式）。`);
  for (const size of [...new Set(rows.map((r) => r.size))]) {
    L.push('');
    L.push(`### ${size}`);
    L.push('');
    L.push('| 规则 | 遭遇回合占比 | 白跑步数 / 人局 | 争抢 / 局 | 到达率 | 运气占比 r | 技巧分：均分差 | 技巧分：冠军率差 | 启发式白跑 | 启发式争抢 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows.filter((x) => x.size === size)) {
      L.push(`| ${r.rule} | ${pct(r.encounter)} | ${f1(r.wasted)} | ${f1(r.contests)} | ${pct(r.escape)} | ${r.luck.toFixed(2)} | ${f2(r.skillScore)} | ${f2(r.skillWin * 100)} pp | ${f1(r.heurWasted)} | ${f1(r.heurContests)} |`);
    }
  }
  return L.join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('用法：node tools/vision-experiment.mjs [--seeds 40] [--sizes XS,S,M,L,XL] [--format md|json]');
    process.exit(0);
  }
  const seeds = Array.from({ length: o.seeds }, (_, k) => k + 1);
  const rows = [];
  const t0 = Date.now();
  for (const size of o.sizes) {
    for (const rule of RULES) {
      const t = Date.now();
      rows.push(runCell(size, rule, seeds));
      process.stderr.write(`${size} ${rule.key} ${((Date.now() - t) / 1000).toFixed(1)}s\n`);
    }
  }
  process.stderr.write(`总计 ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  console.log(o.format === 'json' ? JSON.stringify(rows, null, 2) : renderMarkdown(rows, o.seeds));
}
