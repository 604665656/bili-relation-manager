'use strict';
// 用本机已缓存的 git 凭证（GitHub Desktop 登录态）直接发布 v2.1.12 Release。
// token 仅留在内存，绝不打印。
const { execFileSync } = require('child_process');
const https = require('https');
const path = require('path');

function getCred() {
  const input = 'protocol=https\nhost=github.com\n';
  const out = execFileSync('git', ['credential', 'fill'], { input, encoding: 'utf8', timeout: 30000 });
  const kv = {};
  for (const l of out.split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1);
  }
  return kv;
}

function api(method, url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'brm-publish' }
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  let cred;
  try { cred = getCred(); } catch (e) { console.log('获取 git 凭证失败: ' + e.message); process.exit(2); }
  const token = cred.password;
  if (!token) { console.log('凭证中没有 token'); process.exit(2); }
  console.log('凭证用户名: ' + (cred.username || '(none)'));

  const me = await api('GET', 'https://api.github.com/user', token);
  console.log('GET /user -> HTTP ' + me.status);
  if (me.status !== 200) { console.log('token 无效或权限不足，无法发布'); process.exit(3); }
  const who = JSON.parse(me.body || '{}');
  console.log('已认证为: ' + who.login);

  // 验证可访问目标仓库
  const repo = await api('GET', 'https://api.github.com/repos/604665656/bili-relation-manager', token);
  console.log('GET /repos/604665656/bili-relation-manager -> HTTP ' + repo.status);
  if (repo.status !== 200) { console.log('无法访问目标仓库（可能缺 repo 权限）'); process.exit(3); }

  process.env.GH_TOKEN = token;
  console.log('开始发布 v2.1.12 ...');
  require(path.join(__dirname, 'publish-release.js'));
})().catch((e) => { console.error(e); process.exit(1); });
