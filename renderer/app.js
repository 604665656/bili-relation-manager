'use strict';
/* 渲染进程：无 Node 访问，全部通过 window.api（preload 白名单） */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const ST = { accounts: [], global: {}, selected: null, records: [], logs: [] };

/* ─────────── 启动 ─────────── */
async function boot() {
  // 启动第一件事：强制隐藏所有浮层，绝不依赖样式表
  ['#modal-import', '#modal-support', '#login-bar'].forEach((sel) => hideEl($(sel)));
  wireEvents();
  await reloadState();
  window.api.onLog(onLog);
  window.api.onRecord(onRecord);
  window.api.onAccount(onAccountState);
  window.api.onStats(onStats);
  window.api.onLive(onLive);
  window.api.onBusy((d) => setStatus(d.busy ? '任务运行中…' : '就绪'));
  // 菜单「帮助 → 联系合作 / 打赏支持」
  if (window.api.onMenuOpenSupport) window.api.onMenuOpenSupport(() => openSupport());
}

async function reloadState() {
  const s = await window.api.getState();
  ST.accounts = s.accounts || [];
  ST.global = s.global || {};
  ST.logs = s.logs || [];
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
}

/* ─────────── 交互绑定 ─────────── */
function wireEvents() {
  $('#btn-add').onclick = doLogin;
  $('#btn-import').onclick = openImport;
  $('#btn-login-refresh').onclick = () => window.api.loginRefresh();
  $('#btn-login-cancel').onclick = () => window.api.loginCancel();
  $('#btn-login-manual').onclick = () => { window.api.loginCancel(); openImport(); };
  $('#btn-import-ok').onclick = doImport;
  $('#btn-import-cancel').onclick = closeImport;
  // 点遮罩空白处关闭
  $('#modal-import').onclick = (e) => { if (e.target === $('#modal-import')) closeImport(); };
  // 联系合作 / 打赏支持
  $('#btn-support').onclick = openSupport;
  $('#btn-support-close').onclick = closeSupport;
  $('#modal-support').onclick = (e) => { if (e.target === $('#modal-support')) closeSupport(); };
  // Esc 关闭弹窗 / 收起登录提示条
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeImport();
      closeSupport();
      hideEl($('#login-bar'));
    }
  });
  $('#btn-start-all').onclick = () => doStart(ST.accounts.map((a) => a.id));
  $('#btn-stop-all').onclick = async () => { await window.api.stopTasks(null); toast('已请求停止全部账号'); };
  $('#btn-export').onclick = doExport;
  $('#btn-datadir').onclick = () => window.api.openDataDir();
  $('#btn-refresh-stats').onclick = async () => { setStatus('正在刷新统计…'); await window.api.refreshStats(); await reloadState(); toast('统计已刷新'); setStatus('就绪'); };

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
    '#cfg-watchdog',
    '#cfg-keywords', '#cfg-searchpages', '#cfg-maxfans', '#cfg-minlevel']
    .forEach((sel) => $(sel).addEventListener('change', autoSaveCfg));
  ['#cfg-official', '#cfg-special', '#cfg-dry', '#cfg-days', '#cfg-loop']
    .forEach((sel) => $(sel).addEventListener('change', () => { autoSaveCfg(); renderSelected(); }));
  // 任务类型 / 来源都是多选：勾完立刻存盘并刷新可见行
  ['#task-unfollow', '#task-follow', '#src-fans', '#src-search', '#src-ups']
    .forEach((sel) => $(sel).addEventListener('change', () => { autoSaveCfg(); syncCfgVisibility(); }));

  $$('.tab').forEach((t) => t.onclick = () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('#pane-log').hidden = t.dataset.tab !== 'log';
    $('#pane-record').hidden = t.dataset.tab !== 'record';
    $('#pane-stat').hidden = t.dataset.tab !== 'stat';
  });
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
    autoLoop: $('#cfg-loop').checked,
    loopIntervalMin: clampInt($('#cfg-loop-min').value, 1, 1440, 30),
    dailyCap: clampInt($('#cfg-daily').value, 0, 2000, 0),
    errRetryMin: clampInt($('#cfg-errretry').value, 0, 1440, 0),
    watchdogStallMin: clampInt($('#cfg-watchdog').value, 0, 240, 15),
    onlyAfterDays: $('#cfg-days').checked,
    minFollowDays: clampInt($('#cfg-days-n').value, 1, 365, 7),
    targetUps: String($('#cfg-targets').value || '').trim()
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

function openImport() {
  const m = $('#modal-import');
  $('#import-msg').textContent = '';
  $('#import-cookie').value = '';
  showEl(m);
  $('#import-cookie').focus();
}
function closeImport() { hideEl($('#modal-import')); }

function openSupport() { showEl($('#modal-support')); }
function closeSupport() { hideEl($('#modal-support')); }

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
  const g = {
    autoStartOnLaunch: $('#g-autostart').checked,
    pageGap: clampInt($('#g-pagegap').value, 300, 60000, 1200),
    whiteList: String($('#g-white').value || '').split(/[\s,，;；\n]+/).filter(Boolean),
    rateThreshold: clampInt($('#g-threshold').value, 0, 100, 15) / 100,
    rateMinSample: clampInt($('#g-sample').value, 5, 500, 20),
    rateVerifyGapHours: clampInt($('#g-gap').value, 1, 168, 24),
    statIntervalMin: clampInt($('#g-statint').value, 1, 60, 5)
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
    el.onclick = () => { ST.selected = a.id; renderAll(); };

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
  $('#cfg-days').checked = !!cfg.onlyAfterDays;
  $('#cfg-days-n').value = cfg.minFollowDays || 7;
  $('#cfg-loop').checked = !!cfg.autoLoop;
  $('#cfg-loop-min').value = cfg.loopIntervalMin || 30;
  $('#cfg-daily').value = cfg.dailyCap || 0;
  $('#cfg-errretry').value = (cfg.errRetryMin == null ? 0 : cfg.errRetryMin);
  $('#cfg-watchdog').value = (cfg.watchdogStallMin == null ? 15 : cfg.watchdogStallMin);
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
  $('#g-autostart').checked = !!(g.autoStartOnLaunch);
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
  let h = '<table><tr><th>昵称</th><th>UID</th><th>结果</th><th>说明</th><th>来源</th></tr>';
  for (const r of ST.records.slice().reverse().slice(0, 500)) {
    const cls = /成功|已取关|已回粉/.test(r.result) ? 'res-ok'
      : /失败/.test(r.result) ? 'res-fail'
        : /待/.test(r.result) ? 'res-pending' : 'res-skip';
    h += `<tr><td>${escapeHtml(r.uname || '')}</td><td>${escapeHtml(String(r.mid))}</td>` +
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
      <div class="stat-acc-h">${escapeHtml(a.uname)}　<span class="muted">UID ${a.uid}</span></div>
      <div class="kv"><span>关注数</span><b>${fmtNum((a.live || {}).following)}</b>
        <span>粉丝数</span><b>${fmtNum((a.live || {}).follower)}</b>
        <span>今日操作</span><b>${(a.daily || {}).ops || 0}</b>
        <span>待核验</span><b>${(fs.pendingVerify || []).length}</b></div>
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

/* ─────────── 事件回调 ─────────── */
function onLog(l) { appendLog(l); }
function onRecord(r) {
  ST.records.push(r);
  if (ST.records.length > 3000) ST.records.shift();
  renderRecords();
}
function onAccountState(d) {
  const a = ST.accounts.find((x) => x.id === d.id);
  if (!a) return;
  a.state = d.state;
  if (d.stats) a.stats = Object.assign({}, a.stats, d.stats);
  if (d.live) a.live = d.live;
  renderAccounts();
  if (d.id === ST.selected) renderSelected();
}
function onStats(d) {
  const a = ST.accounts.find((x) => x.id === d.accountId);
  if (!a) return;
  a.followStats = d.followStats || a.followStats;
  a.live = d.live || a.live;
  a.daily = d.daily || a.daily;
  renderAccounts();
  if (d.accountId === ST.selected) renderSelected();
  renderStats();
}
function onLive(d) {
  const a = ST.accounts.find((x) => x.id === d.accountId);
  if (!a || !d.live) return;
  a.live = d.live;
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
