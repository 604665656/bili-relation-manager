'use strict';
/** 安全桥接：只暴露白名单方法，不暴露 ipcRenderer 本体 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, payload) => ipcRenderer.invoke(ch, payload);

const subscribe = (channel, cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  getState: () => invoke('app:state'),
  openDataDir: () => invoke('app:openDataDir'),
  openLogDir: () => invoke('app:openLogDir'),

  login: () => invoke('account:login'),
  loginRefresh: () => invoke('account:loginRefresh'),
  loginCancel: () => invoke('account:loginCancel'),
  importCookie: (cookie) => invoke('account:importCookie', { cookie: String(cookie || '') }),
  // 官方 passport API 扫码登录（应用内二维码，不依赖浏览器弹窗）
  qrStart: () => invoke('account:qrStart'),
  qrPoll: () => invoke('account:qrPoll'),
  qrCancel: () => invoke('account:qrCancel'),
  // refresh_token 免扫码续期
  refreshToken: (id) => invoke('account:refreshToken', { id: String(id || '') }),
  removeAccount: (id) => invoke('account:remove', { id: String(id || '') }),
  updateCfg: (id, cfg) => invoke('account:cfg', { id: String(id || ''), cfg: cfg && typeof cfg === 'object' ? cfg : {} }),
  refreshAccount: (id) => invoke('account:refresh', { id: String(id || '') }),

  updateGlobal: (g) => invoke('global:update', { g: g && typeof g === 'object' ? g : {} }),

  neverAdd: (uids) => invoke('never:add', { uids: String(uids || '') }),
  neverRemove: (uid) => invoke('never:remove', { uid: String(uid || '') }),
  neverClear: () => invoke('never:clear'),
  resetStats: (id) => invoke('account:resetStats', { id: String(id || '') }),
  refreshStats: () => invoke('app:refreshStats'),

  startTasks: (ids) => invoke('task:start', { ids: Array.isArray(ids) ? ids.map(String) : [] }),
  stopTasks: (ids) => invoke('task:stop', { ids: Array.isArray(ids) ? ids.map(String) : [] }),
  duty: (on) => invoke('task:duty', { on: !!on }),

  exportCsv: () => invoke('app:exportCsv'),

  unfollowerList: (id) => invoke('unfollower:list', { id: String(id || '') }),
  unfollowerMark: (id, mid, status) => invoke('unfollower:mark', { id: String(id || ''), mid: String(mid || ''), status: status === 'ignored' ? 'ignored' : 'blocked' }),
  unfollowerExport: (id) => invoke('unfollower:export', { id: String(id || '') }),

  // ── 批量取关（一键取关 + 筛选）──
  unfollowSearch: (id, keyword, maxPages) => invoke('unfollow:search', { id: String(id || ''), keyword: String(keyword || ''), maxPages }),
  unfollowLoadFollowings: (id, maxPages) => invoke('unfollow:loadFollowings', { id: String(id || ''), maxPages }),
  unfollowBatch: (id, items, opts) => invoke('unfollow:batch', {
    id: String(id || ''),
    items: Array.isArray(items) ? items : [],
    excludeMutual: opts && opts.excludeMutual !== false,
    excludeSpecial: opts && opts.excludeSpecial,
    previewOnly: opts && !!opts.previewOnly,
    sessionCap: opts && opts.sessionCap,
    skipRecentFollowDays: opts && opts.skipRecentFollowDays,
    delayMin: opts && opts.delayMin, delayMax: opts && opts.delayMax
  }),
  // P0-B 显式导出待操作备份
  unfollowExportBackup: (id, items) => invoke('unfollow:exportBackup', { id: String(id || ''), items: Array.isArray(items) ? items : [] }),
  // P1-D 文件同步：补关注 + 集合求差计划
  unfollowFollowBatch: (id, items, opts) => invoke('unfollow:followBatch', {
    id: String(id || ''),
    items: Array.isArray(items) ? items : [],
    delayMin: opts && opts.delayMin, delayMax: opts && opts.delayMax
  }),
  unfollowSyncPlan: (id, current, target) => invoke('unfollow:syncPlan', {
    id: String(id || ''),
    current: Array.isArray(current) ? current : [],
    target: Array.isArray(target) ? target : []
  }),
  onUnfollowProgress: (cb) => subscribe('bus:unfollowProgress', cb),
  unfollowEnrich: (id, mids, opts) => invoke('unfollow:enrich', {
    id: String(id || ''),
    mids: Array.isArray(mids) ? mids : [],
    gap: opts && opts.gap
  }),
  onUnfollowEnrich: (cb) => subscribe('bus:unfollowEnrich', cb),

  // 核对搜索结果的关注状态（网页式搜索得到的用户需逐个查关系位，才知道我关没关注 TA）
  unfollowResolveRelations: (id, mids) => invoke('unfollow:resolveRelations', {
    id: String(id || ''),
    mids: Array.isArray(mids) ? mids.map(String) : []
  }),

  updaterCheck: () => invoke('updater:check'),
  updaterInfo: () => invoke('updater:info'),
  updaterApply: () => invoke('updater:apply'),

  onLog: (cb) => subscribe('bus:log', cb),
  onRecord: (cb) => subscribe('bus:record', cb),
  onAccount: (cb) => subscribe('bus:account', cb),
  onStats: (cb) => subscribe('bus:stats', cb),
  onLive: (cb) => subscribe('bus:live', cb),
  onBusy: (cb) => subscribe('bus:busy', cb),
  onMenuOpenSupport: (cb) => subscribe('menu:openSupport', cb),
  onMenuCheckUpdate: (cb) => subscribe('menu:checkUpdate', cb),
  onUpdaterEvent: (cb) => subscribe('updater:event', cb)
});
