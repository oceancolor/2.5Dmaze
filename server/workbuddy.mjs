// 「WorkBuddy 上场」（批次 7）：游戏服务器提供一个 MCP 端点（Streamable HTTP，只回 JSON），
// WorkBuddy 用户在自己的任务会话里调用工具下棋、看复盘。模型调用由 WorkBuddy 自己发起、记在它自己的账号上；服务器不碰任何模型 key。
//
//   POST   /mcp                    MCP JSON-RPC：initialize / ping / tools/list / tools/call / prompts/list / prompts/get
//   GET    /api/v1/mcp             我的 MCP 令牌（只有尾号）与接入地址
//   POST   /api/v1/mcp/token       生成新令牌（只返回这一次；同时作废旧的）
//   DELETE /api/v1/mcp/token       作废令牌
//
// 对局在服务器上托管：调度器 + planner（座位 0 = WorkBuddy，复用接入大模型的整套 harness：博弈事实表、本局会话、
// 决策契约 v2、目标队列 / 放弃条件、自保闸门）。planner 的传输层不调用模型，而是把请求「挂起」等 maze_decide。
// 对手（启发式 / 内置「预判对手」脚本）也在服务器上跑。打完由服务器直接校验入库（座位标签 mcp:workbuddy），
// 另存一份引擎生成的复盘摘要（agent_notes，不对玩家开放：用户裁定「跨局经验我们的服务器记一套，但不提供给玩家」）。
// 验证版：未结束的对局只在内存里，服务器重启即丢失。

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { HttpError, readBody, readJson, selfOrigin, sendJson } from './http.mjs';
import { authenticate, sha256 } from './api/accounts.mjs';
import { saveMatch } from './api/matches.mjs';
import { DEFAULT_CONFIG, makeConfig } from '../src/config/default.config.js';
import { MAP_SIZE_IDS, isMapSize, matchOverrides } from '../src/config/map-sizes.js';
import { configByHash } from '../src/config/known.js';
import { createScheduler } from '../src/app/scheduler.js';
import { messagesFor } from '../src/app/transport.js';
import { createMatch } from '../src/core/state.js';
import { rankActors } from '../src/core/scoring.js';
import { fnv1a, hex8 } from '../src/core/hash.js';
import { createHeuristic } from '../src/ai/heuristic.js';
import { createAgentPool, createPlanner } from '../src/ai/planner.js';
import { matchDigest, outcomeText, targetLabel, timelineFromRecord, whyText } from '../src/ai/harness.js';
import { FRAME_FIELDS, MAX_QUERY_FRAMES, SEATS_LEGEND, aimsOf, buildPacket, frameItem, outcomeLine, packetText } from '../src/ai/decision-packet.js';
import { framesFromRecord } from '../src/record/frame-replay.js';
import { createReceipts, isSubmissionId } from './decision-receipts.mjs';
import { createNodeScriptController } from '../src/player/node-adapter.mjs';
import { scriptMeta, seatTag } from '../src/player/eval/run-eval.js';
import { CLIENT_VERSION } from '../src/app/version.js';

export const MCP_PATH = '/mcp';
export const AGENT_TAG = 'mcp:workbuddy';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TOKEN = /^mz_[A-Za-z0-9_-]{40,60}$/;
const GAME_ID = /^[a-f0-9]{32}$/;
const MAX_ACTIVE = 3;
const IDLE_MS = 6 * 3600 * 1000;
const STATUS_ZH = { escaped: '到达出口', failed: '出局', active: '进行中' };
const RULES_VERSION = DEFAULT_CONFIG.rulesVersion;
const AWARE = { kind: 'script', code: readFileSync(new URL('../src/player/builtin/aware.js', import.meta.url), 'utf8'), name: '预判对手（参考实现）', author: '迷宫寻宝', origin: 'builtin' };
const OPPONENTS = { aware: '预判对手脚本', heuristic: '启发式' };

// ───────── MCP 令牌 ─────────

const newToken = () => `mz_${randomBytes(32).toString('base64url')}`;
const mcpUrl = (req, ctx) => `${selfOrigin(req, ctx.opt.trustProxy)}${MCP_PATH}`;

/** WorkBuddy「连接器 → 自定义连接器 → 配置 MCP」里粘贴的片段。 */
export function workbuddyConfig(url, token) {
  return { mcpServers: { 'maze-treasure': { type: 'streamableHttp', url, headers: { Authorization: `Bearer ${token}` }, timeout: 120000 } } };
}

export function getMcpInfo(req, res, ctx) {
  const user = authenticate(req, ctx.store, ctx.now);
  sendJson(res, 200, { token: ctx.store.mcpTokenOf(user.id), url: mcpUrl(req, ctx), active: ctx.workbuddy.activeOf(user.id) });
}

export async function createMcpToken(req, res, ctx) {
  const user = authenticate(req, ctx.store, ctx.now);
  ctx.limiters.keys.take(user.id);
  await readJson(req, 1024);
  const token = newToken();
  ctx.store.putMcpToken(user.id, sha256(token), `…${token.slice(-4)}`, ctx.now());
  const url = mcpUrl(req, ctx);
  sendJson(res, 201, { token, hint: `…${token.slice(-4)}`, url, config: workbuddyConfig(url, token) });
}

export function revokeMcpToken(req, res, ctx) {
  const user = authenticate(req, ctx.store, ctx.now);
  ctx.store.revokeMcpTokens(user.id);
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function mcpUser(req, ctx) {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/.exec(h.trim()) : null;
  if (!m || !TOKEN.test(m[1])) throw new HttpError(401, 'unauthorized', '缺少或无效的 MCP 令牌：请在游戏设置页「WorkBuddy 上场」生成，并填进 WorkBuddy 的 MCP 配置');
  const hash = sha256(m[1]);
  const user = ctx.store.userByMcpHash(hash);
  if (!user) throw new HttpError(401, 'unauthorized', 'MCP 令牌已作废：请在游戏设置页重新生成');
  ctx.store.touchMcpToken(hash, ctx.now());
  return user;
}

// ───────── 托管对局 ─────────

/**
 * @param {{store:object, now:()=>number}} o
 */
export function createWorkbuddyHost({ store, now }) {
  const games = new Map();

  function sweep() {
    const t = now();
    for (const [id, g] of games) if (t - g.lastAt > IDLE_MS) {
      dispose(g);
      games.delete(id);
    }
  }

  function dispose(g) {
    for (const c of g.sched.controllers) if (c && c.dispose) c.dispose();
  }

  function newGame(user, { size = 'XS', opponents = 'aware', strategy = '', allowRisk = false }) {
    sweep();
    if (!isMapSize(size)) throw new ToolError(`size 只能是 ${MAP_SIZE_IDS.join(' / ')}`);
    if (!OPPONENTS[opponents]) throw new ToolError('opponents 只能是 aware（预判对手脚本）或 heuristic（启发式）');
    const mine = [...games.values()].filter((g) => g.userId === user.id && !g.ended);
    if (mine.length >= MAX_ACTIVE) throw new ToolError(`你同时最多 ${MAX_ACTIVE} 局未完成的对局（${mine.map((g) => g.id).join('、')}）：先打完，或等 6 小时闲置自动清理`);
    const text = String(strategy || '').slice(0, 2000);
    const cfg = makeConfig(matchOverrides('byok', size));
    const id = randomBytes(16).toString('hex');
    const seed = randomBytes(4).readUInt32BE(0);
    const match = createMatch(seed, cfg);
    // point：当前决策点的回包（到达时生成一次并缓存 → maze_observe 纯读、逐字节可重复）
    // anchorK / prevDp：上一个决策点的帧号与编号（帧段 = (anchorK, k]，§14 C7）；receipts：提交回执（§14 C4）
    const g = {
      id, userId: user.id, size, cfg, seed, strategy: text, opponents, pending: null, point: null, anchorK: -1, prevDp: 0, rejects: 0,
      receipts: createReceipts(), startedAt: now(), lastAt: now(), ended: false, result: null,
    };
    const transport = (req, reply) => {
      g.pending = { req, reply };
    };
    const planner = createPlanner({
      map: match.map, seat: 0, cfg, seed: match.seed, pool: createAgentPool(cfg), persona: text,
      autonomy: 'free', safetyGate: !allowRisk, transport,
    });
    const opp = [1, 2, 3].map((s) => (opponents === 'aware'
      ? createNodeScriptController({ code: AWARE.code, map: match.map, seat: s, cfg, seed: match.seed, isPlayer: false })
      : createHeuristic(match.map, s, cfg, match.seed)));
    const oppSpec = opponents === 'aware' ? AWARE : { kind: 'heuristic' };
    g.planner = planner;
    g.sched = createScheduler(cfg, seed, {
      match, controllers: [planner, ...opp],
      seatLabels: [AGENT_TAG, ...[1, 2, 3].map((s) => seatTag(oppSpec, s))],
      players: [{ seat: 0, provider: 'workbuddy', model: 'workbuddy', autonomy: 'free', safetyGate: !allowRisk, strategyHash: hex8(fnv1a(text)) }],
      scripts: opponents === 'aware' ? [1, 2, 3].map((s) => scriptMeta(AWARE, s)) : undefined,
    });
    games.set(id, g);
    return g;
  }

  /** 跑到下一个决策点（planner 挂起请求且调度器在等它）或对局结束；到达决策点时生成并缓存它的回包。 */
  function advance(g) {
    for (let k = 0; k < 10 && !g.sched.state.ended; k++) {
      g.sched.runSync(0, 100000);
      if (g.pending && g.sched.waitingFor.includes(0)) break;
    }
    if (g.sched.state.ended && !g.ended) finish(g);
    else if (g.pending) makePoint(g);
  }

  function finish(g) {
    g.ended = true;
    if (g.pending) g.pending = null;
    // 终局尾段：最后一个决策点之后到终局的帧 + 最后一次决策的全部结果（§14 C7）
    if (g.point) {
      g.anchorK = g.point.k;
      g.prevDp = g.point.dp;
    }
    const endK = g.sched.frames.lastK(0);
    const tail = buildPacket({ frames: g.sched.frames, seat: 0, outcomes: g.planner.outcomes, from: g.anchorK + 1, to: endK, colors: g.cfg.treasure.gemColors, prevDp: g.prevDp });
    const tailText = packetText(tail, { frames: g.sched.frames, seat: 0, colors: g.cfg.treasure.gemColors });
    const record = g.sched.toJSONL();
    const ranking = rankActors(g.sched.state.actors, g.cfg);
    let saved = null;
    try {
      saved = saveMatch(store, { id: g.userId }, {
        matchId: g.id, record, host: 'server', platform: 'workbuddy', clientVersion: CLIENT_VERSION, now,
        startedAt: g.startedAt, endedAt: now(), strategy: g.strategy ? { seat: 0, autonomy: 'free', safetyGate: null, text: g.strategy } : undefined,
      });
    } catch (e) {
      console.error('[workbuddy] 入库失败', e);
    }
    const tl = timelineFromRecord(record, g.cfg, 0);
    const me = ranking.find((r) => r.seat === 0);
    const end = JSON.parse(record.trim().split('\n').at(-1));
    // 服务器自留的复盘摘要（不对玩家开放）
    try {
      store.insertAgentNote(g.id, g.userId, 'workbuddy', matchDigest({ mapSize: g.size, size: g.cfg.maze.size, turns: end.n, me, stats: tl.stats, mistakes: tl.mistakes, entries: tl.entries }), now());
    } catch (e) {
      console.error('[workbuddy] 摘要保存失败', e);
    }
    g.result = { ranking, me, verify: saved ? saved.verify : 'unsaved', turns: end.n, timeline: tl, tail, tailText };
    dispose(g);
  }

  /** 当前挂起请求 → 决策点回包（同一请求只生成一次）。 */
  function makePoint(g) {
    const { req } = g.pending;
    if (g.point && g.point.reqId === req.id) return g.point;
    if (g.point && g.point.dp !== req.dp) {
      g.anchorK = g.point.k;
      g.prevDp = g.point.dp;
    }
    g.point = { reqId: req.id, dp: req.dp, rev: req.rev, k: req.requestTurn - 1, text: '' };
    g.point.text = pointText(g);
    return g.point;
  }

  function gameOf(user, id, { submissionId = null } = {}) {
    sweep();
    let g;
    if (id) {
      if (!GAME_ID.test(String(id))) throw new ToolError('gameId 格式不对（32 位十六进制）');
      g = games.get(id);
    } else {
      // 重试找回：不带 gameId 但带了 submissionId → 在自己的对局（含刚结束的）里找回执
      if (submissionId) g = [...games.values()].find((x) => x.userId === user.id && x.receipts.get(submissionId));
      if (!g) {
        const mine = [...games.values()].filter((x) => x.userId === user.id && !x.ended);
        if (mine.length > 1) throw new ToolError(`你有 ${mine.length} 局进行中的对局（${mine.map((x) => x.id).join('、')}）：请用 gameId 指明是哪一局`);
        g = mine[0];
      }
    }
    if (!g || g.userId !== user.id) throw new ToolError(id ? '没有这局（可能已结束很久、闲置超时被清理，或服务器重启过）：用 maze_history 看已结束的对局' : '你现在没有进行中的对局：用 maze_new_game 开一局');
    g.lastAt = now();
    return g;
  }

  return {
    games,
    newGame(user, args) {
      const g = newGame(user, args);
      advance(g);
      return g;
    },
    gameOf,
    advance,
    makePoint,
    activeOf: (userId) => [...games.values()].filter((g) => g.userId === userId && !g.ended).map((g) => ({ gameId: g.id, size: g.size, turn: g.sched.state.turn, points: g.planner.decisionPoints })),
    disposeAll() {
      for (const g of games.values()) dispose(g);
      games.clear();
    },
  };
}

class ToolError extends Error {}

// ───────── 工具输出 ─────────

const jsonBlock = (o) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

/** 当前决策点回包（§14 C7 / C8）：只由 makePoint 生成一次；之后 maze_observe / 重试都原样返回。 */
function pointText(g) {
  if (g.ended) return endText(g);
  if (g.point && g.point.text && g.pending && g.point.reqId === g.pending.req.id) return g.point.text;
  if (!g.pending) return `对局 ${g.id} 第 ${g.sched.state.turn} 回合：目前没有等你决策的点（正常流程不会出现）。`;
  const { req } = g.pending;
  const k = req.requestTurn - 1;
  const colors = g.cfg.treasure.gemColors;
  const frames = g.sched.frames;
  // 帧段与结果由 planner 在发请求时构造（与网页大模型提示词同一份，§14 C7）；MCP 只是把逐帧放进末尾 JSON 块
  const packet = req.packet || buildPacket({ frames, seat: 0, outcomes: g.planner.outcomes, from: g.anchorK + 1, to: k, colors, prevDp: g.prevDp, dp: req.dp });
  const [, user] = messagesFor(req, g.cfg, { trajectory: false });
  const dpId = `dp-${req.dp}`;
  const when = k === 0 ? '开局（还没有人行动）' : `第 ${k} 回合结束后`;
  return [
    `## 对局 ${g.id} · 决策点 ${dpId}${req.rev ? `（第 ${req.rev + 1} 次提交）` : ''} · 局面是${when}的；你的决定从第 ${k + 1} 回合起执行`,
    `触发原因：${whyText(req.why) || req.why}${req.kind === 'repair' ? ` · 上一次提交不合格：${req.error}，请改正后重新提交（局面不变）` : ''}`,
    '',
    packetText(packet, { frames, seat: 0, colors }),
    '',
    '### 当前局面（据此决策）',
    user.content,
    '',
    `→ 推理后调用 maze_decide 提交 decision（字段同「决策契约」），并带上 decisionPointId: "${dpId}"；建议再带一个你自己生成的 submissionId —— 同一次提交重试时用同一个，服务器原样返回结果、不会重复推进。需要时先用 maze_query 查距离、maze_frames 查更早的逐回合记录。不要停下来问用户，一直打到对局结束。`,
    '',
    jsonBlock({ protocol: 'decision-v2', gameId: g.id, decisionPointId: dpId, rev: req.rev, why: req.why, snapshotTurn: k, effectiveTurn: k + 1, ...packet }),
  ].join('\n');
}

function endText(g) {
  const r = g.result;
  if (!r) return `对局 ${g.id} 已结束。`;
  const me = r.me;
  const rows = r.ranking.map((x) => `- 第 ${x.place} 名：座位 ${x.seat}${x.seat === 0 ? '（你）' : ''} · ${STATUS_ZH[x.status] || x.status} · ${x.score} 分${x.champion ? ' · 冠军' : ''}`);
  const s = r.timeline.stats;
  return [
    `## 对局 ${g.id} 结束（第 ${r.turns} 回合）`,
    `你：第 ${me.place} 名 · ${STATUS_ZH[me.status] || me.status} · ${me.score} 分${me.champion ? ' · 冠军！' : ''}`,
    ...rows,
    `你的决策 ${s.decisions} 次：拿到 ${s.got} · 被抢 ${s.lost} · 主动放弃 ${s.abandoned} · 白跑 ${s.wasted} 步`,
    r.timeline.mistakes.length ? `损失最大的几次：\n${r.timeline.mistakes.map((m) => `- ${m.text}`).join('\n')}` : '',
    r.tailText ? r.tailText.replace('### 上次决策以来', '### 最后一次决策以来') : '',
    `服务器回放校验：${r.verify === 'verified' ? '通过' : r.verify}。对局已记进你的游戏战绩（标为「WorkBuddy 上场」）。`,
    '→ 向用户汇报结果；需要详细复盘时调用 maze_replay。',
    r.tail ? jsonBlock({ protocol: 'decision-v2', gameId: g.id, ended: true, endTurn: r.turns, ...r.tail }) : '',
  ].filter(Boolean).join('\n');
}

function replayText(tl, head, detail) {
  const s = tl.stats;
  const L = [
    head,
    `决策 ${s.decisions} 次：拿到 ${s.got} · 被抢 ${s.lost} · 主动放弃 ${s.abandoned} · 改主意 ${s.switched} · 引擎安全覆盖 ${s.guard} · 不合格 ${s.invalid} · 作废 ${s.stale} · 失败 ${s.failed} · 白跑共 ${s.wasted} 步`,
  ];
  if (tl.mistakes.length) L.push('### 损失最大的几次', ...tl.mistakes.map((m) => `- ${m.text}${m.reason ? `（当时理由：${m.reason}）` : ''}`));
  L.push('### 逐条决策（回合 · 触发 · 目标 · 理由 → 结局）');
  const list = detail === 'full' ? tl.entries : tl.entries.slice(-30);
  if (list.length < tl.entries.length) L.push(`（只列最近 ${list.length} 条；detail: "full" 看全部）`);
  for (const e of list) {
    const why = e.src === 'queue' ? '队列' : e.src === 'guard' ? '闸门' : whyText(e.why) || '';
    L.push(`- T${e.n} ${why ? `[${why}] ` : ''}${e.target ? targetLabel(e) : '—'}${e.reason ? `「${e.reason}」` : ''}${e.memo ? ` 备忘：${e.memo}` : ''} → ${outcomeText(e)}`);
  }
  return L.join('\n');
}

// ───────── 工具定义 ─────────

const POINT = { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] };
const TARGET = { type: 'string', enum: ['gem', 'chest', 'exit'] };
const GAME_ARG = { type: 'string', description: '对局 id（只有一局进行中时可省略；有多局时必填）' };

export const TOOLS = [
  {
    name: 'maze_new_game',
    description: '开一局「迷宫寻宝」：四人迷宫寻宝博弈，你控制座位 0，只选目标（宝石 / 宝箱 / 自己的出口），寻路由引擎完成。返回规则、决策契约和第一个决策点（开局、任何人行动之前）。之后反复调用 maze_decide 直到对局结束，中途不要停下来问用户。',
    inputSchema: {
      type: 'object',
      properties: {
        size: { type: 'string', enum: MAP_SIZE_IDS, description: '地图规格，XS = 16×16（几十回合打完）… XL = 128×128。默认 XS' },
        opponents: { type: 'string', enum: Object.keys(OPPONENTS), description: '对手：aware = 预判对手脚本（默认，较强）；heuristic = 启发式' },
        strategy: { type: 'string', description: '用户的思路（可选，≤ 2000 字），会写进你的规则说明' },
        allowRisk: { type: 'boolean', description: 'true = 关闭自保闸门（目标会让你回不了家时引擎不再自动改为回家）。默认 false' },
      },
    },
  },
  {
    name: 'maze_decide',
    description: '提交当前决策点的决定：它从下一回合起立即执行，引擎跑到下一个决策点并返回新回包（或对局结果）。decision 就是决策契约里的 JSON 对象；局面没变、只想按原计划走时交 {keep:true}（目标 / then / abandonIf 原样保留）。带上 decisionPointId 防止误交给别的决策点；带上 submissionId 后，同一次提交重试会原样返回第一次的结果、不会重复推进。',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: GAME_ARG,
        decisionPointId: { type: 'string', description: '回包里给的决策点 id，如 "dp-7"。不匹配当前决策点时拒绝、不推进' },
        submissionId: { type: 'string', description: '你为这次提交生成的 id（≤ 64 个字母数字 . _ : -）；网络重试时用同一个' },
        decision: {
          type: 'object',
          description: '新目标：{targetType, target, reason, …}；或续走原计划：{keep: true, reason?, memo?}（目标 / then / abandonIf 原样保留）',
          properties: {
            keep: { type: 'boolean', description: 'true = 续走当前计划（局面没变、被与你目标无关的事件问到时用）；此时不用写 targetType / target' },
            targetType: TARGET,
            target: POINT,
            reason: { type: 'string', description: '不超过 30 字' },
            follow: { type: 'string', enum: ['yes', 'partial', 'override'], description: '是否照用户思路做（本模式可一律填 yes；省略 = yes）' },
            deviation: { type: 'string', description: 'follow 不是 yes 时说明偏离了思路的哪一条、为什么' },
            then: { type: 'array', maxItems: 2, items: { type: 'object', properties: { targetType: TARGET, target: POINT }, required: ['targetType', 'target'] }, description: '拿到 target 后依次去的目标（≤ 2；已经没了的自动跳过）。主目标丢失或 abandonIf 触发时整条清空' },
            abandonIf: { type: 'object', properties: { rivalLeadBy: { type: 'integer', minimum: 0 } }, description: '某个能「去目标再回家」的可见对手比你离目标近 ≥ rivalLeadBy 步时放弃（清空 then）并立刻重新问你；每个行动回合检查' },
            memo: { type: 'string', description: '留给下一次决策的自己（≤ 300 字）' },
          },
        },
      },
      required: ['decision'],
    },
  },
  {
    name: 'maze_observe',
    description: '纯读：重新读取当前决策点的完整回包（与上次收到的逐字节相同，不推进对局、不消耗任何东西）。上下文丢了或中断后续玩时用。',
    inputSchema: { type: 'object', properties: { gameId: GAME_ARG, fresh: { type: 'boolean', description: '兼容参数：对局停在决策点时局面已是最新，结果相同' } } },
  },
  {
    name: 'maze_frames',
    description: '纯读：取对局的逐回合记录（你这一座位当时能看到的：各座位位置 / 体力 / 分数 / 状态、公开事件、场上宝物、你当时在执行的决策）。进行中的对局读实时记录，已结束入库的对局由录像重建。帧 k = 第 k 回合结束后，帧 0 = 开局。不推进对局。',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: GAME_ARG,
        from: { type: 'integer', minimum: 0, description: '起始帧号（含），默认 0' },
        to: { type: 'integer', minimum: 0, description: `结束帧号（含），默认最新；一次最多 ${MAX_QUERY_FRAMES} 帧` },
        fields: { type: 'array', items: { type: 'string', enum: FRAME_FIELDS }, description: '只要这些字段（默认全部）' },
      },
    },
  },
  {
    name: 'maze_query',
    description: '只读查询（不推进对局）：dist = 地图上两点的最短步数（墙不可走）；不给出任何超出局面的信息。',
    inputSchema: {
      type: 'object',
      properties: { gameId: GAME_ARG, from: POINT, to: POINT },
      required: ['from', 'to'],
    },
  },
  {
    name: 'maze_replay',
    description: '复盘一局已结束的对局：summary / full = 每次决策的理由、备忘与结局（拿到 / 被谁抢先几步 / 主动放弃 / 白跑步数）以及损失最大的几次；timeline = 逐回合局面 + 每个决策点及其结果事件（由录像严格回放重建）。',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: { type: 'string', description: '可省略 = 最近一局已结束的' },
        detail: { type: 'string', enum: ['summary', 'full', 'timeline'] },
        from: { type: 'integer', minimum: 0, description: 'timeline 的起始帧（默认 0）' },
        to: { type: 'integer', minimum: 0, description: `timeline 的结束帧（默认终局；一次最多 ${MAX_QUERY_FRAMES} 帧）` },
      },
    },
  },
  {
    name: 'maze_history',
    description: '我最近的 WorkBuddy 对局（id、规格、名次、分数、是否通过服务器校验）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

const PROMPTS = [{
  name: 'play_maze',
  description: '帮我打一局迷宫寻宝',
  arguments: [{ name: 'size', description: 'XS / S / M / L / XL，默认 XS' }, { name: 'strategy', description: '我的思路（可选）' }],
}];

export function playPrompt({ size = 'XS', strategy = '' } = {}) {
  return [
    `用 maze-treasure 连接器帮我打一局「迷宫寻宝」，地图 ${size}。`,
    '先调用 maze_new_game，仔细读规则和决策契约；然后每到一个决策点，认真推理（看博弈事实表里的 lead、对手的 heading 和 spare、本局到目前为止的结局）后调用 maze_decide。',
    '一直打到对局结束，中途不要停下来问我。结束后向我汇报名次和分数，再用 maze_replay 复盘：哪些决策好、哪些亏了、下一局怎么改，并把经验记在你自己的记忆里。',
    strategy ? `我的思路：${strategy}` : '',
  ].filter(Boolean).join('\n');
}

// ───────── 工具实现 ─────────

function callTool(ctx, user, name, args = {}) {
  const host = ctx.workbuddy;
  if (name === 'maze_new_game') {
    const g = host.newGame(user, args);
    const rules = g.pending ? messagesFor(g.pending.req, g.cfg)[0].content : '';
    return [
      `# 新对局 ${g.id} · ${g.size}（${g.cfg.maze.size}×${g.cfg.maze.size}）· 对手：${OPPONENTS[g.opponents]} × 3`,
      '你在 WorkBuddy 里通过工具下棋：maze_decide 的 decision 参数就是下面「决策契约」里的 JSON 对象（不用输出成文本）。',
      '',
      '## 规则与决策契约',
      rules,
      '',
      pointText(g),
    ].join('\n');
  }
  if (name === 'maze_decide') {
    const sid = args.submissionId;
    if (sid !== undefined && !isSubmissionId(sid)) throw new ToolError('submissionId 只能是 1–64 个字母、数字或 . _ : -');
    const g = host.gameOf(user, args.gameId, { submissionId: sid });
    // 同一次提交的重试：原样返回第一次的结果，不推进（§14 C4）
    const seen = sid ? g.receipts.get(sid) : null;
    if (seen) return seen;
    if (g.ended) return endText(g);
    const cur = g.point ? `dp-${g.point.dp}` : null;
    if (args.decisionPointId !== undefined && args.decisionPointId !== cur) {
      throw new ToolError(`决策点 ${args.decisionPointId} 已经处理过了（当前是 ${cur || '无'}），这次提交没有用上、对局没有推进。如果是网络重试，请带上同一个 submissionId；否则先用 maze_observe 读取当前决策点。`);
    }
    if (!g.pending) {
      // 正常流程不会出现：不把这次决定套到没看过的局面上，推进到下一个决策点给它看
      host.advance(g);
      return pointText(g);
    }
    const d = args.decision;
    if (!d || typeof d !== 'object') throw new ToolError('decision 必须是对象：{targetType, target:{x,y}, reason, then?, abandonIf?, memo?}，或续走 {keep:true, reason?, memo?}');
    const p = g.pending;
    g.pending = null;
    p.reply.deliver(JSON.stringify(d));
    let text;
    if (g.pending && g.pending.req.kind === 'repair') {
      g.rejects++;
      host.makePoint(g); // 不合格：同一个决策点（同一局面）带着错误再问一次
      text = pointText(g);
    } else {
      host.advance(g);
      text = pointText(g);
    }
    if (sid) g.receipts.put(sid, text);
    return text;
  }
  if (name === 'maze_observe') {
    // 纯读：回包在到达决策点时就生成好了，这里只是原样再给一次（§14 C8）
    return pointText(host.gameOf(user, args.gameId));
  }
  if (name === 'maze_frames') {
    // 进行中（内存里）读实时帧；已入库的对局从录像重建（§14 C9）
    let src = null;
    try {
      const g = host.gameOf(user, args.gameId);
      src = { id: g.id, F: g.sched.frames, outcomes: g.planner.outcomes, cfg: g.cfg, ended: g.ended, anchors: 'recorded' };
    } catch (e) {
      if (!(e instanceof ToolError) || !args.gameId || !GAME_ID.test(String(args.gameId))) throw e;
      const rec = storedRecord(ctx, user, args.gameId);
      if (!rec) throw e;
      const r = framesFromRecord(rec.text, rec.cfg, [0]);
      src = { id: args.gameId, F: r.frames, outcomes: r.outcomes.get(0), cfg: rec.cfg, ended: true, anchors: r.anchors };
    }
    const { F } = src;
    const last = F.lastK(0);
    const from = args.from === undefined ? 0 : args.from;
    const to = args.to === undefined ? last : args.to;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw new ToolError('from / to 必须是整数，且 0 ≤ from ≤ to');
    if (from > last) throw new ToolError(`还没有第 ${from} 帧（最新是帧 ${last}）`);
    const fields = args.fields === undefined ? FRAME_FIELDS : args.fields;
    if (!Array.isArray(fields) || !fields.length || fields.some((f) => !FRAME_FIELDS.includes(f))) throw new ToolError(`fields 只能取 ${FRAME_FIELDS.join(' / ')}`);
    const end = Math.min(to, last, from + MAX_QUERY_FRAMES - 1);
    const aim = aimsOf(src.outcomes);
    const colors = src.cfg.treasure.gemColors;
    const items = F.range(0, from, end).map((f) => frameItem(f, { colors, aim: src.anchors === 'recorded' ? aim(f.k) : null, fields }));
    const more = end < Math.min(to, last);
    return [
      `## 对局 ${src.id} · 帧 ${from}–${end}（最新帧 ${last}${src.ended ? '，已结束' : ''}）`,
      '帧 k = 第 k 回合结束后的局面（帧 0 = 开局）；只含你这一座位当时能看到的信息。aim = 那一回合你在执行的 [决策点, 目标类型, x, y]。',
      src.anchors === 'derived' ? '这局是旧格式录像：没有记下决策锚点，aim 为空。' : '',
      more ? `一次最多 ${MAX_QUERY_FRAMES} 帧：后面的用 from: ${end + 1} 继续取。` : '',
      jsonBlock({ protocol: 'decision-v2', gameId: src.id, from, to: end, last, more, anchors: src.anchors, ...(fields.includes('seats') ? { legend: SEATS_LEGEND } : {}), items }),
    ].filter(Boolean).join('\n');
  }
  if (name === 'maze_query') {
    const g = host.gameOf(user, args.gameId);
    const N = g.cfg.maze.size;
    const ok = (p) => p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < N && p.y < N;
    if (!ok(args.from) || !ok(args.to)) throw new ToolError(`from / to 必须是地图内的坐标（0–${N - 1}）`);
    const d = distance(g, args.from, args.to);
    return d < 0 ? `(${args.from.x},${args.from.y}) 到 (${args.to.x},${args.to.y}) 走不通（至少一端是墙）` : `(${args.from.x},${args.from.y}) 到 (${args.to.x},${args.to.y}) 最短 ${d} 步`;
  }
  if (name === 'maze_replay') {
    let id = args.gameId;
    if (id && !GAME_ID.test(String(id))) throw new ToolError('gameId 格式不对');
    if (!id) {
      const last = ctx.store.listMatches(user.id, { limit: 20 }).find((m) => m.seats[0] && m.seats[0].tag === AGENT_TAG);
      if (!last) throw new ToolError('还没有已结束的 WorkBuddy 对局');
      id = last.matchId;
    }
    const rec = storedRecord(ctx, user, id);
    if (!rec) throw new ToolError('没有这局已结束的对局（进行中的对局请用 maze_observe）');
    const m = ctx.store.getMatch(id);
    const me = m.ranking.find((r) => r.seat === 0) || {};
    const head = `## 复盘 · 对局 ${id} · ${m.mapSize || ''} · ${m.turns} 回合 · 你第 ${me.place} 名、${me.score} 分（${STATUS_ZH[me.status] || me.status}）`;
    if (args.detail === 'timeline') return timelineText(rec, id, head, args);
    return replayText(timelineFromRecord(rec.text, rec.cfg, 0), head, args.detail);
  }
  if (name === 'maze_history') {
    const items = ctx.store.listMatches(user.id, { limit: 30 }).filter((m) => m.seats[0] && m.seats[0].tag === AGENT_TAG).slice(0, 10);
    const active = host.activeOf(user.id);
    const L = [];
    if (active.length) L.push('进行中：', ...active.map((a) => `- ${a.gameId} · ${a.size} · 第 ${a.turn} 回合`));
    L.push(items.length ? '已结束（最近 10 局）：' : '还没有已结束的 WorkBuddy 对局。');
    for (const m of items) {
      const me = m.ranking.find((r) => r.seat === 0) || {};
      L.push(`- ${m.matchId} · ${m.mapSize} · ${m.turns} 回合 · 第 ${me.place} 名 · ${me.score} 分 · ${STATUS_ZH[me.status] || me.status} · ${m.rulesVersion === RULES_VERSION ? `校验 ${m.verify}` : `旧规则 ${m.rulesVersion}（已作废，不可复盘）`}`);
    }
    return L.join('\n');
  }
  throw new ToolError(`没有这个工具：${name}`);
}

/** 已入库对局的录像与配置（只有本人能读；规则版本不认识时报错）。不是本人的 / 不存在 → null。 */
function storedRecord(ctx, user, id) {
  const row = ctx.store.matchRow(id);
  if (!row || row.user_id !== user.id) return null;
  const text = gunzipSync(ctx.store.recordGz(id)).toString('utf8');
  const meta = JSON.parse(text.split('\n')[0]);
  const k = configByHash(meta.configHash);
  if (!k) throw new ToolError(`这局是旧规则 ${meta.rulesVersion} 的对局（已作废），服务器已不认识它的配置，没法复盘`);
  return { text, meta, cfg: k.cfg };
}

/** maze_replay detail: "timeline"：逐帧 + 决策点与结果事件标注（§14 C8 / C9）。from / to / fields 同 maze_frames。 */
function timelineText(rec, id, head, args) {
  const r = framesFromRecord(rec.text, rec.cfg, [0]);
  const F = r.frames;
  const last = F.lastK(0);
  const from = Number.isInteger(args.from) && args.from >= 0 ? Math.min(args.from, last) : 0;
  const to = Number.isInteger(args.to) && args.to >= from ? Math.min(args.to, last) : last;
  const end = Math.min(to, from + MAX_QUERY_FRAMES - 1);
  const colors = rec.cfg.treasure.gemColors;
  const outs = r.outcomes.get(0);
  const aim = aimsOf(outs);
  const items = F.range(0, from, end).map((f) => frameItem(f, { colors, aim: r.anchors === 'recorded' ? aim(f.k) : null, fields: ['seats', 'events', 'aim'] }));
  const points = r.plans.filter((p) => p.src === 'llm' || p.src === 'llm-repair' || p.src === 'invalid' || p.src === 'stale' || p.src === 'failed')
    .map((p) => ({ dp: p.dp ?? null, k: p.req - 1, why: p.why ?? null, src: p.src, target: p.plan && p.plan.target ? [p.plan.targetType, p.plan.target.x, p.plan.target.y] : null }));
  const L = [head];
  if (r.anchors === 'derived') L.push('这局是旧格式录像：没有记下决策锚点与结果事件，下面只有逐帧局面与从计划行推导的决策点。');
  L.push(`### 决策点与结果（${points.length} 个决策点）`);
  for (const p of points) {
    const res = outs.filter((e) => p.dp !== null && e.dp === p.dp);
    L.push(`- ${p.dp ? `dp-${p.dp}` : '决策'} · 帧 ${p.k}${p.why ? ` [${whyText(p.why)}]` : ''}：${res.length ? res.map((e) => outcomeLine(e, colors)).join(' → ') : p.src}`);
  }
  L.push(`### 逐帧（帧 ${from}–${end}，共 ${last + 1} 帧；逐帧数据在下面的 JSON 块）`);
  if (end < to) L.push(`一次最多 ${MAX_QUERY_FRAMES} 帧：后面的用 detail: "timeline", from: ${end + 1} 继续取。`);
  L.push(jsonBlock({ protocol: 'decision-v2', gameId: id, from, to: end, last, more: end < to, anchors: r.anchors, legend: SEATS_LEGEND, points, outcomes: outs, items }));
  return L.join('\n');
}

function distance(g, a, b) {
  const map = g.sched.match.map;
  const N = map.size;
  // 局部 BFS（只读地形）
  const start = a.y * N + a.x;
  const goal = b.y * N + b.x;
  if (!map.grid[start] || !map.grid[goal]) return -1;
  const dist = new Int32Array(N * N).fill(-1);
  dist[start] = 0;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (c === goal) return dist[c];
    const x = c % N;
    const y = (c - x) / N;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const n = ny * N + nx;
      if (dist[n] < 0 && map.grid[n]) {
        dist[n] = dist[c] + 1;
        q.push(n);
      }
    }
  }
  return -1;
}

// ───────── MCP JSON-RPC（Streamable HTTP，只回 application/json）─────────

const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function handleRpc(ctx, user, msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcErr(msg && msg.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = msg;
  const isNote = id === undefined || id === null;
  const ok = (result) => (isNote ? null : { jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': {
      const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return ok({
        protocolVersion: v,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'maze-treasure', title: '迷宫寻宝 · WorkBuddy 上场', version: CLIENT_VERSION },
        instructions: '迷宫寻宝博弈游戏。用 maze_new_game 开局，之后每个决策点调用 maze_decide（带上回包里的 decisionPointId，可选 submissionId 用于安全重试），直到对局结束；决定从下一回合起立即执行。maze_observe / maze_frames 是纯读。结束后可用 maze_replay 复盘。',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'prompts/list':
      return ok({ prompts: PROMPTS });
    case 'prompts/get': {
      if (params.name !== 'play_maze') return rpcErr(id, -32602, `没有这个提示词：${params.name}`);
      const a = params.arguments || {};
      return ok({ description: PROMPTS[0].description, messages: [{ role: 'user', content: { type: 'text', text: playPrompt({ size: isMapSize(a.size) ? a.size : 'XS', strategy: a.strategy }) } }] });
    }
    case 'tools/call': {
      if (!TOOLS.some((t) => t.name === params.name)) return rpcErr(id, -32602, `没有这个工具：${params.name}`);
      try {
        ctx.limiters.mcp.take(user.id);
        return ok({ content: [{ type: 'text', text: callTool(ctx, user, params.name, params.arguments || {}) }] });
      } catch (e) {
        if (e instanceof ToolError || e instanceof HttpError) return ok({ content: [{ type: 'text', text: `出错：${e.message}` }], isError: true });
        console.error('[workbuddy] tool', params.name, e);
        return ok({ content: [{ type: 'text', text: '服务器内部错误' }], isError: true });
      }
    }
    default:
      return isNote ? null : rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(req, res, ctx) {
  if (req.method === 'GET' || req.method === 'DELETE') {
    res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '只支持 POST');
  const user = mcpUser(req, ctx);
  const buf = await readBody(req, 64 * 1024);
  let body;
  try {
    body = JSON.parse(buf.toString('utf8'));
    if (!body || typeof body !== 'object') throw new Error('not json-rpc');
  } catch {
    sendJson(res, 400, rpcErr(null, -32700, 'Parse error'));
    return;
  }
  const batch = Array.isArray(body);
  const out = (batch ? body : [body]).map((m) => handleRpc(ctx, user, m)).filter(Boolean);
  if (!out.length) {
    res.writeHead(202, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  sendJson(res, 200, batch ? out : out[0]);
}
