'use strict';
/**
 * 离线验证（桩替换真实接口）：
 *   [1] 多账号并发    [2] 演练/停止
 *   [3] 关注满 N 天才取关    [4] 取关后进入不再关注名单
 *   [5] 关注指定 UP 的粉丝 + 回关率统计    [6] 回关率过低自动停止
 *   [7] 自动循环受每日上限约束
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BiliClient } = require('../src/bilibili');
const { Engine, accountsToAutoStart } = require('../src/task');
const { Store } = require('../src/store');

const COOKIE = (uid) => `SESSDATA=fake; bili_jct=fakecsrf; DedeUserID=${uid}`;

/* ══════════ 打桩 ══════════ */
const FIX = {
  followings: {},   // 自己的关注列表
  fansOf: {},       // 指定 UP 的粉丝列表  up -> items
  followers: {},    // 自己的粉丝列表
  search: {},       // 关键词 -> 搜索结果
  searchFail: 0,    // 前 N 次搜索返回 -412（模拟限流）
  dupFids: [],      // 关注时返回 22007（重复操作）的 uid
  backResult: {},   // fid -> 是否回关（用于 didFollowBack）
  relationAttr: {}, // fid -> 单用户关系 attribute（模拟「已是我的粉丝 = 4」）
  throwNavN: 0,     // nav 连续抛异常的次数（模拟请求/风控异常）
  stat: { following: 100, follower: 50 },
  fansOfFail: {},   // UP uid -> 错误码（22118 隐藏 / -412 封禁 / -352 风控）
  fansOfCalls: {},  // UP uid -> 被请求次数（验证负缓存与节流）
  modifyFail: {}    // fid -> { code, message, kind }（模拟关注失败，如账号已注销）
};

BiliClient.prototype.getWbiKeys = async function () { return { img: 'a', sub: 'b' }; };
BiliClient.prototype.signParams = async function () { return 'x=1'; };
// 离线测试：避免 ensureBuvid 真去请求 SPI 接口（无网络会卡 30s 超时）
BiliClient.prototype.ensureBuvid = async function () { return false; };
BiliClient.prototype.nav = async function () {
  if (FIX.throwNavN > 0) { FIX.throwNavN--; throw Object.assign(new Error('模拟 nav 异常'), { code: -352 }); }
  return { code: 0, data: { mid: this.mid, uname: 'U' + this.mid, face: '', following: 10, follower: 5 } };
};
BiliClient.prototype.stat = async function () {
  return { code: 0, following: FIX.stat.following, follower: FIX.stat.follower };
};
BiliClient.prototype.followings = async function (pn, ps, vmid) {
  const list = FIX.followings[String(vmid)] || [];
  return { code: 0, data: { total: list.length, list } };
};
BiliClient.prototype.followers = async function (pn, ps, vmid) {
  const list = FIX.followers[String(vmid)] || [];
  return { code: 0, data: { total: list.length, list } };
};
BiliClient.prototype.fansOf = async function (vmid, pn) {
  const k = String(vmid);
  FIX.fansOfCalls[k] = (FIX.fansOfCalls[k] || 0) + 1;
  const code = FIX.fansOfFail[k];
  if (code) return { code, message: code === 22118 ? 'user privacy' : ('err ' + code) };
  const all = FIX.fansOf[k] || [];
  const list = ((pn || 1) === 1) ? all : [];
  return { code: 0, data: { total: all.length, list } };
};
BiliClient.prototype.searchUsers = async function (kw, pn) {
  if (FIX.searchFail > 0) { FIX.searchFail--; return { code: -412, message: 'request was banned', list: [], total: 0, pages: 0 }; }
  const list = pn === 1 ? (FIX.search[kw] || []) : [];
  return { code: 0, list, total: (FIX.search[kw] || []).length, pages: 1 };
};
BiliClient.prototype.didFollowBack = async function (fid) {
  return FIX.backResult[String(fid)] === undefined ? false : FIX.backResult[String(fid)];
};
BiliClient.prototype.relation = async function (fid) {
  const v = FIX.relationAttr[String(fid)];
  return v === undefined ? 0 : v;
};

let actions = [];
BiliClient.prototype.modify = async function (fid, act) {
  actions.push({ uid: this.mid, fid, act });
  const mf = FIX.modifyFail[String(fid)];
  if (mf) return Object.assign({ ok: false }, mf);
  if (act === 1 && FIX.dupFids.includes(fid)) {
    return { ok: false, code: 22007, message: '重复操作', kind: 'skip' };
  }
  return { ok: true, code: 0, message: '0', kind: 'ok' };
};

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
const item = (mid, attr, extra) => Object.assign({
  mid, uname: '用户' + mid, attribute: attr, special: 0, mtime: nowSec(),
  official_verify: { type: -1, desc: '' }
}, extra || {});

const mkStore = (globalPatch) => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'brm-')));
  s.load();
  s.updateGlobal(Object.assign({ pageGap: 20 }, globalPatch || {}));
  return s;
};
const mkAcc = (s, uid, cfg) => s.upsertAccount({
  uid, uname: 'U' + uid, face: '', cookie: COOKIE(uid), cfg
});
const waitIdle = async (e, ms = 30000) => {
  const t0 = Date.now();
  while (e.isBusy()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 60));
  }
};

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '  →  ' + e.message); fail++; }
}

(async () => {
  /* ══════ [1] 多账号并发 ══════ */
  console.log('\n[1] 多账号并发');
  actions = [];
  const s1 = mkStore({ whiteList: ['10003'] });
  FIX.followings['100'] = [item(10001, 2), item(10002, 6), item(10003, 2), item(10005, 2), item(10006, 2)];
  FIX.followings['200'] = [item(10001, 2), item(10002, 6), item(10003, 2), item(10005, 2), item(10006, 2)];
  const a1 = mkAcc(s1, 100, { mode: 'unfollow', delayMin: 1000, delayMax: 1000, maxOps: 2, dryRun: false });
  const a2 = mkAcc(s1, 200, { mode: 'unfollow', delayMin: 1000, delayMax: 1000, maxOps: 2, dryRun: false });
  const e1 = new Engine(s1);
  const seen = {};
  e1.on('record', (r) => { seen[r.accountId] = (seen[r.accountId] || 0) + 1; });
  const t0 = Date.now();
  e1.startAll([a1.id, a2.id]);
  await t('两个账号同时进入 running', () => {
    assert.strictEqual(e1.stateOf(a1.id).state, 'running');
    assert.strictEqual(e1.stateOf(a2.id).state, 'running');
  });
  await waitIdle(e1);
  const dur = Date.now() - t0;
  await t('并行而非串行', () => {
    assert.ok(dur < 3800, `耗时 ${dur}ms 偏长，疑似串行`);
    console.log('      实际耗时 ' + dur + 'ms');
  });
  await t('两账号都产出记录', () => { assert.ok(seen[a1.id] > 0 && seen[a2.id] > 0); });
  await t('严格遵守 maxOps', () => {
    assert.ok(actions.filter((x) => x.uid === 100).length <= 2);
    assert.ok(actions.filter((x) => x.uid === 200).length <= 2);
  });
  await t('互粉不被取关', () => assert.ok(!actions.some((x) => x.fid === 10002)));
  await t('白名单不被操作', () => assert.ok(!actions.some((x) => x.fid === 10003)));
  await t('使用取关 act=2', () => assert.ok(actions.length && actions.every((x) => x.act === 2)));

  /* ══════ [2] 演练模式 + 停止 ══════ */
  console.log('\n[2] 演练模式 / 停止');
  const before = actions.length;
  const s2 = mkStore({});
  FIX.followings['300'] = [item(30001, 2), item(30002, 2)];
  const a3 = mkAcc(s2, 300, { mode: 'unfollow', delayMin: 1000, delayMax: 1000, maxOps: 5, dryRun: true });
  const e2 = new Engine(s2);
  let pend = 0;
  e2.on('record', (r) => { if (r.result === '待取关') pend++; });
  e2.startAll([a3.id]);
  await waitIdle(e2);
  await t('演练产生「待取关」记录', () => assert.ok(pend > 0, 'pend=' + pend));
  await t('演练不发起真实写请求', () => assert.strictEqual(actions.length, before));

  const s3 = mkStore({});
  FIX.followings['400'] = Array.from({ length: 40 }, (_, i) => item(40000 + i, 2));
  const a4 = mkAcc(s3, 400, { mode: 'unfollow', delayMin: 1000, delayMax: 1000, maxOps: 50, dryRun: false });
  const e3 = new Engine(s3);
  e3.startAll([a4.id]);
  await new Promise((r) => setTimeout(r, 1500));
  e3.stopAll();
  await waitIdle(e3);
  await t('停止后不再继续写操作', () => {
    assert.ok(actions.filter((x) => x.uid === 400).length <= 2);
  });

  /* ══════ [3] 关注满 N 天才取关 ══════ */
  console.log('\n[3] 关注满 N 天未回关才取关');
  actions = [];
  const s4 = mkStore({});
  FIX.followings['500'] = [
    item(50001, 2, { mtime: nowSec() - 10 * DAY }),   // 关注 10 天 → 应取关
    item(50002, 2, { mtime: nowSec() - 2 * DAY }),    // 关注 2 天  → 应跳过
    item(50003, 2, { mtime: 0 })                      // 无时间     → 应跳过
  ];
  const a5 = mkAcc(s4, 500, {
    mode: 'unfollow', delayMin: 1000, delayMax: 1000, maxOps: 10, dryRun: false,
    onlyAfterDays: true, minFollowDays: 7
  });
  const e4 = new Engine(s4);
  const skipped = {};
  e4.on('record', (r) => { if (r.result === '跳过') skipped[r.mid] = r.detail; });
  e4.startAll([a5.id]);
  await waitIdle(e4);
  await t('只取关关注满 7 天的', () => {
    assert.ok(actions.some((x) => x.fid === 50001), '50001 应被取关');
    assert.ok(!actions.some((x) => x.fid === 50002), '50002 关注仅 2 天，不应取关');
  });
  await t('缺少关注时间时跳过', () => {
    assert.ok(!actions.some((x) => x.fid === 50003));
    assert.ok(/未满|关注时间/.test(skipped[50003] || ''), 'detail=' + skipped[50003]);
    assert.ok(/未满/.test(skipped[50002] || ''), 'detail=' + skipped[50002]);
  });

  /* ══════ [4] 取关后不再自动关注 ══════ */
  console.log('\n[4] 已取关的人不再自动关注');
  await t('取关成功后写入不再关注名单', () => {
    assert.ok(s4.inNeverFollow(50001), '50001 应进入 neverFollow');
  });
  actions = [];
  const s5 = mkStore({ neverFollow: ['50001'] });
  FIX.followers['600'] = [item(50001, 0), item(60002, 0)];   // 我未关注他们
  const a6 = mkAcc(s5, 600, { mode: 'followback', delayMin: 1000, delayMax: 1000, maxOps: 10, dryRun: false });
  const e5 = new Engine(s5);
  const note = {};
  e5.on('record', (r) => { note[r.mid] = r.detail; });
  e5.startAll([a6.id]);
  await waitIdle(e5);
  await t('不再关注名单内的人被跳过', () => {
    assert.ok(!actions.some((x) => x.fid === 50001), '50001 曾取关，不应再关注');
    assert.strictEqual(note[50001], '不再关注名单');
  });
  await t('名单外的人正常关注', () => {
    assert.ok(actions.some((x) => x.fid === 60002 && x.act === 1));
  });

  /* ══════ [5] 关注指定 UP 的粉丝 + 回关率 ══════ */
  console.log('\n[5] 关注指定UP的粉丝 / 回关率统计');
  actions = [];
  const s6 = mkStore({ rateMinSample: 3, rateThreshold: 0.5, rateVerifyGapHours: 24 });
  FIX.fansOf['999'] = [item(70001, 0), item(70002, 0), item(70003, 0)];
  const a7 = mkAcc(s6, 700, {
    mode: 'fansof', delayMin: 1000, delayMax: 1000, maxOps: 10, dryRun: false, targetUps: '999'
  });
  const e6 = new Engine(s6);
  e6.startAll([a7.id]);
  await waitIdle(e6);
  await t('关注了该 UP 的粉丝', () => {
    assert.strictEqual(actions.filter((x) => x.fid === 70001 && x.act === 1).length, 1);
    assert.strictEqual(actions.filter((x) => x.act === 1).length, 3);
  });
  await t('bySource 统计已记录', () => {
    const fs = s6.getAccount(a7.id).followStats;
    assert.strictEqual(fs.bySource['999'].tried, 3);
    assert.strictEqual(fs.pendingVerify.length, 3, '应产生 3 条待核验');
  });
  await t('24 小时内不核验（待核验队列保留）', () => {
    assert.strictEqual(s6.getAccount(a7.id).followStats.sample, 0);
  });

  // 让待核验条目"到期"，并设置核验结果：2 回关 / 3 → 67%
  const s6b = s6;
  s6b.withFollowStats(a7.id, (fs) => {
    fs.pendingVerify.forEach((x) => { x.at = Date.now() - 48 * 3600 * 1000; });
  });
  FIX.backResult = { 70001: true, 70002: true, 70003: false };
  FIX.fansOf['999'] = [];   // 无新粉丝可关注，只做核验
  const e6b = new Engine(s6b);
  e6b.startAll([a7.id]);
  await waitIdle(e6b);
  await t('到期后核验并计算回关率', () => {
    const fs = s6b.getAccount(a7.id).followStats;
    assert.strictEqual(fs.bySource['999'].sample, 3, 'sample=' + fs.bySource['999'].sample);
    assert.strictEqual(fs.bySource['999'].back, 2, 'back=' + fs.bySource['999'].back);
    assert.strictEqual(fs.bySource['999'].stopped, false, '67% 高于阈值 50%，不应停止');
  });

  /* ══════ [6] 回关率过低自动停止 ══════ */
  console.log('\n[6] 回关率过低自动停止');
  await t('低于阈值后标记 stopped', () => {
    s6b.updateGlobal({ rateThreshold: 0.9 });   // 67% < 90%
    const e = new Engine(s6b);
    // 直接触发一次评估：构造到期条目
    s6b.withFollowStats(a7.id, (fs) => {
      fs.bySource['999'].sample = 0; fs.bySource['999'].back = 0; fs.bySource['999'].stopped = false;
      fs.pendingVerify = [
        { fid: 70001, source: '999', at: Date.now() - 48 * 3600 * 1000 },
        { fid: 70002, source: '999', at: Date.now() - 48 * 3600 * 1000 },
        { fid: 70003, source: '999', at: Date.now() - 48 * 3600 * 1000 }
      ];
    });
    e.startAll([a7.id]);
    return waitIdle(e).then(() => {
      const fs = s6b.getAccount(a7.id).followStats;
      assert.strictEqual(fs.bySource['999'].stopped, true, 'sample=' + fs.bySource['999'].sample + ' back=' + fs.bySource['999'].back);
    });
  });
  actions = [];
  FIX.fansOf['999'] = [item(70009, 0)];
  await t('停止后不再关注该 UP 的粉丝', async () => {
    const e = new Engine(s6b);
    e.startAll([a7.id]);
    await waitIdle(e);
    assert.ok(!actions.some((x) => x.fid === 70009), '不应再关注');
  });

  /* ══════ [7] 自动循环受每日上限约束 ══════ */
  console.log('\n[7] 自动循环 / 每日上限');
  actions = [];
  const s7 = mkStore({});
  FIX.followings['800'] = [item(80001, 2), item(80002, 2), item(80003, 2)];
  const a8 = mkAcc(s7, 800, {
    mode: 'unfollow', delayMin: 1000, delayMax: 1000, maxOps: 1, dryRun: false,
    autoLoop: true, loopIntervalMin: 1, dailyCap: 1
  });
  const e7 = new Engine(s7);
  let rounds = 0;
  e7.on('account', (d) => { if (d.stats && d.stats.round) rounds = Math.max(rounds, d.stats.round); });
  e7.startAll([a8.id]);
  await waitIdle(e7, 20000);
  await t('达到每日上限后停止循环（只跑 1 轮）', () => {
    assert.strictEqual(rounds, 1, 'rounds=' + rounds);
    assert.strictEqual(actions.filter((x) => x.uid === 800).length, 1);
  });

  /* ══════ [8] 关注/粉丝数实时统计 ══════ */
  console.log('\n[8] 关注/粉丝数实时统计');
  const s8 = mkStore({});
  FIX.stat = { following: 120, follower: 66 };
  FIX.followings['900'] = [];
  const a9 = mkAcc(s8, 900, { mode: 'unfollow', delayMin: 1000, delayMax: 1000, maxOps: 1, dryRun: true });
  const e8 = new Engine(s8);
  let live = null;
  e8.on('stat', (d) => { live = d.live; });
  e8.startAll([a9.id]);
  await waitIdle(e8);
  await t('拉取并保存关注/粉丝数', () => {
    assert.ok(live, '未收到 stat 事件');
    assert.strictEqual(live.following, 120);
    assert.strictEqual(live.follower, 66);
  });
  FIX.stat = { following: 125, follower: 70 };
  await t('第二次统计能算出增量', async () => {
    const e = new Engine(s8);
    let l2 = null;
    e.on('stat', (d) => { l2 = d.live; });
    e.startAll([a9.id]);
    await waitIdle(e);
    assert.strictEqual(l2.following, 125);
    assert.strictEqual(l2.prevFollowing, 5, '增量应为 +5，实际 ' + l2.prevFollowing);
    assert.strictEqual(l2.prevFollower, 4);
  });

  /* ══════ [9] 任务类型多选：清理 + 关注一次跑完 ══════ */
  console.log('\n[9] 任务类型多选（清理 + 关注 同时生效）');
  actions = [];
  const s9 = mkStore({});
  FIX.followings['1000'] = [item(11001, 2), item(11002, 2)];   // 单向关注 → 该取关
  FIX.followers['1000'] = [item(12001, 4), item(12002, 6), item(12003, 4)]; // 12002 已互粉
  const a10 = mkAcc(s9, 1000, {
    tasks: { unfollow: true, follow: true },
    sources: { fans: true, search: false, ups: false },
    delayMin: 1000, delayMax: 1000, maxOps: 50, dryRun: false, skipOfficial: false
  });
  const e9 = new Engine(s9);
  e9.startAll([a10.id]);
  await waitIdle(e9);
  await t('同一轮里两个任务都执行了', () => {
    assert.ok(actions.some((x) => x.act === 2), '没有取关动作');
    assert.ok(actions.some((x) => x.act === 1), '没有关注动作');
  });
  await t('粉丝列表里已互粉的人不会被重复关注', () => {
    assert.ok(!actions.some((x) => x.fid === 12002 && x.act === 1));
    assert.ok(actions.some((x) => x.fid === 12001 && x.act === 1));
  });
  await t('只勾「关注」时不会取关', async () => {
    actions = [];
    const s = mkStore({});
    FIX.followings['1001'] = [item(13001, 2)];
    FIX.followers['1001'] = [item(13002, 4)];
    const a = mkAcc(s, 1001, {
      tasks: { unfollow: false, follow: true },
      sources: { fans: true, search: false, ups: false },
      delayMin: 1000, delayMax: 1000, maxOps: 10, dryRun: false
    });
    const e = new Engine(s);
    e.startAll([a.id]);
    await waitIdle(e);
    assert.ok(!actions.some((x) => x.act === 2), '不应有取关');
    assert.ok(actions.some((x) => x.act === 1), '应有回粉');
  });

  /* ══════ [10] 关键词搜索自动找目标 ══════ */
  console.log('\n[10] 关键词搜索找目标（无需填 UID）');
  actions = [];
  const s10 = mkStore({});
  FIX.search['手绘'] = [
    { mid: 14001, uname: 'A', fans: 300, level: 3, official_verify: { type: -1, desc: '' } },
    { mid: 14002, uname: 'B', fans: 900000, level: 6, official_verify: { type: -1, desc: '' } }, // 粉丝超上限
    { mid: 14003, uname: 'C', fans: 100, level: 0, official_verify: { type: -1, desc: '' } },    // 等级过低
    { mid: 14004, uname: 'D', fans: 50, level: 2, official_verify: { type: -1, desc: '' } },
    { mid: 99901, uname: 'E', fans: 60, level: 2, official_verify: { type: -1, desc: '' } }      // 已在关注列表
  ];
  FIX.followings['1500'] = [item(99901, 2)];   // 已关注 99901
  const a11 = mkAcc(s10, 1500, {
    tasks: { unfollow: false, follow: true },
    sources: { fans: false, search: true, ups: false },
    searchKeywords: '手绘', searchMaxPages: 1, searchMaxFans: 1000, searchMinLevel: 1,
    delayMin: 1000, delayMax: 1000, maxOps: 20, dryRun: false, skipOfficial: false
  });
  const e10 = new Engine(s10);
  e10.startAll([a11.id]);
  await waitIdle(e10);
  const followedBySearch = actions.filter((x) => x.act === 1).map((x) => x.fid).sort();
  await t('搜索到的人被自动关注', () => {
    assert.deepStrictEqual(followedBySearch, [14001, 14004], '实际关注：' + followedBySearch.join(','));
  });
  await t('跳过粉丝数超上限 / 等级过低 / 已关注的人', () => {
    for (const bad of [14002, 14003, 99901]) {
      assert.ok(!followedBySearch.includes(bad), bad + ' 不应被关注');
    }
  });
  await t('回关率统计以「搜索关键词」为来源', () => {
    const fs10 = s10.getAccount(a11.id).followStats;
    assert.ok(fs10.bySource['search:手绘'], '缺少 search:手绘 来源统计');
    assert.strictEqual(fs10.bySource['search:手绘'].tried, 2);
  });

  /* ══════ [11] 搜索来源回关率过低自动停用 ══════ */
  console.log('\n[11] 搜索来源回关率过低自动停用');
  // 造一条「到期待核验」记录，让 _verifyBack 走真实路径算出低回关率 → 自动置 stopped
  FIX.backResult['14999'] = false;
  s10.withFollowStats(a11.id, (s) => {
    s.bySource['search:手绘'].sample = 30;
    s.bySource['search:手绘'].back = 1;   // 1/31 ≈ 3.2% < 默认 15%
    s.pendingVerify = [{ fid: 14999, uname: 'X', source: 'search:手绘', at: Date.now() - 48 * 3600 * 1000 }];
  });
  actions = [];
  await t('核验后回关率过低 → 来源被标记 stopped', async () => {
    const e = new Engine(s10);
    e.startAll([a11.id]);
    await waitIdle(e);
    const b = s10.getAccount(a11.id).followStats.bySource['search:手绘'];
    assert.strictEqual(b.stopped, true, '应被标记 stopped');
  });
  await t('低于阈值后不再从该关键词关注', () => {
    assert.strictEqual(actions.filter((x) => x.act === 1).length, 0, '不应再关注');
  });

  /* ══════ [12] 搜索限流 -412 会退避重试 ══════ */
  console.log('\n[12] 搜索限流重试');
  actions = [];
  const s12 = mkStore({});
  FIX.searchFail = 1;   // 第一次返回 -412
  FIX.search['板绘'] = [{ mid: 16001, uname: 'F', fans: 80, level: 3, official_verify: { type: -1, desc: '' } }];
  const a12 = mkAcc(s12, 1700, {
    tasks: { unfollow: false, follow: true },
    sources: { fans: false, search: true, ups: false },
    searchKeywords: '板绘', searchMaxPages: 1, searchMaxFans: 0, searchMinLevel: 0,
    delayMin: 1000, delayMax: 1000, maxOps: 5, dryRun: false, skipOfficial: false
  });
  const e12 = new Engine(s12);
  e12.startAll([a12.id]);
  await waitIdle(e12, 40000);
  await t('-412 后重试仍能完成关注', () => {
    assert.ok(actions.some((x) => x.fid === 16001 && x.act === 1), '重试后应关注成功');
  });

  /* ══════ [13] 关注时返回 22007（其实已关注）不算失败 ══════ */
  console.log('\n[13] 重复关注不算失败');
  actions = [];
  const s13 = mkStore({});
  FIX.search['原画'] = [
    { mid: 18001, uname: 'G', fans: 80, level: 3, official_verify: { type: -1, desc: '' } },
    { mid: 18002, uname: 'H', fans: 90, level: 3, official_verify: { type: -1, desc: '' } }
  ];
  FIX.dupFids = [18001];
  const a13 = mkAcc(s13, 1900, {
    tasks: { unfollow: false, follow: true },
    sources: { fans: false, search: true, ups: false },
    searchKeywords: '原画', searchMaxPages: 1, searchMaxFans: 0, searchMinLevel: 0,
    delayMin: 1000, delayMax: 1000, maxOps: 10, dryRun: false, skipOfficial: false
  });
  const e13 = new Engine(s13);
  const recs13 = [];
  e13.on('record', (r) => recs13.push(r));
  e13.startAll([a13.id]);
  await waitIdle(e13);
  await t('22007 记为「跳过 / 已关注过」而非失败', () => {
    const r = recs13.find((x) => x.mid === 18001);
    assert.ok(r, '缺少 18001 的记录');
    assert.strictEqual(r.result, '跳过', '结果应为跳过，实际 ' + r.result);
    assert.strictEqual(r.detail, '已关注过');
    assert.strictEqual(e13.stateOf(a13.id).stats.fail, 0, '不应计入失败');
    assert.ok(recs13.some((x) => x.mid === 18002 && x.result === '已关注'), '18002 应正常关注');
  });
  FIX.dupFids = [];

  /* ══════ [14] 自动关注排除已是粉丝的人 ══════ */
  console.log('\n[14] 自动关注排除已是粉丝（回粉请用粉丝列表）');
  actions = [];
  FIX.relationAttr = {};
  const s14 = mkStore({});
  FIX.search['插画'] = [
    { mid: 21001, uname: '甲', fans: 80, level: 3, official_verify: { type: -1, desc: '' } },        // 陌生人 → 应关注
    { mid: 21002, uname: '乙', fans: 120, level: 3, official_verify: { type: -1, desc: '' } }         // 已是我的粉丝 → 应跳过
  ];
  FIX.relationAttr['21002'] = 4;   // attribute=4：TA 关注了我（我的粉丝）
  const a14 = mkAcc(s14, 2100, {
    tasks: { unfollow: false, follow: true },
    sources: { fans: false, search: true, ups: false },
    searchKeywords: '插画', searchMaxPages: 1, searchMaxFans: 0, searchMinLevel: 0,
    delayMin: 1000, delayMax: 1000, maxOps: 20, dryRun: false, skipOfficial: false
  });
  const e14 = new Engine(s14);
  const recs14 = [];
  e14.on('record', (r) => recs14.push(r));
  e14.startAll([a14.id]);
  await waitIdle(e14);
  await t('已是粉丝的人不被搜索来源关注', () => {
    assert.ok(actions.some((x) => x.fid === 21001 && x.act === 1), '陌生人 21001 应被关注');
    assert.ok(!actions.some((x) => x.fid === 21002 && x.act === 1), '粉丝 21002 不应被搜索来源关注');
  });
  await t('已是我粉丝的人被标记跳过并给出回粉提示', () => {
    const r = recs14.find((x) => x.mid === 21002);
    assert.ok(r, '缺少 21002 的记录');
    assert.strictEqual(r.result, '跳过');
    assert.ok(/粉丝/.test(r.detail), 'detail 应提示已是其粉丝，实际：' + r.detail);
    assert.ok(/回粉|我的粉丝列表/.test(r.detail), 'detail 应引导用回粉来源，实际：' + r.detail);
  });

  // 指定 UP 的粉丝来源同样排除已是粉丝的人
  actions = [];
  FIX.fansOf['888'] = [item(22001, 0), item(22002, 4)];   // 22002 attribute=4：已是我的粉丝
  const a14b = mkAcc(s14, 2200, {
    tasks: { unfollow: false, follow: true },
    sources: { fans: false, search: false, ups: true },
    targetUps: '888', delayMin: 1000, delayMax: 1000, maxOps: 20, dryRun: false, skipOfficial: false
  });
  const e14b = new Engine(s14);
  e14b.startAll([a14b.id]);
  await waitIdle(e14b);
  await t('指定UP粉丝来源也排除已是粉丝的人', () => {
    assert.ok(actions.some((x) => x.fid === 22001 && x.act === 1), '陌生人 22001 应被关注');
    assert.ok(!actions.some((x) => x.fid === 22002 && x.act === 1), '粉丝 22002 不应被关注');
  });
  FIX.relationAttr = {};
  FIX.fansOf['888'] = [];

  /* ══════ [15] 异常后按设定时间自动重启 ══════ */
  console.log('\n[15] 异常后自动重启');
  // 用桩覆盖等待，避免真实等待 N 分钟；同时让 nav 模拟一次异常
  const mkRestartEngine = (s, uid, cfg) => {
    const e = new Engine(s);
    e._sleepCancelable = async () => true;   // 跳过真实等待
    return e;
  };

  // [15a] 第一次异常 → 等待（桩跳过）→ 第二次重启成功 → done
  FIX.throwNavN = 1;
  {
    const s15 = mkStore({});
    const a15 = mkAcc(s15, 1500, {
      tasks: { unfollow: false, follow: false }, maxOps: 1, dryRun: true,
      autoLoop: false, errRetryMin: 1
    });
    const e15 = mkRestartEngine(s15, 1500, a15);
    const states15 = []; const logs15 = [];
    e15.on('account', (d) => states15.push(d.state));
    e15.on('log', (l) => logs15.push(l.msg));
    e15.startAll([a15.id]);
    await waitIdle(e15);
    await t('异常后自动重启并最终正常结束', () => {
      assert.ok(states15.includes('error'), '应出现过 error 状态');
      assert.ok(states15.includes('done'), '重启后应最终 done');
      assert.ok(states15.indexOf('done') > states15.indexOf('error'), 'done 必须在 error 之后');
      assert.ok(logs15.some((m) => /自动重启/.test(m)), '应有自动重启日志');
      assert.ok(logs15.some((m) => /第 1 次自动重启/.test(m)), '应标注第几次重启');
    });
  }

  // [15b] 连续异常达到上限（6 次）后彻底停止，不再重启
  FIX.throwNavN = 99;
  {
    const s15b = mkStore({});
    const a15b = mkAcc(s15b, 1501, {
      tasks: { unfollow: false, follow: false }, maxOps: 1, dryRun: true,
      autoLoop: false, errRetryMin: 1
    });
    const e15b = mkRestartEngine(s15b, 1501, a15b);
    const logs15b = [];
    e15b.on('log', (l) => logs15b.push(l.msg));
    e15b.startAll([a15b.id]);
    await waitIdle(e15b);
    await t('连续异常达上限后停止自动重启（防死循环）', () => {
      assert.strictEqual(e15b.stateOf(a15b.id).state, 'error', '最终应停在 error');
      assert.ok(logs15b.some((m) => /达到上限/.test(m)), '应有达到上限的日志');
      assert.ok(logs15b.some((m) => /停止自动重启/.test(m)), '应停止自动重启');
    });
  }

  // [15c] errRetryMin=0 时，异常即停止，不重启
  FIX.throwNavN = 1;
  {
    const s15c = mkStore({});
    const a15c = mkAcc(s15c, 1502, {
      tasks: { unfollow: false, follow: false }, maxOps: 1, dryRun: true,
      autoLoop: false, errRetryMin: 0
    });
    const e15c = mkRestartEngine(s15c, 1502, a15c);
    const states15c = []; const logs15c = [];
    e15c.on('account', (d) => states15c.push(d.state));
    e15c.on('log', (l) => logs15c.push(l.msg));
    e15c.startAll([a15c.id]);
    await waitIdle(e15c);
    await t('errRetryMin=0 时异常即停止（不重启）', () => {
      assert.ok(states15c.includes('error'), '应出现 error');
      assert.ok(!logs15c.some((m) => /分钟后自动重启|第.*次自动重启/.test(m)), '不应有实际触发重启的日志');
      assert.ok(logs15c.some((m) => /未设置「异常后自动重启」/.test(m)), '应提示未设置重启');
    });
  }
  FIX.throwNavN = 0;

  /* ══════ [16] 启动时自动恢复账号筛选 ══════ */
  console.log('\n[16] 启动时自动恢复账号筛选');
  {
    const s16 = mkStore({ autoStartOnLaunch: false });
    mkAcc(s16, 1601, { mode: 'unfollow', maxOps: 1, dryRun: true });
    await t('全局开关关闭时不返回任何账号', () => {
      assert.deepStrictEqual(accountsToAutoStart(s16), []);
    });
  }
  {
    const s16b = mkStore({ autoStartOnLaunch: true });
    const aA = mkAcc(s16b, 1602, { tasks: { unfollow: true, follow: false }, sources: { fans: true, search: false, ups: false }, maxOps: 1, dryRun: true });
    mkAcc(s16b, 1603, { tasks: { unfollow: false, follow: false }, sources: { fans: true, search: false, ups: false }, maxOps: 1, dryRun: true }); // 无任务类型 → 排除
    const aC = mkAcc(s16b, 1604, { mode: 'followback', maxOps: 1, dryRun: true });
    mkAcc(s16b, 1605, { tasks: { unfollow: true, follow: false }, maxOps: 1, dryRun: true, enabled: false }); // 已禁用 → 排除
    await t('只返回「有任务且未禁用」的账号', () => {
      const ids = accountsToAutoStart(s16b).sort();
      assert.deepStrictEqual(ids, [aA.id, aC.id].sort());
    });
  }

  /* ══════ [17] 看门狗停滞检测 ══════ */
  console.log('\n[17] 看门狗停滞检测');
  {
    const e17 = new Engine(new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'brm-'))));
    const run = { state: 'running', cancel: false, stats: { scanned: 0, dealt: 0 }, cfg: { watchdogStallMin: 15 } };
    let rej = null;
    e17._watchdog(run, 'x', { tickMs: 30, stallMin: 0.02 }).catch((e) => { rej = e; });  // 0.02min = 1200ms
    await new Promise((r) => setTimeout(r, 1600));
    (run._wdTimers || []).forEach(clearInterval);
    await t('无进展超过阈值 → 看门狗抛错', () => {
      assert.ok(rej instanceof Error, '应 reject 一个 Error');
      assert.ok(/停滞/.test(rej.message), '消息应包含「停滞」：' + rej.message);
    });
  }
  {
    const e17b = new Engine(new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'brm-'))));
    const run2 = { state: 'running', cancel: false, stats: { scanned: 0, dealt: 0 }, cfg: { watchdogStallMin: 15 } };
    let rej2 = null;
    e17b._watchdog(run2, 'y', { tickMs: 20, stallMin: 0.01 }).catch((e) => { rej2 = e; });  // 600ms
    const bump = setInterval(() => { run2.stats.scanned++; }, 10);
    await new Promise((r) => setTimeout(r, 1200));
    clearInterval(bump);
    (run2._wdTimers || []).forEach(clearInterval);
    await t('有持续进展时不触发看门狗', () => {
      assert.strictEqual(rej2, null, '持续进展时不应 reject');
    });
  }
  {
    // 集成：让 followings 永远不返回（卡死），看门狗应在 stallMin 后抛错，
    // 异常被 _launch 捕获并走「异常后自动重启」流程
    const s17c = mkStore({});
    const origF = BiliClient.prototype.followings;
    BiliClient.prototype.followings = () => new Promise(() => {});   // 永远挂起 → 卡死
    const a17c = mkAcc(s17c, 1700, {
      tasks: { unfollow: true, follow: false }, maxOps: 5, dryRun: true, autoLoop: false, errRetryMin: 1
    });
    const e17c = new Engine(s17c);
    e17c._sleepCancelable = async () => true;   // 跳过真实等待
    e17c._watchdog = function (run, id) {
      return Engine.prototype._watchdog.call(this, run, id, { tickMs: 30, stallMin: 0.02 });
    };
    const states17 = []; const logs17 = [];
    e17c.on('account', (d) => states17.push(d.state));
    e17c.on('log', (l) => logs17.push(l.msg));
    e17c.startAll([a17c.id]);
    await waitIdle(e17c, 20000);
    BiliClient.prototype.followings = origF;
    await t('卡死后由看门狗强制重启（走异常重启流程）', () => {
      assert.ok(logs17.some((m) => /看门狗/.test(m)), '应出现看门狗触发日志');
      assert.ok(states17.includes('error'), '应经历过 error 状态');
    });
  }

  /* ══════ [18] 关注上限保护 ══════ */
  console.log('\n[18] 关注上限保护');
  actions = [];
  const s18 = mkStore({ followCap: 10 });
  FIX.stat = { following: 5000, follower: 100 };   // 模拟关注数已满
  FIX.followings['1800'] = [item(19001, 2)];       // 单向关注 → 应取关（腾名额）
  FIX.followers['1800'] = [item(19002, 0)];        // 回粉目标 → 应被跳过（已达上限）
  const a18 = mkAcc(s18, 1800, {
    tasks: { unfollow: true, follow: true },
    sources: { fans: true, search: false, ups: false },
    delayMin: 1000, delayMax: 1000, maxOps: 10, dryRun: false, skipOfficial: false
  });
  {
    const e18 = new Engine(s18);
    const logs18 = [];
    e18.on('log', (l) => logs18.push(l.msg));
    e18.startAll([a18.id]);
    await waitIdle(e18);
    await t('关注数达上限：取关照常、自动关注被跳过并提示', () => {
      assert.ok(actions.some((x) => x.fid === 19001 && x.act === 2), '单向关注应被取关');
      assert.strictEqual(actions.filter((x) => x.act === 1).length, 0, '已达上限，不应再发起关注');
      assert.ok(logs18.some((m) => /关注数已达上限/.test(m)), '应有「已达上限」提示日志');
    });
  }
  // 未达上限时关注照常
  s18.updateGlobal({ followCap: 1000 });
  FIX.stat = { following: 200, follower: 100 };
  FIX.followings['1800'] = [];
  {
    const e18b = new Engine(s18);
    e18b.startAll([a18.id]);
    await waitIdle(e18b);
    await t('未达上限时自动关注照常执行', () => {
      assert.ok(actions.some((x) => x.fid === 19002 && x.act === 1), '未达上限应正常回粉');
    });
  }
  FIX.stat = { following: 100, follower: 50 };

  /* ══════ [19] 满关自救（避免满关 · 保证每天可清） ══════ */
  console.log('\n[19] 满关自救');
  actions = [];
  const s19 = mkStore({ followCap: 5000 });
  FIX.stat = { following: 4950, follower: 100 };   // 距上限仅 50 → 触发自救（预留 100）
  FIX.followings['2200'] = [item(22101, 2)];       // 单向关注，mtime=刚刚（0 天）
  FIX.followers['2200'] = [item(22102, 0)];        // 回粉目标 → 应被暂停
  const a19 = mkAcc(s19, 2200, {
    tasks: { unfollow: true, follow: true },
    sources: { fans: true, search: false, ups: false },
    delayMin: 1000, delayMax: 1000, maxOps: 10, dryRun: false, skipOfficial: false,
    onlyAfterDays: true, minFollowDays: 30, capGuard: true, capGuardReserve: 100
  });
  {
    const e19 = new Engine(s19);
    const logs19 = [];
    e19.on('log', (l) => logs19.push(l.msg));
    e19.startAll([a19.id]);
    await waitIdle(e19);
    await t('贴近上限：忽略天数门槛立即清理，同时暂停自动关注', () => {
      assert.ok(actions.some((x) => x.fid === 22101 && x.act === 2), '满关自救应立即取关（不等 30 天）');
      assert.strictEqual(actions.filter((x) => x.act === 1).length, 0, '贴近上限不应再发起关注');
      assert.ok(logs19.some((m) => /满关自救/.test(m)), '应有满关自救日志');
    });
  }
  // 关闭自救 → 天数门槛恢复（0 天的新关注不再被清）
  // 注意换 UID：上一个用例真取关后已写入「不再关注名单」，同 UID 会先被名单拦截
  s19.updateAccountCfg(a19.id, { capGuard: false });
  FIX.followings['2200'] = [item(22103, 2)];
  const n19b = actions.filter((x) => x.act === 2).length;
  {
    const e19b = new Engine(s19);
    const recs19b = [];
    e19b.on('record', (r) => recs19b.push(r));
    e19b.startAll([a19.id]);
    await waitIdle(e19b);
    await t('关闭满关自救：恢复「关注满 30 天」门槛，未满则跳过', () => {
      assert.strictEqual(actions.filter((x) => x.act === 2).length, n19b, '关闭自救后不应再取关');
      assert.ok(recs19b.some((r) => r.mid === 22103 && /未满 30 天/.test(r.detail || '')), '应记录「关注仅 X 天，未满 30 天」');
    });
  }
  // 开启自救但远离上限 → 门槛照常
  s19.updateAccountCfg(a19.id, { capGuard: true });
  FIX.stat = { following: 4000, follower: 100 };   // 距上限 1000 > 预留 100
  FIX.followings['2200'] = [item(22104, 2)];
  const n19c = actions.filter((x) => x.act === 2).length;
  {
    const e19c = new Engine(s19);
    const recs19c = [];
    e19c.on('record', (r) => recs19c.push(r));
    e19c.startAll([a19.id]);
    await waitIdle(e19c);
    await t('开启自救但远离上限：天数门槛照常生效', () => {
      assert.strictEqual(actions.filter((x) => x.act === 2).length, n19c, '远离上限时不应取关');
      assert.ok(recs19c.some((r) => r.mid === 22104 && /未满 30 天/.test(r.detail || '')), '仍应按天数门槛跳过');
    });
  }
  FIX.stat = { following: 100, follower: 50 };

  /* ══════ [20] 源负缓存：隐藏粉丝列表只请求一次 ══════ */
  console.log('\n[20] 源负缓存');
  actions = [];
  FIX.fansOfCalls = {}; FIX.fansOfFail = {}; FIX.modifyFail = {};
  const s20 = mkStore({});
  FIX.fansOfFail['9001'] = 22118;   // 对方隐藏了粉丝列表
  const a20 = mkAcc(s20, 2300, {
    tasks: { unfollow: false, follow: true },
    sources: { fans: false, search: false, ups: true },
    targetUps: '9001', delayMin: 1000, delayMax: 1000, maxOps: 5, dryRun: false
  });
  {
    const e20 = new Engine(s20);
    e20.startAll([a20.id]);
    await waitIdle(e20);
    await t('隐藏粉丝列表：只请求一次并写入负缓存', () => {
      assert.strictEqual(FIX.fansOfCalls['9001'], 1, '应只请求一次');
      const h = s20.upHealthOf('9001');
      assert.ok(h && h.hiddenUntil > Date.now(), '应记录 hiddenUntil（30 天后复检）');
    });
    const e20b = new Engine(s20);
    e20b.startAll([a20.id]);
    await waitIdle(e20b);
    await t('下一轮不再重复请求隐藏源', () => {
      assert.strictEqual(FIX.fansOfCalls['9001'], 1, '负缓存生效后不应再发请求');
    });
  }

  /* ══════ [21] 目标 UP 轮转 ══════ */
  console.log('\n[21] 目标 UP 轮转');
  actions = [];
  FIX.fansOfCalls = {}; FIX.fansOfFail = {};
  const s21 = mkStore({});
  FIX.fansOf['9011'] = [item(93101, 0)];
  FIX.fansOf['9012'] = [item(93102, 0)];
  FIX.fansOf['9013'] = [item(93103, 0)];
  const a21 = mkAcc(s21, 2400, {
    tasks: { unfollow: false, follow: true },
    sources: { fans: false, search: false, ups: true },
    targetUps: '9011 9012 9013', delayMin: 1000, delayMax: 1000, maxOps: 1, dryRun: false
  });
  {
    for (let i = 0; i < 3; i++) {
      const e = new Engine(s21);
      e.startAll([a21.id]);
      await waitIdle(e);
    }
    await t('每轮从上次停下的位置继续，三轮覆盖三个不同 UP', () => {
      assert.strictEqual(FIX.fansOfCalls['9011'], 1, '第 1 轮应扫 9011');
      assert.strictEqual(FIX.fansOfCalls['9012'], 1, '第 2 轮应扫 9012');
      assert.strictEqual(FIX.fansOfCalls['9013'], 1, '第 3 轮应扫 9013');
      assert.strictEqual(s21.getAccount(a21.id).upCursor, 0, '跑满一圈后游标应回到起点');
    });
  }

  /* ══════ [22] 已注销账号黑名单 ══════ */
  console.log('\n[22] 已注销账号黑名单');
  actions = [];
  FIX.fansOfCalls = {}; FIX.modifyFail = {}; FIX.fansOfFail = {};
  const s22 = mkStore({});
  FIX.fansOf['9020'] = [item(94101, 0)];
  FIX.modifyFail['94101'] = { code: 22012, message: '账号已注销，无法完成操作', kind: 'skip' };
  const a22 = mkAcc(s22, 2500, {
    tasks: { unfollow: false, follow: true },
    sources: { fans: false, search: false, ups: true },
    targetUps: '9020', delayMin: 1000, delayMax: 1000, maxOps: 5, dryRun: false
  });
  {
    const e22 = new Engine(s22);
    e22.startAll([a22.id]);
    await waitIdle(e22);
    const before = actions.filter((x) => x.fid === 94101).length;
    await t('已注销账号被记入「不可关注」名单', () => {
      assert.ok(s22.isDeadUser(94101), '应写入死号名单');
      assert.strictEqual(before, 1, '第一次应真的尝试过');
    });
    const e22b = new Engine(s22);
    e22b.startAll([a22.id]);
    await waitIdle(e22b);
    await t('后续轮次直接跳过死号，不再发请求', () => {
      assert.strictEqual(actions.filter((x) => x.fid === 94101).length, before, '不应再次尝试关注');
    });
  }

  /* ══════ [23] 同一 UP 跨账号节流 ══════ */
  console.log('\n[23] 同一 UP 跨账号节流');
  actions = [];
  FIX.fansOfCalls = {}; FIX.fansOfFail = {}; FIX.modifyFail = {};
  const s23 = mkStore({});
  FIX.fansOf['9030'] = [item(95101, 0)];
  const aA = mkAcc(s23, 2600, {
    tasks: { unfollow: false, follow: true }, sources: { fans: false, search: false, ups: true },
    targetUps: '9030', delayMin: 1000, delayMax: 1000, maxOps: 1, dryRun: false
  });
  const aB = mkAcc(s23, 2700, {
    tasks: { unfollow: false, follow: true }, sources: { fans: false, search: false, ups: true },
    targetUps: '9030', delayMin: 1000, delayMax: 1000, maxOps: 1, dryRun: false
  });
  {
    const e23 = new Engine(s23);
    e23.startAll([aA.id]);
    await waitIdle(e23);
    e23.startAll([aB.id]);
    await waitIdle(e23);
    await t('A 扫过的 UP，B 在 10 分钟内不再重复扫', () => {
      assert.strictEqual(FIX.fansOfCalls['9030'], 1, '同一 UP 只应被请求一次');
    });
  }

  /* ══════ [24] 全局风控熔断 ══════ */
  console.log('\n[24] 全局风控熔断');
  actions = [];
  FIX.fansOfCalls = {}; FIX.fansOfFail = {}; FIX.modifyFail = {};
  const s24 = mkStore({});
  FIX.fansOfFail['9040'] = -352;
  FIX.fansOf['9041'] = [item(96101, 0)];
  const aC = mkAcc(s24, 2800, {
    tasks: { unfollow: false, follow: true }, sources: { fans: false, search: false, ups: true },
    targetUps: '9040', delayMin: 1000, delayMax: 1000, maxOps: 5, dryRun: false
  });
  const aD = mkAcc(s24, 2900, {
    tasks: { unfollow: false, follow: true }, sources: { fans: false, search: false, ups: true },
    targetUps: '9041', delayMin: 1000, delayMax: 1000, maxOps: 5, dryRun: false
  });
  {
    const e24 = new Engine(s24);
    const logs24 = [];
    e24.on('log', (l) => logs24.push(l.msg));
    e24.startAll([aC.id]);
    await waitIdle(e24);
    e24.startAll([aD.id]);
    await waitIdle(e24);
    await t('撞到 -352 后全局熔断，其他账号本轮不再发请求', () => {
      assert.ok(logs24.some((m) => /触发风控/.test(m)), '应有风控提示');
      assert.ok(logs24.some((m) => /冷却中/.test(m)), '其他账号应跳过本轮');
      assert.strictEqual(FIX.fansOfCalls['9041'], undefined, '熔断期间不应请求新 UP');
    });
  }
  FIX.fansOfFail = {}; FIX.modifyFail = {};

  console.log(`\n────────────  通过 ${pass} · 失败 ${fail}  ────────────\n`);
  process.exit(fail ? 1 : 0);
})();