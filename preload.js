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

  onLog: (cb) => subscribe('bus:log', cb),
  onRecord: (cb) => subscribe('bus:record', cb),
  onAccount: (cb) => subscribe('bus:account', cb),
  onStats: (cb) => subscribe('bus:stats', cb),
  onLive: (cb) => subscribe('bus:live', cb),
  onBusy: (cb) => subscribe('bus:busy', cb),
  onMenuOpenSupport: (cb) => subscribe('menu:openSupport', cb)
});
