// 任务书（统一编程接口 v2）：一份可以直接交给通用 agent（WorkBuddy / Codex / Claude Code …）的 Markdown。
// agent 的定位是「用写代码的方式玩游戏的玩家」：写脚本 → 本机评测 → 改进 → 交给玩家导入游戏。

import { BUDGET } from './runtime/budget.js';

const OPP_ZH = { heuristic: '启发式', mock: '模拟大模型', proxy: '大模型（本地代理）', script: '脚本' };

/**
 * @param {{mapSize:string, size:number, rules:{stamina:number, maxTurns:number, visionRadius:number, gemScore:number, setBonus:number, gemRespawnMax:number},
 *          opponents:{brain:string, label?:string}[], requirement?:string, name?:string}} o
 */
export function buildBrief({ mapSize, size, rules, opponents = [], requirement = '', name = 'my-bot' }) {
  const opp = opponents.map((o, k) => `座位 ${k + 1}：${o.label || OPP_ZH[o.brain] || o.brain}`).join('；') || '启发式 × 3';
  const seat = (o) => (o.brain === 'mock' ? `mock:${o.persona || 'balanced'}` : 'heuristic');
  const seatArgs = opponents.map((o, k) => (o.brain === 'heuristic' ? '' : ` --seat${k + 1} ${seat(o)}`)).join('');
  const req = String(requirement || '').trim() || '（玩家没有额外要求：在不出局的前提下分数尽量高、名次尽量靠前）';
  return `# 任务书：为「迷宫寻宝」写一个对战脚本

你是一名用写代码的方式参赛的玩家。请写一个 JavaScript 脚本，它会在一整局里替我控制座位 0 的小机器人，和其他玩家（人、脚本、大模型、电脑）同场竞技。脚本写好后不能在对局中修改，所以它必须自己完成整局的判断。

## 我的要求
${req}

## 对局设置（本次评测按这个来）
- 地图规格 ${mapSize}（${size}×${size}），体力 ${rules.stamina}，回合上限 ${rules.maxTurns}，视野（切比雪夫距离）${rules.visionRadius}
- 对手：${opp}
- 计分：宝石数 × ${rules.gemScore} + 成套数 × ${rules.setBonus}（五色各一颗为一套）+ 宝箱分；宝石拿空后刷新（最多 ${rules.gemRespawnMax} 次）
- 只有到达自己的出口才有成绩；体力归零或到回合上限还没到出口就出局、成绩作废

## 规则要点
- 四人同时行动，每回合各走一格（N=y−1、E=x+1、S=y+1、W=x−1）或原地不动；只有成功移动扣 1 体力，撞墙 / 被挡不扣
- 两人想进同一格：都不动；两人对穿：都不动；目标格的人这一回合也在动走，可以跟进
- 拾取按座位序；同一格的宝石只能一人拿到
- 对手在视野内给实时坐标，视野外只给最后目击位置；对手拾取或开箱时全场都会得知那一刻的位置

## 脚本接口（统一编程接口 v2，完整文档：项目里的 docs/07-脚本编程接口.md）
\`\`\`js
// 可选：开局调用一次，预算 ${BUDGET.initMs} ms。模块变量整局保留。
function init(ctx, api) {}
// 必须：每回合调用一次，返回 'N'|'E'|'S'|'W'|'STAY'，或 { move, intent: { type: 'gem'|'chest'|'exit'|'cell', x, y, note } }
function decide(obs, api) {}
\`\`\`
- \`ctx\`：seat、size、mapSize、grid（Uint8Array，1 = 地板，索引 y*size+x）、spawns、exits（四个出口都公开）、rules
- \`obs\`：self（位置、体力、宝石、出口、distToExit …）、actors（对手：分数 / 体力 / 宝石 / status；视野内 x,y，视野外 lastSeen）、gems（含 dist）、chest、turn、events（上一回合全场公开事件：pickup / chest / escaped / failed / gemRespawn / chestRespawn，以及你自己的 bump / blocked）
- \`api.field(x, y, {avoid})\` 距离场；\`api.dist(x, y, fromX?, fromY?)\`；\`api.shortestStep(x, y, {avoid})\`；\`api.isFloor\`
- \`api.sim.step(belief, moves)\`：用真实结算规则推演一回合（belief 缺省 = 你的观察；视野外对手要你自己给假设位置；开箱只给概率分支、刷新只给标记）
- \`api.random()\` / \`api.randInt(lo, hi)\`：可复现的随机数（Math.random 也已换成同一个流）
- \`api.log(...)\`、\`api.budget\`、\`api.elapsed()\`
- 不能 import，不能联网；只用 api 里给的东西

## 计算预算
每回合 ${BUDGET.baseMs} ms，没用完的存进时间银行（上限 ${BUDGET.bankCapMs} ms）；超时的回合作废，引擎沿你最后声明的 intent 走（没有 intent 就回家）。卡死会被重建并重新 init。

## 怎么评测（请反复跑，直到满意）
在项目目录：
\`\`\`
npm run eval -- --script ${name}.js --size ${mapSize} --seeds 1-50${seatArgs}
npm run eval -- --script ${name}.js --size ${mapSize} --seeds 1-50 --format json${seatArgs}
\`\`\`
输出各座位到达率 / 平均分 / 平均名次、与启发式基线的差、每回合耗时、按正式预算会超时的回合、异常和最差几局（带种子，可单独复现：\`--seeds <种子>\`）。评测默认不打断，同一脚本 + 种子结果可复现。
建议换几组种子和对手（\`--seat1 mock:bold\` 等）验证没有过拟合，并在其他规格上（\`--size S\` / \`--size XL\`）也跑一下。

## 交付
- 一个文件 \`${name}.js\`，第一行写文件头：\`// @maze-script name: <脚本名> | author: <你的名字> | origin: agent\`
- 附上最后一次评测的结果摘要，以及打法说明（怎么选目标、怎么回家、怎么对付对手）
- 我会在游戏设置页「编写 Agent 脚本 → 导入 .js」载入，或放进对手座位和别的玩家对战
`;
}
