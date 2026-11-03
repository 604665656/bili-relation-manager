'use strict';
/**
 * B 站活跃度抓取单测：验证「置顶陷阱」修复（P1-F）。
 * 空间会把置顶视频顶在最前，而置顶可能是一条很旧的视频；
 * recentVideo 必须取「前 N 条里的最大 pubdate」，而不是 list[0] 的 pubdate，
 * 否则会被旧置顶视频误导成「最近刚发过」。这里用 mock request 验证。
 */
const assert = require('assert');
const { BiliClient } = require('../src/bilibili');

let pass = 0, fail = 0;
function t(name, fn) {
  return (async () => {
    try { await fn(); console.log('  \u2713 ' + name); pass++; }
    catch (e) { console.log('  \u2717 ' + name + '  →  ' + e.message); fail++; }
  })();
}

/** 用 mock request 构造一个 BiliClient：按 URL 返回不同响应，避免真实网络 */
function fakeClient(arcVlist) {
  const c = new BiliClient('SESSDATA=x; bili_jct=y; DedeUserID=1');
  c.request = async (url) => {
    if (url.includes('finger/spi')) return { code: 0, data: { b_3: 'b3', b_4: 'b4' } };
    if (url.includes('/x/web-interface/nav')) return { code: 0, data: { mid: 1, wbi_img: { img_url: 'http://x/i.png', sub_url: 'http://x/s.png' } } };
    if (url.includes('arc/search')) return { code: 0, data: { page: { count: arcVlist.length }, list: { vlist: arcVlist } } };
    return { code: 0, data: {} };
  };
  return c;
}

(async () => {
  console.log('\n[活跃度：recentVideo 置顶陷阱修复]');

  await t('置顶旧视频 + 新视频混排时，取最新 pubdate 而非 list[0]', async () => {
    // 模拟 B 站空间：第一条是「置顶的旧视频」(pubdate 极小)，后面有更新的投稿
    const vids = [
      { pubdate: 100 },     // 置顶旧视频（最前）
      { pubdate: 1000 },    // 较新
      { pubdate: 900 },     // 中间
      { pubdate: 700 }      // 更早
    ];
    const c = fakeClient(vids);
    const r = await c.recentVideo(1, 3);   // 探针取前 3 条：100 / 1000 / 900 → 最大 1000
    assert.strictEqual(r.latestPubdate, 1000, '应返回前 N 条中的最大 pubdate，而不是置顶旧的 100');
    assert.strictEqual(r.count, 4);
  });

  await t('正常无置顶：最新即 list[0]', async () => {
    const vids = [{ pubdate: 5000 }, { pubdate: 4000 }, { pubdate: 3000 }];
    const c = fakeClient(vids);
    const r = await c.recentVideo(1, 3);
    assert.strictEqual(r.latestPubdate, 5000);
  });

  await t('列表为空（已注销/无视频）：返回 count=0, latestPubdate=null', async () => {
    const c = fakeClient([]);
    const r = await c.recentVideo(1, 3);
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.latestPubdate, null);
  });

  console.log(`\n[活跃度单测] 通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
