// 脚本计算预算（统一编程接口 v2，SPEC §9.2 方案 C）。
// 这些是「运行时常量」，刻意不放进 cfg：configHash 覆盖整份配置，放进去会让旧记录全部校验不过；
// 预算只影响脚本当回合交不交得出意图，记录里存的是意图本身，回放与它无关。
//
//   init        开局一次，initMs 内完成；超时 → 重建运行环境、不再调用 init 开局（记一次事件）
//   每回合      可用 = baseMs + 时间银行；用不完的存入银行（上限 bankCapMs），超支则当回合作废、银行清零
//   卡死        超过「可用 + hangGraceMs」仍未返回 → 重建运行环境并重新 init（模块变量丢失），记一次 reset；
//               reset 达到 maxResets → 本局改为引擎自动回家（L1）
//   评测 measure 不打断、不作废，只记下「按正式预算会超时的回合」，保证同一脚本 + 种子结果可复现

export const BUDGET = Object.freeze({
  initMs: 2000,
  baseMs: 50,
  bankCapMs: 5000,
  hangGraceMs: 400,
  maxResets: 3,
});

/** 本回合可用毫秒。 */
export const availableMs = (bank, b = BUDGET) => b.baseMs + bank;

/**
 * 记一回合的账。
 * @param {number} bank 本回合开始时的银行余额
 * @param {number} ms 本回合脚本实际耗时
 * @returns {{ok:boolean, bank:number, overrun:number}} ok=false：超支（overrun = 超出的毫秒）
 */
export function chargeTurn(bank, ms, b = BUDGET) {
  const avail = availableMs(bank, b);
  if (ms <= avail) return { ok: true, bank: Math.min(b.bankCapMs, bank + b.baseMs - ms), overrun: 0 };
  return { ok: false, bank: 0, overrun: ms - avail };
}

/** 给脚本看的预算信息（api.budget）。 */
export const budgetView = (bank, b = BUDGET) => Object.freeze({ turnMs: b.baseMs, bankMs: Math.round(bank), availableMs: Math.round(availableMs(bank, b)), bankCapMs: b.bankCapMs });
