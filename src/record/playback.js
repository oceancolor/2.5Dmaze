// 对局回放（2026-11-09）：把一份对局记录变成能「播放」的对局。纯逻辑，不碰 DOM。
// 做法：每个座位一个「录像控制器」，按记录里的意图逐回合出招，交给普通的调度器结算——
// 所以回放和正常对局走同一套内核、画面、HUD、小地图，场景 / UI 怎么改，回放都跟着变。
// 跳转 = 新建调度器从头快进到目标回合（XL 整局约 50 ms）。结果逐回合与记录的 stateHash 对得上（测试断言）。

import { configByHash } from '../config/known.js';
import { createMatch } from '../core/state.js';
import { createScheduler } from '../app/scheduler.js';
import { decodeIntents } from './recorder.js';

/**
 * @param {string} jsonl 对局记录
 * @returns {{meta:object, cfg:object, mapSize:string|null, seed:number, endTurn:number, tags:string[],
 *            plansOf:(seat:number)=>object[], makeScheduler:(toTurn?:number)=>object}}
 */
export function createPlayback(jsonl) {
  const lines = String(jsonl).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const meta = lines[0];
  if (!meta || meta.t !== 'meta') throw new Error('记录缺少 meta 行');
  const known = configByHash(meta.configHash);
  if (!known) throw new Error('这份记录的配置不是本版本认可的（可能来自更新或更旧的游戏版本）');
  const cfg = known.cfg;
  const intents = new Map();
  const plans = [[], [], [], []];
  let endTurn = 0;
  for (const L of lines) {
    if (L.t === 'turn') intents.set(L.n, decodeIntents(L.i));
    else if (L.t === 'plan' && plans[L.seat]) plans[L.seat].push(L);
    else if (L.t === 'end') endTurn = L.n;
  }
  if (!endTurn) endTurn = Math.max(0, ...intents.keys());
  const tags = Array.isArray(meta.seats) ? meta.seats.slice() : ['manual', 'heuristic', 'heuristic', 'heuristic'];

  /** 录像控制器：decide 交出记录里这一回合的意图；status 给 HUD 显示「当时的目标与理由」。 */
  function recorded(seat) {
    let shownTurn = 0;
    return {
      kind: 'recorded',
      decide(obs, turn) {
        shownTurn = turn;
        const row = intents.get(turn);
        return row ? row[seat] : 4;
      },
      status() {
        let p = null;
        for (const L of plans[seat]) {
          if (L.n > shownTurn) break;
          if (L.plan && L.plan.target) p = L;
        }
        return p ? { source: 'replay', target: { type: p.plan.targetType, x: p.plan.target.x, y: p.plan.target.y }, reason: p.plan.reason || '' } : null;
      },
    };
  }

  return {
    meta,
    cfg,
    mapSize: known.mapSize ?? null,
    seed: meta.seed,
    endTurn,
    tags,
    plansOf: (seat) => plans[seat].slice(),
    /** 新建一个调度器，并快进到「第 toTurn 回合将要开始」（1 = 开局）。 */
    makeScheduler(toTurn = 1) {
      const match = createMatch(meta.seed, cfg);
      if (match.map.hash !== meta.mapHash) throw new Error('地图哈希对不上：记录和当前内核不一致');
      const sched = createScheduler(cfg, meta.seed, { match, controllers: [0, 1, 2, 3].map(recorded), seatLabels: tags });
      const target = Math.max(1, Math.min(toTurn, endTurn + 1));
      if (target > sched.state.turn) sched.runSync(0, target - sched.state.turn);
      return sched;
    },
  };
}

/** 座位标签 → 名牌（回放时 HUD / 记分牌用）。 */
export function seatLabelsOf(meta) {
  const scripts = new Map((meta.scripts || []).map((s) => [s.seat, s]));
  const players = new Map((meta.players || []).map((p) => [p.seat, p]));
  const MOCK = { balanced: '均衡', setHunter: '凑套', chest: '开箱', cautious: '保守', bold: '冒险' };
  return (meta.seats || []).map((tag, seat) => {
    if (tag === 'manual') return { label: '手动', tag };
    if (tag === 'mcp:workbuddy') return { label: 'WorkBuddy', persona: '上场', tag };
    if (tag === 'heuristic') return { label: '启发式', tag };
    if (tag === 'script' || tag.startsWith('script:')) {
      const s = scripts.get(seat);
      return { label: s ? s.name : '脚本', persona: s && s.origin === 'agent' ? 'agent 写' : '', tag };
    }
    if (tag.startsWith('byok:')) {
      const p = players.get(seat);
      return { label: p && p.model ? p.model : tag.slice(5).split('/').pop(), persona: '大模型', tag, byok: true };
    }
    const [kind, persona] = tag.split(':');
    if (kind === 'mock' || kind === 'proxy') return { label: kind === 'mock' ? '模拟' : '大模型', persona: MOCK[persona] || persona || '', tag };
    if (tag.startsWith('prompt-')) return { label: '提示词', tag };
    return { label: tag, tag };
  });
}
