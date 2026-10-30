// 线上联调：确认 Release 里的资产名能被 updater 正确挑中，且大小与本地构建一致
const fs = require('fs');
const path = require('path');
const https = require('https');
const { pickAsset, parseVer, compareVer } = require('../src/updater-core');

const REPO = '604665656/bili-relation-manager';
const VERSION = require('../package.json').version;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'brm-verify', Accept: 'application/vnd.github+json' } }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const rel = await get(`https://api.github.com/repos/${REPO}/releases/latest`);
  console.log('线上最新 Release:', rel.tag_name, '| 预发布:', rel.prerelease);
  const assets = (rel.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
  assets.forEach((a) => console.log('  资产', a.name, (a.size / 1048576).toFixed(1) + 'MB'));

  const tagVer = String(rel.tag_name || '').replace(/^v/i, '');
  console.log('版本比较:', VERSION, 'vs', tagVer, '→', compareVer(parseVer(tagVer), parseVer(VERSION)) > 0 ? '有新版' : '已是最新');

  const picked = pickAsset(assets);
  console.log('pickAsset 选中:', picked ? picked.name : '(未选中)');
  const want = `bili-relation-manager-${VERSION}-portable.exe`;
  console.log(picked && picked.name === want ? '✓ 选中 correct portable' : '✗ 选中不对，期望 ' + want);

  const local = path.join(__dirname, '..', 'dist', `B站关注管理台-${VERSION}-便携版.exe`);
  if (fs.existsSync(local)) {
    const ls = fs.statSync(local).size;
    const rs = picked ? picked.size : -1;
    console.log('本地/线上字节:', ls, '/', rs, ls === rs ? '✓ 一致' : '✗ 不一致');
  }
  process.exit(picked && picked.name === want ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
