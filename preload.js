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

  login: () => invoke('account:login'),
  loginRefresh: () => invoke('account:loginRefresh'),
  loginCancel: () => invoke('account:loginCancel'),
  importCookie: (cookie) => invoke('account:importCookie', { cookie: String(cookie || '') }),
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
    delayMin: opts && opts.delayMin, delayMax: opts && opts.delayMax
  }),
  onUnfollowProgress: (cb) => subscribe('bus:unfollowProgress', cb),

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
