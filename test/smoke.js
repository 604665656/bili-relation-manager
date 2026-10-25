'use strict';
/** 冒烟测试：验证 MD5 / WBI 签名 / 真实接口连通性 / 本地存储 CRUD */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { BiliClient, md5, getMixinKey } = require('../src/bilibili');
const { Store } = require('../src/store');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '  →  ' + e.message); fail++; }
}

(async () => {
  console.log('\n[1] MD5 与 WBI');
  await t('md5 标准向量', () => {
    assert.strictEqual(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.strictEqual(md5('a'), '0cc175b9c0f1b6a831c399e269772661');
    assert.strictEqual(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
    assert.strictEqual(md5('message'), '78e731027d8fd50ed642340b7c9a63b3');
    assert.strictEqual(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
      '57edf4a22be3c955ac49da2e2107b67a');
  });
  await t('md5 中文/多字节与 node crypto 一致', () => {
    const crypto = require('crypto');
    for (let i = 0; i < 50; i++) {
      const len = Math.floor(Math.random() * 200);
      let s = '';
      for (let j = 0; j < len; j++) s += String.fromCharCode(Math.floor(Math.random() * 0x10000));
      assert.strictEqual(md5(s), crypto.createHash('md5').update(s, 'utf8').digest('hex'));
    }
  });
  await t('mixinKey 长度 32', () => {
    assert.strictEqual(getMixinKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef').length, 32);
  });

  console.log('\n[2] 真实接口连通性（匿名态）');
  const client = new BiliClient('');
  let keys = null;
  await t('拉取 WBI 密钥（匿名态亦能取到）', async () => {
    keys = await client.getWbiKeys();
    assert.ok(keys.img && keys.sub, '应返回 img/sub key');
    assert.ok(/^[0-9a-zA-Z_-]+$/.test(keys.img), 'img key 形异常: ' + keys.img);
  });
  await t('生成签名参数', async () => {
    const q = await client.signParams({ vmid: 123456, pn: 1, ps: 50, order: 'desc', order_type: 'attention' });
    assert.ok(q.includes('wts='), '缺少 wts');
    assert.ok(/w_rid=[0-9a-f]{32}$/.test(q), 'w_rid 格式异常: ' + q);
  });
  await t('未登录调用关注列表应被正常拒绝（说明请求格式正确）', async () => {
    const j = await client.followings(1, 20);
    assert.ok(j && typeof j.code === 'number', '未返回 JSON');
    console.log('      code=' + j.code + ' ' + (j.message || ''));
    assert.ok([-101, -352, -400, 0].includes(j.code), '非预期 code: ' + j.code);
  });
  await t('未完成登录态时 modify 应被拦截', async () => {
    const r = await client.modify(123, 2);
    assert.strictEqual(r.ok, false);
    assert.ok(['fatal', 'skip', 'ratelimit'].includes(r.kind), 'kind=' + r.kind);
    console.log('      code=' + r.code + ' ' + r.message);
  });

  console.log('\n[3] 本地存储');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brm-'));
  await t('写入与读取', () => {
    const s = new Store(dir);
    s.load();
    const a = s.upsertAccount({ uid: 10086, uname: '测试账号', face: 'http://x/1.jpg', cookie: 'a=1' });
    assert.ok(a.id, '应生成 id');
    assert.strictEqual(a.cfg.dryRun, true, '默认应开启演练模式');
    const s2 = new Store(dir); s2.load();
    assert.strictEqual(s2.listAccounts().length, 1);
    assert.strictEqual(s2.listAccounts()[0].uname, '测试账号');
  });
  await t('配置合并保留原值', () => {
    const s = new Store(dir); s.load();
    s.updateAccountCfg(s.listAccounts()[0].id, { mode: 'both', maxOps: 7 });
    const a = s.getAccount(s.listAccounts()[0].id);
    assert.strictEqual(a.cfg.mode, 'both');
    assert.strictEqual(a.cfg.maxOps, 7);
    assert.strictEqual(a.cfg.skipOfficial, true, '未指定的字段应保留默认');
  });
  await t('新建账号自动具备 live / followStats / daily 字段', () => {
    const s = new Store(dir); s.load();
    const a = s.upsertAccount({ uid: 20001, uname: '新账号', face: '', cookie: 'a=1' });
    assert.ok(a.live, 'live 缺失');
    assert.ok(a.followStats && Array.isArray(a.followStats.pendingVerify), 'followStats 缺失');
    assert.ok(a.daily, 'daily 缺失');
    assert.strictEqual(a.cfg.autoLoop, false);
    assert.strictEqual(a.cfg.onlyAfterDays, false);
    assert.strictEqual(a.cfg.minFollowDays, 7);
    assert.strictEqual(a.cfg.targetUps, '');
    assert.strictEqual(a.cfg.capGuard, true, '满关自救应默认开启');
    assert.strictEqual(a.cfg.capGuardReserve, 100, '默认预留 100 名额');
  });
  await t('任务类型/来源默认为多选对象', () => {
    const s = new Store(dir); s.load();
    const a = s.upsertAccount({ uid: 20002, uname: '多选', face: '', cookie: 'a=1' });
    assert.strictEqual(a.cfg.tasks.unfollow, true);
    assert.strictEqual(a.cfg.tasks.follow, false);
    assert.deepStrictEqual(a.cfg.sources, { fans: true, search: false, ups: false });
    assert.strictEqual(a.cfg.searchMaxPages, 2);
    assert.strictEqual(a.cfg.searchMinLevel, 1);
  });
  await t('旧版单选 mode 自动迁移为多选 tasks/sources', () => {
    const { normalizeCfg } = require('../src/store');
    assert.deepStrictEqual(normalizeCfg({ mode: 'followback' }).tasks, { unfollow: false, follow: true });
    assert.deepStrictEqual(normalizeCfg({ mode: 'fansof' }).sources, { fans: false, search: false, ups: true });
    assert.deepStrictEqual(normalizeCfg({ mode: 'both' }).tasks, { unfollow: true, follow: true });
    // 已存在 tasks 的不能再被 mode 覆盖
    const kept = normalizeCfg({ mode: 'unfollow', tasks: { unfollow: false, follow: true } });
    assert.strictEqual(kept.tasks.follow, true, 'tasks 不应被 mode 覆盖');
    // 老账号填过 targetUps → 自动打开 ups 来源
    assert.strictEqual(normalizeCfg({ mode: 'both', targetUps: '123 456' }).sources.ups, true);
  });
  await t('不再关注名单增删', () => {
    const s = new Store(dir); s.load();
    s.addNeverFollow(['111', '222', '111']);
    assert.ok(s.inNeverFollow(111) && s.inNeverFollow('222'));
    assert.strictEqual(s.get().global.neverFollow.length, 2, '应去重');
    s.removeNeverFollow('111');
    assert.ok(!s.inNeverFollow(111));
  });
  await t('关注/粉丝数统计与增量', () => {
    const s = new Store(dir); s.load();
    const a = s.upsertAccount({ uid: 30001, uname: '统计测试', face: '', cookie: 'a=1' });
    s.setLive(a.id, 10, 20);
    const d = s.setLive(a.id, 13, 18);
    assert.strictEqual(d.following, 13);
    assert.strictEqual(d.dFollowing, 3);
    assert.strictEqual(d.dFollower, -2);
  });
  await t('每日计数跨天重置', () => {
    const s = new Store(dir); s.load();
    const a = s.upsertAccount({ uid: 40001, uname: '每日', face: '', cookie: 'a=1' });
    assert.strictEqual(s.bumpDaily(a.id, 3), 3);
    const acc = s.getAccount(a.id);
    acc.daily.date = '2000-01-01';   // 手动改到过去
    assert.strictEqual(s.bumpDaily(a.id, 2), 2, '跨天应重置');
  });
  await t('回关率统计写入', () => {
    const s = new Store(dir); s.load();
    const a = s.upsertAccount({ uid: 50001, uname: '回关', face: '', cookie: 'a=1' });
    s.withFollowStats(a.id, (fs) => {
      fs.bySource['999'] = { tried: 3, back: 1, sample: 3, stopped: false };
      fs.tried = 3; fs.backed = 1; fs.sample = 3;
    });
    const fs = s.getAccount(a.id).followStats;
    assert.strictEqual(fs.bySource['999'].back, 1);
    assert.strictEqual(s.resetFollowStats(a.id).tried, 0);
  });
  await t('删除账号', () => {
    const s = new Store(dir); s.load();
    const before = s.listAccounts().length;
    const target = s.listAccounts().find((x) => x.uid === 10086);
    assert.ok(target, '应存在 uid=10086 的账号');
    s.removeAccount(target.id);
    assert.strictEqual(s.listAccounts().length, before - 1);
    assert.ok(!s.listAccounts().some((x) => x.uid === 10086));
  });
  await t('全局设置持久化', () => {
    const s = new Store(dir); s.load();
    s.updateGlobal({ whiteList: ['111', '222'], pageGap: 2000 });
    const s2 = new Store(dir); s2.load();
    assert.deepStrictEqual(s2.get().global.whiteList, ['111', '222']);
    assert.strictEqual(s2.get().global.pageGap, 2000);
  });

  console.log('\n[4] 热更新核心逻辑');
  const { parseVer, compareVer, pickAsset } = require('../src/updater-core');
  await t('版本号解析与比较', () => {
    assert.deepStrictEqual(parseVer('v2.1.7'), { major: 2, minor: 1, patch: 7 });
    assert.deepStrictEqual(parseVer('2.1.7-beta'), { major: 2, minor: 1, patch: 7 });
    assert.strictEqual(parseVer('abc'), null);
    assert.strictEqual(parseVer(''), null);
    assert.strictEqual(parseVer(null), null);
    assert.ok(compareVer('2.1.6', '2.1.7') < 0, '小版本应判为旧');
    assert.strictEqual(compareVer('2.1.7', 'v2.1.7'), 0, '同版本不应提示更新');
    assert.ok(compareVer('2.10.0', '2.9.9') > 0, '必须按数值比较（2.10.0 > 2.9.9）');
    assert.ok(compareVer('3.0.0', '2.9.9') > 0, '主版本优先');
    assert.strictEqual(compareVer('x', '2.1.7'), 0, '无法解析时不误升级');
  });
  await t('安装包挑选：优先便携版单文件 EXE', () => {
    const assets = [
      { name: 'B站关注管理台-2.1.7.exe', size: 100, browser_download_url: 'u1' },
      { name: 'B站关注管理台-2.1.7-便携版.exe', size: 90, browser_download_url: 'u2' },
      { name: 'B站关注管理台-2.1.7.exe.blockmap', size: 1, browser_download_url: 'u3' }
    ];
    assert.strictEqual(pickAsset(assets).name, 'B站关注管理台-2.1.7-便携版.exe');
    assert.strictEqual(pickAsset([]), null);
    assert.strictEqual(pickAsset(null), null);
    assert.strictEqual(pickAsset([{ name: 'x.zip', size: 5 }]), null, '非 exe 不选');
    const only = [{ name: 'a.exe', size: 10 }, { name: 'b.exe', size: 20 }];
    assert.strictEqual(pickAsset(only).name, 'b.exe', '无便携版时取最大的');
  });

  console.log(`\n────────────  通过 ${pass} · 失败 ${fail}  ────────────\n`);
  process.exit(fail ? 1 : 0);
})();
