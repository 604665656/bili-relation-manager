'use strict';
/**
 * 热更新「下载 + 替换」真机验收（不碰当前进程里的 EXE）：
 *   1. 打桩成旧版本 → check() 找线上最新版
 *   2. 用 Electron net 流式下载便携版到临时目录，校验字节数与资产 size 一致
 *   3. 用与 _applySwap 相同的 cmd 机制，把「下载好的新版」覆盖到一个替身文件上
 *      （替身文件 + 已退出的假 PID，只验证 wait→move 逻辑，不重启、不动真 EXE）
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/test-update-apply.js
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FAKE = process.env.FAKE_VERSION || '2.1.9';
app.getVersion = () => FAKE;

const { Updater } = require('../src/updater');

app.whenReady().then(async () => {
  const u = new Updater();
  const info = await u.check();
  console.log('假版本:', FAKE, '→ 线上最新:', info.version, '| hasUpdate:', info.hasUpdate);
  if (!info.hasUpdate) { console.log('✗ 没发现新版，跳过'); app.exit(1); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brm-apply-'));
  const dest = path.join(tmp, 'new.exe');
  let lastPct = -1;
  const t0 = Date.now();
  const r = await u._download(info.asset.url, dest, (p) => {
    if (p.pct != null && p.pct !== lastPct && p.pct % 20 === 0) { lastPct = p.pct; process.stdout.write(' ' + p.pct + '%'); }
  });
  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  const diskSize = fs.statSync(dest).size;
  console.log('\n下载完成:', (diskSize / 1048576).toFixed(1) + 'MB', '耗时', cost + 's',
    '| 声明', (info.asset.size / 1048576).toFixed(1) + 'MB');
  console.log(diskSize === info.asset.size && diskSize === r.size ? '✓ 字节数与资产一致' : '✗ 字节数不一致');

  // 2. 替换机制验证（替身文件 + 已退出的 PID）
  const target = path.join(tmp, 'target.exe');
  fs.writeFileSync(target, 'OLD');
  const cmd = path.join(tmp, 'swap.cmd');
  fs.writeFileSync(cmd, [
    '@echo off',
    'setlocal',
    'set "TARGET=%~1"',
    'set "NEW=%~2"',
    'set "PID=%~3"',
    ':wait',
    'tasklist /nh /fi "pid eq %PID%" 2>nul | find "%PID%" >nul',
    'if %errorlevel%==0 (timeout /t 1 /nobreak >nul & goto wait)',
    'move /y "%NEW%" "%TARGET%" >nul',
    'exit'
  ].join('\r\n'), 'utf8');
  execFileSync('cmd', ['/c', cmd, target, dest, '999999'], { windowsHide: true, timeout: 20000 });
  const after = fs.statSync(target).size;
  console.log('替换后替身文件大小:', (after / 1048576).toFixed(1) + 'MB',
    after === info.asset.size ? '✓ move 覆盖成功' : '✗ 覆盖失败');
  console.log('新文件已被 move 走（临时目录不应再有 new.exe）:', !fs.existsSync(dest) ? '✓' : '✗');

  const ok = diskSize === info.asset.size && after === info.asset.size && !fs.existsSync(dest);
  console.log(ok ? '\n✓ 下载 + 替换全链路正常' : '\n✗ 链路异常');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  app.exit(ok ? 0 : 1);
});
