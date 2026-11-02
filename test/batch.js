'use strict';
/** 批量取关（一键取关 + 筛选）纯逻辑单测：验证筛选语义与执行前护栏 */
const assert = require('assert');
const {
  MUTUAL, FOLLOWED, iFollow, followsMe, isMutual,
  classifyActivity, computeOneWay, filterCandidates, canUnfollow
} = require('../src/batch-unfollow');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '  →  ' + e.message); fail++; }
}

// 构造候选：attribute 位 2=我关注 4=TA回关 6=互关 128=拉黑
const F = FOLLOWED, M = MUTUAL, B = 128;
const mk = (mid, uname, fans, attribute) => ({ mid, uname, fans, attribute });

console.log('\n[批量取关：关系位辅助]');
t('iFollow / followsMe / isMutual', () => {
  assert.strictEqual(iFollow(F), true);
  assert.strictEqual(iFollow(M), false);
  assert.strictEqual(followsMe(M), true);
  assert.strictEqual(followsMe(F), false);
  assert.strictEqual(isMutual(F | M), true);
  assert.strictEqual(isMutual(F), false);
});

console.log('\n[批量取关：filterCandidates]');
t('结果内关键字（昵称/UID 子串）', () => {
  const list = [mk(1, '营销号A', 100, F), mk(2, '普通人B', 50, F), mk(3, '营销号C', 10, F)];
  const r = filterCandidates(list, { keyword: '营销' });
  assert.deepStrictEqual(r.map((x) => x.mid), [1, 3]);
  const r2 = filterCandidates(list, { keyword: '2' });   // UID 含 2
  assert.deepStrictEqual(r2.map((x) => x.mid), [2]);
});
t('仅「我正关注的人」(attribute 含 2)', () => {
  const list = [mk(1, 'a', 1, F), mk(2, 'b', 2, M), mk(3, 'c', 3, F | M)];
  const r = filterCandidates(list, { onlyFollowing: true });
  assert.deepStrictEqual(r.map((x) => x.mid), [1, 3]);
});
t('仅「我关注但 TA 未回关」(单向/不互关)', () => {
  const list = [
    mk(1, 'a', 1, F),          // 单向：保留
    mk(2, 'b', 2, F | M),      // 互关：排除
    mk(3, 'c', 3, M),          // TA 关注我但我没关注：排除
    mk(4, 'd', 4, null)        // 关系未知：保守排除
  ];
  const r = filterCandidates(list, { onlyOneWay: true });
  assert.deepStrictEqual(r.map((x) => x.mid), [1]);
});
t('对方粉丝数区间（最小/最大/区间）', () => {
  const list = [mk(1, 'a', 10, F), mk(2, 'b', 100, F), mk(3, 'c', 1000, F)];
  assert.deepStrictEqual(filterCandidates(list, { minFans: 50 }).map((x) => x.mid), [2, 3]);
  assert.deepStrictEqual(filterCandidates(list, { maxFans: 500 }).map((x) => x.mid), [1, 2]);
  assert.deepStrictEqual(filterCandidates(list, { minFans: 50, maxFans: 500 }).map((x) => x.mid), [2]);
});
t('粉丝数字段缺失（null）不参与区间过滤（仅当要求比较时才过滤）', () => {
  const list = [mk(1, 'a', null, F), mk(2, 'b', 999, F)];
  // 不传粉丝数条件 → 全部保留
  assert.strictEqual(filterCandidates(list, {}).length, 2);
  // 传了条件 → null 视为 0 参与比较
  assert.deepStrictEqual(filterCandidates(list, { minFans: 100 }).map((x) => x.mid), [2]);
});
t('多条件叠加：不互关 + 粉丝≥100', () => {
  const list = [
    mk(1, 'a', 10, F),          // 单向但粉丝太少
    mk(2, 'b', 200, F),         // 单向且粉丝达标 → 保留
    mk(3, 'c', 200, F | M)      // 粉丝达标但互关 → 排除
  ];
  const r = filterCandidates(list, { onlyOneWay: true, minFans: 100 });
  assert.deepStrictEqual(r.map((x) => x.mid), [2]);
});

console.log('\n[批量取关：classifyActivity 活跃度分级]');
const NOW = 1700000000;  // 固定基准时间，避免跨日波动
const D = 86400;
t('从未投稿（count=0）→ never', () => {
  assert.strictEqual(classifyActivity(null, 0, NOW).key, 'never');
});
t('90 天内投稿 → active（含天数）', () => {
  const a = classifyActivity(NOW - 10 * D, 5, NOW);
  assert.strictEqual(a.key, 'active');
  assert.strictEqual(a.days, 10);
});
t('90~365 天 → occasional', () => {
  assert.strictEqual(classifyActivity(NOW - 100 * D, 5, NOW).key, 'occasional');
});
t('超 1 年 → dormant', () => {
  assert.strictEqual(classifyActivity(NOW - 400 * D, 5, NOW).key, 'dormant');
});

console.log('\n[批量取关：filterCandidates 活跃度/等级/简介]');
const mkA = (mid, attr, extra) => Object.assign(mk(mid, 'u' + mid, 100, attr), extra);
t('按活跃度分级过滤（active / never）', () => {
  const list = [
    mkA(1, F, { lastPubdate: NOW - 10 * D, archiveCount: 5, _activity: classifyActivity(NOW - 10 * D, 5, NOW) }),
    mkA(2, F, { lastPubdate: NOW - 400 * D, archiveCount: 5, _activity: classifyActivity(NOW - 400 * D, 5, NOW) }),
    mkA(3, F, { lastPubdate: null, archiveCount: 0, _activity: classifyActivity(null, 0, NOW) })
  ];
  assert.deepStrictEqual(filterCandidates(list, { activity: 'active' }).map((x) => x.mid), [1]);
  assert.deepStrictEqual(filterCandidates(list, { activity: 'never' }).map((x) => x.mid), [3]);
});
t('最近投稿 ≤ N 天（从未投稿者被排除）', () => {
  const list = [
    mkA(1, F, { _activity: classifyActivity(NOW - 10 * D, 5, NOW) }),
    mkA(2, F, { _activity: classifyActivity(NOW - 100 * D, 5, NOW) }),
    mkA(3, F, { _activity: classifyActivity(null, 0, NOW) })
  ];
  assert.deepStrictEqual(filterCandidates(list, { lastPostWithinDays: 30 }).map((x) => x.mid), [1]);
});
t('等级下限 minLevel', () => {
  const list = [mkA(1, F, { level: 4 }), mkA(2, F, { level: 6 })];
  assert.deepStrictEqual(filterCandidates(list, { minLevel: 5 }).map((x) => x.mid), [2]);
});
t('有简介 hasSign', () => {
  const list = [mkA(1, F, { sign: 'hello' }), mkA(2, F, { sign: '' })];
  assert.deepStrictEqual(filterCandidates(list, { hasSign: true }).map((x) => x.mid), [1]);
});

console.log('\n[批量取关：computeOneWay]');
t('followings 减 followers 集合 = 单向关注', () => {
  const followings = [mk(1, 'a', 1, F), mk(2, 'b', 2, F), mk(3, 'c', 3, F)];
  const followerSet = new Set(['2', '3']);   // 这两个回关了我
  const r = computeOneWay(followings, followerSet);
  assert.deepStrictEqual(r.map((x) => x.mid), [1]);
});

console.log('\n[批量取关：canUnfollow 护栏]');
t('未关注 TA 不可取关', () => {
  assert.deepStrictEqual(canUnfollow(mk(1, 'a', 1, M), {}), { ok: false, reason: '未关注 TA（无法取关）' });
});
t('白名单 / 不关注名单 / 已注销 被跳过', () => {
  const excl = { white: new Set(['1']), neverFollow: new Set(['2']), dead: new Set(['3']) };
  assert.strictEqual(canUnfollow(mk(1, 'a', 1, F), excl).ok, false);
  assert.strictEqual(canUnfollow(mk(2, 'b', 2, F), excl).ok, false);
  assert.strictEqual(canUnfollow(mk(3, 'c', 3, F), excl).ok, false);
  assert.strictEqual(canUnfollow(mk(9, 'z', 9, F), excl).ok, true);
});
t('默认保护互关：不取关互关的人', () => {
  assert.strictEqual(canUnfollow(mk(1, 'a', 1, F | M), { mutual: true }).ok, false);
  assert.strictEqual(canUnfollow(mk(1, 'a', 1, F | M), { mutual: false }).ok, true);
});
t('普通单向关注可正常取关', () => {
  assert.deepStrictEqual(canUnfollow(mk(5, 'x', 5, F), {}), { ok: true });
});

console.log(`\n[批量取关单测] 通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
