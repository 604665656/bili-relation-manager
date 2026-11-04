'use strict';
/** Electron 主进程 */
const { app, BrowserWindow, ipcMain, session, dialog, shell, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./src/store');
const { BiliClient, sleep } = require('./src/bilibili');
const auth = require('./src/auth');
const { Engine, sourceLabel, accountsToAutoStart } = require('./src/task');
const { Updater } = require('./src/updater');
const { canUnfollow, classifyActivity, classifySegment, diffFollowLists } = require('./src/batch-unfollow');
const platforms = require('./src/platforms');
const { BilibiliAdapter } = require('./src/platforms/bilibili-adapter');
// P2-G：注册平台适配器（当前仅 B 站；微博/抖音/小红书为合规敏感预留挂载点，不在此接入）
platforms.registerAdapter('bilibili', (cookie) => new BilibiliAdapter(cookie));

/** 数值范围钳制（main 内多处复用，统一放这里） */
function clampNum(v, lo, hi, dft) {
  const n = Number(v);
  if (Number.isNaN(n)) return dft;
  return Math.min(hi, Math.max(lo, n));
}

const IS_DEV = !app.isPackaged;
/** 构建标记：界面上会显示，便于确认运行的是哪一版 */
const BUILD_TAG = '2026-11-04 修复二维码登录 405（generate/poll 改 GET）· 账号卡「续期」点击不再误触重渲染 v2.4.1';
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

/* RB11：单实例锁——防止「安装版 + 旧便携版」两个进程同时全量写同一 data.json（最后写者胜、丢更新）。
   拿不到锁说明已有实例在跑，直接退出并聚焦已有窗口。 */
let hasSingleLock = true;
try { hasSingleLock = app.requestSingleInstanceLock(); } catch (e) { hasSingleLock = true; }
if (!hasSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      try { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } catch (e) { /* ignore */ }
    }
  });
}

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
/**
 * RB2：cookie 落盘加密（Windows DPAPI 经 Electron safeStorage）。
 * 内存中始终明文供请求使用，flush 时加密、load 时解密；旧版明文无前缀 → 原样返回，平滑迁移。
 */
const COOKIE_PREFIX = 'enc1:';
function makeCookieCodec() {
  return {
    encrypt(plain) {
      const s = String(plain || '');
      if (!s) return s;
      try {
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
          return COOKIE_PREFIX + safeStorage.encryptString(s).toString('base64');
        }
      } catch (e) { /* 降级明文 */ }
      return s;
    },
    decrypt(stored) {
      const s = String(stored || '');
      if (!s.startsWith(COOKIE_PREFIX)) return s;
      try { return safeStorage.decryptString(Buffer.from(s.slice(COOKIE_PREFIX.length), 'base64')); }
      catch (e) { return ''; }
    }
  };
}

function init() {
  store = new Store(app.getPath('userData'), { codec: makeCookieCodec() });
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
    // RB4：清理本次登录用的临时 partition 存储，避免每次扫码累积磁盘占用
    try { ses.clearStorageData().catch(() => {}); } catch (e) { /* ignore */ }
    try { ses.clearCache().catch(() => {}); } catch (e) { /* ignore */ }
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
        mainWindow.webContents.send('bus:live', { accountId: a.id, live: store.getAccount(a.id).live, followerLog: store.getAccount(a.id).followerLog || {} });
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
    live: a.live, followStats: a.followStats, daily: a.daily, followerLog: a.followerLog || {},
    unfollowers: a.unfollowers || []
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
    records: store.listRecords(500),   // RB3：重启后界面仍能看到历史明细
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

  /* ── 官方 passport API 扫码登录（不依赖 Electron cookie 罐，打包后更稳，且能拿到 refresh_token）── */
  let qrState = null;   // { qrcodeKey, lastPoll }

  ipcMain.handle('account:qrStart', safe('account:qrStart', async () => {
    const g = await auth.generateQr();
    if (!g.ok) return { ok: false, message: g.message };
    qrState = { qrcodeKey: g.qrcodeKey, url: g.url, lastPoll: 0 };
    return { ok: true, qrcodeKey: g.qrcodeKey, url: g.url, dataUrl: g.dataUrl };
  }));

  /**
   * 轮询当前二维码状态。渲染层每隔 1.5s 调一次。
   * 成功（status=success）时自动落库账号并持久化 refreshToken。
   */
  ipcMain.handle('account:qrPoll', safe('account:qrPoll', async () => {
    if (!qrState || !qrState.qrcodeKey) return { status: 'idle' };
    const now = Date.now();
    if (now - qrState.lastPoll < 1000) return { status: 'throttled' };
    qrState.lastPoll = now;
    const r = await auth.pollQr(qrState.qrcodeKey);
    if (r.status !== 'success') {
      return { status: r.status, message: r.message || '' };
    }
    // 校验 + 落库
    const client = new BiliClient(r.cookie);
    const nav = await client.nav();
    if (nav.code !== 0) {
      return { status: 'error', message: `登录校验未通过：${nav.message} (code=${nav.code})` };
    }
    const acc = store.upsertAccount({
      uid: client.profile.mid, uname: client.profile.uname, face: client.profile.face,
      cookie: r.cookie, refreshToken: r.refreshToken || ''
    });
    store.flush();
    sendLog('ok', `二维码扫码登录成功：${client.profile.uname}（UID ${client.profile.mid}）`);
    qrState = null;
    return { status: 'success', account: publicAccount(acc) };
  }));

  /** 取消当前二维码登录（重新生成前调用） */
  ipcMain.handle('account:qrCancel', safe('account:qrCancel', () => {
    qrState = null;
    return true;
  }));

  /**
   * 用 refresh_token 尝试免扫码续期某个账号（启动自动恢复 + 手动「续期」按钮共用）。
   * 成功后更新 cookie/refreshToken；失败返回原因，调用方退回扫码/导入。
   */
  ipcMain.handle('account:refreshToken', safe('account:refreshToken', async (p) => {
    const acc = p && p.id ? store.getAccount(p.id) : null;
    if (!acc) return { ok: false, message: '账号不存在' };
    if (!acc.refreshToken) return { ok: false, message: '该账号没有 refreshToken（多为手动导入 Cookie 登录，无法自动续期；请改用扫码登录）' };
    const res = await auth.refreshCookie({ cookie: acc.cookie, refreshToken: acc.refreshToken });
    if (!res.ok) return { ok: false, message: res.message || '续期失败', step: res.step };
    // 重新校验
    const client = new BiliClient(res.cookie);
    const nav = await client.nav().catch(() => null);
    if (!nav || nav.code !== 0) {
      return { ok: false, message: '续期已返回新 cookie，但校验未通过，请重新扫码', step: 'verify' };
    }
    acc.cookie = res.cookie;
    acc.refreshToken = res.refreshToken || acc.refreshToken;
    acc.uid = client.profile.mid;
    acc.uname = client.profile.uname;
    acc.face = client.profile.face;
    store.flush();
    sendLog('ok', `refresh_token 续期成功：${client.profile.uname}（UID ${client.profile.mid}）`);
    return { ok: true, account: publicAccount(acc) };
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
    if (updater) updater.setMirror(g.updateMirror || 'auto');  // 热更新镜像随全局设置实时生效
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

  /* ── 取关我的名单 ── */
  ipcMain.handle('unfollower:list', safe('unfollower:list', (p) => ({
    list: store.listUnfollowers(String((p && p.id) || ''))
  })));
  ipcMain.handle('unfollower:mark', safe('unfollower:mark', (p) => {
    const status = (p && p.status) === 'ignored' ? 'ignored' : 'blocked';
    const r = store.markUnfollower(String((p && p.id) || ''), String((p && p.mid) || ''), status);
    return { ok: !!r, neverFollow: store.get().global.neverFollow };
  }));
  ipcMain.handle('unfollower:export', safe('unfollower:export', (p) => exportUnfollowersCsv((p && p.id) || '')));

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

  /* ── 批量取关（一键取关 + 筛选）── */
  // 搜索接口偶发 -412 限流，退避重试（与 task.js 内逻辑一致）
  async function searchWithRetryMain(client, kw, pn, accId) {
    let last = null;
    for (let i = 0; i < 3; i++) {
      const j = await client.searchUsers(kw, pn, 50);
      if (j.code === 0) return j;
      last = j;
      if (j.code === -412 || j.code === -509 || j.code === -799) {
        if (j.code === -412) await client.ensureBuvid();
        const wait = 5000 * Math.pow(2, i);
        sendLog('warn', `批量取关搜索被限流（${j.message}），${Math.round(wait / 1000)}s 后重试第 ${i + 1}/3 次`);
        await sleep(wait);
        continue;
      }
      return j;
    }
    return last || { code: -1, message: '搜索失败', list: [] };
  }
  function sendUnfollowProgress(payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('bus:unfollowProgress', payload); } catch (e) { /* ignore */ }
    }
  }
  function sendUnfollowEnrich(payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('bus:unfollowEnrich', payload); } catch (e) { /* ignore */ }
    }
  }

  /** 关键字搜索：返回带 粉丝数 + 关系位 的用户列表（批量取关的筛选数据源之一） */
  ipcMain.handle('unfollow:search', safe('unfollow:search', async (p) => {
    const id = String((p && p.id) || '');
    const acc = store.getAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };
    const keyword = String((p && p.keyword) || '').trim();
    if (!keyword) return { ok: false, error: '关键词为空' };
    const client = new BiliClient(acc.cookie);
    if (!client.isLoggedCookie) return { ok: false, error: 'Cookie 不完整，请重新登录' };
    // 搜索是公开接口，nav 仅用于辅助判断登录态；nav 失败（如 -101 过期）不再阻断搜索——
    // 搜索结果仍可正常返回，仅「取关」需有效登录，通过 authNote 提示用户重新登录。
    let authNote = '';
    try {
      const nav = await client.nav();
      if (!nav || nav.code !== 0) {
        authNote = '登录态已失效（nav=' + (nav ? nav.code : 'null') + '），搜索结果可正常查看，但「取关」需要有效登录（请点账号的「刷新资料 / 扫码登录」后重试）';
      }
    } catch (e) {
      authNote = '无法校验登录态（' + ((e && e.message) || e) + '），搜索仍可尝试；取关需有效登录';
    }
    const maxPages = clampNum((p && p.maxPages) || 3, 1, 20);
    const list = [];
    let lastErr = null;
    for (let pn = 1; pn <= maxPages; pn++) {
      const j = await searchWithRetryMain(client, keyword, pn, id);
      if (!j || j.code !== 0) {
        lastErr = (j && j.message) || '搜索失败';
        // 首屏就失败：直接返回错误（含登录提示），不再静默返回空列表让界面误判为「无结果」
        if (pn === 1) return { ok: false, error: (lastErr + (authNote ? '；' + authNote : '')), list: [] };
        // 中途某页失败：保留已采集部分并提示，避免丢失前几页数据
        return { ok: true, list, total: list.length, warning: `第 ${pn} 页起请求失败（${lastErr}），已展示前 ${list.length} 条`, authNote: authNote || undefined };
      }
      for (const it of (j.list || [])) {
        list.push({
          mid: String(it.mid), uname: it.uname || '',
          fans: Number(it.fans) || 0,
          attribute: (typeof it.attribute === 'number') ? it.attribute : null
        });
      }
      if (!((j.list || []).length)) break;
      if (pn < maxPages) await sleep(store.get().global.pageGap || 1200);
    }
    return { ok: true, list, total: list.length, authNote: authNote || undefined };
  }));

  /** 载入「我的关注列表」：用于无关键字排查「我关注但 TA 未回关」的人 */
  ipcMain.handle('unfollow:loadFollowings', safe('unfollow:loadFollowings', async (p) => {
    const id = String((p && p.id) || '');
    const acc = store.getAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };
    const client = new BiliClient(acc.cookie);
    if (!client.isLoggedCookie) return { ok: false, error: 'Cookie 不完整，请重新登录' };
    const nav = await client.nav();
    if (nav.code !== 0) {
      const hint = nav.code === -101 ? '请重新登录（点账号的「刷新资料 / 扫码登录」）' : (nav.message || '');
      return { ok: false, error: '登录态失效（nav=' + nav.code + '）：' + hint };
    }
    // 关注列表接口无 1000 硬上限，但为防一次载入过多、且粉丝数区间筛选在关注模式不可用，
    // 这里最多读 20 页（1000 条），与「取关名单」监控口径一致，覆盖绝大多数账号
    const maxPages = clampNum((p && p.maxPages) || 20, 1, 20);
    const list = [];
    let pn = 1, total = Infinity, lastErr = null;
    while (pn <= maxPages && (pn - 1) * 50 < total) {
      const j = await client.followings(pn, 50, client.mid, '');
      if (!j || j.code !== 0) {
        lastErr = (j && j.message) || '载入关注失败';
        // 首屏就失败：直接返回错误，不再静默返回空列表让界面误判为「无结果」
        if (pn === 1) return { ok: false, error: lastErr, list: [] };
        // 中途某页失败：保留已采集部分并提示，避免丢失前几页数据
        return { ok: true, list, total: list.length, warning: `第 ${pn} 页起请求失败（${lastErr}），已展示前 ${list.length} 条` };
      }
      if (typeof j.data.total === 'number') total = j.data.total;
      for (const it of (j.data.list || [])) {
        const mtime = (typeof it.mtime === 'number') ? it.mtime : null;
        list.push({
          mid: String(it.mid), uname: it.uname || '',
          face: (it.face) ? String(it.face) : null,
          sign: (it.sign) ? String(it.sign) : null,
          fans: (typeof it.fans === 'number') ? it.fans : null,
          attribute: (typeof it.attribute === 'number') ? it.attribute : null,
          // P0-C：关注天数（来自接口 mtime），用于「最近关注 N 天豁免取关」；null=未知
          followDays: mtime ? Math.max(0, Math.floor((Date.now() / 1000 - mtime) / 86400)) : null
        });
      }
      if (!((j.data.list || []).length)) break;
      pn++;
      if (pn <= maxPages) await sleep(store.get().global.pageGap || 1200);
    }
    return { ok: true, list, total: typeof total === 'number' ? total : list.length };
  }));

  /**
   * 核对关注状态：网页式搜索得到的用户，搜索接口本身不返回 attribute（关注关系位），
   * 需逐个查 /x/relation 才能知道「我到底关没关注 TA」。本接口批量填充后返回 mid→attribute 映射，
   * 供界面标出「已关注 / 未关注」，从而只取关真正关注的账号。需有效登录。
   */
  ipcMain.handle('unfollow:resolveRelations', safe('unfollow:resolveRelations', async (p) => {
    const id = String((p && p.id) || '');
    const acc = store.getAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };
    const mids = Array.isArray(p && p.mids) ? p.mids.map(String).filter(Boolean) : [];
    if (!mids.length) return { ok: false, error: '名单为空' };
    const client = new BiliClient(acc.cookie);
    if (!client.isLoggedCookie) return { ok: false, error: 'Cookie 不完整，请重新登录' };
    const nav = await client.nav();
    if (nav.code !== 0) {
      const hint = nav.code === -101 ? '请重新登录（点账号的「刷新资料 / 扫码登录」）' : (nav.message || '');
      return { ok: false, error: '登录态失效（nav=' + nav.code + '）：' + hint };
    }
    const map = {};
    let lastErr = null, okCount = 0;
    for (let i = 0; i < mids.length; i++) {
      const mid = mids[i];
      try {
        const attr = await client.relation(mid);
        map[mid] = (typeof attr === 'number') ? attr : null;
        if (map[mid] !== null) okCount++;
      } catch (e) { map[mid] = null; lastErr = (e && e.message) || String(e); }
      if (i < mids.length - 1) await sleep(store.get().global.pageGap || 1200);
    }
    return { ok: true, map, resolved: okCount, total: mids.length, warning: lastErr ? ('部分请求失败：' + lastErr) : undefined };
  }));

  /**
   * 一键批量取关：在主进程执行真实写操作（act=2），带节流 / 看门狗 / 每日上限 / 安全护栏。
   * 逐条进度通过 bus:unfollowProgress 推给界面；最终返回汇总。
   */
  ipcMain.handle('unfollow:batch', safe('unfollow:batch', async (p) => {
    const id = String((p && p.id) || '');
    const acc = store.getAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };
    const items = Array.isArray(p && p.items) ? p.items : [];
    if (!items.length) return { ok: false, error: '取关名单为空' };
    const client = new BiliClient(acc.cookie);
    if (!client.isLoggedCookie) return { ok: false, error: 'Cookie 不完整，请重新登录' };
    const nav = await client.nav();
    if (nav.code !== 0) {
      const hint = nav.code === -101 ? '请重新登录（点账号的「刷新资料 / 扫码登录」）' : (nav.message || '');
      return { ok: false, error: '登录态失效（nav=' + nav.code + '）：' + hint };
    }

    const g = store.get().global;
    const o = p || {};
    const previewOnly = !!o.previewOnly;                       // P1-E Demo/预览：只算计划不落地
    const sessionCap = clampNum(o.sessionCap || acc.cfg.sessionCap || 0, 0, 100000);
    const skipRecentDays = clampNum(o.skipRecentFollowDays || acc.cfg.skipRecentFollowDays || 0, 0, 100000);
    const autoMutual = o.excludeMutual !== false;              // 默认保护互关
    const autoSpecial = (o.excludeSpecial !== false) && (acc.cfg.autoWhitelistSpecial !== false);
    const needBackup = (acc.cfg.backupBeforeUnfollow !== false) && !previewOnly; // P0-B 强制备份闸门

    let working = items;
    if (sessionCap > 0 && working.length > sessionCap) {
      working = working.slice(0, sessionCap);
      sendLog('warn', `单次批量取关会话上限 ${sessionCap}，超出部分（${items.length - sessionCap}）留待下一轮`);
    }

    const excl = {
      white: new Set((g.whiteList || []).map(String)),
      neverFollow: new Set((g.neverFollow || []).map(String)),
      dead: (store._deadSet) || new Set((g.deadUsers || []).map(String)),
      mutual: autoMutual
    };
    const delayMin = clampNum(o.delayMin || acc.cfg.delayMin || 3000, 1000, 600000);
    const delayMax = Math.max(delayMin, clampNum(o.delayMax || acc.cfg.delayMax || 6000, 1000, 600000));
    const dailyCap = Number(acc.cfg.dailyCap) || 0;

    let done = 0, ok = 0, fail = 0, skip = 0;
    const total = working.length;
    const startAt = Date.now();
    const WATCHDOG_MS = 20 * 60000;   // 单批总耗时保险：超过 20 分钟视为异常，停止以免卡死
    const plan = [];                  // P0-B 具名确认：记录每个将操作账号与命中原因

    // P0-B 四段式闸门：执行真实取关前，先强制把待操作名单导出为本地 CSV 备份
    let backupPath = null;
    if (needBackup) {
      try { backupPath = writeUnfollowBackup(acc, working); }
      catch (e) { sendLog('error', '待操作名单备份失败：' + ((e && e.message) || e)); }
    }

    if (previewOnly) {
      // P1-E：预览模式——逐条计算「会怎么处理」但不发任何写请求
      for (const it of working) {
        const reason = _batchSkipReason(it, excl, { skipRecentDays, autoSpecial });
        if (reason) { skip++; plan.push({ mid: String(it.mid), uname: it.uname || '', result: '跳过', reason }); }
        else {
          ok++; // 预览里「将取关」计为将操作数
          plan.push({ mid: String(it.mid), uname: it.uname || '', result: '将取关', reason: it.segmentLabel || (it.segment ? ('分段:' + it.segment) : '符合筛选') });
        }
      }
      sendUnfollowProgress({ type: 'done', total, done: total, ok: plan.filter((x) => x.result === '将取关').length, fail: 0, skip: plan.filter((x) => x.result === '跳过').length, preview: true, backupPath });
      return { ok: true, preview: true, total, plan, backupPath, willUnfollow: plan.filter((x) => x.result === '将取关').length };
    }

    sendUnfollowProgress({ type: 'start', total });
    for (const it of working) {
      if (Date.now() - startAt > WATCHDOG_MS) {
        sendLog('error', `批量取关单批耗时超过 ${WATCHDOG_MS / 60000} 分钟，已停止以防卡死`);
        break;
      }
      if (dailyCap > 0 && store.getAccount(id).daily.ops >= dailyCap) {
        sendLog('warn', '批量取关：已达每日操作上限，停止');
        break;
      }
      // P0-C：最近关注 N 天豁免；P0-C：特别关注自动白名单
      const sReason = _batchSkipReason(it, excl, { skipRecentDays, autoSpecial });
      if (sReason) {
        skip++; done++;
        plan.push({ mid: String(it.mid), uname: it.uname || '', result: '跳过', reason: sReason });
        sendUnfollowProgress({ type: 'item', mid: String(it.mid), uname: it.uname || '', result: '跳过', detail: sReason, done, total, ok, fail, skip });
        continue;
      }
      const chk = canUnfollow(it, excl);
      if (!chk.ok) {
        skip++; done++;
        plan.push({ mid: String(it.mid), uname: it.uname || '', result: '跳过', reason: chk.reason });
        sendUnfollowProgress({ type: 'item', mid: String(it.mid), uname: it.uname || '', result: '跳过', detail: chk.reason, done, total, ok, fail, skip });
        continue;
      }
      plan.push({ mid: String(it.mid), uname: it.uname || '', result: '将取关', reason: it.segmentLabel || '符合筛选' });
      let r;
      try { r = await client.modify(Number(it.mid), 2); }
      catch (e) { r = { ok: false, code: -9999, message: (e && e.message) || String(e), kind: 'fatal' }; }
      if (r.ok) {
        ok++; done++;
        store.addNeverFollow(String(it.mid));   // 取关后进入「不再关注」名单
        store.bumpDaily(id, 1);
        sendLog('ok', `已取关 ${it.uname || it.mid} (${it.mid})｜已加入不再关注名单`);
        sendUnfollowProgress({ type: 'item', mid: String(it.mid), uname: it.uname || '', result: '已取关', detail: '已加入不再关注名单', done, total, ok, fail, skip });
      } else {
        fail++; done++;
        sendLog('error', `批量取关失败 ${it.uname || it.mid}：${r.message || ('code=' + r.code)}`);
        sendUnfollowProgress({ type: 'item', mid: String(it.mid), uname: it.uname || '', result: '失败', detail: r.message || ('code=' + r.code), done, total, ok, fail, skip });
        if (r.kind === 'fatal') { sendLog('error', '批量取关遇到致命错误码，已停止'); break; }
        if (r.kind === 'ratelimit') { sendLog('warn', '触发限流，暂停 60s 后继续'); await sleep(60000); }
      }
      const wait = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
      await sleep(wait);
    }
    try { store.flush(); } catch (e) { /* ignore */ }
    sendUnfollowProgress({ type: 'done', total, done, ok, fail, skip, backupPath });
    return { ok: true, total, done, okCount: ok, fail, skip, backupPath };
  }));

  /**
   * 批量取关的「跳过原因」统一判定（P0-C）：
   *   1) 特别关注自动白名单（attribute 第 1 位 = 特别关注）
   *   2) 最近关注 N 天豁免（it.followDays 来自关注列表 mtime，null=未知则不放行）
   * @returns {string|null} 返回原因字符串表示跳过；null 表示可继续
   */
  function _batchSkipReason(it, excl, opts) {
    const attr = (typeof it.attribute === 'number') ? it.attribute : null;
    if (opts.autoSpecial && attr !== null && (attr & 1)) return '特别关注（已保护）';
    if (opts.skipRecentDays > 0 && it.followDays != null) {
      if (Number(it.followDays) <= opts.skipRecentDays) return `最近关注 ${it.followDays} 天（≤${opts.skipRecentDays}天豁免）`;
    }
    return null;
  }

  /** P0-B 四段式闸门：把待操作名单导出为本地 CSV 备份（防误删，可回溯） */
  function writeUnfollowBackup(acc, items) {
    const dir = path.join(store.dir, 'backups');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `unfollow_backup_${acc.uname || acc.uid}_${stamp}.csv`);
    const rows = [['mid', 'uname', 'segment']];
    for (const it of (items || [])) rows.push([String(it.mid), (it.uname || '').replace(/"/g, '""'), it.segment || '']);
    const csv = rows.map((r) => r.map((c) => /[",\n]/.test(c) ? '"' + c + '"' : c).join(',')).join('\n');
    fs.writeFileSync(file, '﻿' + csv, 'utf8');   // BOM 便于 Excel 正确识别 UTF-8
    return file;
  }

  /** 显式导出待操作备份（UI 按钮调用，复用四段式备份逻辑） */
  ipcMain.handle('unfollow:exportBackup', safe('unfollow:exportBackup', async (p) => {
    const id = String((p && p.id) || '');
    const acc = store.getAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };
    const items = Array.isArray(p && p.items) ? p.items : [];
    if (!items.length) return { ok: false, error: '名单为空' };
    try { return { ok: true, path: writeUnfollowBackup(acc, items) }; }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }));

  /**
   * 手动批量关注（P1-D 文件同步「补关注」所需）：在主进程执行真实写操作（act=1）。
   * 与 unfollow:batch 对称，带节流 / 每日上限 / 安全护栏。
   */
  ipcMain.handle('unfollow:followBatch', safe('unfollow:followBatch', async (p) => {
    const id = String((p && p.id) || '');
    const acc = store.getAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };
    const items = Array.isArray(p && p.items) ? p.items : [];
    if (!items.length) return { ok: false, error: '关注名单为空' };
    const client = new BiliClient(acc.cookie);
    if (!client.isLoggedCookie) return { ok: false, error: 'Cookie 不完整，请重新登录' };
    const nav = await client.nav();
    if (nav.code !== 0) return { ok: false, error: '登录态失效（nav=' + nav.code + '）' };
    const g = store.get().global;
    const excl = {
      white: new Set((g.whiteList || []).map(String)),
      neverFollow: new Set((g.neverFollow || []).map(String)),
      dead: (store._deadSet) || new Set((g.deadUsers || []).map(String))
    };
    const delayMin = clampNum((p && p.delayMin) || acc.cfg.delayMin || 3000, 1000, 600000);
    const delayMax = Math.max(delayMin, clampNum((p && p.delayMax) || acc.cfg.delayMax || 6000, 1000, 600000));
    const dailyCap = Number(acc.cfg.dailyCap) || 0;
    let done = 0, ok = 0, fail = 0, skip = 0;
    const total = items.length;
    const startAt = Date.now();
    const WATCHDOG_MS = 20 * 60000;
    sendUnfollowProgress({ type: 'start', total, mode: 'follow' });
    for (const it of items) {
      if (Date.now() - startAt > WATCHDOG_MS) { sendLog('error', '批量关注单批超时，已停止'); break; }
      if (dailyCap > 0 && store.getAccount(id).daily.ops >= dailyCap) { sendLog('warn', '批量关注：已达每日上限'); break; }
      const chk = canUnfollow({ mid: it.mid, attribute: 0 }, excl); // attribute=0 表示「尚未关注」，canUnfollow 对「未关注」放行
      if (!chk.ok) { skip++; done++; sendUnfollowProgress({ type: 'item', mid: String(it.mid), uname: it.uname || '', result: '跳过', detail: chk.reason, done, total, ok, fail, skip, mode: 'follow' }); continue; }
      let r;
      try { r = await client.modify(Number(it.mid), 1); }
      catch (e) { r = { ok: false, code: -9999, message: (e && e.message) || String(e), kind: 'fatal' }; }
      if (r.ok) { ok++; done++; sendLog('ok', `已关注 ${it.uname || it.mid}`); sendUnfollowProgress({ type: 'item', mid: String(it.mid), uname: it.uname || '', result: '已关注', done, total, ok, fail, skip, mode: 'follow' }); }
      else {
        fail++; done++;
        sendLog('error', `批量关注失败 ${it.uname || it.mid}：${r.message || ('code=' + r.code)}`);
        sendUnfollowProgress({ type: 'item', mid: String(it.mid), uname: it.uname || '', result: '失败', detail: r.message || ('code=' + r.code), done, total, ok, fail, skip, mode: 'follow' });
        if (r.kind === 'fatal') { sendLog('error', '批量关注遇到致命错误码，已停止'); break; }
        if (r.kind === 'ratelimit') { sendLog('warn', '触发限流，暂停 60s'); await sleep(60000); }
      }
      const wait = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
      await sleep(wait);
    }
    try { store.flush(); } catch (e) { /* ignore */ }
    sendUnfollowProgress({ type: 'done', total, done, ok, fail, skip, mode: 'follow' });
    return { ok: true, total, done, okCount: ok, fail, skip };
  }));

  /**
   * 文件级同步语义（P1-D，借鉴 BilibiliFollowManage「从文件同步」）：
   * 把「当前关注列表」与「目标关注集（导入的 TXT/CSV，MID,昵称）」做集合求差，
   * 返回 { toFollow, toUnfollow, unchanged } 供 UI 预览；执行时分别走 followBatch / batch。
   * 这是换号迁移、备份还原最自然的抽象。
   */
  ipcMain.handle('unfollow:syncPlan', safe('unfollow:syncPlan', async (p) => {
    const id = String((p && p.id) || '');
    const acc = store.getAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };
    const current = Array.isArray(p && p.current) ? p.current : [];
    const target = Array.isArray(p && p.target) ? p.target : [];
    if (!target.length) return { ok: false, error: '目标关注集为空' };
    const diff = diffFollowLists(current, target);
    return {
      ok: true,
      toFollow: diff.toFollow.map((x) => ({ mid: String(x.mid), uname: x.uname || '' })),
      toUnfollow: diff.toUnfollow.map((x) => ({ mid: String(x.mid), uname: x.uname || '' })),
      unchangedCount: diff.unchanged.length
    };
  }));

  /**
   * 画像/活跃度分析：对传入的一批 UID 逐个查询「最近投稿」与「空间资料」，
   * 计算活跃度分级，节流推送进度，返回 mid → 画像 映射。只读取、不做写操作。
   */
  ipcMain.handle('unfollow:enrich', safe('unfollow:enrich', async (p) => {
    const id = String((p && p.id) || '');
    const acc = store.getAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };
    const mids = Array.isArray(p && p.mids) ? p.mids.map(String).filter(Boolean) : [];
    if (!mids.length) return { ok: false, error: '分析名单为空' };
    const client = new BiliClient(acc.cookie);
    if (!client.isLoggedCookie) return { ok: false, error: 'Cookie 不完整，请重新登录' };
    const nav = await client.nav();
    if (nav.code !== 0) return { ok: false, error: '登录态失效：' + nav.message };
    const gap = clampNum((p && p.gap) || store.get().global.pageGap || 1200, 500, 600000);
    const total = mids.length;
    const out = {};
    sendUnfollowEnrich({ type: 'start', total });
    let done = 0, okCount = 0, fail = 0;
    for (const mid of mids) {
      try {
        const rv = await client.recentVideo(mid);
        const act = classifyActivity(rv.latestPubdate, rv.count);
        // P0-A：死粉三段细分（已注销/内容变质/停更/沉寂），复用本地 deadUsers 判定「已注销」
        const seg = classifySegment({ flagDeleted: store.isDeadUser(mid), lastPubdate: rv.latestPubdate, archiveCount: rv.count });
        out[mid] = {
          mid,
          lastPubdate: rv.latestPubdate,
          archiveCount: rv.count,
          activity: act.key,
          activityLabel: act.label,
          activityDays: act.days,
          segment: seg.key,
          segmentLabel: seg.label
        };
        okCount++;
      } catch (e) {
        fail++;
        out[mid] = { mid, lastPubdate: null, archiveCount: 0, activity: 'unknown', activityLabel: '活跃度未知', activityDays: null, segment: 'unknown', segmentLabel: '未知' };
      }
      done++;
      sendUnfollowEnrich({ type: 'item', mid, done, total, ok: okCount, fail });
      if (done < total) await sleep(gap);
    }
    sendUnfollowEnrich({ type: 'done', total, done, ok: okCount, fail });
    return { ok: true, profiles: out, total, ok: okCount, fail };
  }));

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

/** 导出「取关我的名单」（按账号） */
async function exportUnfollowersCsv(id) {
  const win = mainWindow;
  if (!win) return { ok: false };
  const acc = store.getAccount(String(id));
  if (!acc) return { ok: false, error: '账号不存在' };
  const list = store.listUnfollowers(String(id));
  const res = await dialog.showSaveDialog(win, {
    title: '导出取关我的名单',
    defaultPath: path.join(app.getPath('downloads'), `bili_unfollowers_${acc.uname || acc.uid}_${Date.now()}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    // RB18：复用 escapeCell（引号转义 + 包裹 + 公式前缀防护），与操作记录 CSV 一致
    const header = ['日期', 'UID', '昵称', '处理状态'].map(escapeCell).join(',');
    const lines = list.map((u) => {
      const h = u.handled === 'blocked' ? '已拉黑' : u.handled === 'ignored' ? '已忽略'
        : u.handled === 'auto' ? '自动记录' : '未处理';
      return [u.date || '', u.mid || '', u.uname || '', h].map(escapeCell).join(',');
    }).join('\r\n');
    fs.writeFileSync(res.filePath, '﻿' + header + '\r\n' + lines, 'utf8'); // BOM 让 Excel 正确识别 UTF-8
    sendLog('ok', `已导出 ${list.length} 条取关记录 → ${res.filePath}`);
    return { ok: true, path: res.filePath, rows: list.length };
  } catch (e) {
    sendLog('error', '导出失败：' + e.message);
    return { ok: false, error: e.message };
  }
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
    const n = store.listRecords(3000).length;
    sendLog('ok', `已导出 ${n} 条操作记录 → ${res.filePath}`);
    return { ok: true, path: res.filePath, rows: n };
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

function escapeCell(v) {
  let s = String(v == null ? '' : v);
  // RB15：防 CSV 公式注入——以 = + - @ 或 tab/CR 开头的单元格前置单引号，避免被表格软件当公式执行
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function buildCsv() {
  const lines = [['时间', '账号', '昵称', 'UID', '结果', '说明', '来源'].map(escapeCell).join(',')];
  // RB3：导出基于落盘的操作明细（重启后仍可导出历史），而非进程内存
  for (const row of store.listRecords(3000)) {
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

// 记录由 engine 事件累积到 store（RB3：落盘持久化，重启不丢；由 3s 定时 flush）
function hookRecords() {
  engine.on('record', (row) => {
    const acc = store.getAccount(row.accountId);
    store.addRecord(Object.assign({}, row, { accountName: acc ? acc.uname : '' }));
  });
}

/* ══════════════ 生命周期 ══════════════ */
app.whenReady().then(async () => {
  if (!hasSingleLock) return;   // 已有实例在运行，本实例退出
  init();
  registerIPC();
  hookRecords();
  buildAppMenu();   // 中文应用菜单（文件/编辑/视图/窗口/帮助）

  // 热更新：事件统一转发给渲染进程（available/progress/status/error/none）
  updater = new Updater({ onEvent: (ev) => sendUpdater(ev) });
  // v2.1.17：按全局设置选择更新镜像（默认自动探测最快镜像加速）
  try { updater.setMirror((store.get().global || {}).updateMirror || 'auto'); } catch (e) { /* ignore */ }

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
      if (typeof core.sha256File !== 'function') throw new Error('缺少 SHA256 校验函数（RB1）');
      if (!core.parseChecksums('a'.repeat(64) + '  x.exe').x.exe) throw new Error('校验文件解析异常');
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

  // 启动会话自动恢复：穷尽「免扫码续期」——对已过期（nav=-101）且持有 refreshToken 的账号，
  // 先尝试 refresh_token 续命；失败才退回扫码/导入。避免每次过期都要手动重登。
  try {
    setTimeout(async () => {
      const accs = store.listAccounts();
      let recovered = 0, needReauth = 0;
      for (const a of accs) {
        try {
          const client = new BiliClient(a.cookie || '');
          const nav = await client.nav().catch(() => null);
          if (nav && nav.code === 0) continue;          // 仍有效，跳过
          if (!a.refreshToken) { needReauth++; continue; } // 无续期凭据，只能重登
          const res = await auth.refreshCookie({ cookie: a.cookie, refreshToken: a.refreshToken });
          if (res.ok) {
            const c2 = new BiliClient(res.cookie);
            const n2 = await c2.nav().catch(() => null);
            if (n2 && n2.code === 0) {
              a.cookie = res.cookie;
              a.refreshToken = res.refreshToken || a.refreshToken;
              a.uid = c2.profile.mid; a.uname = c2.profile.uname; a.face = c2.profile.face;
              store.flush();
              recovered++;
              sendLog('ok', `启动自动续期成功：${c2.profile.uname}（UID ${c2.profile.mid}）`);
            } else { needReauth++; }
          } else { needReauth++; }
        } catch (e) { /* 单账号失败不影响其他 */ }
      }
      if (recovered) sendLog('info', `启动自动续期完成：成功恢复 ${recovered} 个账号`);
      if (needReauth) sendLog('warn', `${needReauth} 个账号登录态已失效且无续期凭据，请点「扫码登录」重新登录`);
      // 主动通知界面刷新账号状态
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bus:account', { recover: true });
      }
    }, 2500);
  } catch (e) {
    sendLog('error', '启动会话恢复异常：' + (e && e.message || e));
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

/* RB19：主进程未捕获异常不能只 console——写按天日志 + 通知界面 + 尽量落盘，否则用户无感且难排查 */
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e);
  try {
    const msg = (e && (e.stack || e.message)) || String(e);
    if (store) { store.addLog({ level: 'error', msg: '主进程未捕获异常：' + msg }); store.flush(); }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bus:log', { accountId: '', level: 'error', msg: '主进程未捕获异常：' + ((e && e.message) || e), ts: Date.now() });
    }
  } catch (e2) { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  try {
    const msg = (reason && (reason.stack || reason.message)) || String(reason);
    if (store) store.addLog({ level: 'error', msg: '未处理的 Promise 拒绝：' + msg });
  } catch (e) { /* ignore */ }
});
