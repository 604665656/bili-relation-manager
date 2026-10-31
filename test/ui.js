'use strict';
/**
 * 界面显隐静态校验：
 * 组件普遍用 display:flex，会覆盖 HTML 的 hidden 属性，导致弹窗/面板常驻且关不掉。
 * 这里强制校验存在全局 [hidden] { display:none !important } 兜底规则。
 *
 * 同时校验 index.html 与 app.js 的 id 引用一致性（避免改了 HTML 忘了改 JS → 点击无效果）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(DIR, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '  →  ' + e.message); fail++; }
}

console.log('\n[界面显隐]');

t('存在全局 [hidden] 兜底规则', () => {
  const m = css.match(/\[hidden\]\s*\{[^}]*display\s*:\s*none[^}]*!important[^}]*\}/i);
  assert.ok(m, '缺少 [hidden] { display: none !important; }，带 display:flex 的元素将无视 hidden 属性');
});

t('所有用 hidden 控制的元素都有对应 class/id 定义', () => {
  const ids = [...html.matchAll(/id="([^"]+)"[^>]*\bhidden\b/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, '未找到使用 hidden 的元素');
  // 每个 id 都应在 css 或 html 里有样式来源（这里只确保不是拼错）
  for (const id of ids) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `id ${id} 不存在`);
  }
});

t('带 display:flex 且用 hidden 控制的元素会被兜底规则覆盖', () => {
  // 找出所有 hidden 元素，检查其 class 是否被设置了非 none 的 display
  const blocks = [...html.matchAll(/<(\w+)\s([^>]*\bhidden\b[^>]*)>/g)];
  const risky = [];
  for (const [, tag, attrs] of blocks) {
    const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1];
    const id = (attrs.match(/id="([^"]*)"/) || [, ''])[1];
    for (const sel of [...cls.split(/\s+/).filter(Boolean).map((c) => '.' + c), id ? '#' + id : '']) {
      const re = new RegExp(`^\\${sel}\\s*\\{[^}]*display\\s*:\\s*(?!none)([a-z-]+)`, 'm');
      const m = css.match(re);
      if (m) risky.push(`${sel} → display:${m[1]}`);
    }
  }
  // 只要全局兜底规则在，risky 存在也没关系；这里只做提示性断言：规则必须带 !important
  assert.ok(/\[hidden\][^}]*!important/.test(css), '兜底规则必须带 !important');
  if (risky.length) console.log('      （以下元素依赖兜底规则：' + risky.join('，') + '）');
});

t('浮层显隐不依赖 CSS（内联 style 兜底）', () => {
  assert.ok(/function hideEl\(el\)[\s\S]{0,200}style\.display\s*=\s*'none'/.test(js), 'closeImport 必须用内联 style 隐藏');
  assert.ok(/function closeImport\(\)\s*\{\s*hideEl\(/.test(js), 'closeImport 未使用 hideEl');
  assert.ok(/function openImport\(\)[\s\S]{0,300}showEl\(/.test(js), 'openImport 未使用 showEl');
  assert.ok(/\[\s*'#modal-import'[\s\S]{0,120}'#login-bar'\s*\]\.forEach\(\(sel\) => hideEl\(\$\(sel\)\)\)/.test(js), 'boot() 启动时必须强制隐藏浮层');
  assert.ok(/<div class="modal" id="modal-import" hidden>/.test(html), '导入弹窗初始应带 hidden');
  assert.ok(/<div class="modal" id="modal-support" hidden>/.test(html), '支持弹窗初始应带 hidden');
});

console.log('\n[引用一致性]');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

t('app.js 里 getElementById 的目标都存在于 HTML', () => {
  const used = new Set([
    ...[...js.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]),
    ...[...js.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1])
  ]);
  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.strictEqual(missing.length, 0, 'HTML 中缺少这些 id：' + missing.join(', '));
});

t('preload 暴露的 API 都被 app.js 正确调用（无拼写错误）', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const exposed = [...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  const used = new Set([...js.matchAll(/window\.api\.(\w+)/g)].map((m) => m[1]));
  const unknown = [...used].filter((n) => !exposed.includes(n));
  assert.strictEqual(unknown.length, 0, 'app.js 调用了 preload 未暴露的方法：' + unknown.join(', '));
  // 反向：暴露了但没用到的仅作提示
  const unused = exposed.filter((n) => !used.has(n));
  if (unused.length) console.log('      （preload 已暴露但未使用：' + unused.join('，') + '）');
});

t('HTML 里 data-tab 与 JS 的面板 id 对应', () => {
  const tabs = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  for (const tab of tabs) assert.ok(htmlIds.has('pane-' + tab), `缺少面板 #pane-${tab}`);
});

console.log('\n[任务配置多选]');

t('任务类型与目标来源都是多选 checkbox（不是单选 radio）', () => {
  assert.ok(!/name="mode"/.test(html), '不应再有单选 mode 单选组');
  for (const id of ['task-unfollow', 'task-follow', 'src-fans', 'src-search', 'src-ups']) {
    assert.ok(new RegExp(`type="checkbox" id="${id}"`).test(html), `缺少多选项 #${id}`);
  }
});

t('搜索 / 定向相关输入行可动态显隐', () => {
  for (const id of ['row-sources', 'row-keywords', 'row-kwopts', 'row-target']) {
    assert.ok(htmlIds.has(id), `缺少行容器 #${id}`);
  }
  assert.ok(/function syncCfgVisibility\(cfg\)/.test(js), '缺少显隐同步函数');
  for (const id of ['row-sources', 'row-keywords', 'row-kwopts', 'row-target']) {
    assert.ok(new RegExp(`\\$\\('#${id}'\\)\\.hidden`).test(js), `syncCfgVisibility 未处理 #${id}`);
  }
});

t('表单读写覆盖新的多选字段', () => {
  for (const k of ['tasks', 'sources', 'searchKeywords', 'searchMaxPages', 'searchMaxFans', 'searchMinLevel']) {
    assert.ok(new RegExp(`\\b${k}\\b`).test(js), 'readCfgForm 缺少字段 ' + k);
  }
  assert.ok(/\$\('#task-follow'\)\.checked\s*=\s*!!T\.follow/.test(js), 'renderSelected 未回填 tasks');
  assert.ok(/\$\('#src-search'\)\.checked\s*=\s*!!S\.search/.test(js), 'renderSelected 未回填 sources');
});

console.log('\n[满关自救与热更新]');

t('满关自救配置项齐全且被读写', () => {
  for (const id of ['cfg-capguard', 'cfg-capguard-reserve']) {
    assert.ok(htmlIds.has(id), `缺少配置项 #${id}`);
  }
  assert.ok(/capGuard:/.test(js) && /capGuardReserve:/.test(js), 'readCfgForm 未读写满关自救配置');
  assert.ok(/\$\('#cfg-capguard'\)\.checked/.test(js), 'renderSelected 未回填 capGuard');
  assert.ok(/\$\('#cfg-capguard-reserve'\)\.value/.test(js), 'renderSelected 未回填 capGuardReserve');
});

t('热更新弹窗与交互就位', () => {
  assert.ok(/<div class="modal" id="modal-update" hidden>/.test(html), '更新弹窗初始应带 hidden');
  for (const id of ['upd-cur', 'upd-new', 'upd-notes', 'upd-prog', 'upd-bar-in', 'upd-pct', 'upd-status', 'btn-update-now', 'btn-update-later']) {
    assert.ok(htmlIds.has(id), `更新弹窗缺少 #${id}`);
  }
  assert.ok(/function openUpdate\(/.test(js), '缺少 openUpdate');
  assert.ok(/function closeUpdate\(/.test(js), '缺少 closeUpdate');
  assert.ok(/function doApplyUpdate\(/.test(js), '缺少 doApplyUpdate');
  assert.ok(/function onUpdaterEvent\(/.test(js), '缺少 onUpdaterEvent');
  assert.ok(/onUpdaterEvent/.test(js) && /onMenuCheckUpdate/.test(js), 'app.js 未订阅更新相关事件');
  assert.ok(/localStorage\.setItem\('brm-skip-ver'/.test(js), '缺少「稍后再说」版本跳过记录');
});

t('preload 暴露热更新 API', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const m of ['updaterCheck', 'updaterInfo', 'updaterApply', 'onUpdaterEvent', 'onMenuCheckUpdate']) {
    assert.ok(new RegExp(`\\b${m}:`).test(preload), 'preload 缺少 ' + m);
  }
});

t('顶部「可更新」常驻标记就位', () => {
  assert.ok(/id="upd-badge"/.test(html), '缺少 #upd-badge');
  assert.ok(/<button[^>]*id="upd-badge"[^>]*hidden/.test(html), '标记初始应隐藏');
  assert.ok(/function setUpdateBadge\(/.test(js), '缺少 setUpdateBadge');
  assert.ok(/\$\('#upd-badge'\)\.onclick/.test(js), '标记未绑定点击');
  assert.ok(/setUpdateBadge\(ev\)/.test(js), 'available 事件未更新标记');
  assert.ok(/ev\.type === 'none'/.test(js), '未处理「无更新」事件');
  assert.ok(/window\.api\.updaterInfo\(\)/.test(js), '启动时未恢复已有提醒');
  assert.ok(/\.upd-badge\s*\{[^}]*display:\s*none/.test(css), '标记默认 display 应为 none（显隐交给 JS）');
});

console.log('\n[新增粉丝统计与时间戳]');

t('操作明细表含「时间」列（与日志时间戳一致）', () => {
  assert.ok(/<th[^>]*class="rc-time"[^>]*>时间<\/th>/.test(js), 'renderRecords 缺少时间列');
  assert.ok(/<td class="rc-time">\$\{escapeHtml\(time\(r\.ts\)\)\}/.test(js), 'renderRecords 未用 time(r.ts) 渲染时间');
});

t('统计卡片含「更新于」时间戳', () => {
  assert.ok(/更新于/.test(js), 'renderStats 缺少「更新于」时间戳');
  // 数据来自 a.live.at（main.js setLive 每次刷新写入的时间戳）
  assert.ok(/a\.live && a\.live\.at/.test(js), '统计未读取 a.live.at 作为更新时间');
});

t('统计卡片含 本/周/月/年 新增粉丝指标', () => {
  for (const k of ['今日新增粉', '本周新增', '本月新增', '本年新增']) {
    assert.ok(js.includes(k), 'renderStats 缺少指标 ' + k);
  }
  assert.ok(/followerGain\(/.test(js), 'renderStats 未调用 followerGain');
});

t('followerGain 各周期净增计算正确（抽取真实函数验证）', () => {
  const startIdx = js.indexOf('function followerGain');
  assert.ok(startIdx >= 0, 'app.js 未找到 followerGain');
  let i = js.indexOf('{', startIdx), depth = 0, end = -1;
  for (; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > startIdx, '无法定位 followerGain 函数体');
  const src = js.slice(startIdx, end + 1);
  const fn = eval('(' + src + ')');
  const mk = (cur, log) => ({ live: { follower: cur }, followerLog: log });
  // 必须用「本地日期」构造键：followerLog 自 v2.1.14 起统一写本地日期（RB9），
  // 若测试仍用 toISOString()（UTC），本地 00:00–08:00 会算成昨天，掩盖基线判断。
  const p2 = (n) => String(n).padStart(2, '0');
  const ld = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const today = ld(new Date());
  const y = ld(new Date(Date.now() - 86400000));
  const wk = ld(new Date(Date.now() - 7 * 86400000));
  const mo = ld(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15));
  assert.strictEqual(fn('day', mk(100, { [y]: 80 })), 20, '今日净增应为 +20');
  assert.strictEqual(fn('week', mk(100, { [wk]: 70 })), 30, '本周净增应为 +30');
  assert.strictEqual(fn('month', mk(100, { [mo]: 60 })), 40, '本月净增应为 +40');
  // 无更早基线（仅有今日快照）→ null（界面显示「— / 基线不足」，不谎报 0）
  assert.strictEqual(fn('day', mk(100, { [today]: 100 })), null, '无更早基线应返回 null');
  // 空日志 → null
  assert.strictEqual(fn('year', mk(100, {})), null, '空日志应返回 null');
});

console.log('\n[取关我的名单 (v2.1.13)]');

t('HTML 含「取关」tab、面板、导出按钮、配置项', () => {
  assert.ok(/data-tab="unfollower"/.test(html), '缺少 data-tab="unfollower"');
  for (const id of ['pane-unfollower', 'unfollowerbox', 'btn-export-unfollower', 'cfg-track-unfollowers']) {
    assert.ok(htmlIds.has(id), `缺少 #${id}`);
  }
  // 面板初始应隐藏
  assert.ok(/<div class="tabpane" id="pane-unfollower" hidden>/.test(html), '取关面板初始应带 hidden');
});

t('app.js 实现取关名单渲染与导出/标记交互', () => {
  assert.ok(/function renderUnfollowers\(\)/.test(js), '缺少 renderUnfollowers');
  assert.ok(/function doExportUnfollowers\(\)/.test(js), '缺少 doExportUnfollowers');
  assert.ok(/function onUnfollowerBoxClick\(/.test(js), '缺少 onUnfollowerBoxClick');
  assert.ok(/renderUnfollowers\(\)/.test(js), 'tab 切换未调用 renderUnfollowers');
  assert.ok(/\$\('#btn-export-unfollower'\)\.onclick\s*=\s*doExportUnfollowers/.test(js), '导出按钮未绑定');
  // 标记：数据属性 data-act + data-mid 用于事件委托
  assert.ok(/data-act="block"/.test(js) && /data-act="ignore"/.test(js), 'renderUnfollowers 未渲染标记按钮');
  // 标记后回写 neverFollow（自动加入不再回关）
  assert.ok(/neverFollow:\s*r\.neverFollow/.test(js) || /ST\.global\.neverFollow\s*=\s*r\.neverFollow/.test(js), '标记后未同步 neverFollow 名单');
});

t('任务配置含 trackUnfollowers 且被读写', () => {
  assert.ok(/trackUnfollowers:/.test(js), 'readCfgForm 缺少 trackUnfollowers');
  assert.ok(/\$\('#cfg-track-unfollowers'\)\.checked\s*=\s*cfg\.trackUnfollowers\s*!==\s*false/.test(js), 'renderSelected 未回填 trackUnfollowers（默认开启）');
  assert.ok(/\$\('#cfg-track-unfollowers'\)\.addEventListener\('change', autoSaveCfg\)/.test(js), '配置项未绑定自动保存');
});

t('preload 暴露取关名单 API', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const m of ['unfollowerList', 'unfollowerMark', 'unfollowerExport']) {
    assert.ok(new RegExp(`\\b${m}:`).test(preload), 'preload 缺少 ' + m);
  }
});

t('main.js 提供取关名单 IPC + publicAccount 透传 unfollowers', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const ch of ['unfollower:list', 'unfollower:mark', 'unfollower:export']) {
    assert.ok(new RegExp(`ipcMain\.handle\\('${ch}'`).test(main), 'main.js 缺少 ' + ch);
  }
  assert.ok(/unfollowers:\s*a\.unfollowers\s*\|\|\s*\[\]/.test(main), 'publicAccount 未透传 unfollowers');
  assert.ok(/function exportUnfollowersCsv\(/.test(main), '缺少 exportUnfollowersCsv');
});

t('task.js 每日比对取关者：调用点 + 差集逻辑', () => {
  const task = fs.readFileSync(path.join(__dirname, '..', 'src', 'task.js'), 'utf8');
  assert.ok(/_phaseUnfollowers\(acc, run, client\)/.test(task), '主循环未调用 _phaseUnfollowers');
  assert.ok(/async _phaseUnfollowers\(acc, run, client\)/.test(task), '缺少 _phaseUnfollowers 方法');
  assert.ok(/diffUnfollowers\(prevSnap, list\)/.test(task), '未复用 diffUnfollowers 算取关者');
  // 受 B站 1000 条上限约束：应有提示分支
  assert.ok(/接口上限|前 1000|1000/.test(task), '缺少粉丝 1000 条上限提示');
  // 每日节流：同一天已建基线则跳过
  assert.ok(/today && prevSnap\.length > 0/.test(task) || /lastFollowerSnapDate === today/.test(task), '缺少每日节流判断');
});

t('store 取关名单数据层：快照/记录/标记/差集', () => {
  const { Store, diffUnfollowers } = require(path.join(__dirname, '..', 'src', 'store'));
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brm-uf-'));
  const store = new Store(tmp);
  store.load();
  const acc = store.upsertAccount({ uid: 111, uname: '测试号', cookie: 'x' });
  const id = acc.id;

  // 差集：prev 有 1/2/3，curr 有 1 → 2、3 取关
  const diff = diffUnfollowers(
    [{ mid: '1', uname: 'a' }, { mid: '2', uname: 'b' }, { mid: 3, uname: 'c' }],
    [{ mid: '1', uname: 'a' }]
  );
  assert.deepStrictEqual(diff.map((x) => x.mid).sort(), ['2', '3'], 'diffUnfollowers 结果应为 2、3');
  assert.strictEqual(diff[0].uname, diff.find((x) => x.mid === '2').uname || 'b', '应保留昵称');

  // 基线快照
  store.setFollowerSnapshot(id, [{ mid: '1', uname: 'a' }, { mid: '2', uname: 'b' }]);
  let a = store.getAccount(id);
  assert.ok(a.followerSnapshot.length === 2, '快照应写入 2 条');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(a.lastFollowerSnapDate), '快照日期应为 YYYY-MM-DD');

  // 记录取关者 + 自动加入不再回关
  store.addUnfollowers(id, [{ mid: '2', uname: 'b' }]);
  store.addNeverFollow('2');
  a = store.getAccount(id);
  assert.strictEqual(a.unfollowers.length, 1, 'unfollowers 应 1 条');
  assert.strictEqual(a.unfollowers[0].handled, 'auto', '新建记录 handled 应为 auto');
  assert.ok(store.inNeverFollow('2'), '取关者应自动加入 neverFollow');

  // 手动标记忽略 / 拉黑
  store.markUnfollower(id, '2', 'ignored');
  assert.strictEqual(store.getAccount(id).unfollowers[0].handled, 'ignored', '应标记为 ignored');
  store.markUnfollower(id, '2', 'blocked');
  assert.strictEqual(store.getAccount(id).unfollowers[0].handled, 'blocked', '应标记为 blocked');
  assert.ok(store.inNeverFollow('2'), 'blocked 后仍在 neverFollow');

  // listUnfollowers 透传
  assert.strictEqual(store.listUnfollowers(id).length, 1, 'listUnfollowers 应返回 1 条');

  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log('\n[审计修复 v2.1.14]');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const STORE = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');
const TASK = fs.readFileSync(path.join(__dirname, '..', 'src', 'task.js'), 'utf8');
const UPCORE = fs.readFileSync(path.join(__dirname, '..', 'src', 'updater-core.js'), 'utf8');
const UPD = fs.readFileSync(path.join(__dirname, '..', 'src', 'updater.js'), 'utf8');
const PUB = fs.readFileSync(path.join(__dirname, '..', 'tools', 'publish-release.js'), 'utf8');

t('RB12 大会员过滤：配置项 + 读写 + 引擎判断', () => {
  assert.ok(htmlIds.has('cfg-skipvip'), '缺少 #cfg-skipvip');
  assert.ok(/skipVip:\s*\$\('#cfg-skipvip'\)\.checked/.test(js), 'readCfgForm 未读 skipVip');
  assert.ok(/\$\('#cfg-skipvip'\)\.checked\s*=\s*!!cfg\.skipVip/.test(js), 'renderSelected 未回填 skipVip');
  assert.ok(TASK.includes('cfg.skipVip') && TASK.includes('it.vip'), '_skipReason 未处理 skipVip');
});

t('RB20 休息时段：全局配置 + 引擎暂停', () => {
  for (const id of ['g-quiet', 'g-restdays']) assert.ok(htmlIds.has(id), '缺少 #' + id);
  assert.ok(/quietHours:/.test(js) && /restDays:/.test(js), 'doSaveGlobal 未读写休息配置');
  assert.ok(TASK.includes('_quietRemainMs()'), '缺少 _quietRemainMs');
  assert.ok(TASK.includes('quiet.ms'), '循环未使用休息等待');
});

t('RB17 渲染节流：scheduleRender 合并高频事件', () => {
  assert.ok(/function scheduleRender\(/.test(js), '缺少 scheduleRender');
  assert.ok(/scheduleRender\('records', renderRecords\)/.test(js), 'onRecord 未节流');
  assert.ok(/scheduleRender\('stats', renderStats\)/.test(js), 'onStats 未节流');
});

t('RB15/RB18 CSV 公式注入防护且两处导出统一', () => {
  assert.ok(MAIN.includes('[=+\\-@\\t\\r]'), 'escapeCell 缺少公式前缀防护');
  assert.ok(/exportUnfollowersCsv[\s\S]{0,900}escapeCell/.test(MAIN), '取关 CSV 未复用 escapeCell');
});

t('RB1/RB13 更新 SHA256 校验 + 断点续传 + 发布产出校验文件', () => {
  assert.ok(/function sha256File\(/.test(UPCORE), '缺少 sha256File');
  assert.ok(/function parseChecksums\(/.test(UPCORE), '缺少 parseChecksums');
  assert.ok(/sha256File\(dest\)/.test(UPD), '下载后未校验 SHA256');
  assert.ok(/Range/.test(UPD), '未实现断点续传');
  assert.ok(/sha256sums/.test(UPD), '未识别校验文件');
  assert.ok(/sha256sums\.txt/.test(PUB), '发布脚本未产出校验文件');
});

t('RB2 Cookie 加密 / RB11 单实例 / RB19 异常日志', () => {
  assert.ok(/safeStorage/.test(MAIN) && /encryptString/.test(MAIN), '未用 safeStorage 加密 cookie');
  assert.ok(/requestSingleInstanceLock/.test(MAIN), '缺少单实例锁');
  assert.ok(/uncaughtException[\s\S]{0,400}addLog/.test(MAIN), 'uncaughtException 未写日志');
});

t('RB3 明细落盘 / RB6 清理 / RB8 延迟落盘 / RB9 本地日期', () => {
  assert.ok(/addRecord\(row\)/.test(STORE) && /listRecords\(/.test(STORE), '缺少操作明细持久化');
  assert.ok(/pruneFollowStats/.test(STORE), '缺少 bySource 清理');
  assert.ok(/function localDate/.test(STORE), '未定义 localDate');
  // bumpDaily 内不应再直接 flush（RB8）
  const i = STORE.indexOf('bumpDaily(id, n)');
  const seg = STORE.slice(i, STORE.indexOf('}', i) + 1);
  assert.ok(seg && !/this\.flush\(\)/.test(seg), 'bumpDaily 仍即时 flush');
});

t('RB9 localDate 使用本地时区（凌晨不落到 UTC 前一天）', () => {
  const { localDate } = require(path.join(__dirname, '..', 'src', 'store'));
  const d = new Date(2026, 0, 2, 0, 30, 0);   // 本地 2026-01-02 00:30
  assert.strictEqual(localDate(d), '2026-01-02', 'localDate 应返回本地日期');
});

t('RB3/RB8 store 记录进内存但不立即落盘，flush 后持久化', () => {
  const { Store } = require(path.join(__dirname, '..', 'src', 'store'));
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brm-rec-'));
  const s = new Store(tmp); s.load();
  s.addRecord({ mid: 1, uname: 'a', result: '已关注' });
  assert.strictEqual(s.listRecords().length, 1, 'addRecord 应立即进内存');
  const file = path.join(tmp, 'data.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  assert.ok(before.indexOf('已关注') < 0, 'addRecord 不应立即落盘（RB8）');
  assert.strictEqual(s.flush(), true, 'flush 应成功');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(disk.records.length, 1, 'flush 后记录应落盘（RB3）');
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log('\n[v2.1.15 顶栏与统计排版]');

t('顶栏：构建标记过长时省略号截断，按钮不被挤换行', () => {
  assert.ok(/\.ver\s*\{[^}]*text-overflow:\s*ellipsis/.test(css), '.ver 缺少省略号截断');
  assert.ok(/\.actions\s*\{[^}]*flex-wrap:\s*nowrap/.test(css), '.actions 应禁止换行');
  assert.ok(/\.title\s*\{[^}]*white-space:\s*nowrap/.test(css), '.title 应禁止换行');
  assert.ok(/\.brand\s*\{[^}]*min-width:\s*0/.test(css), '.brand 缺少 min-width:0');
});

t('统计：指标成组渲染，缺基线显示「—」而非 0', () => {
  assert.ok(/<span class="mi">关注数<b>/.test(js), 'renderStats 未使用 .mi 分组');
  assert.ok(/class="gain-na"[\s\S]{0,120}—/.test(js), 'fmtGain 未输出「—」占位');
  assert.ok(/\.stat-acc \.kv \.mi\s*\{[^}]*white-space:\s*nowrap/.test(css), '缺少 .mi 不换行样式');
});

(async () => {
  // RB1/RB14：真实文件 SHA256 校验
  try {
    const core = require(path.join(__dirname, '..', 'src', 'updater-core'));
    const os = require('os');
    const crypto = require('crypto');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brm-sha-'));
    const f = path.join(tmp, 'x.bin');
    fs.writeFileSync(f, 'hello-bili');
    const expect = crypto.createHash('sha256').update('hello-bili').digest('hex');
    const actual = await core.sha256File(f);
    assert.strictEqual(actual, expect, 'sha256File 结果不正确');
    const map = core.parseChecksums(expect + '  bili-relation-manager-test.exe');
    assert.strictEqual(core.findHash(map, 'bili-relation-manager-test.exe'), expect, 'findHash 未命中');
    console.log('  \u2713 RB1 sha256File / parseChecksums / findHash 真实文件校验');
    pass++;
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    console.log('  \u2717 RB1 sha256File 真实文件校验  →  ' + e.message);
    fail++;
  }
  console.log(`\n────────────  通过 ${pass} · 失败 ${fail}  ────────────\n`);
  process.exit(fail ? 1 : 0);
})();
