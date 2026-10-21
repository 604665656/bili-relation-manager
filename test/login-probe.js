'use strict';
/**
 * 登录 cookie 读取路径探针（需 Electron 运行，不开窗口以规避本机 GPU 问题）：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe test/login-probe.js
 *
 * 验证：写入到 .bilibili.com 域的 HttpOnly cookie，能否被主进程轮询逻辑读到
 */
const { app, session } = require('electron');

const URLS = [
  'https://www.bilibili.com', 'https://bilibili.com', 'https://passport.bilibili.com',
  'https://api.bilibili.com', 'https://space.bilibili.com'
];

async function readLoginCookies(ses) {
  const map = {};
  for (const url of URLS) {
    try {
      const list = await ses.cookies.get({ url });
      for (const c of list) if (c.value) map[c.name] = c.value;
    } catch (e) { console.log('  读取异常 ' + url + ': ' + e.message); }
  }
  return map;
}

function buildCookieHeader(map) {
  const keys = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4', 'b_lsid'];
  return keys.filter((k) => map[k]).map((k) => `${k}=${map[k]}`).join('; ');
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('probe_' + Date.now());

  // 模拟扫码成功后 B 站写入的 cookie（SESSDATA 在真实环境是 HttpOnly + Secure）
  const fake = [
    { name: 'SESSDATA', value: 'abcdefg1234567', domain: '.bilibili.com', httpOnly: true, secure: true },
    { name: 'bili_jct', value: 'csrf-token-xyz', domain: '.bilibili.com', httpOnly: false, secure: true },
    { name: 'DedeUserID', value: '12345678', domain: '.bilibili.com', httpOnly: false, secure: false },
    { name: 'DedeUserID__ckMd5', value: 'md5xxxx', domain: '.bilibili.com', httpOnly: false, secure: false },
    { name: 'buvid3', value: 'uuid-3', domain: '.bilibili.com', httpOnly: false, secure: false },
    { name: 'sid', value: 'session-id', domain: '.bilibili.com', httpOnly: false, secure: false }
  ];

  let fail = 0;
  for (const c of fake) {
    try {
      await ses.cookies.set({
        url: 'https://www.bilibili.com', name: c.name, value: c.value,
        domain: c.domain, path: '/', httpOnly: c.httpOnly, secure: c.secure,
        expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30
      });
    } catch (e) { console.log('  写入失败 ' + c.name + ': ' + e.message); fail++; }
  }

  // 单域名读取（旧实现）
  const single = {};
  try {
    (await ses.cookies.get({ url: 'https://www.bilibili.com' }))
      .forEach((c) => { if (c.value) single[c.name] = c.value; });
  } catch (e) { console.log('  单域名读取异常: ' + e.message); }
  console.log('\n[旧实现] 仅查 https://www.bilibili.com');
  console.log('  读到: ' + (Object.keys(single).join(', ') || '(无)'));
  console.log('  三项齐全: ' + !!(single.SESSDATA && single.bili_jct && single.DedeUserID));

  // 多域名读取（新实现）
  const map = await readLoginCookies(ses);
  const ok = !!(map.SESSDATA && map.bili_jct && map.DedeUserID);
  console.log('\n[新实现] 多域名合并读取');
  console.log('  读到: ' + (Object.keys(map).join(', ') || '(无)'));
  console.log('  三项齐全: ' + ok);
  console.log('  拼装结果: ' + buildCookieHeader(map).slice(0, 120));

  console.log('\n结论: ' + (ok && !fail ? 'PASS — 登录轮询能读到凭证' : 'FAIL — 读取路径有问题'));
  app.quit(ok && !fail ? 0 : 1);
});
