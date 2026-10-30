'use strict';
/**
 * 真实网络联调：用 Electron 主进程跑一遍「检查更新」全链路
 * （app.getVersion 被打桩成旧版本，验证线上最新版能被发现并挑对便携版资产）
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/test-update-check.js
 */
const { app } = require('electron');

const FAKE = process.env.FAKE_VERSION || '2.1.6';
app.getVersion = () => FAKE;

const { Updater } = require('../src/updater');

app.whenReady().then(async () => {
  const u = new Updater({ onEvent: (ev) => console.log('[event]', ev.type, JSON.stringify(ev).slice(0, 120)) });
  const t0 = Date.now();
  const r = await u.check();
  const cost = Date.now() - t0;
  console.log('假版本:', FAKE, '| 耗时:', cost + 'ms');
  console.log('hasUpdate:', r.hasUpdate, '| latest:', r.version, '| current:', r.current);
  if (r.error) console.log('error:', r.error);
  if (r.asset) console.log('asset:', r.asset.name, Math.round(r.asset.size / 1048576) + 'MB');

  const ok = !!(r.hasUpdate && r.asset && /portable/i.test(r.asset.name)
    && require('../src/updater-core').compareVer(r.version, FAKE) > 0);
  console.log(ok ? '✓ 全链路正常：能发现新版且挑中 portable' : '✗ 链路异常');
  app.exit(ok ? 0 : 1);
});
