'use strict';
/**
 * 登录协议单测：官方 API 扫码登录（generate/poll 状态机）+ refresh_token 自动续期
 * + refreshToken 持久化（加密落盘 + 读取解密）。
 * 用 global.fetch 打桩，不依赖真实网络。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../src/auth');

let pass = 0, fail = 0;
const _tests = [];
function t(name, fn) { _tests.push({ name, fn }); }

/* 用桩替代 fetch：返回我们需要的 json / text / setCookie */
function mockFetch(handler) {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const r = await handler(url, init);
    return {
      status: r.status || 200,
      headers: { getSetCookie: () => (r.setCookie || []) },
      text: async () => (r.text != null ? r.text : JSON.stringify(r.json))
    };
  };
  return () => { global.fetch = orig; };
}

(async () => {
console.log('\n[登录协议 · 二维码扫码]');

t('RSA-OAEP 加密 correspondPath 为合法小写 hex（128 字节密文 → 256 hex）', async () => {
  const p1 = auth.getCorrespondPath(1684466082562);
  assert.ok(/^[0-9a-f]{256}$/.test(p1), 'correspondPath 不是 256 位小写 hex');
  // RSA-OAEP 带随机盐，同一明文密文不固定；服务端用私钥解密即可还原，无需客户端可复现
});

t('parseRefreshCsrf 能提取 refresh_csrf', () => {
  const html = '<html><body><div id="1-name">abcDEF123_</div></body></html>';
  assert.strictEqual(auth.parseRefreshCsrf(html), 'abcDEF123_');
  assert.strictEqual(auth.parseRefreshCsrf('<div id="other">x</div>'), '', '无 1-name 应返回空');
});

t('parseSetCookie 正确解析 Set-Cookie 数组', () => {
  const arr = ['SESSDATA=aaa; Path=/; HttpOnly', 'bili_jct=bbb; Path=/', 'DedeUserID=1; Domain=.bilibili.com'];
  const m = auth.parseSetCookie(arr);
  assert.strictEqual(m.SESSDATA, 'aaa');
  assert.strictEqual(m.bili_jct, 'bbb');
  assert.strictEqual(m.DedeUserID, '1');
  assert.strictEqual(auth.buildCookieFromMap(m), 'SESSDATA=aaa; bili_jct=bbb; DedeUserID=1');
});

t('generateQr 返回 qrcodeKey + dataURL（PNG base64）', async () => {
  const restore = mockFetch(async () => ({ json: { code: 0, data: { qrcode_key: 'KEY123', url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=KEY123' } } }));
  try {
    const g = await auth.generateQr();
    assert.ok(g.ok, 'generateQr 应成功');
    assert.strictEqual(g.qrcodeKey, 'KEY123');
    assert.ok(/^data:image\/png;base64,/.test(g.dataUrl), 'dataUrl 应为 PNG base64');
  } finally { restore(); }
});

t('pollQr：86101 等待扫码 / 86090 已扫码待确认 / 86038 过期', async () => {
  const statuses = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' };
  for (const code of Object.keys(statuses)) {
    const restore = mockFetch(async () => ({ json: { code: 0, data: { code: Number(code), message: 'x' } } }));
    try {
      const r = await auth.pollQr('K');
      assert.strictEqual(r.status, statuses[code], `code=${code} 应映射为 ${statuses[code]}`);
    } finally { restore(); }
  }
});

t('pollQr：成功返回完整 cookie + refreshToken', async () => {
  const restore = mockFetch(async () => ({
    json: {
      code: 0,
      data: {
        code: 0, message: '0', refresh_token: 'RT999',
        cookie_info: { cookies: [
          { name: 'SESSDATA', value: 'sess-val' },
          { name: 'bili_jct', value: 'jct-val' },
          { name: 'DedeUserID', value: '123' }
        ] }
      }
    }
  }));
  try {
    const r = await auth.pollQr('K');
    assert.strictEqual(r.status, 'success', '应 success');
    assert.strictEqual(r.cookie, 'SESSDATA=sess-val; bili_jct=jct-val; DedeUserID=123', 'cookie 拼接错误');
    assert.strictEqual(r.refreshToken, 'RT999');
  } finally { restore(); }
});

console.log('\n[登录协议 · refresh_token 续期]');

t('refreshCookie：缺少 refreshToken 直接失败', async () => {
  const r = await auth.refreshCookie({ cookie: 'SESSDATA=a; bili_jct=b; DedeUserID=1', refreshToken: '' });
  assert.strictEqual(r.ok, false, '无 refreshToken 应失败');
});

t('refreshCookie：refresh=false 时原样返回（无需刷新）', async () => {
  const restore = mockFetch(async (url) => {
    if (url.includes('/cookie/info')) return { json: { code: 0, data: { refresh: false } } };
    throw new Error('不应再请求后续接口');
  });
  try {
    const c = 'SESSDATA=a; bili_jct=b; DedeUserID=1';
    const r = await auth.refreshCookie({ cookie: c, refreshToken: 'RT' });
    assert.strictEqual(r.ok, true, '无需刷新应 ok');
    assert.strictEqual(r.step, 'no-refresh-needed');
    assert.strictEqual(r.cookie, c);
  } finally { restore(); }
});

t('refreshCookie：完整流程（info→correspond→refresh→confirm）成功续期', async () => {
  const ts = 1684466082562;
  const restore = mockFetch(async (url) => {
    if (url.includes('/cookie/info')) return { json: { code: 0, data: { refresh: true, timestamp: ts } } };
    if (url.includes('/correspond/1/')) return { text: '<div id="1-name">CSRF_TOKEN_X</div>' };
    if (url.includes('/cookie/refresh')) {
      return { json: { code: 0, data: {} }, setCookie: ['SESSDATA=new-sess; Path=/', 'bili_jct=new-jct; Path=/'] };
    }
    if (url.includes('/confirm/refresh')) return { json: { code: 0, data: { refresh_token: 'RT_NEW' } } };
    throw new Error('未预期的请求：' + url);
  });
  try {
    const r = await auth.refreshCookie({ cookie: 'SESSDATA=old; bili_jct=old; DedeUserID=1', refreshToken: 'RT_OLD' });
    assert.strictEqual(r.ok, true, '续期应成功：' + (r.message || ''));
    assert.strictEqual(r.step, 'done');
    assert.ok(r.cookie.includes('SESSDATA=new-sess') && r.cookie.includes('bili_jct=new-jct'), '新 cookie 未生效');
    assert.strictEqual(r.refreshToken, 'RT_NEW', '应返回新 refresh_token');
  } finally { restore(); }
});

t('refreshCookie：correspond 解析失败应给出明确错误', async () => {
  const restore = mockFetch(async (url) => {
    if (url.includes('/cookie/info')) return { json: { code: 0, data: { refresh: true, timestamp: 1 } } };
    if (url.includes('/correspond/1/')) return { text: '<div>x</div>' };
    throw new Error('不应到这');
  });
  try {
    const r = await auth.refreshCookie({ cookie: 'SESSDATA=a; bili_jct=b; DedeUserID=1', refreshToken: 'RT' });
    assert.strictEqual(r.ok, false, '解析失败应失败');
    assert.strictEqual(r.step, 'correspond');
  } finally { restore(); }
});

console.log('\n[refreshToken 持久化 · 加密落盘]');

t('store 加密落盘 refreshToken，读取时解密回原文', () => {
  const { Store } = require('../src/store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brm-auth-'));
  const codec = { encrypt: (s) => 'ENC:' + s, decrypt: (s) => (s && String(s).startsWith('ENC:') ? s.slice(4) : s) };
  const store = new Store(tmp, { codec });
  store.load();
  store.upsertAccount({ uid: 999, uname: '持久化测试', cookie: 'SESSDATA=a; bili_jct=b; DedeUserID=999', refreshToken: 'RT_SECRET' });
  store.flush();

  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'data.json'), 'utf8'));
  const acc = disk.accounts[0];
  assert.strictEqual(acc.refreshToken, 'ENC:RT_SECRET', '磁盘上 refreshToken 应已加密');
  assert.strictEqual(acc.cookie, 'ENC:SESSDATA=a; bili_jct=b; DedeUserID=999', 'cookie 也应加密');

  // 重新装载，应解密回原文
  const store2 = new Store(tmp, { codec });
  store2.load();
  const a2 = store2.getAccount(acc.id);
  assert.strictEqual(a2.refreshToken, 'RT_SECRET', '读取时 refreshToken 应解密');
  assert.strictEqual(a2.cookie, 'SESSDATA=a; bili_jct=b; DedeUserID=999', '读取时 cookie 应解密');
  fs.rmSync(tmp, { recursive: true, force: true });
});

for (const { name, fn } of _tests) {
  try { await fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '  →  ' + e.message); fail++; }
}
console.log(`\n────────────  通过 ${pass} · 失败 ${fail}  ────────────\n`);
process.exit(fail ? 1 : 0);
})();
