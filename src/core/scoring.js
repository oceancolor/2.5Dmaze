// 计分（SPEC §3.2）与排名（SPEC §5）。

export function gemTotal(gems) {
  let s = 0;
  for (let i = 0; i < gems.length; i++) s += gems[i];
  return s;
}

/** 成套数 = 各色持有数的最小值 */
export function setsOf(gems) {
  if (!gems.length) return 0;
  let m = gems[0];
  for (let i = 1; i < gems.length; i++) if (gems[i] < m) m = gems[i];
  return m;
}

/** score = Σ宝石 × gemScore + setBonus × 成套数 + 宝箱得分。例：[2,2,3,3,1] → 11 + 5×1 = 16 */
export function scoreFromParts(gems, chestScore, cfg) {
  const T = cfg.treasure;
  return gemTotal(gems) * T.gemScore + T.setBonus * setsOf(gems) + chestScore;
}

export function scoreOf(actor, cfg) {
  return scoreFromParts(actor.gems, actor.chestScore, cfg);
}

function compare(p, q) {
  if (p.escaped !== q.escaped) return p.escaped ? -1 : 1;
  if (p.score !== q.score) return q.score - p.score;
  if (p.stamina !== q.stamina) return q.stamina - p.stamina;
  if (p.escaped) return p.escapedTurn - q.escapedTurn;
  return p.moves - q.moves;
}

/**
 * 达成 > 分数 > 剩余体力 > 达成回合早（未达成者：分数 > 剩余体力 > 移动步数少）> 并列。
 * 冠军 = 名次 1 的达成者（可并列）；全员未达成则无冠军。
 */
export function rankActors(actors, cfg) {
  const rows = actors.map((a) => ({
    seat: a.seat,
    status: a.status,
    escaped: a.status === 'escaped',
    score: scoreOf(a, cfg),
    stamina: a.stamina,
    escapedTurn: a.escapedTurn,
    moves: a.moves,
    place: 0,
    champion: false,
  }));
  for (const r of rows) r.place = 1 + rows.filter((o) => compare(o, r) < 0).length;
  for (const r of rows) r.champion = r.escaped && r.place === 1;
  return rows.slice().sort((p, q) => compare(p, q) || p.seat - q.seat);
}
