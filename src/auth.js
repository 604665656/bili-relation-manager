'use strict';
/**
 * B 站登录协议（纯 Node，无任何第三方登录库）
 *
 * 兜底了「穷尽所有方式」恢复/建立会话：
 *   ① 官方 passport API 扫码登录（generate + poll）——不依赖 Electron cookie 罐，打包后更稳，且能拿到 refresh_token
 *   ② refresh_token 自动续期（cookie/info → RSA-OAEP correspondPath → correspond → cookie/refresh → confirm/refresh）
 *      —— cookie 临期/失效时，先尝试免扫码续命；失败才退回扫码/导入
 *
 * 参考（开源权威文档）：
 *   - SocialSisterYi/bilibili-API-collect · docs/login/cookie_refresh.md
 *   - BiliTools / @renmu/bili-api 登录实现
 *
 * 设计：所有 HTTP 走内部 fetchRequest，便于单测用 global.fetch 打桩。
 */

const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* 扫码状态语义（poll 接口 data.code） */
const QR_STATUS = {
  0: 'success',
  86101: 'waiting',     // 未扫码
  86090: 'scanned',     // 已扫码，待手机确认
  86038: 'expired'      // 二维码已失效，需重新生成
};

/* B 站 cookie 刷新用的官方 RSA 公钥（从 bilibili-API-collect 文档取证） */
const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

function fetchRequest(url, { method = 'GET', form = null, query = null, cookie = '', referer = null, timeoutMs = 30000 } = {}) {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    Referer: referer || 'https://passport.bilibili.com/'
  };
  if (cookie) headers.Cookie = cookie;
  // GET 接口（如 qrcode/generate、qrcode/poll）用 query 拼 URL；POST 接口用 form 当 body
  if (query && method === 'GET') {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    url = u.toString();
  }
  const init = { method, headers };
  if (form) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) body.append(k, String(v));
    init.body = body;
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  init.signal = AbortSignal.timeout(timeoutMs);
  return fetch(url, init).then(async (res) => {
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    // 把响应头一并带回，便于 refresh 流程解析 Set-Cookie
    const setCookie = (res.headers && res.headers.getSetCookie) ? res.headers.getSetCookie() : [];
    return { status: res.status, json, text, setCookie };
  });
}

/** 把 URL 渲染为 PNG dataURL（主进程生成，渲染层直接用 <img src=dataURL>） */
async function urlToQrDataUrl(url, opts = {}) {
  const qrcode = require('qrcode');
  return await qrcode.toDataURL(url, Object.assign({ margin: 1, width: 260 }, opts));
}

/* ───────────────── 扫码登录 ───────────────── */

/**
 * 申请登录二维码。
 * @returns {{ok:boolean, qrcodeKey?:string, url?:string, dataUrl?:string, message?:string}}
 */
async function generateQr() {
  const r = await fetchRequest('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
    method: 'GET', referer: 'https://passport.bilibili.com/'
  });
  const d = r.json && r.json.data;
  if (!r.json || r.json.code !== 0 || !d || !d.qrcode_key) {
    return { ok: false, message: (r.json && r.json.message) || `生成二维码失败（HTTP ${r.status}）` };
  }
  const dataUrl = await urlToQrDataUrl(d.url);
  return { ok: true, qrcodeKey: d.qrcode_key, url: d.url, dataUrl };
}

/**
 * 轮询扫码状态。
 * @param {string} key qrcode_key
 * @returns {Promise<{status:'waiting'|'scanned'|'expired'|'success'|'error',
 *   cookie?:string, refreshToken?:string, navCode?:number, message?:string}>}
 */
async function pollQr(key) {
  const r = await fetchRequest('https://passport.bilibili.com/x/passport-login/web/qrcode/poll', {
    method: 'GET', query: { qrcode_key: key }, referer: 'https://passport.bilibili.com/'
  });
  const data = r.json && r.json.data;
  const code = data && Number(data.code);
  const mapped = QR_STATUS[code] || (r.json && r.json.code !== 0 ? 'error' : 'waiting');

  if (mapped !== 'success') {
    return { status: mapped, message: (data && data.message) || (r.json && r.json.message) || '' };
  }

  // 成功：cookie_info.cookies 是 B 站下发的完整 cookie 列表
  const info = data.cookie_info || {};
  const cookies = Array.isArray(info.cookies) ? info.cookies : [];
  if (!cookies.length) {
    return { status: 'error', message: '扫码成功但未返回任何 cookie' };
  }
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return {
    status: 'success',
    cookie,
    refreshToken: data.refresh_token || '',
    navCode: 0
  };
}

/* ───────────────── refresh_token 续期 ───────────────── */

/** 用官方公钥对 refresh_{ts} 做 RSA-OAEP(SHA-256) 加密，小写 hex 即 correspondPath */
function getCorrespondPath(timestamp) {
  const enc = crypto.publicEncrypt(
    { key: RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from('refresh_' + timestamp, 'utf8')
  );
  return enc.toString('hex');
}

/** 解析 correspond 页面里的 refresh_csrf（<div id="1-name">VALUE</div>） */
function parseRefreshCsrf(html) {
  if (!html) return '';
  const m = String(html).match(/id=["']1-name["'][^>]*>([^<]+)</i);
  return m ? m[1].trim() : '';
}

/** 从 Set-Cookie 数组解析出 cookie map（保留每个 name 的第一个/最后一个值） */
function parseSetCookie(setCookieHeaders) {
  const map = {};
  for (const h of (setCookieHeaders || [])) {
    const parts = String(h).split(';');
    const kv = parts[0].indexOf('=');
    if (kv <= 0) continue;
    const name = parts[0].slice(0, kv).trim();
    const value = parts[0].slice(kv + 1).trim();
    if (name) map[name] = value;
  }
  return map;
}

function buildCookieFromMap(map) {
  return Object.keys(map).map((k) => `${k}=${map[k]}`).join('; ');
}

/**
 * 用 refresh_token 刷新 cookie（免扫码续命）。
 * @param {{cookie:string, refreshToken:string}} param0
 * @returns {Promise<{ok:boolean, cookie?:string, refreshToken?:string, step?:string, message?:string}>}
 */
async function refreshCookie({ cookie, refreshToken }) {
  if (!cookie || !refreshToken) {
    return { ok: false, step: 'input', message: '缺少 cookie 或 refreshToken，无法续期' };
  }
  const biliJct = (cookie.match(/bili_jct=([^;]+)/) || [])[1] || '';

  // 1) 是否真的需要刷新
  let r = await fetchRequest('https://passport.bilibili.com/x/passport-login/web/cookie/info', {
    method: 'GET', cookie, referer: 'https://passport.bilibili.com/',
    // cookie/info 用 GET + query；csrf 可选
  });
  const need = r.json && r.json.data && r.json.data.refresh;
  const timestamp = (r.json && r.json.data && r.json.data.timestamp) ||
    (r.json && r.json.ts) || Date.now();
  if (r.json && r.json.code !== 0) {
    return { ok: false, step: 'cookie/info', message: `凭证校验失败（code=${r.json.code} ${r.json.message || ''}），请重新登录` };
  }
  if (need === false) {
    // 不需要刷新：cookie 仍有效，原样返回
    return { ok: true, cookie, refreshToken, step: 'no-refresh-needed' };
  }

  // 2) 生成 correspondPath（RSA-OAEP）
  const correspondPath = getCorrespondPath(timestamp);
  // 3) 取 refresh_csrf
  r = await fetchRequest('https://www.bilibili.com/correspond/1/' + correspondPath, {
    method: 'GET', cookie, referer: 'https://www.bilibili.com/'
  });
  const refreshCsrf = parseRefreshCsrf(r.text);
  if (!refreshCsrf) {
    return { ok: false, step: 'correspond', message: '无法从 correspond 页面解析 refresh_csrf，续期中止' };
  }

  // 4) 刷新 cookie（关键：必须带上已有 cookie，新 cookie 在 Set-Cookie 里返回）
  r = await fetchRequest('https://passport.bilibili.com/x/passport-login/web/cookie/refresh', {
    method: 'POST',
    form: { csrf: biliJct, refresh_csrf: refreshCsrf, refresh_token: refreshToken, source: 'main_web' },
    cookie, referer: 'https://passport.bilibili.com/'
  });
  if (!r.json || r.json.code !== 0) {
    return { ok: false, step: 'cookie/refresh', message: `刷新失败（code=${r.json && r.json.code} ${r.json && r.json.message || ''}）` };
  }
  const newMap = parseSetCookie(r.setCookie);
  if (!newMap.SESSDATA || !newMap.bili_jct) {
    return { ok: false, step: 'parse-cookie', message: '刷新接口未下发新 cookie' };
  }
  const newCookie = buildCookieFromMap(newMap);
  const newJct = newMap.bili_jct;

  // 5) 确认更新（失效旧 token）：csrf 用新 bili_jct，refresh_token 用旧的
  r = await fetchRequest('https://passport.bilibili.com/x/passport-login/web/confirm/refresh', {
    method: 'POST',
    form: { csrf: newJct, refresh_token: refreshToken, source: 'main_web' },
    cookie: newCookie, referer: 'https://passport.bilibili.com/'
  });
  if (!r.json || r.json.code !== 0) {
    // 刷新已成功，确认失败也接受（新 cookie 已生效），但记录告警
    return { ok: true, cookie: newCookie, refreshToken, step: 'confirm-skipped',
      message: `cookie 已刷新，但确认更新返回 code=${r.json && r.json.code}（可忽略）` };
  }
  const newToken = (r.json.data && r.json.data.refresh_token) || refreshToken;
  return { ok: true, cookie: newCookie, refreshToken: newToken, step: 'done' };
}

module.exports = {
  UA,
  QR_STATUS,
  generateQr,
  pollQr,
  refreshCookie,
  getCorrespondPath,
  parseRefreshCsrf,
  parseSetCookie,
  buildCookieFromMap,
  urlToQrDataUrl
};
