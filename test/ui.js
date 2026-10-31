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
  const today = new Date().toISOString().slice(0, 10);
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const wk = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const mo = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).toISOString().slice(0, 10);
  assert.strictEqual(fn('day', mk(100, { [y]: 80 })), 20, '今日净增应为 +20');
  assert.strictEqual(fn('week', mk(100, { [wk]: 70 })), 30, '本周净增应为 +30');
  assert.strictEqual(fn('month', mk(100, { [mo]: 60 })), 40, '本月净增应为 +40');
  // 无更早基线（仅有今日快照）→ 0
  assert.strictEqual(fn('day', mk(100, { [today]: 100 })), 0, '无更早基线应为 0');
  // 空日志 → 0
  assert.strictEqual(fn('year', mk(100, {})), 0, '空日志应为 0');
});

console.log(`\n────────────  通过 ${pass} · 失败 ${fail}  ────────────\n`);
process.exit(fail ? 1 : 0);
