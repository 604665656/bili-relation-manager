'use strict';
// 搜索 / 筛选逻辑单测（纯函数，无需网络）
// 覆盖三搜索路径里可单测的部分：
//   1) 列表内本地关键字搜索（filterCandidates keyword）
//   2) 搜索结果 attribute 为 null 时取关护栏不误杀（网页式搜索结果可送入取关流程）
//   3) 「仅我正关注的人」筛选在 attribute 填充后生效
const assert = require('assert');
const { filterCandidates, canUnfollow } = require('../src/batch-unfollow');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' :: ' + e.message); }
}

console.log('[搜索/筛选逻辑]');

// 1. 列表内本地关键字搜索（选项 1：在已加载名单里按昵称/UID 过滤）
t('结果内关键字：昵称子串匹配', () => {
  const list = [
    { mid: '1', uname: '营销号A', attribute: 2 },
    { mid: '2', uname: '正常用户', attribute: 2 },
    { mid: '3', uname: '某某', attribute: 6 }
  ];
  const r = filterCandidates(list, { keyword: '营销' });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].mid, '1');
});
t('结果内关键字：UID 子串匹配', () => {
  const list = [{ mid: '12345', uname: 'a' }, { mid: '999', uname: 'b' }];
  const r = filterCandidates(list, { keyword: '234' });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].mid, '12345');
});

// 2. 搜索结果 attribute 为 null 时，取关护栏不误杀（网页式搜索结果可被送入取关流程，由服务器最终判定）
t('canUnfollow：attribute 为 null 不拦截（交由服务器判定）', () => {
  const r = canUnfollow({ mid: '1' }, {});
  assert.strictEqual(r.ok, true);
});
t('canUnfollow：明确未关注则拦截', () => {
  const r = canUnfollow({ mid: '1', attribute: 0 }, {});
  assert.strictEqual(r.ok, false);
  assert.ok(/未关注/.test(r.reason));
});
t('canUnfollow：互关被保护', () => {
  const r = canUnfollow({ mid: '1', attribute: 6 }, { mutual: true });
  assert.strictEqual(r.ok, false);
  assert.ok(/互关/.test(r.reason));
});

// 3. 仅我正关注的人（搜索结果核对关系位后由 UI 填充 attribute，筛选生效）
t('仅我正关注的人：attribute 含 2 保留，bit4 排除，未知(null)保守保留', () => {
  const list = [
    { mid: '1', uname: 'a', attribute: 2 },   // 单向关注（我关注）
    { mid: '2', uname: 'b', attribute: 4 },   // 仅 TA 关注我
    { mid: '3', uname: 'c', attribute: null } // 关系未知
  ];
  const r = filterCandidates(list, { onlyFollowing: true });
  const mids = r.map((x) => x.mid).sort();
  assert.deepStrictEqual(mids, ['1', '3']);
});

console.log(`\n[搜索/筛选逻辑] 通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
