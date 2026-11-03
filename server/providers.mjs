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
 * extra(reasoning)：附加到请求体的字段，用来关掉 / 压低思考。不压的话 completion_tokens 含思考 token，
 *   200 的输出预算会被思考吃光、content 为空（K3 实测）。各家写法不同，网关对不认识的写法直接 400：
 *   HY4 / K3 / DeepSeek 认 thinking:{type:'disabled'}（关掉后 reasoning_tokens = 0）；
 *   GLM 关不掉（thinking:disabled、reasoning_effort:none / minimal 都 400），最低只能 reasoning_effort:'low'。
 * outputFloor：普通档的输出预算下限。思考关不掉的模型要给残余思考留余量，否则答案被截断。
 */
const MAAS = 'https://tokenhub.tencentmaas.com/v1';
const disableThinking = (reasoning) => (reasoning ? {} : { thinking: { type: 'disabled' } });
const lowEffort = (reasoning) => (reasoning ? {} : { reasoning_effort: 'low' });

export const PROVIDERS = Object.freeze({
  hunyuan: Object.freeze({
    label: '腾讯混元 HY4', baseUrl: MAAS, model: 'hy4-preview', verified: true,
    note: '关闭思考：每次决策约 3 秒、输入约 1k token、输出约 35 token',
    extra: disableThinking,
  }),
  kimi: Object.freeze({
    label: 'Kimi K3', baseUrl: MAAS, model: 'kimi-k3', verified: true,
    note: '关闭思考：每次决策约 2.5 秒、输出约 36 token。勾「这是推理模型」则先思考（约 22 秒、500 token）',
    extra: disableThinking,
  }),
  deepseek: Object.freeze({
    label: 'DeepSeek V4.1 Flash', baseUrl: MAAS, model: 'deepseek-v4.1-flash', verified: true,
    note: '关闭思考：每次决策约 1.5 秒、输出约 35 token',
    extra: disableThinking,
  }),
  glm: Object.freeze({
    label: 'GLM-5.3 Flash', baseUrl: MAAS, model: 'glm-5.3-flash', verified: true,
    note: '思考关不掉、只能压到 low：每次决策约 12 秒；输出预算自动放宽到 1000 token 给残余思考留余量',
    extra: lowEffort,
    outputFloor: 1000,
  }),
  custom: Object.freeze({ label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', verified: false, note: '只允许 https:// 公网地址' }),
});

export function providerList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model, verified: p.verified, note: p.note ?? '' }));
}

export function extraBody(providerId, reasoning) {
  const p = PROVIDERS[providerId];
  return p && p.extra ? p.extra(Boolean(reasoning)) : {};
}

/** 输出预算上限：普通档 400、推理档 4000；思考关不掉的模型普通档抬到它的 outputFloor。 */
export const OUTPUT_CAP = Object.freeze({ normal: 400, reasoning: 4000 });

/**
 * 实际发给上游的 max_tokens：请求值先抬到服务商下限，再按档位封顶。
 * 服务器中转与桌面端本机直连共用这条规则。
 */
export function outputBudget(providerId, requested, reasoning) {
  const floor = (PROVIDERS[providerId] && PROVIDERS[providerId].outputFloor) || 0;
  const cap = reasoning ? OUTPUT_CAP.reasoning : Math.max(OUTPUT_CAP.normal, floor);
  const want = Number.isInteger(requested) && requested > 0 ? requested : 200;
  return Math.min(Math.max(want, floor), cap);
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
