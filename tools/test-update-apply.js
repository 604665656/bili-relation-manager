'use strict';
/**
 * 热更新「下载 + 替换」真机验收（不碰当前进程里的 EXE）：
 *   1. 打桩成旧版本 → check() 找线上最新版
 *   2. 用 Electron net 流式下载便携版到临时目录，校验字节数与资产 size 一致
 *   3. 用 cmd 的 move /y 把「下载好的新版」覆盖到一个替身文件上（不重启、不动真 EXE）
 *
 * 结果同时写到 %TEMP%\brm-apply-result.txt —— app.exit() 会丢弃管道里未刷出的 stdout。
 * 运行：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/test-update-apply.js
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FAKE = process.env.FAKE_VERSION || '2.1.9';
app.getVersion = () => FAKE;

const LOG = path.join(os.tmpdir(), 'brm-apply-result.txt');
const lines = [];
const say = (s) => {
  lines.push(s);
  try { fs.writeFileSync(LOG, lines.join('\n') + '\n', 'utf8'); } catch (e) { /* ignore */ }
};

const { Updater } = require('../src/updater');

const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

app.whenReady().then(async () => {
  try { fs.unlinkSync(LOG); } catch (e) { /* ignore */ }
  let ok = false;
  try {
    const u = new Updater();
    const info = await u.check();
    say(`假版本 ${FAKE} → 线上最新 ${info.version} | hasUpdate ${info.hasUpdate}`);
    if (!info.hasUpdate) { say('✗ 没发现新版'); app.exit(1); return; }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brm-apply-'));
    const dest = path.join(tmp, 'new.exe');
    const t0 = Date.now();
    const r = await u._download(info.asset.url, dest, null);
    const cost = ((Date.now() - t0) / 1000).toFixed(1);
    const diskSize = fs.statSync(dest).size;
    say(`下载完成 ${mb(diskSize)} 耗时 ${cost}s（声明 ${mb(info.asset.size)}）`);
    say(diskSize === info.asset.size && diskSize === r.size ? '✓ 字节数与资产一致' : '✗ 字节数不一致');

    if (process.env.SKIP_SWAP === '1') {
      say('（SKIP_SWAP=1，跳过替换验证）');
      ok = diskSize === info.asset.size;
    } else {
      const target = path.join(tmp, 'target.exe');
      fs.writeFileSync(target, 'OLD');
      const cmd = path.join(tmp, 'swap.cmd');
      fs.writeFileSync(cmd, [
        '@echo off',
        'setlocal',
        'set "TARGET=%~1"',
        'set "NEW=%~2"',
        'move /y "%NEW%" "%TARGET%" >nul',
        'exit'
      ].join('\r\n'), 'utf8');
      execFileSync('cmd', ['/c', cmd, target, dest], { windowsHide: true, timeout: 60000 });
      const after = fs.statSync(target).size;
      say(`替换后替身文件 ${mb(after)} → ` + (after === info.asset.size ? '✓ move 覆盖成功' : '✗ 覆盖失败'));
      say('新文件已被 move 走：' + (!fs.existsSync(dest) ? '✓' : '✗'));
      ok = diskSize === info.asset.size && after === info.asset.size && !fs.existsSync(dest);
    }
  } catch (e) {
    say('✗ 异常：' + ((e && e.message) || e));
  }
  say(ok ? '✓ 下载 + 替换全链路正常' : '✗ 链路异常');
  app.exit(ok ? 0 : 1);
});
