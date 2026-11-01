'use strict';
/**
 * 批量取关（一键取关 + 筛选）核心纯逻辑。
 *
 * 本模块不依赖 Electron / 具体账号，便于在主进程（main.js）与渲染进程（app.js）
 * 之间共用同一套筛选语义，也便于单测覆盖。
 *
 * 关系位（attribute，与 bilibili.js 一致）：
 *   2   = 我关注了 TA
 *   4   = TA 关注了我（回关）
 *   6   = 互粉（2 | 4）
 *   128 = 拉黑
 */

const MUTUAL = 4;    // TA 关注了我
const FOLLOWED = 2;  // 我关注了 TA
const BLOCKED = 128;

/** 是否「我关注了 TA」 */
function iFollow(attribute) {
  return (typeof attribute === 'number') && (attribute & FOLLOWED) !== 0;
}
/** 是否「TA 回关了我」 */
function followsMe(attribute) {
  return (typeof attribute === 'number') && (attribute & MUTUAL) !== 0;
}
/** 是否「互关」 */
function isMutual(attribute) {
  return iFollow(attribute) && followsMe(attribute);
}

/**
 * 计算「单向关注 / 不互关」：在 followings 中、但不在 followers 集合里的人。
 * 仅用于「我的关注列表」模式下、且接口未直接给出 attribute 时做兜底；
 * 绝大多数情况 followings 接口本身就会返回 attribute，直接用 isOneWay 即可。
 *
 * @param {Array<{mid:string|number, uname?:string}>} followings
 * @param {Set<string>} followerSet 粉丝 UID 集合（字符串）
 * @returns {Array} 我关注但 TA 没回关的人
 */
function computeOneWay(followings, followerSet) {
  if (!followerSet) return (followings || []).slice();
  return (followings || []).filter((it) => !followerSet.has(String(it.mid)));
}

/**
 * 对一个候选列表按筛选条件过滤。
 * 候选元素统一字段：{ mid, uname, fans?, attribute? }
 *   - fans:      对方粉丝数（搜索模式有；关注列表模式可能为空 → 粉丝数区间筛选会跳过该字段）
 *   - attribute: 关系位（搜索/关注列表模式都有；为空表示未知）
 *
 * @param {Array<{mid,uname,fans?,attribute?}>} list
 * @param {object} opts
 *   - keyword:      结果内按「昵称/UID」再次过滤（小写子串包含）
 *   - onlyOneWay:   仅保留「我关注但 TA 未回关」（attribute 含 2 且不含 4）
 *   - onlyFollowing:仅保留「我正关注 TA」（attribute 含 2）
 *   - minFans/maxFans: 对方粉丝数区间（null/'' = 不限；字段缺失视为 0 参与比较）
 * @returns {Array} 过滤后的候选（引用原对象，附加 _matched 调试信息可选）
 */
function filterCandidates(list, opts) {
  const o = opts || {};
  const kw = String(o.keyword || '').trim().toLowerCase();
  const minFans = (o.minFans == null || o.minFans === '') ? null : Number(o.minFans);
  const maxFans = (o.maxFans == null || o.maxFans === '') ? null : Number(o.maxFans);
  const needFans = (minFans != null && !Number.isNaN(minFans)) || (maxFans != null && !Number.isNaN(maxFans));

  return (list || []).filter((it) => {
    // 1) 结果内关键字（昵称 / UID）
    if (kw) {
      const hay = `${it.uname || ''} ${it.mid || ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    const attr = (typeof it.attribute === 'number') ? it.attribute : null;

    // 2) 仅「我正关注 TA」
    if (o.onlyFollowing && attr !== null && !(attr & FOLLOWED)) return false;

    // 3) 仅「我关注但 TA 未回关」（不互关）
    if (o.onlyOneWay) {
      if (attr === null) return false;            // 关系未知，保守排除
      if (!(attr & FOLLOWED)) return false;       // 我都没关注 TA，谈不上单向取关
      if (attr & MUTUAL) return false;            // 互关，排除
    }

    // 4) 对方粉丝数区间（仅当调用方要求比较粉丝数时；字段缺失不参与过滤）
    if (needFans) {
      const fans = Number(it.fans || 0);
      if (minFans != null && !Number.isNaN(minFans) && fans < minFans) return false;
      if (maxFans != null && !Number.isNaN(maxFans) && fans > maxFans) return false;
    }
    return true;
  });
}

/**
 * 执行前的最终校验：该候选是否可被取关。
 * 取关前提 = 我正关注 TA。再叠加各类保护排除项。
 *
 * @param {{mid:string|number, uname?:string, attribute?:number, fans?:number}} it
 * @param {object} excl 排除集合
 *   - white:       Set<string> 白名单
 *   - neverFollow: Set<string> 不再关注名单
 *   - dead:        Set<string> 已注销 / 不可关注
 *   - mutual:      boolean     是否保护互关（true=不取关互关，默认 true）
 * @returns {{ok:boolean, reason?:string}}
 */
function canUnfollow(it, excl) {
  const e = excl || {};
  const attr = (typeof it.attribute === 'number') ? it.attribute : null;
  if (attr !== null && !(attr & FOLLOWED)) return { ok: false, reason: '未关注 TA（无法取关）' };
  const key = String(it.mid);
  if (e.white && e.white.has(key)) return { ok: false, reason: '白名单' };
  if (e.neverFollow && e.neverFollow.has(key)) return { ok: false, reason: '已在不关注名单' };
  if (e.dead && e.dead.has(key)) return { ok: false, reason: '已注销/不可关注' };
  if (e.mutual && attr !== null && (attr & MUTUAL)) return { ok: false, reason: '互关（已保护）' };
  return { ok: true };
}

module.exports = {
  MUTUAL, FOLLOWED, BLOCKED,
  iFollow, followsMe, isMutual,
  computeOneWay, filterCandidates, canUnfollow
};
