'use strict';
/**
 * 探测：B站「搜索用户」接口是否可用、返回结构是什么（不打印任何 cookie）
 * 用法：node test/search-probe.js [关键词] [--anon]
 */
const fs = require('fs');
const path = require('path');
const { BiliClient } = require('../src/bilibili');

const KEYWORD = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '手绘';
const ANON = process.argv.includes('--anon');

function loadCookie() {
  const dir = path.join(process.env.APPDATA || '', 'bili-relation-manager');
  const f = path.join(dir, 'data.json');
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const a = (d.accounts || [])[0];
    return a ? a.cookie : '';
  } catch (e) { return ''; }
}

(async () => {
  const cookie = ANON ? '' : loadCookie();
  console.log('关键词:', KEYWORD, '| 登录态:', cookie ? '使用本地已登录账号' : '匿名');
  const c = new BiliClient(cookie);
  if (cookie) {
    const nav = await c.nav();
    console.log('nav code =', nav.code, '| mid =', nav.data && nav.data.mid);
  }

  // A. 不带 wbi 签名
  try {
    const j = await c.request('https://api.bilibili.com/x/web-interface/search/type', {
      params: { search_type: 'bili_user', keyword: KEYWORD, page: 1 },
      referer: 'https://search.bilibili.com/'
    });
    console.log('\n[A 无签名] code =', j.code, '| message =', j.message);
    dump(j);
  } catch (e) { console.log('[A 无签名] 异常:', e.message); }

  // B. 带 wbi 签名
  try {
    const q = await c.signParams({ search_type: 'bili_user', keyword: KEYWORD, page: 1 });
    const j = await c.request('https://api.bilibili.com/x/web-interface/search/type?' + q, {
      referer: 'https://search.bilibili.com/'
    });
    console.log('\n[B 带签名] code =', j.code, '| message =', j.message);
    dump(j);
  } catch (e) { console.log('[B 带签名] 异常:', e.message); }

  // C. 另一个候选：聚合搜索接口
  try {
    const q = await c.signParams({
      keyword: KEYWORD, search_type: 'bili_user', page: 1, page_size: 20
    });
    const j = await c.request('https://api.bilibili.com/x/web-interface/wbi/search/type?' + q, {
      referer: 'https://search.bilibili.com/'
    });
    console.log('\n[C wbi/search/type] code =', j.code, '| message =', j.message);
    dump(j);
  } catch (e) { console.log('[C wbi] 异常:', e.message); }
})();

function dump(j) {
  const d = j && j.data;
  if (!d) { console.log('  data 为空'); return; }
  console.log('  data keys =', Object.keys(d).join(','));
  const r = d.result;
  console.log('  result 类型 =', Array.isArray(r) ? 'array' : typeof r);
  if (Array.isArray(r) && r.length) {
    console.log('  首项字段 =', Object.keys(r[0]).join(','));
    const x = r[0];
    console.log('  样例 =', JSON.stringify({
      mid: x.mid, uname: (x.uname || '').replace(/<[^>]+>/g, ''),
      fans: x.fans, level: x.level, videos: x.videos,
      official_verify: x.official_verify, attribute: x.attribute
    }));
  }
  if (d.numResults != null) console.log('  numResults =', d.numResults, 'numPages =', d.numPages);
}
