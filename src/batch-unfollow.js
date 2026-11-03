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

/* 活跃度分级阈值（天） */
const ACTIVE_DAYS = 90;       // 近 90 天内有投稿 = 活跃
const OCCASIONAL_DAYS = 365;  // 90~365 天 = 偶尔
// > 365 天 = 沉寂；从未投稿 = never

/**
 * 根据「最近投稿时间」与「总投稿数」分类活跃度。
 * @param {number|null} lastPubdate 最近投稿 unix 秒（null=未知）
 * @param {number|null} count 总投稿数（0/空=从未投稿）
 * @param {number} [nowSec] 当前 unix 秒（默认取系统时间）
 * @returns {{key:'never'|'active'|'occasional'|'dormant', days:number|null, label:string}}
 */
function classifyActivity(lastPubdate, count, nowSec) {
  const now = (typeof nowSec === 'number') ? nowSec : Math.floor(Date.now() / 1000);
  if (!count || !lastPubdate) return { key: 'never', days: null, label: '从未投稿' };
  const days = Math.floor((now - lastPubdate) / 86400);
  if (days <= ACTIVE_DAYS) return { key: 'active', days, label: `活跃（${days}天前投稿）` };
  if (days <= OCCASIONAL_DAYS) return { key: 'occasional', days, label: `偶尔（${days}天前）` };
  return { key: 'dormant', days, label: `沉寂（${days}天前）` };
}

/**
 * 死粉三段细分（借鉴 bilibili-following-manager 的 已注销/停更/内容变质 思路，本地数据可判定版）。
 * 在「活跃度分级」之上，把「值得取关的沉默号」再拆成有决策意义的桶，让用户做的是决策而非翻名单。
 *
 * 字段约定（enrich 后写入候选）：
 *   - flagDeleted:  boolean  已注销 / 不可关注（spaceProfile 返回 null 或昵称含「账号已注销」）
 *   - lastPubdate / archiveCount：来自 recentVideo / spaceProfile（classifyActivity 同源）
 *   - followDays:  number|null  已关注天数（来自关注列表 mtime；null=未知）
 *
 * 分段（优先级从高到低）：
 *   deleted  已注销/不可关注       → flagDeleted
 *   decay    内容变质(高产停更)     → 历史投稿较多(>=DECAY_MIN_ARCHIVE) 且 停更超过阈值(>OCCASIONAL_DAYS)
 *   stopped  停更(低产沉寂)        → 停更超过阈值 且 不属于上面(decay)
 *   dormant  沉寂(临界)            → OCCASIONAL_DAYS < 天数 <= ACTIVE_DAYS*2（介于偶尔与停更之间，临界限）
 *   occasional 偶尔                → classifyActivity 的 occasional
 *   active   活跃                 → classifyActivity 的 active
 *   never    从未投稿             → archiveCount 为 0/空
 *   unknown  未知（无数据）        → 缺 lastPubdate 且未标记 deleted
 *
 * @param {{flagDeleted?:boolean, lastPubdate?:number|null, archiveCount?:number|null, followDays?:number|null}} c
 * @param {{stoppedDays?:number, decayMinArchive?:number}} [opts] 阈值覆盖
 * @returns {{key:'deleted'|'decay'|'stopped'|'dormant'|'occasional'|'active'|'never'|'unknown', label:string, days:number|null}}
 */
const DECAY_MIN_ARCHIVE = 20;     // 历史投稿达到此数视为「曾高产」，停更后归为「内容变质」而非普通低产
// 「沉寂临界」band 上界：停更超过 OCCASIONAL_DAYS(365) 但不超过此值（≈1.5 年）视为「还能再观望」的临界区，
// 超过则归为「停更」。注意：ACTIVE_DAYS*2(180) 恒小于 365，不能用作该 band 上界（否则 dormant 永远不可达）。
const SEG_DORMANT_MAX_DAYS = 540;
function classifySegment(c, opts) {
  const o = opts || {};
  const stoppedDays = (o.stoppedDays != null) ? Number(o.stoppedDays) : OCCASIONAL_DAYS; // 默认 365 天
  const decayMin = (o.decayMinArchive != null) ? Number(o.decayMinArchive) : DECAY_MIN_ARCHIVE;
  if (c && c.flagDeleted) return { key: 'deleted', label: '已注销/不可关注', days: null };
  const act = classifyActivity(c && c.lastPubdate, c && c.archiveCount);
  if (act.key === 'never') return { key: 'never', label: '从未投稿', days: null };
  if (act.key === 'active') return { key: 'active', label: act.label, days: act.days };
  if (act.key === 'occasional') return { key: 'occasional', label: act.label, days: act.days };
  // 到这里是 days > OCCASIONAL_DAYS（沉寂/停更区间）
  const days = act.days;
  const archive = Number((c && c.archiveCount) || 0);
  if (archive >= decayMin) return { key: 'decay', label: `内容变质（曾高产 ${archive} 投稿，停更 ${days}天）`, days };
  // 介于 occasional 与 stopped 之间的「临界沉寂」单独标出，便于用户区分「还能再观望」与「可清」
  if (days <= SEG_DORMANT_MAX_DAYS) return { key: 'dormant', label: `沉寂临界（${days}天前）`, days };
  return { key: 'stopped', label: `停更（${days}天前）`, days };
}

/** 在候选列表上批量写入 _segment（避免重复计算） */
function attachSegments(list, opts) {
  return (list || []).map((it) => {
    const seg = classifySegment(it, opts);
    return Object.assign({}, it, { _segment: seg, _activity: it._activity || classifyActivity(it.lastPubdate, it.archiveCount) });
  });
}

/**
 * 集合求差（借鉴 BilibiliFollowManage「从文件同步」语义）：
 *   应收关注 = target（目标集），current = 当前已关注。
 *   toUnfollow = 当前关注了、但目标集里没有的（多余 → 取关）
 *   toFollow   = 目标集里有、但当前没关注的（缺失 → 补关注）
 *   unchanged  = 两边都有
 * 均按 mid 归一为字符串比对。
 *
 * @param {Array<{mid:string|number, uname?:string}>} current
 * @param {Array<{mid:string|number, uname?:string}>} target
 * @returns {{toFollow:Array, toUnfollow:Array, unchanged:Array}}
 */
function diffFollowLists(current, target) {
  const cur = new Map((current || []).map((x) => [String(x.mid), x]));
  const tgt = new Map((target || []).map((x) => [String(x.mid), x]));
  const toFollow = [], toUnfollow = [], unchanged = [];
  for (const [mid, it] of tgt) if (!cur.has(mid)) toFollow.push(it);
  for (const [mid, it] of cur) {
    if (tgt.has(mid)) unchanged.push(it);
    else toUnfollow.push(it);
  }
  return { toFollow, toUnfollow, unchanged };
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
 * 候选元素统一字段：{ mid, uname, fans?, attribute?, face?, sign?, level?, lastPubdate?, archiveCount?, _activity? }
 *   - fans:          对方粉丝数（搜索/关注列表模式均可能为空 → 粉丝数区间筛选会跳过该字段）
 *   - attribute:     关系位（搜索/关注列表模式都有；为空表示未知）
 *   - face/sign:     头像/简介（载入时若接口返回则带）
 *   - lastPubdate:   最近投稿 unix 秒（enrich 分析得到；null=未知）
 *   - archiveCount:  总投稿数（enrich 分析得到）
 *   - _activity:     预计算的 classifyActivity 结果（enrich 后写入；缺则当场算）
 *
 * @param {Array} list
 * @param {object} opts
 *   - keyword:          结果内按「昵称/UID」再次过滤（小写子串包含）
 *   - onlyOneWay:       仅保留「我关注但 TA 未回关」（attribute 含 2 且不含 4）
 *   - onlyFollowing:    仅保留「我正关注 TA」（attribute 含 2）
 *   - minFans/maxFans:  对方粉丝数区间（null/'' = 不限；字段缺失视为 0 参与比较）
 *   - activity:         'active'|'occasional'|'dormant'|'never'|null → 按活跃度分级匹配
 *   - lastPostWithinDays: 仅保留「最近投稿在 N 天内」的人（从未投稿者被排除）
 *   - minLevel:         最低等级（0=不限）
 *   - hasSign:          true 时仅保留「有简介」的人
 * @returns {Array} 过滤后的候选（引用原对象）
 */
function filterCandidates(list, opts) {
  const o = opts || {};
  const kw = String(o.keyword || '').trim().toLowerCase();
  const minFans = (o.minFans == null || o.minFans === '') ? null : Number(o.minFans);
  const maxFans = (o.maxFans == null || o.maxFans === '') ? null : Number(o.maxFans);
  const needFans = (minFans != null && !Number.isNaN(minFans)) || (maxFans != null && !Number.isNaN(maxFans));
  const activityFilter = o.activity || null;
  const lastPostWithin = (o.lastPostWithinDays == null || o.lastPostWithinDays === '') ? null : Number(o.lastPostWithinDays);
  const minLevel = (o.minLevel == null || o.minLevel === '') ? 0 : Number(o.minLevel);
  const needSign = !!o.hasSign;

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

    // 5) 活跃度分级
    if (activityFilter) {
      const act = it._activity || classifyActivity(it.lastPubdate, it.archiveCount);
      if (act.key !== activityFilter) return false;
    }

    // 6) 最近投稿在 N 天内（从未投稿者排除）
    if (lastPostWithin != null && !Number.isNaN(lastPostWithin)) {
      const act = it._activity || classifyActivity(it.lastPubdate, it.archiveCount);
      if (act.days == null || act.days > lastPostWithin) return false;
    }

    // 7) 最低等级
    if (minLevel > 0) {
      const lv = Number(it.level || 0);
      if (lv < minLevel) return false;
    }

    // 8) 有简介
    if (needSign && !(it.sign && String(it.sign).trim())) return false;

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
  classifyActivity, ACTIVE_DAYS, OCCASIONAL_DAYS, DECAY_MIN_ARCHIVE, SEG_DORMANT_MAX_DAYS,
  classifySegment, attachSegments,
  diffFollowLists,
  computeOneWay, filterCandidates, canUnfollow
};
