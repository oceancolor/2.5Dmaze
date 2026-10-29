// 模拟大模型（SPEC §7：HY4 凭证到位前一律用 mock）。
// 只读提示词载荷（与真 LLM 拿到的完全一样），按「风格」文本给出计划 JSON；不看地图、不看对手隐藏位置。
// 纯函数、确定性：同一载荷 + 同一风格 → 同一回复。风格靠关键词粗分（保守 / 冒险 / 凑套 / 开箱 / 避让），让提示词托管离线也有效果。

import { COLOR_ZH } from './codec.js';

/** 预设风格：AI 对手可选，玩家提示词托管也可一键套用。text 原样进真 LLM 的风格段。 */
export const PERSONAS = Object.freeze({
  balanced: Object.freeze({ label: '均衡', text: '稳健均衡：优先离得近、能凑成套的宝石；体力只剩回家余量就立刻回家。' }),
  setHunter: Object.freeze({ label: '凑套', text: '凑套狂：五色成套额外 +5 分，优先拿自己缺的颜色，重复颜色能不拿就不拿。' }),
  chest: Object.freeze({ label: '开箱', text: '开箱爱好者：宝箱在场又负担得起就先去开宝箱，其次才是宝石。' }),
  cautious: Object.freeze({ label: '保守', text: '保守派：体力余量留足，宁可少拿一颗也绝不冒险；对手比我近的宝物不去抢，提前回家。' }),
  bold: Object.freeze({ label: '冒险', text: '冒险家：体力余量压到最低，能多拿一颗是一颗，敢和对手抢近处的宝石。' }),
});

/** 风格文本 → 权重。 */
export function styleOf(text) {
  const t = String(text ?? '');
  const has = (re) => re.test(t);
  return {
    marginX10: has(/保守|谨慎|留足|安全|稳妥/) ? 16 : has(/冒险|激进|压到最低|大胆|贪/) ? 11 : 13,
    homeX10: has(/提前回家|早点回|保守/) ? 15 : has(/冒险|压到最低/) ? 12 : 13,
    setW: has(/凑套|成套|缺的颜色|五色/) ? 2.4 : 1,
    dupW: has(/重复颜色|不拿重复/) ? 0.45 : 1,
    chestW: has(/宝箱|开箱/) ? 3 : 1,
    contest: has(/不去抢|避开|别抢|躲/) ? 0.3 : has(/敢|抢/) ? 1.1 : 0.75,
  };
}

/**
 * @param {{contract?:boolean}} [o] contract：玩家自己的 AI（决策契约 v1），回复里带 follow:"yes"
 * @returns {string} 一行 JSON（与真 LLM 的期望输出同格式）
 */
export function mockPlan(payload, personaText, { contract = false } = {}) {
  const w = styleOf(personaText);
  const me = payload.self;
  const colors = Object.keys(me.gems);
  const counts = colors.map((c) => me.gems[c]);
  const sets = Math.min(...counts);
  const out = (targetType, x, y, reason) => JSON.stringify(contract ? { targetType, target: { x, y }, reason, follow: 'yes' } : { targetType, target: { x, y }, reason });
  const home = (why) => out('exit', me.exit.x, me.exit.y, why);

  if (me.stamina * 10 <= me.distToExit * w.homeX10) return home(`体力 ${me.stamina} 只够回家（${me.distToExit} 步）`);
  const ok = (dist, back) => dist >= 0 && back >= 0 && me.stamina * 10 >= dist * 10 + back * w.marginX10;

  let best = null;
  const offer = (score, cand) => {
    if (!best || score > best.score || (score === best.score && (cand.y < best.y || (cand.y === best.y && cand.x < best.x)))) best = { score, ...cand };
  };
  for (const g of payload.gems) {
    if (!ok(g.dist, g.back)) continue;
    const ci = colors.indexOf(g.color);
    const after = counts.slice();
    after[ci]++;
    const completes = Math.min(...after) > sets;
    const missing = counts[ci] === sets;
    let v = 1 + (completes ? 5 : 0) + (missing ? 0.5 * w.setW : 0);
    if (!missing) v *= w.dupW;
    if (g.rivalsNearer.length) v *= w.contest;
    const name = `${COLOR_ZH[g.color] ?? g.color}宝石`;
    offer(v / (g.dist + 1), {
      type: 'gem', x: g.x, y: g.y,
      reason: `${name} ${g.dist} 步${completes ? '，拿到就成套' : missing ? '，正缺这色' : ''}${g.rivalsNearer.length ? '，有人在抢' : ''}`,
    });
  }
  const ch = payload.chest;
  if (ch.present && ok(ch.dist, ch.back)) {
    let v = (me.stamina < 300 ? 1.2 : 0.6) * w.chestW;
    if (ch.rivalsNearer.length) v *= w.contest;
    offer(v / (ch.dist + 1), { type: 'chest', x: ch.x, y: ch.y, reason: `宝箱 ${ch.dist} 步，${me.stamina < 300 ? '顺便补体力' : '碰碰运气'}` });
  }
  if (!best) return home('没有负担得起的宝物了，回出口');
  return out(best.type, best.x, best.y, best.reason);
}
