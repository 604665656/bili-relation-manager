'use strict';
/* 一次性发布脚本：删除被剥名的资产 → 用纯 node https 重传（UTF-8 名称经 encodeURIComponent 进 query） */
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = '604665656/bili-relation-manager';
const RID = '423134896';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1); }

const DIST = path.join(__dirname, '..', 'dist');
// 注意：GitHub 会剥掉资产名里的非 ASCII 字符（中文名会变成 B.-2.1.7-.exe），
// 因此资产一律用 ASCII 名 + portable/setup 标记，updater-core.pickAsset 靠这个标记挑选。
const FILES = [
  { local: 'B站关注管理台-2.1.7-便携版.exe', remote: 'bili-relation-manager-2.1.7-portable.exe' },
  { local: 'B站关注管理台-2.1.7.exe', remote: 'bili-relation-manager-2.1.7-setup.exe' }
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
        try { j = JSON.parse(txt); } catch (e) { /* 204 等无 body */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function upload(filePath, name) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const u = new URL(`https://uploads.github.com/repos/${REPO}/releases/${RID}/assets`);
    u.searchParams.set('name', name);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
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
  // 1. 列出现有资产，删掉名字里没有中文/portable 的残留
  const rel = await api('GET', `https://api.github.com/repos/${REPO}/releases/${RID}`);
  for (const a of (rel.json && rel.json.assets) || []) {
    console.log('现有资产: [' + a.name + '] id=' + a.id);
    const d = await api('DELETE', `https://api.github.com/repos/${REPO}/releases/assets/${a.id}`);
    console.log('  删除 → HTTP ' + d.status);
  }
  // 2. 重传
  for (const f of FILES) {
    const p = path.join(DIST, f.local);
    if (!fs.existsSync(p)) { console.error('文件不存在: ' + p); process.exit(1); }
    const r = await upload(p, f.remote);
    if (r.json && r.json.id) {
      console.log('✓ 上传成功: [' + r.json.name + '] ' + Math.round(r.json.size / 1048576) + 'MB');
    } else {
      console.error('✗ 上传失败: HTTP ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      process.exit(1);
    }
  }
  console.log('DONE');
})().catch((e) => { console.error(e); process.exit(1); });
