'use strict';
/**
 * 一条命令发布当前版本：
 *   GH_TOKEN=xxx node tools/publish-release.js
 * 1) 读 package.json 版本 → tag vX.Y.Z
 * 2) 该 tag 的 Release 不存在就创建（说明取 RELEASE_NOTES.md，没有则用默认文案）
 * 3) 删掉同 Release 下的旧资产后重新上传（幂等，可反复执行）
 *
 * 关键坑：GitHub 会剥掉资产名里的非 ASCII 字符（中文名变成 B.-2.1.7-.exe），
 * 所以线上资产一律用 ASCII 名 + portable/setup 标记，updater-core.pickAsset 靠标记挑选。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = '604665656/bili-relation-manager';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1); }

const VERSION = require('../package.json').version;
const TAG = 'v' + VERSION;
const DIST = path.join(__dirname, '..', 'dist');
const FILES = [
  { local: `B站关注管理台-${VERSION}-便携版.exe`, remote: `bili-relation-manager-${VERSION}-portable.exe` },
  { local: `B站关注管理台-${VERSION}.exe`, remote: `bili-relation-manager-${VERSION}-setup.exe` }
];

function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'bili-relation-manager',
        'Content-Type': 'application/json'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(txt); } catch (e) { /* 204 无 body */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function upload(filePath, name, releaseId) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const u = new URL(`https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets`);
    u.searchParams.set('name', name);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,        // 注意：search 自带 ?，不能再拼一个
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'bili-relation-manager',
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req);
  });
}

(async () => {
  // 1. 找 Release，没有就建
  let rel = await api('GET', `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
  if (rel.status === 404) {
    const notesFile = path.join(__dirname, '..', 'RELEASE_NOTES.md');
    const notes = fs.existsSync(notesFile)
      ? fs.readFileSync(notesFile, 'utf8')
      : `## v${VERSION}\n\n详见仓库提交记录。`;
    const r = await api('POST', `https://api.github.com/repos/${REPO}/releases`,
      JSON.stringify({ tag_name: TAG, name: TAG, body: notes }));
    if (!r.json || !r.json.id) { console.error('创建 Release 失败: ' + JSON.stringify(r.json).slice(0, 200)); process.exit(1); }
    console.log('已创建 Release ' + TAG + ' (id=' + r.json.id + ')');
    rel = r;
  }
  const releaseId = rel.json && rel.json.id;
  if (!releaseId) { console.error('读取 Release 失败: ' + rel.status); process.exit(1); }
  console.log('Release ' + TAG + ' id=' + releaseId);

  // 2. 清掉旧资产（幂等重传）
  for (const a of (rel.json.assets || [])) {
    const d = await api('DELETE', `https://api.github.com/repos/${REPO}/releases/assets/${a.id}`);
    console.log('  删除旧资产 [' + a.name + '] → HTTP ' + d.status);
  }

  // 3. 上传新资产
  for (const f of FILES) {
    const p = path.join(DIST, f.local);
    if (!fs.existsSync(p)) { console.error('文件不存在: ' + p + '（先 npm run build）'); process.exit(1); }
    const r = await upload(p, f.remote, releaseId);
    if (r.json && r.json.id) {
      console.log('✓ 上传 [' + r.json.name + '] ' + Math.round(r.json.size / 1048576) + 'MB');
    } else {
      console.error('✗ 上传失败 HTTP ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      process.exit(1);
    }
  }
  console.log('DONE → https://github.com/' + REPO + '/releases/tag/' + TAG);
})().catch((e) => { console.error(e); process.exit(1); });
