'use strict';
/**
 * 生成「静态界面预览」：把真实的 index.html / styles.css / app.js 拷出来，
 * 用一个假的 window.api 喂数据，方便用无头浏览器截图检查排版（不参与打包）。
 *
 * 用法：node tools/gen-preview.js <输出目录> <变体>
 *   变体：search | unfollow | ups | stats | record
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'shots', 'preview');
const VARIANT = process.argv[3] || 'search';

const baseCfg = {
  tasks: { unfollow: true, follow: true },
  sources: { fans: true, search: true, ups: false },
  searchKeywords: '手绘 板绘 互粉',
  searchMaxPages: 2, searchMaxFans: 5000, searchMinLevel: 1,
  delayMin: 3000, delayMax: 6000, maxOps: 30,
  dryRun: true, skipOfficial: true, skipSpecial: true,
  autoLoop: true, loopIntervalMin: 30, dailyCap: 80, errRetryMin: 5, watchdogStallMin: 15,
  onlyAfterDays: true, minFollowDays: 7, targetUps: ''
};
const cfgByVariant = {
  search: {},
  unfollow: { tasks: { unfollow: true, follow: false } },
  ups: { sources: { fans: false, search: false, ups: true }, targetUps: '123456 889900' },
  stats: {},
  record: {}
};

const ACC = {
  id: 'acc-1', uid: 1542633399, uname: '若辰-弹幕游戏', face: '', cookie: 'x', state: 'idle',
  cfg: Object.assign({}, baseCfg, cfgByVariant[VARIANT] || {}),
  live: { following: 1288, follower: 613, prevFollowing: 12, prevFollower: 5, at: Date.now() },
  followStats: {
    tried: 40, backed: 11, sample: 35,
    bySource: {
      self: { tried: 18, back: 7, sample: 16, stopped: false },
      'search:手绘': { tried: 12, back: 3, sample: 10, stopped: false },
      'search:板绘': { tried: 10, back: 1, sample: 9, stopped: true }
    },
    pendingVerify: [{ fid: 1 }, { fid: 2 }, { fid: 3 }]
  },
  daily: { date: '2026-10-21', ops: 23 },
  stats: { scanned: 96, dealt: 23, ok: 21, fail: 2, round: 1, phase: '关键词搜索' }
};
const ACC2 = Object.assign({}, ACC, {
  id: 'acc-2', uid: 99887766, uname: '许许许许许丶若辰', state: 'waiting',
  cfg: Object.assign({}, baseCfg, { dryRun: false, tasks: { unfollow: true, follow: false }, sources: { fans: true, search: false, ups: false } }),
  stats: { scanned: 40, dealt: 8, ok: 8, fail: 0, round: 2, countdown: 920 }
});

const STATE = {
  accounts: [ACC, ACC2],
  global: {
    whiteList: ['10003', '10004'], neverFollow: ['501', '502', '503', '504'],
    rateThreshold: 0.15, rateMinSample: 20, rateVerifyGapHours: 24, pageGap: 1200, statIntervalMin: 5,
    autoStartOnLaunch: true
  },
  logs: [
    ['info', 'acc-1', '第 1 轮开始｜清理单向关注 + 自动关注目标（我的粉丝 / 关键词搜索）｜延迟 3000~6000ms｜上限 30｜【演练模式】'],
    ['info', 'acc-1', '已补充设备指纹 buvid3（关键词搜索接口需要）'],
    ['info', 'acc-1', '—— 进入：我的粉丝（在粉丝列表里找还没互粉的人） ——'],
    ['ok', 'acc-1', '我的粉丝 结束｜扫描到已互粉 128 人｜本次回粉 18 人'],
    ['info', 'acc-1', '—— 进入：关键词搜索｜3 个关键词：手绘、板绘、互粉｜每个最多翻 2 页（每页 50 人） ——'],
    ['info', 'acc-1', '已载入关注列表 1000 人（最多读前 1000 条）'],
    ['warn', 'acc-1', '来源「搜索「板绘」」回关率 11%（1/9）低于 15%，已停止继续关注该来源'],
    ['ok', 'acc-1', '已关注 高漫手绘板 (401739957) 来源：搜索「手绘」'],
    ['info', 'acc-2', '第 2 轮结束，30 分钟后开始第 3 轮']
  ].map(([level, accountId, msg], i) => ({ level, accountId, msg, ts: Date.now() - (9 - i) * 50000 })),
  version: '2.1.6', build: '2026-10-25 11:00 关注上限保护',
  writable: { ok: true, dir: 'C:\\Users\\x\\AppData\\Roaming\\bili-relation-manager' }
};

const RECORDS = [
  { mid: 401739957, uname: '高漫手绘板', result: '已关注', detail: '来源：搜索「手绘」', source: 'search:手绘' },
  { mid: 12001, uname: '小明', result: '已回粉', detail: '', source: 'self' },
  { mid: 18001, uname: '画师A', result: '跳过', detail: '已关注过', source: 'search:原画' },
  { mid: 11001, uname: '单向号', result: '已取关', detail: '已加入不再关注名单', source: '' },
  { mid: 14002, uname: '大V', result: '跳过', detail: '粉丝 900000 超过上限', source: 'search:手绘' },
  { mid: 14005, uname: '老粉', result: '跳过', detail: '已是你的粉丝（回粉请在「我的粉丝列表」来源）', source: 'search:手绘' }
];

const MOCK = `'use strict';
const S = ${JSON.stringify(STATE)};
const RECS = ${JSON.stringify(RECORDS)};
const noop = () => () => {};
window.api = {
  getState: async () => JSON.parse(JSON.stringify(S)),
  openDataDir: async () => ({ ok: true }),
  login: async () => ({ ok: false }), loginRefresh: async () => ({}), loginCancel: async () => ({}),
  importCookie: async () => ({ ok: false }), removeAccount: async () => S.accounts,
  updateCfg: async () => ({ ok: true }), refreshAccount: async () => ({ ok: true }),
  updateGlobal: async () => ({ global: S.global }),
  neverAdd: async () => ({}), neverRemove: async () => ({}), neverClear: async () => ({ global: S.global }),
  resetStats: async () => ({ ok: true }), refreshStats: async () => ({ ok: true }),
  startTasks: async () => ({ ok: true }), stopTasks: async () => ({ ok: true }),
  exportCsv: async () => ({ ok: false }),
  onLog: noop,
  onRecord: (cb) => { setTimeout(() => RECS.forEach((r) => cb(Object.assign({ ts: Date.now(), accountId: 'acc-1' }, r))), 300); return noop(); },
  onAccount: noop, onStats: noop, onLive: noop, onBusy: noop
};
setTimeout(() => {
  const tab = ${JSON.stringify(VARIANT === 'stats' ? 'stat' : VARIANT === 'record' ? 'record' : 'log')};
  const el = document.querySelector('[data-tab="' + tab + '"]');
  if (el) el.click();
  ${VARIANT === 'support' ? "const sb = document.querySelector('#btn-support'); if (sb) sb.click();" : ''}
}, 200);
`;

fs.mkdirSync(OUT, { recursive: true });
let html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
html = html.replace('<script src="app.js"></script>',
  '<script src="mock-api.js"></script>\n  <script src="app.js"></script>');
fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');
fs.copyFileSync(path.join(ROOT, 'renderer', 'styles.css'), path.join(OUT, 'styles.css'));
fs.copyFileSync(path.join(ROOT, 'renderer', 'app.js'), path.join(OUT, 'app.js'));
// 拷贝 assets（打赏/合作二维码），否则预览里图片 404
const assetsSrc = path.join(ROOT, 'renderer', 'assets');
if (fs.existsSync(assetsSrc)) {
  const dstAssets = path.join(OUT, 'assets');
  fs.mkdirSync(dstAssets, { recursive: true });
  for (const f of fs.readdirSync(assetsSrc)) fs.copyFileSync(path.join(assetsSrc, f), path.join(dstAssets, f));
}
fs.writeFileSync(path.join(OUT, 'mock-api.js'), MOCK, 'utf8');
console.log('预览已生成：' + OUT + '（变体 ' + VARIANT + '）');
console.log('记录条数用于「操作明细」页：' + RECORDS.length);
