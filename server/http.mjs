// HTTP 小工具：JSON 响应、限长读请求体、令牌桶限频、来源（CORS）检查、客户端版本解析。

export class HttpError extends Error {
  /** @param {number} status @param {string} code 机器可读错误码 @param {string} [message] 给人看的说明 */
  constructor(status, code, message = code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

export function sendError(res, e) {
  if (e instanceof HttpError) {
    const h = e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {};
    sendJson(res, e.status, { error: e.code, message: e.message, ...e.extra.body }, h);
  } else {
    sendJson(res, 500, { error: 'internal', message: '服务器内部错误' });
  }
}

/** 读请求体，超过 limit 字节立即 413（不把整个大包读进内存）。 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'body_too_large', `请求体超过 ${limit} 字节`));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'body_too_large', `请求体超过 ${limit} 字节`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!failed) reject(e); });
  });
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'bad_json', '请求体不是合法的 JSON 对象');
  }
}

/**
 * 令牌桶限频（单进程内存）。
 * @param {{capacity:number, perMinute:number, now:()=>number}} o
 */
export function createLimiter({ capacity, perMinute, now }) {
  const buckets = new Map();
  const rate = perMinute / 60000;
  return {
    /** 扣一个令牌；不够时抛 429。 */
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, at: t };
        buckets.set(key, b);
      }
      b.tokens = Math.min(capacity, b.tokens + (t - b.at) * rate);
      b.at = t;
      if (b.tokens < 1) {
        const wait = Math.ceil((1 - b.tokens) / rate / 1000);
        throw new HttpError(429, 'rate_limited', '请求太频繁，请稍后再试', { retryAfter: wait });
      }
      b.tokens -= 1;
      if (buckets.size > 50000) {
        for (const [k, v] of buckets) if (t - v.at > 600000) buckets.delete(k);
      }
    },
  };
}

/** 客户端 IP：只有部署在反向代理后（trustProxy）才信 X-Forwarded-For 的第一个地址。 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** 本次请求自己的来源（同源判断用）。 */
export function selfOrigin(req, trustProxy) {
  const proto = trustProxy && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : 'http';
  return `${proto}://${req.headers.host}`;
}

/** X-Maze-Client: web/0.3.0 → {platform:'web', version:'0.3.0'}。 */
export function parseClient(header) {
  const m = /^(web|h5|desktop|agent|tool)\/(\d+\.\d+\.\d+)$/.exec(String(header || '').trim());
  return m ? { platform: m[1], version: m[2] } : null;
}

/** 语义版本比较：a < b → 负数。 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
