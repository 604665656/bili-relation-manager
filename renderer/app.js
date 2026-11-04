'use strict';
/* 渲染进程：无 Node 访问，全部通过 window.api（preload 白名单） */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const ST = { accounts: [], global: {}, selected: null, records: [], logs: [], busy: false, tab: 'log' };

/* 批量取关（一键取关 + 筛选）的临时状态（不落盘） */
const BATCH = {
  mode: 'search',     // 'search' | 'follow'
  items: [],          // 原始候选 { mid, uname, fans, attribute, face, sign, selected, result, detail, _activity }
  filtered: [],       // 过滤后（引用 items）
  profiles: {},       // mid -> { lastPubdate, archiveCount, activity, activityLabel, activityDays }
  loading: false,
  executing: false,
  enriching: false,
  enrichReqId: 0,
  reqId: 0            // 防止过期搜索/载入响应覆盖最新结果
};

/* 文件级同步（集合求差）的当前计划（doSyncPlan 计算、doSyncRun 执行） */
let SYNC_PLAN = null;   // { toFollow:[{mid,uname}], toUnfollow:[{mid,uname}], unchangedCount }

/* RB17：高频事件合并渲染——同一 key 在一帧内只重建一次 DOM，避免每条 record/stats 都全量重绘 */
const _pendingRender = new Set();
function scheduleRender(key, fn) {
  if (_pendingRender.has(key)) return;
  _pendingRender.add(key);
  const run = () => { _pendingRender.delete(key); try { fn(); } catch (e) { /* ignore */ } };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 50);
}
const UPD = { info: null, busy: false };   // 热更新状态

/* ─────────── 启动 ─────────── */
async function boot() {
  // 启动第一件事：强制隐藏所有浮层，绝不依赖样式表
  ['#modal-import', '#modal-support', '#modal-update', '#modal-qr', '#login-bar'].forEach((sel) => hideEl($(sel)));
  wireEvents();
  await reloadState();
  window.api.onLog(onLog);
  window.api.onRecord(onRecord);
  window.api.onAccount(onAccountState);
  window.api.onStats(onStats);
  window.api.onLive(onLive);
  window.api.onBusy((d) => { ST.busy = !!d.busy; setStatus(d.busy ? '任务运行中…' : '就绪'); });
  // 菜单「帮助 → 联系合作 / 打赏支持」
  if (window.api.onMenuOpenSupport) window.api.onMenuOpenSupport(() => openSupport());
  // 菜单「帮助 → 检查更新…」
  if (window.api.onMenuCheckUpdate) window.api.onMenuCheckUpdate(() => doCheckUpdate());
  // 热更新事件（启动静默检查 / 定时复查 / 下载进度 / 出错）
  if (window.api.onUpdaterEvent) window.api.onUpdaterEvent(onUpdaterEvent);
  // 主进程可能已经查到过新版（比如弹窗被关掉了），启动后补一次常驻提醒
  if (window.api.updaterInfo) {
    try {
      const info = await window.api.updaterInfo();
      if (info && info.version) setUpdateBadge(info);
    } catch (e) { /* ignore */ }
  }
}

async function reloadState() {
  const s = await window.api.getState();
  ST.accounts = s.accounts || [];
  ST.global = s.global || {};
  ST.logs = s.logs || [];
  ST.records = s.records || [];   // RB3：操作明细落盘后，重启仍能显示历史
  if (s.version) $('#ver').textContent = `v${s.version}${s.build ? ' · ' + s.build : ''}`;
  if (s.writable && s.writable.ok === false) {
    $('#status').innerHTML =
      `<span style="color:#f87171">⚠ 数据目录不可写，账号无法保存：${escapeHtml(s.writable.dir)}（${escapeHtml(s.writable.message || '')}）` +
      `　请把程序移到有写权限的目录，或右键以管理员身份运行</span>`;
  }
  if (s.storeError) toast('保存数据时出错：' + s.storeError);
  if (!ST.selected && ST.accounts.length) ST.selected = ST.accounts[0].id;
  fillGlobalForm();
  renderAll();
}

function renderAll() {
  renderAccounts();
  renderSelected();
  renderLogs();
  renderRecords();
  renderStats();
  refreshDutyBtn();
}

/** 根据账号实时状态反映「一键值守」按钮（实战 + 自动循环 + 正在运行 = 值守中） */
function refreshDutyBtn() {
  const el = $('#btn-duty');
  if (!el) return;
  const dutyActive = ST.accounts.some((a) => a.cfg && a.cfg.enabled !== false &&
    (a.cfg.tasks && (a.cfg.tasks.unfollow || a.cfg.tasks.follow)) &&
    a.cfg.dryRun === false && a.cfg.autoLoop === true &&
    (a.state === 'running' || a.state === 'waiting' || a.state === 'restart'));
  if (dutyActive) {
    if (!el.classList.contains('on')) {
      el.classList.add('on');
      el.textContent = '🛡 值守中（点击退出）';
    }
  } else {
    if (el.classList.contains('on')) {
      el.classList.remove('on');
      el.textContent = '🛡 一键值守';
    }
  }
}

/* ─────────── 交互绑定 ─────────── */
/* ─────────── 侧边栏可拖拽调整宽度 ─────────── */
/* 侧栏宽度按窗口比例动态钳制，保证中栏永不被挤成 0 宽（否则 CJK 文字会逐字竖排） */
function maxLeftForWin() { return Math.max(200, Math.min(480, Math.floor(window.innerWidth * 0.32))); }
function maxRightForWin() { return Math.max(240, Math.min(620, Math.floor(window.innerWidth * 0.42))); }
function initLayout() {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  try {
    const saved = JSON.parse(localStorage.getItem('brm-layout') || '{}');
    if (saved.left) layout.style.setProperty('--left-w', Math.max(200, Math.min(maxLeftForWin(), saved.left)) + 'px');
    if (saved.right) layout.style.setProperty('--right-w', Math.max(240, Math.min(maxRightForWin(), saved.right)) + 'px');
  } catch (e) { /* ignore */ }
  makeResizer('resize-left', 'left');
  makeResizer('resize-right', 'right');
  // 窗口缩放时重新钳制，避免中栏塌缩
  window.addEventListener('resize', () => {
    const layout = document.querySelector('.layout');
    if (!layout) return;
    const lv = parseFloat(getComputedStyle(layout).getPropertyValue('--left-w'));
    const rv = parseFloat(getComputedStyle(layout).getPropertyValue('--right-w'));
    if (!Number.isNaN(lv) && lv > maxLeftForWin()) layout.style.setProperty('--left-w', maxLeftForWin() + 'px');
    if (!Number.isNaN(rv) && rv > maxRightForWin()) layout.style.setProperty('--right-w', maxRightForWin() + 'px');
  });
}
function makeResizer(id, side) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const layout = document.querySelector('.layout');
    if (!layout) return;
    const startX = e.clientX;
    const key = side === 'left' ? '--left-w' : '--right-w';
    const cur = () => {
      const v = parseFloat(getComputedStyle(layout).getPropertyValue(key));
      return isNaN(v) ? (side === 'left' ? 268 : 380) : v;
    };
    const start = cur();
    const min = side === 'left' ? 200 : 240;
    const max = side === 'left' ? maxLeftForWin() : maxRightForWin();
    el.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const mv = (ev) => {
      let w = start + (ev.clientX - startX) * (side === 'left' ? 1 : -1);
      w = Math.max(min, Math.min(max, w));
      layout.style.setProperty(key, w + 'px');
    };
    const up = () => {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
      el.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        const saved = { left: 268, right: 380 };
        const raw = JSON.parse(localStorage.getItem('brm-layout') || '{}');
        if (raw.left) saved.left = raw.left;
        if (raw.right) saved.right = raw.right;
        saved[side] = parseFloat(getComputedStyle(layout).getPropertyValue(key)) || saved[side];
        localStorage.setItem('brm-layout', JSON.stringify(saved));
      } catch (e) { /* ignore */ }
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  });
}

function wireEvents() {
  initLayout();
  $('#btn-add').onclick = doLogin;
  $('#btn-add-qr').onclick = doQrLogin;
  $('#btn-import').onclick = openImport;
  $('#btn-login-refresh').onclick = () => window.api.loginRefresh();
  $('#btn-login-cancel').onclick = () => window.api.loginCancel();
  $('#btn-login-manual').onclick = () => { window.api.loginCancel(); openImport(); };
  $('#btn-import-ok').onclick = doImport;
  $('#btn-import-cancel').onclick = closeImport;
  // 点遮罩空白处关闭
  $('#modal-import').onclick = (e) => { if (e.target === $('#modal-import')) closeImport(); };
  $('#btn-qr-refresh').onclick = qrRegenerate;
  $('#btn-qr-cancel').onclick = qrCancel;
  $('#modal-qr').onclick = (e) => { if (e.target === $('#modal-qr')) qrCancel(); };
  // 账号卡片里的「续期」按钮（refresh_token 免扫码续命），用事件委托避免重复 id
  $('#acc-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="renew"]');
    if (btn) { e.stopPropagation(); doRenewOne(btn.getAttribute('data-id')); }
  });
  // 联系合作 / 打赏支持
  $('#btn-support').onclick = openSupport;
  $('#btn-support-close').onclick = closeSupport;
  $('#modal-support').onclick = (e) => { if (e.target === $('#modal-support')) closeSupport(); };
  // 热更新弹窗
  $('#btn-update-now').onclick = doApplyUpdate;
  $('#btn-update-later').onclick = () => {
    const v = UPD.info && UPD.info.version;
    if (v) { try { localStorage.setItem('brm-skip-ver', v); } catch (e) { /* ignore */ } }
    closeUpdate();
  };
  $('#modal-update').onclick = (e) => { if (e.target === $('#modal-update')) closeUpdate(); };
  // 顶部「可更新 vX」常驻提示：点开就回到更新弹窗（没信息则现场查一次）
  $('#upd-badge').onclick = () => {
    if (UPD.info && UPD.info.version) openUpdate(UPD.info);
    else doCheckUpdate();
  };
  // Esc 关闭弹窗 / 收起登录提示条
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeImport();
      closeSupport();
      closeUpdate();
      hideEl($('#login-bar'));
    }
  });
  $('#btn-start-all').onclick = () => doStart(ST.accounts.map((a) => a.id));
  $('#btn-stop-all').onclick = async () => { await window.api.stopTasks(null); toast('已请求停止全部账号'); };
  $('#btn-export').onclick = doExport;
  $('#btn-datadir').onclick = () => window.api.openDataDir();
  $('#btn-logdir').onclick = () => window.api.openLogDir ? window.api.openLogDir() : window.api.openDataDir();
  $('#btn-refresh-stats').onclick = async () => { setStatus('正在刷新统计…'); await window.api.refreshStats(); await reloadState(); toast('统计已刷新'); setStatus('就绪'); };

  // 一键值守：开启 = 实战 + 自动循环 + 异常自重启 + 开机自启；关闭 = 停止全部
  $('#btn-duty').onclick = async () => {
    const el = $('#btn-duty');
    if (!el.classList.contains('on')) {
      const hasTask = ST.accounts.some((a) => a.cfg && a.cfg.enabled !== false &&
        (a.cfg.tasks && (a.cfg.tasks.unfollow || a.cfg.tasks.follow)));
      if (!hasTask) { toast('请先登录账号并在配置里勾选任务类型（清理/关注）'); return; }
      if (!confirm('一键值守将把全部已启用账号设为：\n  • 实战操作（真正关注/取关，非演练）\n  • 自动循环（跑完一轮自动接下一轮）\n  • 异常自重启（撞错后自动恢复）\n  • 开机自动接回任务\n\n这将真正对 B 站执行操作，每日每账号上限约 150 次。\n确定开启无人值守跑量？')) return;
      const r = await window.api.duty(true);
      if (!r || !r.ok) { toast('开启失败：' + (r && (r.error || r.message) || '未知错误')); return; }
      el.classList.add('on');
      el.textContent = '🛡 值守中（点击退出）';
      toast(`一键值守已开启：${r.ids ? r.ids.length : 0} 个账号进入实战循环`);
    } else {
      if (!confirm('确定退出一键值守并停止全部账号任务？')) return;
      await window.api.duty(false);
      el.classList.remove('on');
      el.textContent = '🛡 一键值守';
      toast('已退出值守，全部任务停止');
    }
    await reloadState();
  };

  $('#btn-start-one').onclick = () => ST.selected && doStart([ST.selected]);
  $('#btn-stop-one').onclick = async () => { if (ST.selected) await window.api.stopTasks([ST.selected]); };
  $('#btn-refresh-one').onclick = doRefreshOne;
  $('#btn-del-one').onclick = doDeleteOne;
  $('#btn-reset-one').onclick = async () => {
    if (!ST.selected) return;
    if (!confirm('重置该账号的回关率统计？关注/粉丝数不受影响。')) return;
    await window.api.resetStats(ST.selected);
    await reloadState(); toast('统计已重置');
  };
  $('#btn-save-global').onclick = doSaveGlobal;
  $('#btn-never-clear').onclick = async () => {
    if (!confirm('清空「不再关注名单」？之后这些 UID 又可能被自动关注。')) return;
    ST.global = (await window.api.neverClear()).global || ST.global;
    await reloadState(); toast('已清空');
  };

  // 配置自动保存
  ['#cfg-min', '#cfg-max', '#cfg-limit', '#cfg-targets', '#cfg-days-n', '#cfg-loop-min', '#cfg-daily', '#cfg-errretry',
    '#cfg-watchdog', '#cfg-capguard-reserve',
    '#cfg-keywords', '#cfg-searchpages', '#cfg-maxfans', '#cfg-minlevel']
    .forEach((sel) => $(sel).addEventListener('change', autoSaveCfg));
  ['#cfg-official', '#cfg-special', '#cfg-skipvip', '#cfg-dry', '#cfg-days', '#cfg-loop', '#cfg-capguard']
    .forEach((sel) => $(sel).addEventListener('change', () => { autoSaveCfg(); renderSelected(); }));
  // 任务类型 / 来源都是多选：勾完立刻存盘并刷新可见行
  ['#task-unfollow', '#task-follow', '#src-fans', '#src-search', '#src-ups']
    .forEach((sel) => $(sel).addEventListener('change', () => { autoSaveCfg(); syncCfgVisibility(); }));

  $$('.tab').forEach((t) => t.onclick = () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const tab = t.dataset.tab;
    ST.tab = tab;
    $('#pane-log').hidden = tab !== 'log';
    $('#pane-record').hidden = tab !== 'record';
    $('#pane-stat').hidden = tab !== 'stat';
    $('#pane-unfollower').hidden = tab !== 'unfollower';
    $('#pane-batch').hidden = tab !== 'batch';
    if (tab === 'unfollower') renderUnfollowers();
    if (tab === 'batch') renderBatch();
  });
  $('#btn-export-unfollower').onclick = doExportUnfollowers;
  $('#unfollowerbox').addEventListener('click', onUnfollowerBoxClick);
  $('#cfg-track-unfollowers').addEventListener('change', autoSaveCfg);

  /* ── 批量取关 ── */
  $$('.seg-btn[data-bmode]').forEach((b) => b.onclick = () => switchBatchMode(b.dataset.bmode));
  $('#btn-batch-search').onclick = doBatchSearch;
  $('#btn-batch-load').onclick = doBatchLoad;
  $('#batch-keyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doBatchSearch(); });
  ['#batch-filter-kw', '#batch-only-oneway', '#batch-only-following', '#batch-minfans', '#batch-maxfans',
   '#batch-activity', '#batch-lastpost', '#batch-minlevel', '#batch-hassign']
    .forEach((sel) => { const el = $(sel); if (el) el.addEventListener('input', applyBatchFiltersLive); });
  $('#btn-batch-enrich').onclick = doBatchEnrich;
  $('#btn-batch-checkrel').onclick = doBatchResolveRelations;
  $('#batch-selall').onclick = onBatchSelAll;
  $('#btn-batch-unfollow').onclick = openBatchConfirm;
  $('#btn-batch-confirm-ok').onclick = doBatchUnfollow;
  $('#btn-batch-confirm-cancel').onclick = () => hideEl($('#modal-batch'));
  $('#modal-batch').onclick = (e) => { if (e.target === $('#modal-batch')) hideEl($('#modal-batch')); };
  $('#btn-batch-backup').onclick = doBatchExportBackup;
  $('#btn-sync-plan').onclick = doSyncPlan;
  $('#btn-sync-run').onclick = doSyncRun;
  if (window.api.onUnfollowProgress) window.api.onUnfollowProgress(onUnfollowProgress);
  if (window.api.onUnfollowEnrich) window.api.onUnfollowEnrich(onUnfollowEnrich);
}

function readCfgForm() {
  return {
    tasks: {
      unfollow: $('#task-unfollow').checked,
      follow: $('#task-follow').checked
    },
    sources: {
      fans: $('#src-fans').checked,
      search: $('#src-search').checked,
      ups: $('#src-ups').checked
    },
    searchKeywords: String($('#cfg-keywords').value || '').trim(),
    searchMaxPages: clampInt($('#cfg-searchpages').value, 1, 20, 2),
    searchMaxFans: clampInt($('#cfg-maxfans').value, 0, 100000000, 0),
    searchMinLevel: clampInt($('#cfg-minlevel').value, 0, 6, 1),
    delayMin: clampInt($('#cfg-min').value, 1000, 600000, 3000),
    delayMax: clampInt($('#cfg-max').value, 1000, 600000, 6000),
    maxOps: clampInt($('#cfg-limit').value, 1, 500, 30),
    dryRun: $('#cfg-dry').checked,
    skipOfficial: $('#cfg-official').checked,
    skipSpecial: $('#cfg-special').checked,
    skipVip: $('#cfg-skipvip').checked,
    autoLoop: $('#cfg-loop').checked,
    loopIntervalMin: clampInt($('#cfg-loop-min').value, 1, 1440, 30),
    dailyCap: clampInt($('#cfg-daily').value, 0, 2000, 0),
    errRetryMin: clampInt($('#cfg-errretry').value, 0, 1440, 0),
    watchdogStallMin: clampInt($('#cfg-watchdog').value, 0, 240, 15),
    onlyAfterDays: $('#cfg-days').checked,
    minFollowDays: clampInt($('#cfg-days-n').value, 1, 365, 7),
    capGuard: $('#cfg-capguard').checked,
    capGuardReserve: clampInt($('#cfg-capguard-reserve').value, 0, 4900, 100),
    targetUps: String($('#cfg-targets').value || '').trim(),
    trackUnfollowers: $('#cfg-track-unfollowers').checked
  };
}
/** 依据勾选情况显示 / 隐藏相关输入行 */
function syncCfgVisibility(cfg) {
  const c = cfg || readCfgForm();
  const followOn = !!(c.tasks && c.tasks.follow);
  const s = c.sources || {};
  $('#row-sources').hidden = !followOn;
  $('#row-keywords').hidden = !(followOn && s.search);
  $('#row-kwopts').hidden = !(followOn && s.search);
  $('#row-target').hidden = !(followOn && s.ups);
}
function clampInt(v, lo, hi, dft) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dft;
  return Math.min(hi, Math.max(lo, n));
}
async function autoSaveCfg() {
  if (!ST.selected) return;
  const cfg = readCfgForm();
  await window.api.updateCfg(ST.selected, cfg);
  const a = ST.accounts.find((x) => x.id === ST.selected);
  if (a) a.cfg = cfg;
}

/* ─────────── 动作 ─────────── */
async function doLogin() {
  $('#btn-add').disabled = true;
  showEl($('#login-bar'));
  setStatus('等待扫码确认…');
  let r = null, err = null;
  try { r = await window.api.login(); }
  catch (e) { err = e && e.message || String(e); }
  finally {
    hideEl($('#login-bar'));
    $('#btn-add').disabled = false;
  }
  if (err) { setStatus('登录出错：' + err); toast('登录出错：' + err); return; }
  await reloadState();
  if (r && r.ok) toast(`已添加账号：${r.account.uname}`);
  else if (r && r.reason === 'already') toast('登录窗口已打开，请查看');
  else if (r && r.error) { setStatus('登录失败：' + r.error); toast(r.error); }
  else {
    setStatus('登录未成功');
    toast('未检测到登录。可点「手动导入 Cookie」兜底');
  }
}

/* 显隐统一走「内联 style + hidden 双保险」，不依赖任何 CSS 规则，
   避免样式表优先级导致弹窗关不掉 */
function showEl(el, display) {
  if (!el) return;
  el.hidden = false;
  el.style.display = display || 'flex';
}
function hideEl(el) {
  if (!el) return;
  el.hidden = true;
  el.style.display = 'none';
}

/* ─────────── 应用内二维码扫码登录（官方 passport API） ─────────── */
let qrTimer = null;
let qrClosedByUser = false;

async function qrRegenerate() {
  $('#qr-status').textContent = '正在生成二维码…';
  let g = null;
  try { g = await window.api.qrStart(); }
  catch (e) { $('#qr-status').textContent = '生成失败：' + (e && e.message || e); return; }
  if (!g || !g.ok) {
    $('#qr-status').textContent = '生成失败：' + ((g && g.message) || '未知错误');
    return;
  }
  $('#qr-img').src = g.dataUrl;
  $('#qr-status').textContent = '请用手机 B 站 App 扫码，并在手机上点「确认登录」';
}

async function doQrLogin() {
  qrClosedByUser = false;
  showEl($('#modal-qr'));
  await qrRegenerate();
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = setInterval(qrPollLoop, 1500);
}

async function qrPollLoop() {
  if (qrClosedByUser) { if (qrTimer) clearInterval(qrTimer); qrTimer = null; return; }
  let r = null;
  try { r = await window.api.qrPoll(); } catch (e) { return; }
  if (!r) return;
  if (r.status === 'throttled' || r.status === 'idle') return;
  if (r.status === 'waiting') {
    $('#qr-status').textContent = '等待扫码…（请用手机 B 站 App 扫码）';
  } else if (r.status === 'scanned') {
    $('#qr-status').textContent = '已扫描，请在手机上点「确认登录」';
  } else if (r.status === 'expired') {
    $('#qr-status').textContent = '二维码已过期，正在重新生成…';
    await qrRegenerate();
  } else if (r.status === 'success') {
    if (qrTimer) clearInterval(qrTimer); qrTimer = null;
    hideEl($('#modal-qr'));
    await reloadState();
    toast('扫码登录成功：' + ((r.account && r.account.uname) || ''));
    setStatus('就绪');
  } else if (r.status === 'error') {
    $('#qr-status').textContent = '登录校验未通过：' + (r.message || '');
  }
}

function qrCancel() {
  qrClosedByUser = true;
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  try { window.api.qrCancel(); } catch (e) { /* ignore */ }
  hideEl($('#modal-qr'));
  $('#qr-status').textContent = '';
}

/* 续期：refresh_token 免扫码续命 */
async function doRenewOne(id) {
  if (!id) return;
  const a = ST.accounts.find((x) => x.id === id);
  const name = (a && a.uname) || '该账号';
  setStatus('正在用 refresh_token 续期 ' + name + '…');
  let r = null;
  try { r = await window.api.refreshToken(id); }
  catch (e) { r = { ok: false, message: (e && e.message || String(e)) }; }
  if (r && r.ok) {
    await reloadState();
    toast('续期成功：' + name);
    setStatus('就绪');
  } else {
    toast('续期失败：' + ((r && r.message) || '未知错误'));
    setStatus('就绪');
  }
}

function openImport() {
  const m = $('#modal-import');
  $('#import-msg').textContent = '';
  $('#import-cookie').value = '';  showEl(m);
  $('#import-cookie').focus();
}
function closeImport() { hideEl($('#modal-import')); }

function openSupport() { showEl($('#modal-support')); }
function closeSupport() { hideEl($('#modal-support')); }

/* ─────────── 热更新 ─────────── */

/** 顶部「可更新 vX」常驻标记：关掉弹窗也不会错过（传 null 隐藏） */
function setUpdateBadge(info) {
  const el = $('#upd-badge');
  if (!el) return;
  if (info && info.version) {
    UPD.info = info;
    el.textContent = '可更新 v' + info.version;
    el.title = `发现新版本 v${info.version}（当前 v${info.current || '?'}），点击查看并更新`;
    showEl(el, 'inline-flex');
  } else {
    UPD.info = null;
    el.textContent = '可更新 v?';
    hideEl(el);
  }
}

function openUpdate(info) {
  UPD.info = info || null;
  $('#upd-cur').textContent = 'v' + ((info && info.current) || '?');
  $('#upd-new').textContent = 'v' + ((info && info.version) || '?');
  $('#upd-notes').textContent = (info && info.notes) ? String(info.notes).replace(/\r/g, '') : '（无更新说明）';
  $('#upd-status').textContent = '';
  $('#btn-update-now').disabled = false;
  $('#btn-update-now').textContent = '立即更新并重启';
  $('#btn-update-later').disabled = false;
  hideEl($('#upd-prog'));
  showEl($('#modal-update'));
}
function closeUpdate() {
  if (UPD.busy) return;   // 下载中不允许关
  hideEl($('#modal-update'));
}

async function doCheckUpdate() {
  setStatus('正在检查更新…');
  let r = null;
  try { r = await window.api.updaterCheck(); }
  catch (e) { r = { hasUpdate: false, error: String(e && e.message || e) }; }
  if (r && r.hasUpdate) {
    setUpdateBadge(r);
    openUpdate(r);
    setStatus(`发现新版本 v${r.version}`);
  } else {
    setUpdateBadge(null);
    const msg = (r && r.error) ? r.error : `已是最新版本 v${(r && r.version) || ''}`;
    setStatus(msg);
    toast(msg);
  }
}

async function doApplyUpdate() {
  if (UPD.busy) return;
  if (ST.busy && !confirm('当前有账号任务正在运行，热更新会中断它们。确定仍要更新吗？')) return;
  UPD.busy = true;
  $('#btn-update-now').disabled = true;
  $('#btn-update-now').textContent = '正在更新…';
  $('#btn-update-later').disabled = true;
  $('#upd-status').textContent = '正在连接 GitHub…';
  showEl($('#upd-prog'), 'flex');
  try { await window.api.updaterApply(); }
  catch (e) { /* 错误经 onUpdaterEvent 展示 */ }
}

function onUpdaterEvent(ev) {
  if (!ev || !ev.type) return;
  if (ev.type === 'available') {
    setUpdateBadge(ev);   // 不管弹不弹窗，顶部标记都要在
    // 同一版本被「稍后再说」跳过就不再自动弹
    let skipped = null;
    try { skipped = localStorage.getItem('brm-skip-ver'); } catch (e) { /* ignore */ }
    if (skipped && skipped === ev.version) { setStatus(`有新版本 v${ev.version}（已设置跳过提醒，可点顶部「可更新」）`); return; }
    openUpdate(ev);
  } else if (ev.type === 'none') {
    setUpdateBadge(null);
    // 自动检查失败/无更新就静默；用户手动点「检查更新」必须给反馈
    if (ev.manual) {
      const msg = ev.error || `已是最新版本 v${ev.version || ''}`;
      setStatus(msg);
      toast(msg);
    }
  } else if (ev.type === 'progress') {
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    $('#upd-pct').textContent = ev.pct != null ? `${ev.pct}%` : `已下载 ${mb(ev.received || 0)}`;
    $('#upd-bar-in').style.width = (ev.pct != null ? ev.pct : 8) + '%';
  } else if (ev.type === 'status') {
    if (ev.msg) $('#upd-status').textContent = ev.msg;
  } else if (ev.type === 'error') {
    UPD.busy = false;
    $('#btn-update-now').disabled = false;
    $('#btn-update-now').textContent = '重试更新';
    $('#btn-update-later').disabled = false;
    $('#upd-status').textContent = '更新失败：' + (ev.msg || '未知错误');
    setStatus('更新失败：' + (ev.msg || '未知错误'));
  }
}

async function doImport() {
  const raw = $('#import-cookie').value.trim();
  if (!raw) { $('#import-msg').textContent = '请先粘贴 Cookie'; return; }
  $('#import-msg').textContent = '校验中…';
  let r;
  try { r = await window.api.importCookie(raw); }
  catch (e) { $('#import-msg').textContent = '导入异常：' + (e && e.message || e); return; }
  if (!r || !r.ok) { $('#import-msg').textContent = (r && (r.message || r.error)) || '导入失败'; return; }
  closeImport();
  await reloadState();
  toast(`已添加账号：${r.account.uname}`);
}

async function doStart(ids) {
  if (!ids.length) return toast('请先扫码登录至少一个账号');
  const list = ST.accounts.filter((a) => ids.includes(a.id));
  if (list.every((a) => a.cfg.dryRun)) setStatus('全部账号均为演练模式，不会真正执行操作');
  await window.api.startTasks(ids);
  toast(`已启动 ${ids.length} 个账号（并行执行）`);
}

async function doRefreshOne() {
  if (!ST.selected) return;
  const r = await window.api.refreshAccount(ST.selected);
  if (!r) return;
  if (!r.ok) return toast('刷新失败：' + r.message);
  toast('资料已刷新');
  await reloadState();
}

async function doDeleteOne() {
  if (!ST.selected) return;
  const a = ST.accounts.find((x) => x.id === ST.selected);
  if (!a) return;
  if (!confirm(`确定删除账号「${a.uname}」吗？\n（仅删除本地保存的登录凭证，不影响 B 站账号本身）`)) return;
  ST.accounts = await window.api.removeAccount(ST.selected);
  ST.selected = ST.accounts.length ? ST.accounts[0].id : null;
  renderAll();
  toast('已删除');
}

async function doSaveGlobal() {
  const mirrorEl = document.querySelector('input[name=updmirror]:checked');
  let updateMirror = (mirrorEl && mirrorEl.value) || 'auto';
  if (updateMirror === 'custom') {
    const c = String($('#g-mirror-custom').value || '').trim();
    updateMirror = /^https?:\/\//i.test(c) ? c.replace(/\/+$/, '/') : 'auto';
  }
  const g = {
    autoStartOnLaunch: $('#g-autostart').checked,
    updateMirror: updateMirror,
    pageGap: clampInt($('#g-pagegap').value, 300, 60000, 1200),
    whiteList: String($('#g-white').value || '').split(/[\s,，;；\n]+/).filter(Boolean),
    rateThreshold: clampInt($('#g-threshold').value, 0, 100, 15) / 100,
    rateMinSample: clampInt($('#g-sample').value, 5, 500, 20),
    rateVerifyGapHours: clampInt($('#g-gap').value, 1, 168, 24),
    statIntervalMin: clampInt($('#g-statint').value, 1, 60, 5),
    followCap: clampInt($('#g-followcap').value, 0, 100000, 5000),
    quietHours: String($('#g-quiet').value || '').trim(),
    restDays: String($('#g-restdays').value || '').split(/[\s,，;；]+/)
      .map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 6)
  };
  const never = String($('#g-never').value || '').split(/[\s,，;；\n]+/).filter(Boolean);
  const r = await window.api.updateGlobal(g);
  ST.global = r.global;
  // 不再关注名单：差量同步
  const before = (ST.global.neverFollow || []).map(String);
  const add = never.filter((u) => !before.includes(String(u)));
  const del = before.filter((u) => !never.includes(String(u)));
  if (add.length) await window.api.neverAdd(add.join(','));
  for (const u of del) await window.api.neverRemove(u);
  await reloadState();
  toast('全局设置已保存');
}

async function doExport() {
  const r = await window.api.exportCsv();
  if (!r.ok) return;
  toast(`已导出 ${r.rows} 条记录 → ${r.path}`);
}

/* ─────────── 渲染 ─────────── */
function renderAccounts() {
  const box = $('#acc-list');
  box.innerHTML = '';
  $('#acc-empty').hidden = ST.accounts.length > 0;
  $('#acc-count').textContent = ST.accounts.length;

  for (const a of ST.accounts) {
    const el = document.createElement('div');
    el.className = 'acc-card' + (a.id === ST.selected ? ' sel' : '');
    el.onclick = (e) => { if (e.target.closest('button')) return; ST.selected = a.id; renderAll(); };

    const st = a.state || 'idle';
    const s = a.stats || {};
    const live = a.live || {};
    const pct = a.cfg.maxOps ? Math.min(100, Math.round(((s.dealt || 0) / a.cfg.maxOps) * 100)) : 0;
    const cd = (st === 'waiting' && s.countdown != null) ? fmtCountdown(s.countdown) : '';

    el.innerHTML = `
      <div class="acc-top">
        <img class="acc-face" src="${escapeAttr(a.face || '')}" onerror="this.style.visibility='hidden'">
        <div class="acc-meta">
          <div class="acc-name">${escapeHtml(a.uname || '未知用户')}</div>
          <div class="acc-live">
            关注 <b>${fmtNum(live.following)}</b> ${delta(live.prevFollowing)}
            粉丝 <b>${fmtNum(live.follower)}</b> ${delta(live.prevFollower)}
          </div>
        </div>
        <span class="chip ${st}">${stateText(st)}${cd ? ' ' + cd : ''}</span>
      </div>
      <div class="acc-ops">
        <span class="chip ${a.cfg.dryRun ? 'paused' : 'idle'}">${a.cfg.dryRun ? '演练' : '实战'}</span>
        <span class="chip idle">${modeText(a.cfg)}</span>
        ${a.cfg.autoLoop ? '<span class="chip running">循环</span>' : ''}
        <span class="chip idle">今日 ${(a.daily && a.daily.ops) || 0}</span>
        <button class="mini renew" data-act="renew" data-id="${a.id}" title="用 refresh_token 免扫码续期登录态（需账号曾通过扫码登录获得续期凭据）">续期</button>
      </div>
      <div class="prog"><i style="width:${pct}%"></i></div>`;
    box.appendChild(el);
  }
}

function renderSelected() {
  const a = ST.accounts.find((x) => x.id === ST.selected);
  $('#cfg-panel').hidden = !a;
  if (!a) return;
  $('#cfg-uname').textContent = `${a.uname} (UID ${a.uid})`;
  const cfg = a.cfg || {};
  const T = cfg.tasks || {};
  const S = cfg.sources || {};
  $('#task-unfollow').checked = !!T.unfollow;
  $('#task-follow').checked = !!T.follow;
  $('#src-fans').checked = !!S.fans;
  $('#src-search').checked = !!S.search;
  $('#src-ups').checked = !!S.ups;

  $('#cfg-min').value = cfg.delayMin;
  $('#cfg-max').value = cfg.delayMax;
  $('#cfg-limit').value = cfg.maxOps;
  $('#cfg-keywords').value = cfg.searchKeywords || '';
  $('#cfg-searchpages').value = cfg.searchMaxPages || 2;
  $('#cfg-maxfans').value = cfg.searchMaxFans || 0;
  $('#cfg-minlevel').value = (cfg.searchMinLevel == null ? 1 : cfg.searchMinLevel);
  $('#cfg-targets').value = cfg.targetUps || '';
  $('#cfg-dry').checked = !!cfg.dryRun;
  $('#cfg-official').checked = !!cfg.skipOfficial;
  $('#cfg-special').checked = !!cfg.skipSpecial;
  $('#cfg-skipvip').checked = !!cfg.skipVip;
  $('#cfg-days').checked = !!cfg.onlyAfterDays;
  $('#cfg-days-n').value = cfg.minFollowDays || 7;
  $('#cfg-capguard').checked = cfg.capGuard !== false;
  $('#cfg-capguard-reserve').value = (cfg.capGuardReserve == null ? 100 : cfg.capGuardReserve);
  $('#cfg-loop').checked = !!cfg.autoLoop;
  $('#cfg-loop-min').value = cfg.loopIntervalMin || 30;
  $('#cfg-daily').value = cfg.dailyCap || 0;
  $('#cfg-errretry').value = (cfg.errRetryMin == null ? 0 : cfg.errRetryMin);
  $('#cfg-watchdog').value = (cfg.watchdogStallMin == null ? 15 : cfg.watchdogStallMin);
  $('#cfg-track-unfollowers').checked = cfg.trackUnfollowers !== false;
  syncCfgVisibility(cfg);

  const s = a.stats || {};
  const fs = a.followStats || {};
  const rate = fs.sample ? Math.round((fs.backed / fs.sample) * 100) + '%' : '—';
  $('#cfg-stats').innerHTML = `
    <div class="stat"><b>${s.scanned || 0}</b><span>已扫描</span></div>
    <div class="stat"><b>${s.dealt || 0}</b><span>已操作</span></div>
    <div class="stat"><b>${s.ok || 0}</b><span>成功</span></div>
    <div class="stat"><b style="color:#f87171">${s.fail || 0}</b><span>失败</span></div>
    <div class="stat"><b>${fs.tried || 0}</b><span>累计关注</span></div>
    <div class="stat"><b>${fs.backed || 0}</b><span>已回关</span></div>
    <div class="stat"><b style="color:#4ade80">${rate}</b><span>总回关率</span></div>
    <div class="stat"><b>${(fs.pendingVerify || []).length}</b><span>待核验</span></div>`;
}

function fillGlobalForm() {
  const g = ST.global || {};
  $('#g-pagegap').value = g.pageGap || 1200;
  $('#g-white').value = (g.whiteList || []).join(', ');
  $('#g-never').value = (g.neverFollow || []).join(', ');
  $('#g-threshold').value = Math.round((g.rateThreshold == null ? 0.15 : g.rateThreshold) * 100);
  $('#g-sample').value = g.rateMinSample || 20;
  $('#g-gap').value = g.rateVerifyGapHours || 24;
  $('#g-statint').value = g.statIntervalMin || 5;
  $('#g-followcap').value = (g.followCap == null ? 5000 : g.followCap);
  $('#g-quiet').value = g.quietHours || '';
  $('#g-restdays').value = (g.restDays || []).join(',');
  $('#g-autostart').checked = !!(g.autoStartOnLaunch);
  const um = g.updateMirror || 'auto';
  let mmode = 'auto', mcustom = '';
  if (um === 'direct') mmode = 'direct';
  else if (/^https?:\/\//i.test(um)) { mmode = 'custom'; mcustom = um; }
  $$('input[name=updmirror]').forEach((r) => { if (r.value === mmode) r.checked = true; });
  const mc = $('#g-mirror-custom'); if (mc) mc.value = mcustom;
  $('#never-count').textContent = `　共 ${(g.neverFollow || []).length} 个`;
}

function renderLogs() {
  const box = $('#logbox');
  box.innerHTML = '';
  for (const l of ST.logs) box.appendChild(logLine(l));
  box.scrollTop = box.scrollHeight;
}

function logLine(l) {
  const el = document.createElement('div');
  el.className = 'logline ' + (l.level || 'info');
  const who = nameOf(l.accountId);
  el.innerHTML = `<span class="t">${time(l.ts)}</span>` +
    (who ? `<span class="who">[${escapeHtml(who)}]</span>` : '') +
    `<span class="m">${escapeHtml(l.msg)}</span>`;
  return el;
}

function renderRecords() {
  const box = $('#recbox');
  if (!ST.records.length) { box.innerHTML = '<p class="muted" style="padding:10px">暂无记录</p>'; return; }
  let h = '<table><tr><th class="rc-time">时间</th><th>昵称</th><th>UID</th><th>结果</th><th>说明</th><th>来源</th></tr>';
  for (const r of ST.records.slice().reverse().slice(0, 500)) {
    const cls = /成功|已取关|已回粉/.test(r.result) ? 'res-ok'
      : /失败/.test(r.result) ? 'res-fail'
        : /待/.test(r.result) ? 'res-pending' : 'res-skip';
    h += `<tr><td class="rc-time">${escapeHtml(time(r.ts))}</td>` +
      `<td>${escapeHtml(r.uname || '')}</td><td>${escapeHtml(String(r.mid))}</td>` +
      `<td class="${cls}">${escapeHtml(r.result || '')}</td><td>${escapeHtml(r.detail || '')}</td>` +
      `<td>${escapeHtml(r.source ? sourceShort(r.source) : '')}</td></tr>`;
  }
  box.innerHTML = h + '</table>';
}

function renderStats() {
  const box = $('#statbox');
  const rows = [];
  for (const a of ST.accounts) {
    const fs = a.followStats || {};
    const by = fs.bySource || {};
    const keys = Object.keys(by);
    rows.push(`<div class="stat-acc">
      <div class="stat-acc-h">${escapeHtml(a.uname)}　<span class="muted">UID ${a.uid}</span>${a.live && a.live.at ? `<span class="muted upd">更新于 ${time(a.live.at)}</span>` : ''}</div>
      <div class="kv">
        <span class="mi">关注数<b>${fmtNum((a.live || {}).following)}</b></span>
        <span class="mi">粉丝数<b>${fmtNum((a.live || {}).follower)}</b></span>
        <span class="mi">今日操作<b>${(a.daily || {}).ops || 0}</b></span>
        <span class="mi">待核验<b>${(fs.pendingVerify || []).length}</b></span>
      </div>
      <div class="kv gain">
        <span class="mi">今日新增粉${fmtGain(followerGain('day', a))}</span>
        <span class="mi">本周新增${fmtGain(followerGain('week', a))}</span>
        <span class="mi">本月新增${fmtGain(followerGain('month', a))}</span>
        <span class="mi">本年新增${fmtGain(followerGain('year', a))}</span>
      </div>
      ${keys.length ? `<table>
        <tr><th>来源</th><th>已关注</th><th>已核验</th><th>回关</th><th>回关率</th><th>状态</th></tr>
        ${keys.map((k) => {
          const b = by[k];
          const rate = b.sample ? Math.round((b.back / b.sample) * 100) + '%' : '样本不足';
          const cls = b.stopped ? 'res-fail' : (b.sample && b.back / b.sample >= 0.3 ? 'res-ok' : 'res-pending');
          return `<tr><td>${escapeHtml(sourceText(k))}</td><td>${b.tried || 0}</td><td>${b.sample || 0}</td>` +
            `<td>${b.back || 0}</td><td class="${cls}">${rate}</td>` +
            `<td class="${b.stopped ? 'res-fail' : 'res-ok'}">${b.stopped ? '已停止' : '正常'}</td></tr>`;
        }).join('')}
      </table>` : '<p class="muted" style="padding:4px 0">尚无回关率数据（需先执行关注类任务并等待核验）</p>'}
    </div>`);
  }
  box.innerHTML = ST.accounts.length
    ? rows.join('')
    : '<p class="muted" style="padding:10px">请先登录账号</p>';
}

function renderUnfollowers() {
  const box = $('#unfollowerbox');
  const a = ST.accounts.find((x) => x.id === ST.selected);
  if (!a) { box.innerHTML = '<p class="muted" style="padding:10px">请先登录账号</p>'; return; }
  const list = (a.unfollowers || []);
  const btn = $('#btn-export-unfollower');
  if (btn) btn.disabled = !list.length;
  if (!list.length) {
    box.innerHTML = '<p class="muted" style="padding:10px">暂无取关记录。<br>' +
      '本功能每日自动比对一次粉丝快照，发现「关注你后又取关」的人会记到这里。<br>' +
      '首次运行会先建立粉丝基线，之后每天比对（若某天没跑任务则跳过当天比对）。<br>' +
      '<span class="warnline">注意：B站 粉丝列表接口仅开放前 1000 条，粉丝数超过 1000 的账号无法覆盖更早的取关者。</span></p>';
    return;
  }
  let h = '<table><tr><th>日期</th><th>昵称</th><th>UID</th><th>状态</th><th>操作</th></tr>';
  for (const u of list.slice().reverse().slice(0, 1000)) {
    const handled = u.handled;
    const stTxt = handled === 'blocked' ? '已拉黑' : handled === 'ignored' ? '已忽略'
      : handled === 'auto' ? '自动记录' : '未处理';
    const cls = (handled === 'blocked' || handled === 'ignored') ? 'res-skip' : 'res-pending';
    const ops = (handled === 'blocked' || handled === 'ignored')
      ? ''
      : `<button class="mini danger" data-act="block" data-mid="${escapeAttr(u.mid)}">加入黑名单</button>` +
        `<button class="mini" data-act="ignore" data-mid="${escapeAttr(u.mid)}">忽略</button>`;
    h += `<tr><td>${escapeHtml(u.date || '')}</td>` +
      `<td>${escapeHtml(u.uname || '')}</td><td>${escapeHtml(String(u.mid))}</td>` +
      `<td class="${cls}">${stTxt}</td><td class="ub-ops">${ops}</td></tr>`;
  }
  box.innerHTML = h + '</table>';
}

async function reloadUnfollowers(id) {
  try { const r = await window.api.unfollowerList(id); return (r && r.list) || []; }
  catch (e) { return []; }
}

async function doExportUnfollowers() {
  if (!ST.selected) return;
  const r = await window.api.unfollowerExport(ST.selected);
  if (!r.ok) return toast('导出失败：' + ((r && r.error) || ''));
  toast(`已导出 ${r.rows} 条记录 → ${r.path}`);
}

async function onUnfollowerBoxClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !ST.selected) return;
  const mid = btn.dataset.mid;
  const act = btn.dataset.act;
  btn.disabled = true;
  const r = await window.api.unfollowerMark(ST.selected, mid, act === 'ignore' ? 'ignored' : 'blocked');
  if (r && r.ok) {
    const a = ST.accounts.find((x) => x.id === ST.selected);
    if (a) a.unfollowers = await reloadUnfollowers(ST.selected);
    if (r.neverFollow) ST.global.neverFollow = r.neverFollow;
    renderUnfollowers();
    toast(act === 'ignore' ? '已忽略该用户' : '已加入黑名单');
  } else {
    toast('操作失败：' + ((r && r.error) || '未知'));
    btn.disabled = false;
  }
}

/* ─────────── 批量取关（一键取关 + 筛选） ─────────── */
/** 关系位 → 可读文本（2=我关注 4=TA回关 6=互关 128=拉黑） */
function relText(attr) {
  if (typeof attr !== 'number') return '未知';
  if (attr & 128) return '已拉黑';
  if ((attr & 6) === 6) return '互关';
  if (attr & 2) return '单向（我关注）';
  if (attr & 4) return 'TA 关注我';
  return '未关注';
}
function relClass(attr) {
  if (typeof attr !== 'number') return '';
  if (attr & 128) return 'res-skip';
  if ((attr & 6) === 6) return 'res-ok';
  if (attr & 2) return 'res-pending';
  if (attr & 4) return 'res-ok';
  return 'res-skip';
}
function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }
/** 渲染进程本地版活跃度分类（与 src/batch-unfollow.js 的 classifyActivity 语义一致） */
function activityOf(it) {
  if (it && it._activity) return it._activity;
  const now = Math.floor(Date.now() / 1000);
  const last = (it && typeof it.lastPubdate === 'number') ? it.lastPubdate : null;
  const count = (it && typeof it.archiveCount === 'number') ? it.archiveCount : 0;
  if (!count || !last) return { key: 'never', days: null, label: '从未投稿' };
  const days = Math.floor((now - last) / 86400);
  if (days <= 90) return { key: 'active', days, label: `活跃（${days}天前投稿）` };
  if (days <= 365) return { key: 'occasional', days, label: `偶尔（${days}天前）` };
  return { key: 'dormant', days, label: `沉寂（${days}天前）` };
}

/* 死粉三段细分（与 src/batch-unfollow.js 的 classifySegment 语义一致）。
   渲染进程无 node，这里本地实现精简版；enrich 后优先用服务端算好的 _segment。 */
const SEG_DORMANT_MAX_DAYS = 540;   // 与 batch-unfollow.js 保持一致
function segmentOf(it) {
  if (it && it._segment) return it._segment;
  if (it && it.flagDeleted) return { key: 'deleted', label: '已注销/不可关注', days: null };
  // 未分析（无最近投稿/投稿数数据）时返回 unknown，避免把「未分析」误标成「从未投稿」
  const hasData = (it && (typeof it.lastPubdate === 'number' || (typeof it.archiveCount === 'number' && it.archiveCount > 0)));
  if (!hasData) return { key: 'unknown', label: '待分析（先点「分析画像 / 活跃度」）', days: null };
  const act = activityOf(it);
  if (act.key === 'never') return { key: 'never', label: '从未投稿', days: null };
  if (act.key === 'active') return { key: 'active', label: act.label, days: act.days };
  if (act.key === 'occasional') return { key: 'occasional', label: act.label, days: act.days };
  const days = act.days;
  const archive = (it && typeof it.archiveCount === 'number') ? it.archiveCount : 0;
  if (archive >= 20) return { key: 'decay', label: `内容变质（曾高产 ${archive} 投稿，停更 ${days}天）`, days };
  if (days <= SEG_DORMANT_MAX_DAYS) return { key: 'dormant', label: `沉寂临界（${days}天前）`, days };
  return { key: 'stopped', label: `停更（${days}天前）`, days };
}
function removeBatchBar() {
  hideEl($('#batch-prog'));   // 仅隐藏，保留静态元素（ui 单测要求 id 存在于 HTML）
}

/** 批量取关面板内的加载态（带转圈），替代无反馈的「一直转圈」 */
function setBatchLoading(msg) {
  const box = $('#batchbox');
  if (box) box.innerHTML = `<div class="batch-msg"><span class="spinner"></span><div>${escapeHtml(msg)}</div></div>`;
}
/** 批量取关面板内的错误 / 警告 / 提示信息（错误会直接显示在面板里，不再只是 toast 一闪而过） */
function showBatchMessage(type, msg, sub) {
  const box = $('#batchbox');
  if (!box) return;
  const cls = type === 'error' ? 'is-error' : type === 'warn' ? 'is-warn' : 'is-info';
  box.innerHTML =
    `<div class="batch-msg ${cls}"><div>` +
    `<div class="bm-title">${escapeHtml(msg)}</div>` +
    (sub ? `<div class="bm-sub">${escapeHtml(sub)}</div>` : '') +
    `</div></div>`;
}

function switchBatchMode(mode) {
  BATCH.mode = mode;
  $$('.seg-btn[data-bmode]').forEach((b) => b.classList.toggle('active', b.dataset.bmode === mode));
  $('#batch-search-row').hidden = mode !== 'search';
  $('#batch-follow-row').hidden = mode !== 'follow';
  // 关注列表模式接口不返回对方粉丝数 → 粉丝数区间筛选不可用
  const fanDisabled = mode === 'follow';
  $('#batch-minfans').disabled = fanDisabled;
  $('#batch-maxfans').disabled = fanDisabled;
  $('#batch-fans-note').textContent = fanDisabled ? '（关注列表模式无粉丝数，请用搜索模式）' : '';
  if (fanDisabled) { $('#batch-minfans').value = ''; $('#batch-maxfans').value = ''; }
  BATCH.items = []; BATCH.filtered = []; BATCH.reqId++;   // 切模式清名单，防过期响应串台
  removeBatchBar();
  renderBatch();
  setStatus(mode === 'search' ? '关键字搜索模式：输入关键词后点「搜索」' : '我的关注列表模式：点「载入我的关注」');
}

async function doBatchSearch() {
  if (!ST.selected) return toast('请先选中一个账号');
  const kw = $('#batch-keyword').value.trim();
  if (!kw) return toast('请输入搜索关键词');
  const maxPages = $('#batch-search-pages').checked ? clampInt($('#batch-maxpages').value, 1, 20, 3) : 3;
  const reqId = ++BATCH.reqId;
  BATCH.loading = true; setBatchBusy(true);
  setBatchLoading('正在搜索「' + kw + '」…（通常需数秒到十余秒，请稍候）');
  setStatus('正在搜索「' + kw + '」…');
  let r;
  try { r = await window.api.unfollowSearch(ST.selected, kw, maxPages); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  if (reqId !== BATCH.reqId) return;   // 过期响应（用户已切模式/重新搜索）直接丢弃
  BATCH.loading = false; setBatchBusy(false);
  if (!r || !r.ok) {
    const m = (r && r.error) || '未知错误';
    setStatus('搜索失败：' + m);
    showBatchMessage('error', '搜索失败：' + m, '请检查账号登录态（点「刷新资料」或重新登录）；B 站搜索接口偶发限流，可稍后重试。');
    return;
  }
  BATCH.items = (r.list || []).map((it) => {
    const o = Object.assign({}, it, { selected: false, result: '', detail: '' });
    const p = BATCH.profiles[String(it.mid)];
    if (p && p._activity) o._activity = p._activity;
    return o;
  });
  applyBatchFilters();
  if (r.warning) {
    const box = $('#batchbox');
    if (box) {
      const w = document.createElement('div');
      w.className = 'batch-warn';
      w.textContent = r.warning;
      box.insertBefore(w, box.firstChild);
    }
  }
  if (r.authNote) {
    const box = $('#batchbox');
    if (box) {
      const w = document.createElement('div');
      w.className = 'batch-warn';
      w.textContent = r.authNote;
      box.insertBefore(w, box.firstChild);
    }
  }
  setStatus(`搜索「${kw}」返回 ${BATCH.items.length} 人，筛选后展示 ${BATCH.filtered.length} 人`);
  toast(`搜索到 ${BATCH.items.length} 人`);
}

async function doBatchLoad() {
  if (!ST.selected) return toast('请先选中一个账号');
  const reqId = ++BATCH.reqId;
  BATCH.loading = true; setBatchBusy(true);
  setBatchLoading('正在载入「我的关注」…（关注较多时可能需 10~30 秒，请稍候）');
  setStatus('正在载入我的关注列表…');
  let r;
  try { r = await window.api.unfollowLoadFollowings(ST.selected, 20); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  if (reqId !== BATCH.reqId) return;
  BATCH.loading = false; setBatchBusy(false);
  if (!r || !r.ok) {
    const m = (r && r.error) || '未知错误';
    setStatus('载入失败：' + m);
    showBatchMessage('error', '载入关注失败：' + m, '请检查账号登录态（点「刷新资料」或重新登录）；若提示限流可稍后重试。');
    return;
  }
  BATCH.items = (r.list || []).map((it) => {
    const o = Object.assign({}, it, { selected: false, result: '', detail: '' });
    const p = BATCH.profiles[String(it.mid)];
    if (p && p._activity) o._activity = p._activity;
    return o;
  });
  applyBatchFilters();
  if (r.warning) {
    const box = $('#batchbox');
    if (box) {
      const w = document.createElement('div');
      w.className = 'batch-warn';
      w.textContent = r.warning;
      box.insertBefore(w, box.firstChild);
    }
  }
  setStatus(`已载入关注 ${BATCH.items.length} 人（共 ${r.total} 关注），筛选后展示 ${BATCH.filtered.length} 人`);
  toast(`载入 ${BATCH.items.length} 人`);
}

function applyBatchFiltersLive() { applyBatchFilters(); }

/** 对当前筛选后的候选批量分析「昵称画像 + 活跃度（最近投稿）」 */
async function doBatchEnrich() {
  if (!ST.selected) return toast('请先选中一个账号');
  if (!BATCH.items.length) return toast('请先载入 / 搜索名单');
  const targets = (BATCH.filtered.length ? BATCH.filtered : BATCH.items).map((it) => String(it.mid));
  if (!targets.length) return toast('当前没有可分析的账号');
  const myReq = ++BATCH.enrichReqId;
  BATCH.enriching = true; setBatchBusy(true);
  const eb = $('#btn-batch-enrich'); if (eb) eb.disabled = true;
  showEl($('#batch-enrich-prog'));
  $('#batch-enrich-prog').querySelector('i').style.width = '0%';
  $('#batch-enrich-txt').textContent = `准备分析 ${targets.length} 人…`;
  setStatus(`正在分析 ${targets.length} 个账号的活跃度与画像（逐个查询空间，请稍候）…`);
  let r;
  try { r = await window.api.unfollowEnrich(ST.selected, targets); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  if (myReq !== BATCH.enrichReqId) return;   // 已被新一轮替代
  BATCH.enriching = false; setBatchBusy(false);
  if (eb) eb.disabled = false;
  if (!r || !r.ok) { setStatus('画像分析失败：' + ((r && r.error) || '未知')); return toast('分析失败：' + ((r && r.error) || '未知')); }
  const profs = r.profiles || {};
  for (const mid of Object.keys(profs)) {
    const p = profs[mid];
    BATCH.profiles[mid] = {
      lastPubdate: p.lastPubdate, archiveCount: p.archiveCount,
      activity: p.activity, activityLabel: p.activityLabel, activityDays: p.activityDays,
      segment: p.segment, segmentLabel: p.segmentLabel,
      _activity: { key: p.activity, days: p.activityDays, label: p.activityLabel },
      _segment: { key: p.segment, label: p.segmentLabel }
    };
    const it = BATCH.items.find((x) => String(x.mid) === String(mid));
    if (it) {
      it._activity = BATCH.profiles[mid]._activity;
      it._segment = BATCH.profiles[mid]._segment;
    }
  }
  applyBatchFilters();
  const n = Object.keys(profs).length;
  setStatus(`画像分析完成：${n} 人；活跃度已标注（活跃 / 偶尔 / 沉寂 / 从未投稿）。可叠加筛选后一键取关。`);
  toast(`分析完成 ${n} 人`);
  setTimeout(() => hideEl($('#batch-enrich-prog')), 1500);
}

/** 核对搜索结果的关注状态：搜索接口不返回 attribute，逐个查 /x/relation 填充，
 *  界面即可标出「已关注 / 未关注」，并让「仅我正关注的人」等筛选真正生效。需有效登录。 */
async function doBatchResolveRelations() {
  if (!ST.selected) return toast('请先选中一个账号');
  if (!BATCH.items.length) return toast('请先搜索 / 载入名单');
  const mids = BATCH.items.map((it) => String(it.mid));
  BATCH.loading = true; setBatchBusy(true);
  const btn = $('#btn-batch-checkrel'); if (btn) btn.disabled = true;
  setBatchLoading('正在核对关注状态…（逐个查询关系位，请稍候）');
  let r;
  try { r = await window.api.unfollowResolveRelations(ST.selected, mids); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  BATCH.loading = false; setBatchBusy(false);
  if (btn) btn.disabled = false;
  if (!r || !r.ok) {
    const m = (r && r.error) || '未知错误';
    setStatus('核对关注状态失败：' + m);
    showBatchMessage('error', '核对关注状态失败：' + m, '该功能需要有效登录（点账号「刷新资料 / 扫码登录」）。也可直接用「我的关注列表」模式，那里自带关注关系。');
    return;
  }
  const map = r.map || {};
  let filled = 0;
  for (const it of BATCH.items) {
    const a = map[String(it.mid)];
    if (typeof a === 'number') { it.attribute = a; filled++; }
  }
  applyBatchFilters();
  if (r.warning) {
    const box = $('#batchbox');
    if (box) {
      const w = document.createElement('div');
      w.className = 'batch-warn';
      w.textContent = r.warning;
      box.insertBefore(w, box.firstChild);
    }
  }
  setStatus(`已核对 ${filled} 人的关注状态（共 ${mids.length} 人）；卡片会显示「已关注 / 未关注」，勾选「仅我正关注的人」即可只取关真正关注的。`);
  toast(`已核对 ${filled} 人`);
}

/** 富集进度（只读，不写操作） */
async function onUnfollowEnrich(ev) {
  if (!ev || !ev.type) return;
  const bar = $('#batch-enrich-prog');
  if (!bar) return;
  if (ev.type === 'start') {
    showEl(bar); bar.querySelector('i').style.width = '0%';
    $('#batch-enrich-txt').textContent = `0 / ${ev.total}`;
    return;
  }
  if (ev.type === 'item') {
    const pct = ev.total ? Math.round((ev.done / ev.total) * 100) : 0;
    bar.querySelector('i').style.width = pct + '%';
    $('#batch-enrich-txt').textContent = `分析活跃度 ${ev.done} / ${ev.total}（成功 ${ev.ok} · 失败 ${ev.fail}）`;
    return;
  }
  if (ev.type === 'done') {
    bar.querySelector('i').style.width = '100%';
    $('#batch-enrich-txt').textContent = `完成：成功 ${ev.ok} · 失败 ${ev.fail}`;
  }
}

function applyBatchFilters() {
  const kw = $('#batch-filter-kw').value;
  const onlyOneWay = $('#batch-only-oneway').checked;
  const onlyFollowing = $('#batch-only-following').checked;
  const minFans = $('#batch-minfans').value;
  const maxFans = $('#batch-maxfans').value;
  const activity = $('#batch-activity') ? $('#batch-activity').value : '';
  const lastPostWithin = $('#batch-lastpost') ? Number($('#batch-lastpost').value) : NaN;
  const minLevel = $('#batch-minlevel') ? Number($('#batch-minlevel').value) : 0;
  const needSign = $('#batch-hassign') ? $('#batch-hassign').checked : false;
  const segment = $('#batch-segment') ? $('#batch-segment').value : '';
  // 与主进程 batch-unfollow.js 同一套语义（渲染进程无 node，这里本地实现精简版）
  BATCH.filtered = BATCH.items.filter((it) => {
    if (kw) {
      const h = `${it.uname || ''} ${it.mid || ''}`.toLowerCase();
      if (!h.includes(kw.toLowerCase())) return false;
    }
    const attr = (typeof it.attribute === 'number') ? it.attribute : null;
    if (onlyFollowing && attr !== null && !(attr & 2)) return false;
    if (onlyOneWay) {
      if (attr === null) return false;          // 关系未知，保守排除
      if (!(attr & 2)) return false;            // 我都没关注 TA
      if (attr & 4) return false;               // 互关排除
    }
    if (minFans !== '' && !Number.isNaN(Number(minFans)) && Number(it.fans || 0) < Number(minFans)) return false;
    if (maxFans !== '' && !Number.isNaN(Number(maxFans)) && Number(it.fans || 0) > Number(maxFans)) return false;
    // 活跃度分级
    const act = activityOf(it);
    if (activity && act.key !== activity) return false;
    if (!Number.isNaN(lastPostWithin) && lastPostWithin > 0) {
      if (act.days == null || act.days > lastPostWithin) return false;
    }
    if (!Number.isNaN(minLevel) && minLevel > 0 && Number(it.level || 0) < minLevel) return false;
    if (needSign && !(it.sign && String(it.sign).trim())) return false;
    // 死粉分段（需先「分析画像 / 活跃度」得到最近投稿/投稿数；未分析时分段为 never/unknown 不会被误判）
    if (segment) {
      const seg = segmentOf(it);
      if (seg.key !== segment) return false;
    }
    return true;
  });
  renderBatch();
}

function setBatchBusy(b) {
  $('#btn-batch-search').disabled = b;
  $('#btn-batch-load').disabled = b;
  $('#btn-batch-checkrel').disabled = b;
}

function renderBatch() {
  const box = $('#batchbox');
  const a = ST.accounts.find((x) => x.id === ST.selected);
  if (!a) { box.innerHTML = '<p class="muted" style="padding:10px">请先登录并选中一个账号</p>'; updateBatchCounts(); return; }
  $('#batch-acc-hint').textContent = `当前账号：${a.uname}`;
  if (!BATCH.items.length) {
    box.innerHTML = '<p class="muted" style="padding:12px">选择上方模式并「加载 / 搜索」后，这里会列出可批量取关的对象。' +
      '建议：先用「我的关注列表 → 载入我的关注」穷举所有单向关注，再点「分析画像 / 活跃度」获取昵称画像与最近投稿情况。</p>';
    updateBatchCounts();
    return;
  }
  const rows = BATCH.filtered;
  if (!rows.length) {
    box.innerHTML = '<p class="muted" style="padding:12px">当前筛选条件下没有可显示的对象，放宽条件试试。</p>';
    updateBatchCounts();
    return;
  }
  const oneWay = BATCH.items.filter((it) => {
    const attr = (typeof it.attribute === 'number') ? it.attribute : null;
    return attr !== null && (attr & 2) && !(attr & 4);
  }).length;
  const analyzed = Object.keys(BATCH.profiles).length;
  let h = `<div class="bsum">可一键取关（单向关注）：<b>${oneWay}</b> 人 · 已分析画像：<b>${analyzed}</b> / ${BATCH.items.length} 人</div>`;
  h += '<div class="bgrid">';
  for (const it of rows) {
    const canPick = !BATCH.executing;
    const act = activityOf(it);
    const seg = segmentOf(it);
    const faceUrl = it.face || '';
    const initial = escapeHtml((it.uname || '?').slice(0, 1));
    const avatar = faceUrl
      ? `<img class="bavatar" src="${escapeAttr(faceUrl)}" alt="" onerror="this.style.display='none'">`
      : `<div class="bavatar bavatar-ph">${initial}</div>`;
    h += `<div class="bcard" data-mid="${escapeAttr(it.mid)}">` +
      `<label class="bchkwrap"><input type="checkbox" class="bchk" data-mid="${escapeAttr(it.mid)}" ${it.selected ? 'checked' : ''} ${canPick ? '' : 'disabled'}></label>` +
      avatar +
      `<div class="bmeta">` +
        `<div class="bname">${escapeHtml(it.uname || '')} <span class="buid">${escapeHtml(String(it.mid))}</span></div>` +
        `<div class="bpills">` +
          `<span class="pill ${relClass(it.attribute)}">${relText(it.attribute)}</span>` +
          `<span class="pill fans">粉丝 ${it.fans == null ? '—' : fmtNum(it.fans)}</span>` +
          `<span class="pill act-${act.key}">${escapeHtml(act.label)}</span>` +
          `<span class="pill seg-${seg.key}">${escapeHtml(seg.label)}</span>` +
        `</div>` +
        (it.sign ? `<div class="bsign">${escapeHtml(String(it.sign).slice(0, 60))}</div>` : '') +
        (it.result ? `<div class="bstatus ${/已取关/.test(it.result) ? 'res-ok' : /失败/.test(it.result) ? 'res-fail' : 'res-skip'}">${escapeHtml(it.result)}${it.detail ? ' · ' + escapeHtml(it.detail) : ''}</div>` : '') +
      `</div>` +
    `</div>`;
  }
  h += '</div>';
  box.innerHTML = h;
  box.querySelectorAll('.bchk').forEach((cb) => {
    cb.onchange = () => {
      const it = BATCH.filtered.find((x) => String(x.mid) === String(cb.dataset.mid));
      if (it) { it.selected = cb.checked; updateBatchCounts(); }
    };
  });
  updateBatchCounts();
}

function updateBatchCounts() {
  const total = BATCH.items.length;
  const shown = BATCH.filtered.length;
  const sel = BATCH.filtered.filter((x) => x.selected).length;
  $('#batch-count').textContent = `共 ${total} 人 · 筛选后 ${shown} 人 · 已选 ${sel} 人`;
  const btn = $('#btn-batch-unfollow');
  btn.textContent = `一键取关（${sel}）`;
  btn.disabled = sel === 0 || BATCH.loading || BATCH.executing;
  const bb = $('#btn-batch-backup');
  if (bb) bb.disabled = sel === 0 || BATCH.loading || BATCH.executing;
  const eb = $('#btn-batch-enrich');
  if (eb) eb.disabled = total === 0 || BATCH.loading || BATCH.executing || BATCH.enriching;
  const crb = $('#btn-batch-checkrel');
  if (crb) crb.disabled = total === 0 || BATCH.loading || BATCH.executing || BATCH.enriching || BATCH.mode !== 'search';
}

function onBatchSelAll(e) {
  const check = e.target.checked;
  BATCH.filtered.forEach((it) => { it.selected = check; });
  renderBatch();
}

function openBatchConfirm() {
  const sel = BATCH.filtered.filter((x) => x.selected);
  if (!sel.length) return;
  $('#batch-confirm-n').textContent = sel.length;
  let h = '<table><tr><th>昵称</th><th>UID</th><th>关系</th><th>活跃度</th><th>死粉分段</th></tr>';
  for (const it of sel.slice(0, 30)) {
    const act = activityOf(it);
    const seg = segmentOf(it);
    h += `<tr><td>${escapeHtml(it.uname || '')}</td><td>${escapeHtml(String(it.mid))}</td><td>${relText(it.attribute)}</td><td>${escapeHtml(act.label)}</td><td>${escapeHtml(seg.label)}</td></tr>`;
  }
  if (sel.length > 30) h += `<tr><td colspan="5" class="muted">… 其余 ${sel.length - 30} 人略</td></tr>`;
  h += '</table>';
  $('#batch-confirm-list').innerHTML = h;

  // 演示 / 备份闸门提示：让用户清楚「这一步到底会发生什么」
  const a = ST.accounts.find((x) => x.id === ST.selected);
  const demo = $('#batch-demo') && $('#batch-demo').checked;
  const backupOn = !a || a.cfg.backupBeforeUnfollow !== false;
  const notes = [];
  if (demo) notes.push('① 演示模式：本次只预览「将取关名单」与跳过原因，不发送任何真实取关请求。');
  else notes.push('① 真实执行：将向 B 站发送取关请求，不可撤销。');
  if (!demo && backupOn) notes.push('② 执行前会自动导出待操作名单 CSV 备份（防误删，可回溯）。');
  if (!demo && !backupOn) notes.push('② 已关闭「执行前备份」（不推荐）。');
  $('#batch-confirm-msg').textContent = notes.join(' ');
  showEl($('#modal-batch'));
}

async function doBatchUnfollow() {
  const sel = BATCH.filtered.filter((x) => x.selected);
  if (!sel.length) return;
  hideEl($('#modal-batch'));
  const previewOnly = $('#batch-demo') && $('#batch-demo').checked;
  const sessionCap = $('#batch-session-cap') ? clampInt($('#batch-session-cap').value, 0, 100000, 0) : 0;
  const skipRecent = $('#batch-skip-days') ? clampInt($('#batch-skip-days').value, 0, 100000, 0) : 0;
  BATCH.executing = true;
  setBatchBusy(true);
  $('#batch-selall').disabled = true;
  setStatus(previewOnly
    ? `正在预览取关名单（演示模式，不会真正取关）…`
    : `正在批量取关 ${sel.length} 人…（白名单/互关/不关注名单/已注销会被跳过）`);
  sel.forEach((it) => { it.result = ''; it.detail = ''; });
  renderBatch();
  removeBatchBar();
  showEl($('#batch-prog'));
  const barEl = $('#batch-prog');
  if (barEl) { barEl.querySelector('i').style.width = '0%'; $('#batch-prog-txt').textContent = ''; }
  const items = sel.map((it) => {
    const seg = segmentOf(it);
    return {
      mid: String(it.mid), uname: it.uname, attribute: it.attribute, fans: it.fans,
      segment: seg.key, segmentLabel: seg.label, followDays: it.followDays != null ? it.followDays : null
    };
  });
  try {
    const r = await window.api.unfollowBatch(ST.selected, items, {
      excludeMutual: true, excludeSpecial: true,
      previewOnly, sessionCap, skipRecentFollowDays: skipRecent
    });
    if (previewOnly && r && r.ok) {
      // 预览完成：展示将取关 / 跳过计划与备份路径，不刷新统计（没有真实变更）
      const willUnfollow = r.willUnfollow || (r.plan ? r.plan.filter((x) => x.result === '将取关').length : 0);
      setStatus(`演示模式完成：将取关约 ${willUnfollow} 人，跳过 ${sel.length - willUnfollow} 人（未发送任何请求）`);
      showBatchMessage('info',
        `演示模式预览完成：将取关 ${willUnfollow} 人、跳过 ${sel.length - willUnfollow} 人。`,
        (r.backupPath ? '待操作名单已导出备份：' + r.backupPath : '未导出备份。') + ' 取消勾选「演示模式」并再次确认即可真正执行。');
      toast(`演示模式：将取关约 ${willUnfollow} 人`);
    }
  } catch (e) {
    toast('批量取关异常：' + ((e && e.message) || e));
    BATCH.executing = false; setBatchBusy(false); $('#batch-selall').disabled = false; updateBatchCounts();
  }
}

/** 把当前已选名单导出为本地 CSV 备份（不发送任何请求，纯本地） */
async function doBatchExportBackup() {
  if (!ST.selected) return toast('请先选中一个账号');
  const sel = BATCH.filtered.filter((x) => x.selected);
  if (!sel.length) return toast('请先勾选要备份的账号');
  const items = sel.map((it) => {
    const seg = segmentOf(it);
    return { mid: String(it.mid), uname: it.uname, segment: seg.key };
  });
  let r;
  try { r = await window.api.unfollowExportBackup(ST.selected, items); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  if (!r || !r.ok) return toast('导出备份失败：' + ((r && r.error) || '未知'));
  toast('已导出待操作备份：' + r.path);
  setStatus('已导出待操作名单备份：' + r.path);
}

/** 解析「文件级同步」目标集文本：每行 `MID,昵称`（昵称可空），忽略空行与非法行 */
function parseSyncTarget(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.split(/[,，\t]/).map((s) => s.trim());
    const mid = m[0];
    if (!/^\d+$/.test(mid)) continue;   // 首字段必须是纯数字 UID，否则跳过该行
    out.push({ mid, uname: m[1] || '' });
  }
  return out;
}

/** 计算同步计划：当前关注（来自「我的关注列表」载入）与目标集做集合求差 */
async function doSyncPlan() {
  if (!ST.selected) return toast('请先选中一个账号');
  if (BATCH.mode !== 'follow' || !BATCH.items.length) {
    return toast('请先用「我的关注列表 → 载入我的关注」载入当前关注，作为求差的基准');
  }
  const target = parseSyncTarget($('#sync-target').value);
  if (!target.length) return toast('请先粘贴目标关注集（每行 MID,昵称）');
  const current = BATCH.items.map((it) => ({ mid: String(it.mid), uname: it.uname || '' }));
  let r;
  try { r = await window.api.unfollowSyncPlan(ST.selected, current, target); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  if (!r || !r.ok) return toast('计算同步计划失败：' + ((r && r.error) || '未知'));
  SYNC_PLAN = r;
  const box = $('#sync-plan-box');
  box.hidden = false;
  const tf = (r.toFollow || []).slice(0, 60);
  const tu = (r.toUnfollow || []).slice(0, 60);
  let h = `<div class="sync-summary">目标 ${target.length} 人 · 当前关注 ${current.length} 人　→　` +
    `<b class="tofollow">补关注 ${r.toFollow.length}</b> · <b class="tounfollow">取关多余 ${r.toUnfollow.length}</b> · 不变 ${r.unchangedCount}</div>`;
  h += '<div class="sync-cols">';
  h += '<div><div class="sync-col-h tofollow">补关注（目标有、当前没有）</div>' +
    (tf.length ? '<table>' + tf.map((x) => `<tr><td>${escapeHtml(x.uname || '(无名)')}</td><td>${escapeHtml(x.mid)}</td></tr>`).join('') + '</table>' : '<p class="muted">无</p>') + '</div>';
  h += '<div><div class="sync-col-h tounfollow">取关多余（当前有、目标没有）</div>' +
    (tu.length ? '<table>' + tu.map((x) => `<tr><td>${escapeHtml(x.uname || '(无名)')}</td><td>${escapeHtml(x.mid)}</td></tr>`).join('') + '</table>' : '<p class="muted">无</p>') + '</div>';
  h += '</div>';
  if (r.toFollow.length > 60 || r.toUnfollow.length > 60) h += `<p class="muted">（仅预览前 60 条，执行时按完整名单处理）</p>`;
  box.innerHTML = h;
  $('#sync-exec-row').hidden = false;
  setStatus(`同步计划：补关注 ${r.toFollow.length} 人 · 取关 ${r.toUnfollow.length} 人`);
  toast(`同步计划已生成：补 ${r.toFollow.length} / 取关 ${r.toUnfollow.length}`);
}

/** 执行同步：先补关注（followBatch），再取关多余（batch）。演示模式只预览不执行。 */
async function doSyncRun() {
  if (!SYNC_PLAN) return toast('请先「计算同步计划」');
  const demo = $('#sync-demo') && $('#sync-demo').checked;
  if (demo) {
    toast(`演示模式：将补关注 ${SYNC_PLAN.toFollow.length} 人、取关 ${SYNC_PLAN.toUnfollow.length} 人（未执行）`);
    setStatus(`同步预览：补关注 ${SYNC_PLAN.toFollow.length} · 取关 ${SYNC_PLAN.toUnfollow.length}（未发送请求）`);
    return;
  }
  if (!ST.selected) return toast('请先选中一个账号');
  BATCH.executing = true; setBatchBusy(true);
  setStatus('正在执行同步：先补关注，再取关多余…');
  removeBatchBar(); showEl($('#batch-prog'));
  const barEl = $('#batch-prog');
  if (barEl) { barEl.querySelector('i').style.width = '0%'; $('#batch-prog-txt').textContent = ''; }
  try {
    if (SYNC_PLAN.toFollow.length) {
      await window.api.unfollowFollowBatch(ST.selected, SYNC_PLAN.toFollow, { excludeMutual: true });
    }
    if (SYNC_PLAN.toUnfollow.length) {
      const items = SYNC_PLAN.toUnfollow.map((it) => ({ mid: String(it.mid), uname: it.uname, attribute: 2 }));
      await window.api.unfollowBatch(ST.selected, items, { excludeMutual: true, excludeSpecial: true, previewOnly: false });
    }
    toast('同步执行完成');
    setStatus('同步执行完成');
  } catch (e) {
    toast('同步执行异常：' + ((e && e.message) || e));
  } finally {
    BATCH.executing = false; setBatchBusy(false); updateBatchCounts();
    if (ST.selected) { try { await window.api.refreshStats(); } catch (e) { /* ignore */ } await reloadState(); }
  }
}

async function onUnfollowProgress(ev) {
  if (!ev || !ev.type) return;
  const box = $('#batchbox');
  const bar = $('#batch-prog');
  if (ev.type === 'start') {
    if (bar) { bar.querySelector('i').style.width = '0%'; $('#batch-prog-txt').textContent = `0 / ${ev.total}`; }
    return;
  }
  if (ev.type === 'item') {
    const row = box.querySelector(`.bcard[data-mid="${cssEscape(ev.mid)}"]`);
    if (row) {
      const cls = /已取关/.test(ev.result) ? 'res-ok' : /失败/.test(ev.result) ? 'res-fail' : 'res-skip';
      const cell = row.querySelector('.bstatus');
      if (cell) { cell.className = 'bstatus ' + cls; cell.textContent = ev.result + (ev.detail ? ' · ' + ev.detail : ''); }
    }
    if (bar) {
      const pct = ev.total ? Math.round((ev.done / ev.total) * 100) : 0;
      bar.querySelector('i').style.width = pct + '%';
      $('#batch-prog-txt').textContent = `${ev.done} / ${ev.total}（成功 ${ev.ok} · 失败 ${ev.fail} · 跳过 ${ev.skip}）`;
    }
    return;
  }
  if (ev.type === 'done') {
    BATCH.executing = false; setBatchBusy(false); $('#batch-selall').disabled = false;
    updateBatchCounts();
    if (bar) {
      bar.querySelector('i').style.width = '100%';
      $('#batch-prog-txt').textContent = ev.preview
        ? `预览完成：将取关 ${ev.ok} · 跳过 ${ev.skip}`
        : `完成：成功 ${ev.ok} · 失败 ${ev.fail} · 跳过 ${ev.skip}`;
    }
    if (ev.preview) {
      setStatus(`演示模式完成：将取关 ${ev.ok} 人（未发送任何请求）`);
      // 预览不刷新统计（没有真实变更），详细计划已由 doBatchUnfollow 的返回结果展示
    } else {
      setStatus(`批量取关完成：成功 ${ev.ok} · 失败 ${ev.fail} · 跳过 ${ev.skip}`);
      toast(`批量取关完成：成功 ${ev.ok} 人`);
      if (ST.selected) { try { await window.api.refreshStats(); } catch (e) { /* ignore */ } await reloadState(); }
    }
  }
}

/* ─────────── 事件回调 ─────────── */
function onLog(l) { appendLog(l); }
function onRecord(r) {
  ST.records.push(r);
  if (ST.records.length > 3000) ST.records.shift();
  scheduleRender('records', renderRecords);
}
function onAccountState(d) {
  const a = ST.accounts.find((x) => x.id === d.id);
  if (!a) return;
  a.state = d.state;
  if (d.stats) a.stats = Object.assign({}, a.stats, d.stats);
  if (d.live) a.live = d.live;
  renderAccounts();
  refreshDutyBtn();
  if (d.id === ST.selected) renderSelected();
}
function onStats(d) {
  const a = ST.accounts.find((x) => x.id === d.accountId);
  if (!a) return;
  a.followStats = d.followStats || a.followStats;
  a.live = d.live || a.live;
  a.daily = d.daily || a.daily;
  if (d.unfollowers) a.unfollowers = d.unfollowers;
  renderAccounts();
  if (d.accountId === ST.selected) renderSelected();
  scheduleRender('stats', renderStats);
  if (d.accountId === ST.selected && ST.tab === 'unfollower') scheduleRender('unfollower', renderUnfollowers);
}
function onLive(d) {
  const a = ST.accounts.find((x) => x.id === d.accountId);
  if (!a || !d.live) return;
  a.live = d.live;
  if (d.followerLog) a.followerLog = d.followerLog;
  renderAccounts();
  renderStats();
}

/* ─────────── 工具 ─────────── */
function appendLog(l) {
  const box = $('#logbox');
  box.appendChild(logLine(l));
  while (box.childElementCount > 600) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function nameOf(id) {
  if (!id) return '';
  const a = ST.accounts.find((x) => x.id === id);
  return a ? a.uname : '';
}
function time(ts) { return new Date(ts || Date.now()).toTimeString().slice(0, 8); }
function fmtNum(n) {
  if (n == null) return '—';
  return String(n);
}
function fmtCountdown(sec) {
  const m = Math.ceil(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
}
function delta(n) {
  if (!n) return '<i class="d0">±0</i>';
  return n > 0 ? `<i class="dup">+${n}</i>` : `<i class="ddn">${n}</i>`;
}
/** 粉丝净增：当前粉丝数 − 周期起点（本周一/本月1号/本年1月1号，或今天00:00取昨天基线） */
function followerGain(period, a) {
  const log = (a && a.followerLog) || {};
  const cur = (a && a.live && a.live.follower) || 0;
  const keys = Object.keys(log).sort();
  if (!keys.length) return null;   // 还没任何快照 → 显示「—」
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start;
  if (period === 'day') start = d;                                   // 今天 00:00 → 基线取昨天
  else if (period === 'week') { d.setDate(d.getDate() - d.getDay()); start = d; }   // 周一
  else if (period === 'month') { d.setDate(1); start = d; }          // 本月 1 号
  else { d.setMonth(0, 1); start = d; }                              // 本年 1 月 1 日
  let base = null;
  for (const k of keys) {
    const dd = new Date(k + 'T00:00:00');
    if (dd < start) base = log[k]; else break;
  }
  // 没有更早的快照 → 返回 null（界面显示「— / 基线不足」，不谎报 0）
  return base == null ? null : cur - base;
}
function fmtGain(n) {
  if (n == null) return '<i class="gain-na" title="基线不足：需至少 2 天粉丝快照才能算周期净增">—</i>';
  if (!n) return '0';
  return n > 0 ? `<i class="dup">+${n}</i>` : `<i class="ddn">${n}</i>`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function escapeAttr(s) { return escapeHtml(s); }
function stateText(st) {
  return ({
    idle: '空闲', running: '运行中', waiting: '等待下轮', paused: '限流暂停',
    stopping: '停止中', done: '已完成', error: '异常', restart: '异常重启中'
  })[st] || st;
}
/** 任务类型的简短描述（多选，最多显示两项 + 省略） */
function modeText(cfg) {
  const c = cfg || {};
  const T = c.tasks || {};
  const S = c.sources || {};
  const parts = [];
  if (T.unfollow) parts.push('清理单向');
  if (T.follow) {
    const s = [];
    if (S.fans) s.push('粉丝');
    if (S.search) s.push('搜索');
    if (S.ups) s.push('指定UP');
    parts.push('关注' + (s.length ? '(' + s.join('/') + ')' : '(未选来源)'));
  }
  return parts.length ? parts.join('+') : '未选任务';
}
/** 来源 key → 可读名称 */
function sourceText(key) {
  const k = String(key || '');
  if (k === 'self' || k === 'fans' || k === '') return '我的粉丝';
  if (k.startsWith('search:')) return '搜索「' + k.slice(7) + '」';
  return 'UP ' + k;
}
/** 明细表里空间窄，用更短的写法 */
function sourceShort(key) {
  const k = String(key || '');
  if (!k || k === 'self' || k === 'fans') return '粉丝';
  if (k.startsWith('search:')) return '搜·' + k.slice(7);
  return 'UP' + k;
}
function setStatus(t) { $('#status').textContent = t; }
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

boot();
