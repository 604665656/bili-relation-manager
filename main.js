'use strict';
/** Electron 主进程 */
const { app, BrowserWindow, ipcMain, session, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./src/store');
const { BiliClient } = require('./src/bilibili');
const { Engine, sourceLabel, accountsToAutoStart } = require('./src/task');
const { Updater } = require('./src/updater');

const IS_DEV = !app.isPackaged;
/** 构建标记：界面上会显示，便于确认运行的是哪一版 */
const BUILD_TAG = '2026-10-31 14:30 修复界面滚动/溢出（今日不截断·可拖动）';
let store, engine, mainWindow = null, loginWindow = null, updater = null;

/** 热更新节奏：启动后首查、之后定时复查、回到前台补查（都只为「别错过新版」） */
const UPDATE_FIRST_DELAY_MS = 6000;        // 启动后 6 秒静默首查
const UPDATE_RECHECK_MS = 2 * 3600000;     // 每 2 小时自动复查一次
const UPDATE_FOCUS_MIN_MS = 30 * 60000;    // 窗口重获焦点时，距上次检查超过 30 分钟才补查
let updateInfo = null;                     // 最近一次「发现有新版」的信息（供界面常驻提醒）
let lastCheckAt = 0;
let checkInFlight = null;

app.disableHardwareAcceleration();
app.setAppUserModelId && app.setAppUserModelId('com.local.bili.relation.manager');

/* GPU 进程在部分机器上会 FATAL 退出并带走整个应用（表现为「点登录没反应」），
   这里显式关闭 GPU 相关子系统；不要加 in-process-gpu，实测会导致加载页面卡死 */
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor,UseChromeOSDirectVideoDecoder');

app.on('child-process-gone', (_e, details) => {
  console.error('[child-process-gone]', details.type, details.reason);
});

/* ══════════════ 初始化 ══════════════ */
function init() {
  store = new Store(app.getPath('userData'));
  store.load();
  engine = new Engine(store);

  engine.on('log', (row) => { if (mainWindow) mainWindow.webContents.send('bus:log', row); });
  engine.on('record', (row) => { if (mainWindow) mainWindow.webContents.send('bus:record', row); });
  engine.on('account', (row) => { if (mainWindow) mainWindow.webContents.send('bus:account', row); });
  engine.on('stats', (row) => { if (mainWindow) mainWindow.webContents.send('bus:stats', row); });
  engine.on('stat', (row) => { if (mainWindow) mainWindow.webContents.send('bus:live', row); });

  startStatTimer();

  const originalStart = engine.startAll.bind(engine);
  engine.startAll = (ids) => {
    originalStart(ids);
    if (mainWindow) mainWindow.webContents.send('bus:busy', { busy: engine.isBusy() });
  };
}

/* ══════════════ 窗口 ══════════════ */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 1020,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1117',
    title: 'B站关注管理台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return mainWindow;
}

/* ══════════════ 登录窗口（每次独立会话，支持多账号逐个登录） ══════════════ */
let loginCtx = null;

/** 去掉 Electron 字样，伪装成常规 Chrome：B 站登录页对非浏览器 UA 会异常 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const LOGIN_URLS = [
  'https://www.bilibili.com',
  'https://bilibili.com',
  'https://passport.bilibili.com',
  'https://api.bilibili.com',
  'https://space.bilibili.com'
];

/** 合并多个域下的 cookie，避免只查一个域名漏掉凭证 */
async function readLoginCookies(ses) {
  const map = {};
  for (const url of LOGIN_URLS) {
    try {
      const list = await ses.cookies.get({ url });
      for (const c of list) if (c.value) map[c.name] = c.value;
    } catch (e) { /* 忽略单个域名失败 */ }
  }
  return map;
}

/** 把 cookie map 拼成请求头格式，只保留 bilibili 相关且必要的键 */
function buildCookieHeader(map) {
  const keys = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4', 'b_lsid'];
  const parts = keys.filter((k) => map[k]).map((k) => `${k}=${map[k]}`);
  return parts.join('; ');
}

function sendLog(level, msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('bus:log', { accountId: '', level, msg, ts: Date.now() });
    } catch (e) { /* ignore */ }
  }
}

function openLoginWindow() {
  // 残留窗口守卫：避免第二次点「登录」时只是 focus 一个已销毁窗口 → 表现为「没反应」
  if (loginWindow) {
    if (loginWindow.isDestroyed()) loginWindow = null;
    else { loginWindow.focus(); return Promise.resolve({ ok: false, reason: 'already' }); }
  }

  const partition = 'bili_login_' + Date.now();
  const ses = session.fromPartition(partition);

  loginWindow = new BrowserWindow({
    width: 520,
    height: 780,
    parent: mainWindow,
    title: '扫码登录 B 站',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  try { loginWindow.webContents.setUserAgent(BROWSER_UA); } catch (e) { /* ignore */ }

  // 加载失败要让用户看见，而不是静默
  loginWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    sendLog('error', `登录页加载失败（${code} ${desc}）${url}。请检查网络，或点「刷新登录页」重试`);
  });
  loginWindow.webContents.on('did-finish-load', () => {
    sendLog('info', '登录页已加载，请用手机 B 站 App 扫码。扫码后需在手机上点「确认登录」。');
  });

  const done = (result) => {
    if (loginCtx && !loginCtx.settled && loginCtx.resolve) {
      loginCtx.settled = true;
      loginCtx.resolve(result);
    }
  };

  loginCtx = { win: loginWindow, ses, resolve: null, timer: null, settled: false, ticks: 0 };

  const poll = async () => {
    try {
      if (!loginWindow || loginWindow.isDestroyed()) { clearInterval(loginCtx.timer); return; }
      loginCtx.ticks++;

      const map = await readLoginCookies(loginCtx.ses);
      const hasAll = !!(map.SESSDATA && map.bili_jct && map.DedeUserID);

      // 每 15 秒播报一次进度，避免用户以为卡死
      if (!hasAll && loginCtx.ticks % 19 === 0) {
        const got = Object.keys(map).filter((k) => /SESSDATA|bili_jct|DedeUserID/.test(k));
        sendLog('info', `等待扫码确认中…（已 ${Math.round(loginCtx.ticks * 0.8)}s，已获取凭证：${got.join('/') || '无'}）`);
        if (loginCtx.ticks * 800 > 180000) {
          sendLog('warn', '扫码超过 3 分钟仍无结果。请确认手机上点了「确认登录」；若一直无效，改用「手动导入 Cookie」');
        }
      }
      if (!hasAll) return;

      clearInterval(loginCtx.timer);
      const cookie = buildCookieHeader(map);
      sendLog('info', '检测到登录凭证，正在校验…');

      const client = new BiliClient(cookie);
      const nav = await client.nav();
      if (nav.code !== 0) {
        sendLog('warn', `登录校验未通过：${nav.message} (code=${nav.code})，继续等待…`);
        loginCtx.timer = setInterval(poll, 800);
        return;
      }

      const acc = store.upsertAccount({
        uid: client.profile.mid,
        uname: client.profile.uname,
        face: client.profile.face,
        cookie
      });
      store.flush();
      sendLog('ok', `登录成功：${client.profile.uname}（UID ${client.profile.mid}）`);
      done({ ok: true, account: publicAccount(acc) });
      try { loginWindow.close(); } catch (e) { /* ignore */ }
    } catch (e) {
      sendLog('warn', '登录轮询异常：' + (e && e.message || e));
    }
  };
  loginCtx.timer = setInterval(poll, 800);

  loginWindow.on('closed', () => {
    clearInterval(loginCtx && loginCtx.timer);
    loginWindow = null;
    done({ ok: false, reason: 'closed' });
  });

  loginWindow.loadURL('https://passport.bilibili.com/login');
  return new Promise((resolve) => { loginCtx.resolve = resolve; });
}

/* ══════════════ 关注/粉丝数定时刷新 ══════════════ */
let statTimer = null;

function startStatTimer() {
  if (statTimer) clearInterval(statTimer);
  const min = Number((store.get().global || {}).statIntervalMin) || 5;
  statTimer = setInterval(() => { refreshLiveStats(); }, Math.max(1, min) * 60000);
}

async function refreshLiveStats() {
  for (const a of store.listAccounts()) {
    const client = new BiliClient(a.cookie);
    try {
      const s = await client.stat(a.uid || client.mid);
      if (s.code !== 0) continue;
      const d = store.setLive(a.id, s.following, s.follower);
      if (mainWindow) {
        mainWindow.webContents.send('bus:live', { accountId: a.id, live: store.getAccount(a.id).live });
        mainWindow.webContents.send('bus:account', { id: a.id, state: engine.stateOf(a.id).state, live: store.getAccount(a.id).live });
      }
      if (d && (d.dFollowing || d.dFollower)) {
        const sign = (n) => (n > 0 ? '+' + n : String(n));
        store.addLog({ level: 'info', accountId: a.id, msg: `统计刷新｜关注 ${d.following}（${sign(d.dFollowing)}）｜粉丝 ${d.follower}（${sign(d.dFollower)}）` });
      }
    } catch (e) { /* 单账号失败不影响其他 */
    }
  }
  try { store.flush(); } catch (e) { /* ignore */ }
}

function publicAccount(a) {
  return {
    id: a.id, uid: a.uid, uname: a.uname, face: a.face,
    cfg: a.cfg, state: engine ? engine.stateOf(a.id).state : 'idle',
    stats: engine ? engine.stateOf(a.id).stats : null,
    live: a.live, followStats: a.followStats, daily: a.daily
  };
}

/* ══════════════ IPC ══════════════ */

/**
 * 统一异常兜底：任何一步抛错都要变成前端可见的错误，
 * 否则渲染层 await 直接 reject → 界面表现为「点了没反应」
 */
function safe(name, fn) {
  return async (_e, payload) => {
    try { return await fn(payload); }
    catch (e) {
      const msg = (e && e.message) || String(e);
      console.error(`[ipc:${name}]`, e);
      sendLog('error', `操作失败（${name}）：${msg}`);
      return { ok: false, error: msg };
    }
  };
}

function registerIPC() {
  ipcMain.handle('app:state', safe('app:state', () => ({
    accounts: store.listAccounts().map(publicAccount),
    global: store.get().global,
    logs: store.get().logs.slice(-200),
    busy: engine.isBusy(),
    writable: store.checkWritable(),
    storeError: store.lastError,
    version: app.getVersion(),
    build: BUILD_TAG
  })));

  ipcMain.handle('app:openDataDir', safe('app:openDataDir', () => {
    shell.openPath(store.dir);
    return true;
  }));

  ipcMain.handle('account:login', safe('account:login', async () => await openLoginWindow()));

  /* 手动导入 Cookie：扫码不通时的兜底方案 */
  ipcMain.handle('account:importCookie', safe('account:importCookie', async (p) => {
    const raw = String((p && p.cookie) || '').trim();
    if (!raw) return { ok: false, message: 'Cookie 为空' };

    const map = {};
    raw.split(';').forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0) map[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });

    // 也支持直接粘贴整段含换行的文本（例如从 DevTools 复制的多行内容）
    if (!map.SESSDATA || !map.bili_jct || !map.DedeUserID) {
      const m2 = {};
      raw.split(/[\r\n]+/).forEach((line) => {
        const parts = line.split(/\s+/);
        if (parts.length >= 2 && /^(SESSDATA|bili_jct|DedeUserID)$/i.test(parts[0])) {
          m2[parts[0]] = parts.slice(1).join(' ');
        }
      });
      Object.assign(map, m2);
    }

    if (!(map.SESSDATA && map.bili_jct && map.DedeUserID)) {
      return { ok: false, message: '缺少 SESSDATA / bili_jct / DedeUserID 中的某一项' };
    }

    const cookie = buildCookieHeader(map);
    const client = new BiliClient(cookie);
    let nav;
    try { nav = await client.nav(); }
    catch (e) { return { ok: false, message: '网络请求失败：' + e.message }; }
    if (nav.code !== 0) return { ok: false, message: `校验失败：${nav.message} (code=${nav.code})` };

    const acc = store.upsertAccount({
      uid: client.profile.mid, uname: client.profile.uname, face: client.profile.face, cookie
    });
    store.flush();
    sendLog('ok', `手动导入成功：${client.profile.uname}（UID ${client.profile.mid}）`);
    if (!store.flush()) {
      return { ok: false, message: `账号校验通过，但保存失败：${store.lastError}。请把程序放到有写权限的目录。` };
    }
    return { ok: true, account: publicAccount(acc) };
  }));

  ipcMain.handle('account:loginRefresh', safe('account:loginRefresh', () => {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.webContents.reload();
    return true;
  }));

  ipcMain.handle('account:loginCancel', safe('account:loginCancel', () => {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    return true;
  }));

  ipcMain.handle('account:remove', safe('account:remove', (p) => {
    if (!p || !p.id) return false;
    engine.stop([p.id]);
    store.removeAccount(p.id);
    return store.listAccounts().map(publicAccount);
  }));

  ipcMain.handle('account:cfg', safe('account:cfg', (p) => {
    if (!p || !p.id) return null;
    const a = store.updateAccountCfg(p.id, p.cfg);
    return a ? publicAccount(a) : null;
  }));

  ipcMain.handle('account:refresh', safe('account:refresh', async (p) => {
    const acc = p && p.id ? store.getAccount(p.id) : null;
    if (!acc) return null;
    const client = new BiliClient(acc.cookie);
    const nav = await client.nav();
    if (nav.code !== 0) return { ok: false, message: nav.message };
    const updated = store.upsertAccount({
      uid: acc.uid, uname: client.profile.uname, face: client.profile.face, cookie: acc.cookie
    });
    return { ok: true, account: publicAccount(updated), profile: client.profile };
  }));

  ipcMain.handle('global:update', safe('global:update', (p) => {
    const g = store.updateGlobal(p && p.g);
    startStatTimer();                 // 刷新间隔可能变了，重启定时器
    return { global: g };
  }));

  /* ── 不再关注名单 ── */
  ipcMain.handle('never:remove', safe('never:remove', (p) => ({
    neverFollow: store.removeNeverFollow(String((p && p.uid) || ''))
  })));
  ipcMain.handle('never:clear', safe('never:clear', () => ({ neverFollow: store.clearNeverFollow() })));
  ipcMain.handle('never:add', safe('never:add', (p) => {
    const list = String((p && p.uids) || '').split(/[\s,，;；\n]+/).filter(Boolean);
    return { neverFollow: store.addNeverFollow(list) };
  }));

  /* ── 统计 ── */
  ipcMain.handle('app:refreshStats', safe('app:refreshStats', async () => {
    await refreshLiveStats();
    return true;
  }));
  ipcMain.handle('account:resetStats', safe('account:resetStats', (p) => {
    const s = store.resetFollowStats(String((p && p.id) || ''));
    return { ok: !!s, followStats: s };
  }));

  ipcMain.handle('task:start', safe('task:start', (p) => {
    const ids = (p && Array.isArray(p.ids) ? p.ids : [])
      .map(String)
      .filter((id) => store.getAccount(id));
    engine.startAll(ids);
    return { started: ids, busy: engine.isBusy() };
  }));

  ipcMain.handle('task:stop', safe('task:stop', (p) => {
    const ids = p && Array.isArray(p.ids) ? p.ids.map(String) : null;
    if (ids === null) engine.stopAll(); else engine.stop(ids);
    return { busy: engine.isBusy() };
  }));

  ipcMain.handle('app:exportCsv', safe('app:exportCsv', async () => exportCsvNow()));

  // ── 热更新 ──
  ipcMain.handle('updater:check', safe('updater:check', () => runUpdateCheck({ manual: true })));
  ipcMain.handle('updater:info', safe('updater:info', () => updateInfo));
  ipcMain.handle('updater:apply', safe('updater:apply', async () => {
    if (!updater) return { ok: false, error: '更新模块未就绪' };
    return await updater.downloadAndApply();
  }));
}

/* ══════════════ 热更新：检查调度 ══════════════ */

/** 把更新事件转发给界面（窗口没起来时静默丢弃） */
function sendUpdater(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('updater:event', ev); } catch (e) { /* ignore */ }
  }
}

/**
 * 统一的检查入口：手动与自动共用，并做并发去重。
 * 有新版本 → 记入 updateInfo + 事件通知界面（界面弹窗并显示常驻「可更新」标记）；
 * 已最新 / 失败 → manual 时也回一次事件，让用户手动点「检查更新」总能拿到反馈。
 */
function runUpdateCheck(opts = {}) {
  if (checkInFlight) return checkInFlight;
  const manual = !!opts.manual;
  checkInFlight = (async () => {
    if (!updater) return { hasUpdate: false, error: '更新模块未就绪' };
    lastCheckAt = Date.now();
    let r;
    try { r = await updater.check(); }
    catch (e) { r = { hasUpdate: false, error: String((e && e.message) || e) }; }
    if (r && r.hasUpdate) {
      const fresh = !updateInfo || updateInfo.version !== r.version;
      updateInfo = { version: r.version, current: r.current, notes: r.notes, asset: r.asset, pageUrl: r.pageUrl };
      sendUpdater(Object.assign({ type: 'available' }, updateInfo));
      if (fresh) sendLog('ok', `发现新版本 v${r.version}（当前 v${r.current}），可在弹窗或顶部「可更新」处一键更新`);
    } else {
      updateInfo = null;
      sendUpdater({ type: 'none', manual, version: r && r.version, current: r && r.current, error: r && r.error });
      if (r && r.error) sendLog('warn', r.error);
    }
    return r;
  })().finally(() => { checkInFlight = null; });
  return checkInFlight;
}

/** 导出操作记录（IPC 与菜单共用） */
async function exportCsvNow() {
  const win = mainWindow;
  if (!win) return { ok: false };
  const res = await dialog.showSaveDialog(win, {
    title: '导出操作记录',
    defaultPath: path.join(app.getPath('downloads'), `bili_relation_${Date.now()}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    const csv = buildCsv();
    fs.writeFileSync(res.filePath, csv, 'utf8');
    sendLog('ok', `已导出 ${engineRecords.length} 条操作记录 → ${res.filePath}`);
    return { ok: true, path: res.filePath, rows: engineRecords.length };
  } catch (e) {
    sendLog('error', '导出失败：' + e.message);
    return { ok: false, error: e.message };
  }
}

/* ══════════════ 应用菜单（中文） ══════════════ */
function buildAppMenu() {
  const send = (ch) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch); };
  const reload = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); };
  const forceReload = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache(); };
  const devtools = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools(); };

  const template = [
    {
      label: '文件',
      submenu: [
        { label: '重新加载界面', accelerator: 'CmdOrCtrl+R', click: reload },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', click: forceReload },
        { type: 'separator' },
        { label: '导出操作记录（CSV）…', click: () => exportCsvNow() },
        { label: '打开数据目录', click: () => { try { shell.openPath(store.dir); } catch (e) { /* ignore */ } } },
        { label: '打开日志目录（按天存档）', click: () => { try { shell.openPath(path.join(store.dir, 'logs')); } catch (e) { /* ignore */ } } },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载界面', accelerator: 'CmdOrCtrl+R', click: reload },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', click: forceReload },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: devtools },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '切换全屏', accelerator: 'F11', role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', accelerator: 'CmdOrCtrl+W', role: 'close' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新…', click: () => send('menu:checkUpdate') },
        { label: '使用说明 / 风险提示', click: showHelpDialog },
        { label: '联系合作 / 打赏支持', click: () => send('menu:openSupport') },
        { type: 'separator' },
        { label: '打开项目主页（GitHub）', click: () => { try { shell.openExternal('https://github.com/604665656/bili-relation-manager'); } catch (e) { /* ignore */ } } },
        { type: 'separator' },
        { label: '关于 B站关注管理台', click: showAboutDialog }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showHelpDialog() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '使用说明 / 风险提示',
    message: '批量操作属自动化行为，可能被平台识别。',
    detail: '建议：单次 ≤ 50、操作间隔 ≥ 3 秒；出现 -509（请求频繁）或 -352（风控）立即停止并等待数小时。\n\n默认「演练模式」只列名单、不真正执行，确认无误后再关闭演练模式。\n\n所有账号凭证与数据只保存在你本机，不上传任何服务器。',
    buttons: ['知道了'],
    noLink: true
  });
}

function showAboutDialog() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于',
    message: 'B站关注管理台',
    detail: `版本 v${app.getVersion()}\n构建 ${BUILD_TAG}\n\n多账号并行 · 数据本地存储 · 完全免费\n\n项目主页：https://github.com/604665656/bili-relation-manager`,
    buttons: ['确定'],
    noLink: true
  });
}

function escapeCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
function buildCsv() {
  const lines = [['时间', '账号', '昵称', 'UID', '结果', '说明', '来源'].map(escapeCell).join(',')];
  for (const row of engineRecords) {
    lines.push([
      new Date(row.ts).toLocaleString('zh-CN'),
      row.accountName, row.uname, row.mid, row.result, row.detail,
      row.source ? sourceLabel(row.source) : ''
    ].map(escapeCell).join(','));
  }
  // 追加回关率统计区块
  lines.push('');
  lines.push(['=== 回关率统计 ==='].map(escapeCell).join(','));
  lines.push(['账号', '来源', '已关注', '已核验', '已回关', '回关率', '状态'].map(escapeCell).join(','));
  for (const a of store.listAccounts()) {
    const by = (a.followStats && a.followStats.bySource) || {};
    const keys = Object.keys(by);
    if (!keys.length) continue;
    for (const k of keys) {
      const b = by[k];
      const rate = b.sample ? Math.round((b.back / b.sample) * 100) + '%' : '样本不足';
      lines.push([
        a.uname, sourceLabel(k), b.tried, b.sample, b.back, rate, b.stopped ? '已停止（回关率过低）' : '正常'
      ].map(escapeCell).join(','));
    }
  }
  return '\uFEFF' + lines.join('\r\n');
}

// 记录由 engine 事件累积，供导出使用
const engineRecords = [];
const MAX_RECORDS = 5000;
function hookRecords() {
  engine.on('record', (row) => {
    const acc = store.getAccount(row.accountId);
    engineRecords.push(Object.assign({}, row, { accountName: acc ? acc.uname : '' }));
    if (engineRecords.length > MAX_RECORDS) engineRecords.splice(0, engineRecords.length - MAX_RECORDS);
  });
}

/* ══════════════ 生命周期 ══════════════ */
app.whenReady().then(async () => {
  init();
  registerIPC();
  hookRecords();
  buildAppMenu();   // 中文应用菜单（文件/编辑/视图/窗口/帮助）

  // 热更新：事件统一转发给渲染进程（available/progress/status/error/none）
  updater = new Updater({ onEvent: (ev) => sendUpdater(ev) });

  // 自检模式：不起界面，验证主进程各模块可正常装载（打包后可用 EXE --selftest 验证完整性）
  if (process.argv.includes('--selftest')) {
    const problems = [];
    const check = (name, fn) => { try { fn(); } catch (e) { problems.push(name + ': ' + e.message); } };
    check('store', () => { store.load(); store.listAccounts(); });
    check('engine', () => { if (!engine || typeof engine.startAll !== 'function') throw new Error('engine 未初始化'); });
    check('bilibili', () => { new BiliClient('SESSDATA=a; bili_jct=b; DedeUserID=1'); });
    check('updater', () => {
      if (typeof Updater !== 'function') throw new Error('Updater 未导出');
      if (typeof runUpdateCheck !== 'function') throw new Error('更新检查调度未定义');
      if (!(UPDATE_RECHECK_MS > 0)) throw new Error('复查间隔未配置');
      const core = require('./src/updater-core');
      if (core.compareVer('2.1.6', '2.1.7') >= 0) throw new Error('版本比较逻辑异常');
      if (!core.pickAsset([{ name: 'x-便携版.exe', size: 1 }])) throw new Error('资产挑选逻辑异常');
    });
    check('renderer资源', () => {
      fs.accessSync(path.join(__dirname, 'renderer', 'index.html'));
      fs.accessSync(path.join(__dirname, 'renderer', 'app.js'));
      fs.accessSync(path.join(__dirname, 'preload.js'));
    });
    const out = problems.length ? 'FAIL\n' + problems.join('\n') : 'OK';
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'selftest.txt'),
        new Date().toLocaleString('zh-CN') + '\n[selftest] ' + out + '\n', 'utf8');
    } catch (e) { /* ignore */ }
    console.log('[selftest] ' + out);
    app.quit(problems.length ? 1 : 0);
    return;
  }

  createMainWindow();

  // 热更新：启动 6 秒后静默首查，之后每 2 小时复查，窗口重获焦点时按 30 分钟节流补查。
  // 之前只在启动时查一次 —— 软件常开几天就永远发现不了新版，这里补上持续发现能力。
  // 发现新版只发事件：界面弹窗 + 顶部常驻「可更新 vX」标记；用户点「立即更新并重启」才下载替换。
  lastCheckAt = Date.now();
  setTimeout(() => { runUpdateCheck(); }, UPDATE_FIRST_DELAY_MS);
  const recheckTimer = setInterval(() => { runUpdateCheck(); }, UPDATE_RECHECK_MS);
  if (recheckTimer.unref) recheckTimer.unref();
  if (mainWindow) {
    mainWindow.on('focus', () => {
      if (Date.now() - lastCheckAt >= UPDATE_FOCUS_MIN_MS) runUpdateCheck();
    });
  }

  // 启动时自动恢复：若用户在全局设置中开启「启动时自动恢复任务」，
  // 则按上次配置自动启动「有任务且未禁用」的账号——软件第二天 / 崩溃重启后无需手动点「开始」。
  try {
    const autoIds = accountsToAutoStart(store);
    if (autoIds.length) {
      // 延迟 1.5s 启动，让主窗口先渲染出来，用户能看到状态
      setTimeout(() => {
        engine.startAll(autoIds);
        sendLog('info', `已按「启动时自动恢复任务」自动启动 ${autoIds.length} 个账号`);
      }, 1500);
    } else {
      sendLog('info', '未开启「启动时自动恢复任务」，本次启动不会自动运行任何账号');
    }
  } catch (e) {
    sendLog('error', '启动时自动恢复失败：' + (e && e.message || e));
  }

  // 定期落盘（日志高频产生，避免每条都重写文件）
  setInterval(() => { try { store.flush(); } catch (e) { /* ignore */ } }, 3000);
  app.on('before-quit', () => { try { store.flush(); } catch (e) { /* ignore */ } });

  // 开发者工具快捷键已由「视图」菜单提供（Ctrl+Shift+I），此处不再重复注册，避免双触发

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  engine && engine.stopAll();
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e);
});
