// 大模型服务商（05 §7.3、06 §7.3）：预设只帮玩家填地址；自定义地址做 SSRF 防护。
// 统一走 OpenAI 兼容的 POST {base}/chat/completions。
//
// SSRF 防护两层：
//   ① 保存时 checkBaseUrl：只允许 https + 443；不允许账号密码、查询串；主机名不是 localhost / 内网后缀；IP 字面量必须是公网地址
//   ② 每次连接时 guardedLookup：DNS 解析出的每个地址都必须是公网地址（防 DNS 重绑定：校验的就是实际要连的地址）

import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';

/**
 * 预设：四个模型都在腾讯 MaaS 网关上，共用同一把凭证（2026-11-02 真凭证实测）；另留「自定义（OpenAI 兼容）」。
 * verified：已用真实凭证跑通过「测试连接」。
 *
 * 思考档位 think[off|low|high]（批次 6，玩家可选，默认 low）：附加到请求体的字段；null = 该模型不支持这一档，降为 off。
 *   不压思考时 completion_tokens 含思考 token，答案的输出预算会被思考吃光、content 为空（K3 实测），所以 off 一律显式关。
 *   各家写法不同，网关对不认识的写法直接 400。2026-11-06 开局局面一次决策实测：
 *     HY4      effort low 77 s / 2.5k 思考 token；high / enabled 3000 token 写不完答案 → 只能关
 *     Kimi K3  effort high 2.5 s / 35 token；thinking enabled 53 s / 2.1k token；
 *              thinking:disabled 与 effort none 都 400（11-02 时 disabled 还能用），最低只能 effort low（~20 token 残余思考）
 *     DeepSeek effort low 5.7 s / 450 token；effort high 5.9 s / 490 token
 *     GLM      关不掉（thinking:disabled、effort none / minimal 都 400），effort low 只剩 ~8 token 当作关；
 *              effort high 4.1 s / 100 token；thinking enabled 10 s / 640 token
 * outputFloor：off 档的输出预算下限（思考关不掉的模型给残余思考留余量）。
 */
const MAAS = 'https://tokenhub.tencentmaas.com/v1';
const OFF = Object.freeze({ thinking: { type: 'disabled' } });
const ENABLED = Object.freeze({ thinking: { type: 'enabled' } });
const effort = (e) => Object.freeze({ reasoning_effort: e });

export const PROVIDERS = Object.freeze({
  hunyuan: Object.freeze({
    label: '腾讯混元 HY4', baseUrl: MAAS, model: 'hy4-preview', verified: true,
    note: '只能关闭思考（开了要 1 分钟以上、经常写不出答案）：每次决策约 3 秒',
    think: { off: OFF, low: null, high: null },
  }),
  kimi: Object.freeze({
    label: 'Kimi K3', baseUrl: MAAS, model: 'kimi-k3', verified: true,
    note: '思考关不掉（2026-11-06 起网关拒收 thinking:disabled），「关」= 压到最低；关 ≈ 2 秒 · 低 ≈ 3 秒 · 高 ≈ 50 秒（每次决策）',
    think: { off: effort('low'), low: effort('high'), high: ENABLED },
    outputFloor: 1000,
  }),
  deepseek: Object.freeze({
    label: 'DeepSeek V4.1 Flash', baseUrl: MAAS, model: 'deepseek-v4.1-flash', verified: true,
    note: '思考 关 ≈ 1.5 秒 · 低 ≈ 6 秒 · 高 ≈ 6 秒（每次决策）',
    think: { off: OFF, low: effort('low'), high: effort('high') },
  }),
  glm: Object.freeze({
    label: 'GLM-5.3 Flash', baseUrl: MAAS, model: 'glm-5.3-flash', verified: true,
    note: '思考关不掉，「关」= 压到最低；关 ≈ 2–12 秒 · 低 ≈ 4 秒 · 高 ≈ 10 秒（每次决策）',
    think: { off: effort('low'), low: effort('high'), high: ENABLED },
    outputFloor: 1000,
  }),
  custom: Object.freeze({ label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', verified: false, note: '只允许 https:// 公网地址；思考档位无法控制，按「这是推理模型」勾选放宽预算' }),
});

export const THINKING = Object.freeze(['off', 'low', 'high']);
export const DEFAULT_THINKING = 'low';

export function providerList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, label: p.label, baseUrl: p.baseUrl, model: p.model, verified: p.verified, note: p.note ?? '',
    thinking: p.think ? THINKING.filter((l) => p.think[l]) : ['off'],
  }));
}

/** 思考 token 的额外预算与上游超时（按实际档位）。 */
export const THINK_BUDGET = Object.freeze({ off: 0, low: 3000, high: 7000 });
export const ANSWER_CAP = 1200;
export const RELAY_TIMEOUT_MS = Object.freeze({ off: 45000, low: 75000, high: 150000 });

/**
 * 某把 key 在某个思考档位下实际怎么调：
 *   level     实际档位（模型不支持时降为 off；自定义按 key 的「推理模型」勾选：勾了视为 high、否则 off）
 *   extra     附加到请求体的字段
 *   maxTokens 答案预算（请求值，≤ 1200）+ 思考预算；off 档抬到服务商下限
 *   timeoutMs 上游超时
 * 服务器中转、测试连接与桌面端本机直连共用。
 */
export function thinkingPlan(providerId, requestedLevel, { requested, reasoning = false } = {}) {
  const p = PROVIDERS[providerId];
  const want = THINKING.includes(requestedLevel) ? requestedLevel : DEFAULT_THINKING;
  let level;
  let extra;
  if (p && p.think) {
    level = p.think[want] ? want : 'off';
    extra = { ...p.think[level] };
  } else {
    level = reasoning ? 'high' : 'off';
    extra = {};
  }
  const answer = Math.min(Number.isInteger(requested) && requested > 0 ? requested : 200, ANSWER_CAP);
  const floor = (p && p.outputFloor) || 0;
  const maxTokens = level === 'off' ? Math.max(answer, floor) : answer + THINK_BUDGET[level];
  return { level, requested: want, extra, maxTokens, timeoutMs: RELAY_TIMEOUT_MS[level] };
}

function v4Public(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // 本网 / 私网 / 回环 / 组播 / 保留 / 广播
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF 协议分配 / 文档
  if (a === 198 && (b === 18 || b === 19)) return false; // 基准测试
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** 是否公网地址。IPv6 只放行全球单播 2000::/3（去掉文档段、6to4、Teredo）；IPv4 映射地址按 IPv4 判。 */
export function isPublicAddress(ip) {
  const fam = isIP(ip);
  if (fam === 4) return v4Public(ip);
  if (fam !== 6) return false;
  const s = ip.toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s) || /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return v4Public(mapped[1]);
  const head = parseInt(s.split(':')[0] || '0', 16);
  if (!(head >= 0x2000 && head <= 0x3fff)) return false;
  if (s.startsWith('2001:db8:') || s.startsWith('2001:0db8:') || s.startsWith('2002:') || /^2001:0{0,4}:/.test(s)) return false;
  return true;
}

const BAD_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

/**
 * 校验自定义地址；通过返回规范化的 base（无结尾斜杠），否则抛出带中文原因的 Error。
 * 只做字面检查；实际连接时还会由 guardedLookup 按 DNS 结果再查一次。
 */
export function checkBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('地址格式不对');
  }
  if (u.protocol !== 'https:') throw new Error('只允许 https:// 地址');
  if (u.username || u.password) throw new Error('地址里不能带账号密码');
  if (u.port && u.port !== '443') throw new Error('只允许 443 端口');
  if (u.search || u.hash) throw new Error('地址里不能带查询串');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || BAD_HOST.test(host) || (!host.includes('.') && !isIP(host))) throw new Error('不允许内网主机名');
  if (isIP(host) && !isPublicAddress(host)) throw new Error('不允许内网 / 回环 / 链路本地地址');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** 给 https.request 的 lookup：解析结果里有任何非公网地址就拒绝连接。 */
export function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'object' && options ? options : { family: options };
  if (isIP(hostname)) {
    const fam = isIP(hostname);
    if (!isPublicAddress(hostname)) {
      callback(Object.assign(new Error(`拒绝连接非公网地址 ${hostname}`), { code: 'ESSRF' }));
      return;
    }
    if (opts.all) callback(null, [{ address: hostname, family: fam }]);
    else callback(null, hostname, fam);
    return;
  }
  dnsLookup(hostname, { all: true, family: opts.family || 0 }, (err, addrs) => {
    if (err) {
      callback(err);
      return;
    }
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad || !addrs.length) {
      callback(Object.assign(new Error(`拒绝连接非公网地址 ${bad ? bad.address : '(空)'}`), { code: 'ESSRF' }));
      return;
    }
    if (opts.all) callback(null, addrs);
    else callback(null, addrs[0].address, addrs[0].family);
  });
}
