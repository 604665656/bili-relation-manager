'use strict';
/**
 * RB10：清理历史打包产物，只保留当前版本（默认需你本机终端直接运行，
 * 因为 WorkBuddy 的 safe-delete 守卫在会话内会拦截批量删除）。
 *
 *   node tools/clean-dist.js
 *
 * 删除内容：
 *   - 项目根下的 dist-v2 / dist-v3 …（开发历史快照目录）
 *   - dist/ 下与当前 package.json 版本号不一致的 *.exe / *.exe.blockmap
 *   - dist/latest.yml（本项目热更新走 GitHub API，不需要 electron-builder 的本地更新元数据）
 * 保留：dist/win-unpacked（重新打包会自动覆盖）、当前版本产物、sha256sums.txt
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;
const DIST = path.join(ROOT, 'dist');

let removed = 0, failed = 0;
function rm(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); removed++; return true; }
  catch (e) { failed++; console.log('  跳过（占用/无权限）: ' + p); return false; }
}

for (const name of fs.readdirSync(ROOT)) {
  if (/^dist-v\d+$/.test(name)) { rm(path.join(ROOT, name)); console.log('删除快照目录 ' + name); }
}

if (fs.existsSync(DIST)) {
  for (const f of fs.readdirSync(DIST)) {
    const p = path.join(DIST, f);
    if (f === 'latest.yml') { rm(p); console.log('删除 latest.yml'); continue; }
    if (!/\.exe(\.blockmap)?$/i.test(f)) continue;
    if (!f.includes(VERSION)) { rm(p); console.log('删除旧版本产物 ' + f); }
  }
}

console.log(`\n完成：删除 ${removed} 项，跳过 ${failed} 项（若旧版便携版仍在运行，请先退出后重跑）`);
