// 大模型服务商（05 §7.3、06 §7.3）：预设只帮玩家填地址；自定义地址做 SSRF 防护。
// 统一走 OpenAI 兼容的 POST {base}/chat/completions。
//
// SSRF 防护两层：
//   ① 保存时 checkBaseUrl：只允许 https + 443；不允许账号密码、查询串；主机名不是 localhost / 内网后缀；IP 字面量必须是公网地址
//   ② 每次连接时 guardedLookup：DNS 解析出的每个地址都必须是公网地址（防 DNS 重绑定：校验的就是实际要连的地址）

import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';

/**
 * verified：已用真实凭证实测过（其余地址与模型名以厂商文档为准，上线前逐个核对）。
 * extra(reasoning)：附加到请求体的字段（例：混元关闭思考，否则 max_tokens 内只有思考、答案为空）。
 */
export const PROVIDERS = Object.freeze({
  hunyuan: Object.freeze({
    label: '腾讯混元（HY4）', baseUrl: 'https://tokenhub.tencentmaas.com/v1', model: 'hy4-preview', verified: true,
    note: '默认关闭思考：每次决策约 3 秒、输入约 800 token、输出约 35 token',
    extra: (reasoning) => (reasoning ? {} : { thinking: { type: 'disabled' } }),
  }),
  deepseek: Object.freeze({ label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', verified: false }),
  ark: Object.freeze({ label: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', verified: false, note: '模型名填方舟控制台里的模型名或接入点 ID' }),
  dashscope: Object.freeze({ label: '阿里云百炼（通义）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', verified: false }),
  moonshot: Object.freeze({ label: 'Moonshot（Kimi）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', verified: false }),
  openai: Object.freeze({ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', verified: false, note: '服务器在中国大陆时可能连不通' }),
  custom: Object.freeze({ label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', verified: false, note: '只允许 https:// 公网地址' }),
});

export function providerList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model, verified: p.verified, note: p.note ?? '' }));
}

export function extraBody(providerId, reasoning) {
  const p = PROVIDERS[providerId];
  return p && p.extra ? p.extra(Boolean(reasoning)) : {};
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
