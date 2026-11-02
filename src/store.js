'use strict';
/** 本地数据持久化（全部落在用户目录，不上传任何数据） */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 本地时区日期 YYYY-MM-DD（RB9：统一日期口径，避免 UTC 与本地混用导致跨天错位 8 小时） */
function localDate(d) {
  const t = d ? new Date(d) : new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
}

const DEFAULT_ACCOUNT_CFG = {
  mode: 'auto',          // 旧字段，仅用于兼容历史数据；实际行为由 tasks 决定

  // ── 任务类型（多选）──
  tasks: {
    unfollow: true,      // 清理单向关注：取关「我关注了TA，TA没回关我」
    follow: false        // 自动关注互粉目标：按下方 sources 自动找人关注
  },
  // ── 关注目标来源（多选，tasks.follow 打开时生效）──
  sources: {
    fans: true,          // 我的粉丝列表（回粉）
    search: false,       // 关键词搜索用户
    ups: false           // 指定 UP 的粉丝（定向，需填 UID）
  },

  // ── 关键词搜索参数 ──
  searchKeywords: '',    // 空格/逗号分隔，每个词独立统计回关率
  searchMaxPages: 2,     // 每个关键词最多翻几页（每页 50 人）
  searchMaxFans: 0,      // 跳过粉丝数超过该值的（0=不限，中小号回关率更高）
  searchMinLevel: 1,     // 跳过低于该等级的账号（0/1 级多为小号）

  delayMin: 3000,
  delayMax: 6000,
  maxOps: 30,
  dryRun: true,
  skipOfficial: true,
  skipSpecial: true,     // 跳过「特别关注」（接口字段名为 special）
  skipVip: false,        // RB12：跳过大会员（vipStatus=1）的 UP
  enabled: true,

  // ── 自动循环 ──
  autoLoop: false,       // 一轮结束后自动进入下一轮
  loopIntervalMin: 30,   // 每轮间隔（分钟）
  dailyCap: 0,           // 每日操作总量上限，0 = 不限

  // ── 异常自动重启 ──
  errRetryMin: 0,        // 任务异常后，等待 N 分钟再自动重启（0 = 不重启，异常即停止）

  // ── 看门狗（停滞检测）──
  watchdogStallMin: 15,  // 单轮内连续 N 分钟无任何「扫描/操作」进展则判定为卡死，强制抛错走重启（0 = 禁用）

  // ── 关注满 N 天未回关才取关 ──
  onlyAfterDays: false,  // 是否启用天数门槛
  minFollowDays: 7,      // 门槛天数

  // ── 满关自救（避免撞关注上限，保证每天都能清理）──
  capGuard: true,        // 关注数达到「全局上限 − 预留」时：① 自动关注暂停 ② 清理忽略天数门槛立即腾名额
  capGuardReserve: 100,  // 自救触发预留：距关注上限还剩多少名额时触发（0 = 只有满了才触发）

  // ── 指定 UP 的粉丝（sources.ups 打开时才需要）──
  targetUps: '',         // 目标 UP 的 UID，逗号/空格分隔

  // ── 取关我的名单（unfollowers）──
  trackUnfollowers: true // 每日拉取粉丝快照并比对，记录取关者并自动加入不再回关名单
};

/** 旧版本单选 mode → 新多选 tasks/sources 的迁移映射 */
const MODE_TO_TASKS = {
  unfollow: { tasks: { unfollow: true, follow: false }, sources: { fans: true, search: false, ups: false } },
  followback: { tasks: { unfollow: false, follow: true }, sources: { fans: true, search: false, ups: false } },
  fansof: { tasks: { unfollow: false, follow: true }, sources: { fans: false, search: false, ups: true } },
  both: { tasks: { unfollow: true, follow: true }, sources: { fans: true, search: false, ups: false } }
};

/** 合并账号配置：嵌套对象要逐层补默认值，不能整体覆盖 */
function normalizeCfg(cfg) {
  const src = cfg || {};
  const out = Object.assign({}, DEFAULT_ACCOUNT_CFG, src);
  out.tasks = Object.assign({}, DEFAULT_ACCOUNT_CFG.tasks, src.tasks || {});
  out.sources = Object.assign({}, DEFAULT_ACCOUNT_CFG.sources, src.sources || {});

  // 历史数据只有 mode：按映射补齐（仅在完全没有 tasks 字段时执行，避免覆盖用户的新选择）
  if (!src.tasks && MODE_TO_TASKS[src.mode]) {
    const m = MODE_TO_TASKS[src.mode];
    out.tasks = Object.assign({}, m.tasks);
    out.sources = Object.assign({}, m.sources);
  }
  // 老数据若填过 targetUps，自动把「指定 UP」来源打开，避免升级后静默失效
  if (!src.sources && String(src.targetUps || '').trim()) out.sources.ups = true;
  return out;
}


const DEFAULT_GLOBAL = {
  whiteList: [],           // 全局白名单：永不操作
  neverFollow: [],         // 不再关注名单：取关成功后自动写入，后续模式一律跳过
  deadUsers: [],           // 不可关注用户（已注销 / 隐私限制），跨账号共享，避免重复尝试
  upHealth: {},            // 目标 UP 健康度（跨账号共享）：{ [uid]: { hiddenUntil, nextTryAt, fails, kind, lastScanAt, lastBy } }
  rateThreshold: 0.15,     // 回关率下限（低于则停止关注该来源的粉丝）
  rateMinSample: 20,       // 达到该核验样本量才做回关率判断
  rateVerifyGapHours: 24,  // 关注后至少多久才核验对方是否回关
  pageGap: 1200,           // 翻页间隔(ms)
  statIntervalMin: 5,      // 关注/粉丝数实时刷新间隔(分钟)
  autoStartOnLaunch: false, // 应用启动时，自动恢复「有任务且未禁用」的账号（需用户主动开启）
  followCap: 5000,         // 关注上限保护：关注数达到该值就跳过「自动关注」，防止被 B 站拒绝（普通账号 5000，大会员可调高；0 = 关闭）
  logKeepDays: 14,         // 每日日志文件保留天数（logs/YYYY-MM-DD.log）
  quietHours: '',          // 每日休息时段（RB20）：如 "23:00-08:00"，空 = 不限制
  restDays: [],            // 每周休息日（RB20）：0=周日…6=周六，空 = 不限制
  updateMirror: 'auto'     // 热更新下载镜像：'auto'（自动探测最快镜像）/ 'direct'（直连 GitHub）/ 自定义 http(s) 前缀
};

/** 界面日志保留条数（完整历史在 logs/ 目录的每日文件里） */
const UI_LOG_CAP = 300;

class Store {
  /**
   * @param {string} dir 数据目录
   * @param {{codec?: {encrypt:(s:string)=>string, decrypt:(s:string)=>string}}} [opts]
   *   codec 用于 cookie 落盘加密（RB2）：main 进程传 safeStorage(DPAPI) 实现；
   *   单测/无 electron 环境不传 → identity（明文），保持 store.js 可独立 require。
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'data.json');
    this.data = null;
    this.lastError = null;
    this.codec = opts.codec || null;
    this._dirty = false;   // RB8：高频字段只标记脏，由主进程 3s 定时 flush
  }

  /** 标记有变更待落盘（不立即写文件） */
  _markDirty() { this._dirty = true; }

  ensure() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { /* ignore */ }
  }

  load() {
    this.ensure();
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { raw = null; }
    this.data = Object.assign(
      { version: 1, accounts: [], global: {}, logs: [] },
      raw || {}
    );
    this.data.global = Object.assign({}, DEFAULT_GLOBAL, this.data.global || {});
    // 默认值里的数组/对象是共享引用，必须克隆成本实例私有，避免多个 Store 互相污染
    const g = this.data.global;
    if (!Array.isArray(g.whiteList)) g.whiteList = [];
    if (!Array.isArray(g.neverFollow)) g.neverFollow = [];
    if (!Array.isArray(g.deadUsers)) g.deadUsers = [];
    if (!g.upHealth || typeof g.upHealth !== 'object' || Array.isArray(g.upHealth)) g.upHealth = {};
    if (typeof g.quietHours !== 'string') g.quietHours = '';
    if (!Array.isArray(g.restDays)) g.restDays = [];
    if (!Array.isArray(this.data.logs)) this.data.logs = [];
    if (!Array.isArray(this.data.records)) this.data.records = [];
    this.data.accounts = (this.data.accounts || []).map((a) => this._normalize(a));
    // RB2：cookie 解密（旧版明文无前缀，codec.decrypt 原样返回，天然兼容迁移）
    if (this.codec) {
      for (const a of this.data.accounts) {
        try { a.cookie = this.codec.decrypt(a.cookie || ''); } catch (e) { a.cookie = a.cookie || ''; }
        // v2.3.0：refreshToken 同样加密落盘（与 cookie 同密级）
        try { a.refreshToken = this.codec.decrypt(a.refreshToken || ''); } catch (e) { a.refreshToken = a.refreshToken || ''; }
      }
    }
    this._deadSet = null;   // 懒加载索引
    this.pruneLogFiles();
    this.pruneUpHealth();
    this.pruneFollowStats();
    return this.data;
  }

  /** 补齐字段默认值（新建账号与读取历史数据共用） */
  _normalize(a) {
    return {
      id: a.id || crypto.randomUUID(),
      uid: a.uid, uname: a.uname, face: a.face, cookie: a.cookie,
      refreshToken: a.refreshToken || '',
      cfg: normalizeCfg(a.cfg),
      // 实时统计：关注数 / 粉丝数
      live: Object.assign({ following: 0, follower: 0, prevFollowing: 0, prevFollower: 0, at: 0 }, a.live || {}),
      // 回关率统计（按来源 UP 分组）
      followStats: Object.assign(
        { tried: 0, backed: 0, sample: 0, bySource: {}, pendingVerify: [] },
        a.followStats || {}
      ),
      // 每日操作计数
      daily: Object.assign({ date: '', ops: 0 }, a.daily || {}),
      // 粉丝数按天快照：用于计算「今日/本周/本月/本年 新增粉丝」
      followerLog: (a.followerLog && typeof a.followerLog === 'object' && !Array.isArray(a.followerLog)) ? a.followerLog : {},
      // 「指定 UP」轮转游标：记住上轮扫到列表第几个，下轮从这里继续（避免只扫头部）
      upCursor: Number(a.upCursor) || 0,
      // 粉丝 UID 快照（用于比对「取关我的名单」）：[{mid,uname}]，受 B站 API 前 1000 条上限约束
      followerSnapshot: Array.isArray(a.followerSnapshot) ? a.followerSnapshot.slice(-2000) : [],
      lastFollowerSnapDate: typeof a.lastFollowerSnapDate === 'string' ? a.lastFollowerSnapDate : '',
      // 取关我的名单：{ date, mid, uname, handled: null|'auto'|'blocked'|'ignored' }
      unfollowers: Array.isArray(a.unfollowers) ? a.unfollowers : []
    };
  }

  /**
   * 落盘。便携版可能被放在无写权限的目录，这里必须把失败暴露出来，
   * 否则登录成功却存不下 → 界面静默无反应。
   */
  flush() {
    if (!this.data) return false;
    try {
      this.ensure();
      const tmp = this.file + '.tmp';
      // RB2：落盘前对 cookie 加密（内存里保持明文供请求使用，磁盘只存密文）
      let payload = this.data;
      if (this.codec) {
        payload = Object.assign({}, this.data, {
          accounts: this.data.accounts.map((a) => Object.assign({}, a, {
            cookie: this.codec.encrypt(a.cookie || ''),
            refreshToken: this.codec.encrypt(a.refreshToken || '')
          }))
        });
      }
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      this.lastError = null;
      this._dirty = false;
      return true;
    } catch (e) {
      this.lastError = e && e.message || String(e);
      console.error('[store] 写入失败:', this.lastError);
      return false;
    }
  }

  /** 目录可写性自检，启动时调用一次 */
  checkWritable() {
    try {
      this.ensure();
      const probe = path.join(this.dir, '.write_probe');
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.unlinkSync(probe);
      return { ok: true, dir: this.dir };
    } catch (e) {
      return { ok: false, dir: this.dir, message: e && e.message || String(e) };
    }
  }

  get() { return this.data || this.load(); }

  listAccounts() { return this.get().accounts; }
  getAccount(id) { return this.get().accounts.find((a) => a.id === id) || null; }

  upsertAccount(acc) {
    const list = this.get().accounts;
    const i = list.findIndex((a) => a.uid === acc.uid);
    if (i >= 0) {
      list[i] = Object.assign({}, list[i], acc, {
        cfg: normalizeCfg(Object.assign({}, list[i].cfg || {}, acc.cfg || {}))
      });
      this.flush();
      return list[i];
    }
    const row = this._normalize(Object.assign({
      id: crypto.randomUUID()
    }, acc));
    list.push(row);
    this.flush();
    return row;
  }

  removeAccount(id) {
    const d = this.get();
    d.accounts = d.accounts.filter((a) => a.id !== id);
    this.flush();
  }

  updateAccountCfg(id, cfg) {
    const a = this.getAccount(id);
    if (!a) return null;
    a.cfg = normalizeCfg(Object.assign({}, a.cfg || {}, cfg || {}));
    this.flush();
    return a;
  }

  updateGlobal(g) {
    this.get().global = Object.assign({}, this.get().global, g || {});
    this.flush();
    return this.get().global;
  }

  /* ══════ 不再关注名单 ══════ */
  inNeverFollow(uid) {
    return (this.get().global.neverFollow || []).map(String).includes(String(uid));
  }
  addNeverFollow(uids) {
    const g = this.get().global;
    const set = new Set((g.neverFollow || []).map(String));
    (Array.isArray(uids) ? uids : [uids]).forEach((u) => set.add(String(u)));
    g.neverFollow = Array.from(set).slice(-20000);
    this.flush();
    return g.neverFollow;
  }
  removeNeverFollow(uid) {
    const g = this.get().global;
    g.neverFollow = (g.neverFollow || []).filter((u) => String(u) !== String(uid));
    this.flush();
    return g.neverFollow;
  }
  clearNeverFollow() {
    this.get().global.neverFollow = [];
    this.flush();
    return [];
  }

  /* ══════ 取关我的名单（unfollowers） ══════ */
  setFollowerSnapshot(id, list) {
    const a = this.getAccount(id);
    if (!a) return null;
    a.followerSnapshot = Array.isArray(list)
      ? list.map((x) => ({ mid: String(x.mid), uname: x.uname || '' })).slice(-2000)
      : [];
    a.lastFollowerSnapDate = localDate();
    this.flush();
    return a.followerSnapshot;
  }
  addUnfollower(id, entry) {
    const a = this.getAccount(id);
    if (!a) return null;
    a.unfollowers = a.unfollowers || [];
    a.unfollowers.unshift(Object.assign({ date: localDate(), handled: 'auto' }, entry));
    if (a.unfollowers.length > 5000) a.unfollowers.length = 5000;
    this.flush();
    return a.unfollowers;
  }
  /** 批量写入取关者（一次落盘，避免逐条重写整个 data.json） */
  addUnfollowers(id, entries) {
    const a = this.getAccount(id);
    if (!a) return null;
    const today = localDate();
    a.unfollowers = a.unfollowers || [];
    const items = (Array.isArray(entries) ? entries : [entries]).map((e) =>
      Object.assign({ date: today, handled: 'auto' }, e));
    a.unfollowers = items.concat(a.unfollowers);
    if (a.unfollowers.length > 5000) a.unfollowers.length = 5000;
    this.flush();
    return a.unfollowers;
  }
  markUnfollower(id, mid, status) {
    const a = this.getAccount(id);
    if (!a) return null;
    const item = (a.unfollowers || []).find((u) => String(u.mid) === String(mid));
    if (!item) return null;
    item.handled = status; // 'blocked' | 'ignored'
    if (status === 'blocked') this.addNeverFollow(mid);
    this.flush();
    return a.unfollowers;
  }
  listUnfollowers(id) {
    const a = this.getAccount(id);
    return a ? (a.unfollowers || []) : [];
  }

  /* ══════ 不可关注用户（已注销 / 隐私限制），跨账号共享 ══════ */
  isDeadUser(uid) {
    const key = String(uid);
    if (!this._deadSet) this._deadSet = new Set((this.get().global.deadUsers || []).map(String));
    return this._deadSet.has(key);
  }
  addDeadUser(uid, reason) {
    const g = this.get().global;
    const key = String(uid);
    if (!this._deadSet) this._deadSet = new Set((g.deadUsers || []).map(String));
    if (this._deadSet.has(key)) return g.deadUsers;
    this._deadSet.add(key);
    g.deadUsers = (g.deadUsers || []).concat([key]).slice(-5000);
    this.flush();
    return g.deadUsers;
  }
  clearDeadUsers() {
    this.get().global.deadUsers = [];
    this._deadSet = new Set();
    this.flush();
    return [];
  }

  /* ══════ 目标 UP 健康度（跨账号共享的负缓存，避免反复打隐藏/风控源） ══════ */
  upHealthOf(uid) {
    const h = this.get().global.upHealth || {};
    return h[String(uid)] || null;
  }
  setUpHealth(uid, patch) {
    const g = this.get().global;
    if (!g.upHealth || typeof g.upHealth !== 'object') g.upHealth = {};
    const key = String(uid);
    const prev = g.upHealth[key] || {};
    g.upHealth[key] = Object.assign({}, prev, patch || {}, { updatedAt: Date.now() });
    // 不在这里 flush：每轮会写很多次，交给主进程 3s 定时落盘，避免频繁重写整个 data.json
    return g.upHealth[key];
  }
  /** 清理 30 天没再碰过的 UP 健康度记录，防无限膨胀 */
  pruneUpHealth(days = 30) {
    const g = this.get().global;
    const h = g && g.upHealth;
    if (!h || typeof h !== 'object') return 0;
    const cutoff = Date.now() - days * 86400000;
    let n = 0;
    for (const k of Object.keys(h)) {
      const t = Number((h[k] || {}).updatedAt) || 0;
      if (t && t < cutoff) { delete h[k]; n++; }
    }
    return n;
  }
  /** 保存某账号的「指定 UP」轮转游标 */
  setUpCursor(id, n) {
    const a = this.getAccount(id);
    if (!a) return 0;
    a.upCursor = Math.max(0, Number(n) || 0);
    this.flush();
    return a.upCursor;
  }

  /* ══════ 日志：内存留最近 N 条给界面，完整历史按天写文件 ══════ */
  _logFilePath(day) {
    return path.join(this.dir, 'logs', day + '.log');
  }
  _appendLogFile(row) {
    const ts = new Date(row.ts || Date.now());
    const p2 = (n) => String(n).padStart(2, '0');
    const day = `${ts.getFullYear()}-${p2(ts.getMonth() + 1)}-${p2(ts.getDate())}`;
    const time = `${p2(ts.getHours())}:${p2(ts.getMinutes())}:${p2(ts.getSeconds())}`;
    const acc = row.accountId ? ((this.getAccount(row.accountId) || {}).uname || '') : '';
    const line = `${day} ${time} [${row.level}]${acc ? ' [' + acc + ']' : ''} ${row.msg}\n`;
    try {
      const f = this._logFilePath(day);
      if (!this._logDirReady) { fs.mkdirSync(path.dirname(f), { recursive: true }); this._logDirReady = true; }
      fs.appendFileSync(f, line, 'utf8');
    } catch (e) { /* 日志文件写失败不影响主流程 */ }
  }
  /** 清理超过 logKeepDays 天的日志文件 */
  pruneLogFiles() {
    const keep = Number((this.get().global || {}).logKeepDays) || 14;
    const cutoff = Date.now() - keep * 86400000;
    let n = 0;
    try {
      const dir = path.join(this.dir, 'logs');
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
        if (!m) continue;
        const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
        if (t && t < cutoff) { try { fs.unlinkSync(path.join(dir, f)); n++; } catch (e) { /* ignore */ } }
      }
    } catch (e) { /* 目录不存在 */ }
    return n;
  }

  /* ══════ 账号级统计 ══════ */
  /** 通用字段补丁（live / followStats / daily） */
  patchAccount(id, patch) {
    const a = this.getAccount(id);
    if (!a) return null;
    Object.assign(a, patch || {});
    this._markDirty();
    return a;
  }

  /** 每日计数：跨天自动重置，返回累加后的当日总量（RB9 用本地日期；RB8 不即时 flush） */
  bumpDaily(id, n) {
    const a = this.getAccount(id);
    if (!a) return 0;
    const today = localDate();
    if (a.daily.date !== today) { a.daily.date = today; a.daily.ops = 0; }
    a.daily.ops += (n || 0);
    this._markDirty();
    return a.daily.ops;
  }

  /** 更新实时关注/粉丝数，返回与上一次的差值 */
  setLive(id, following, follower) {
    const a = this.getAccount(id);
    if (!a) return null;
    const dF = (following == null) ? 0 : following - (a.live.following || 0);
    const dR = (follower == null) ? 0 : follower - (a.live.follower || 0);
    a.live = {
      following: following == null ? a.live.following : following,
      follower: follower == null ? a.live.follower : follower,
      prevFollowing: dF, prevFollower: dR, at: Date.now()
    };
    // 记录每日粉丝快照（用于「新增粉丝」周期统计），保留最近 400 天（RB9 本地日期）
    if (follower != null) {
      const day = localDate();
      a.followerLog = a.followerLog || {};
      a.followerLog[day] = follower;
      const keys = Object.keys(a.followerLog).sort();
      if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete a.followerLog[k];
    }
    this._markDirty();
    return { following: a.live.following, follower: a.live.follower, dFollowing: dF, dFollower: dR };
  }

  /** 回关率统计：修改 followStats（mutator 直接操作对象；RB8 不即时 flush） */
  withFollowStats(id, mutator) {
    const a = this.getAccount(id);
    if (!a) return null;
    if (!a.followStats) a.followStats = { tried: 0, backed: 0, sample: 0, bySource: {}, pendingVerify: [] };
    mutator(a.followStats);
    this._markDirty();
    return a.followStats;
  }

  resetFollowStats(id) {
    const a = this.getAccount(id);
    if (!a) return null;
    a.followStats = { tried: 0, backed: 0, sample: 0, bySource: {}, pendingVerify: [] };
    this.flush();
    return a.followStats;
  }

  /**
   * RB6：清理长期未更新的回关率来源（bySource 随关键词/UP 数线性膨胀）。
   * 仅删除「带 at 时间戳且超过 N 天」的条目；旧数据无 at 时保留，避免误删历史。
   * 并限制来源总数（按 at 最旧优先丢弃）。
   */
  pruneFollowStats(days = 30, maxKeys = 500) {
    const cutoff = Date.now() - days * 86400000;
    for (const a of this.get().accounts) {
      const by = a && a.followStats && a.followStats.bySource;
      if (!by || typeof by !== 'object') continue;
      for (const k of Object.keys(by)) {
        const b = by[k];
        const t = Number(b && b.at) || 0;
        if (t && t < cutoff) delete by[k];
      }
      const keys = Object.keys(by);
      if (keys.length > maxKeys) {
        keys.sort((x, y) => (Number(by[x].at) || 0) - (Number(by[y].at) || 0));
        for (const k of keys.slice(0, keys.length - maxKeys)) delete by[k];
      }
    }
  }

  /* ══════ 操作明细（RB3：落盘持久化，重启不丢） ══════ */
  addRecord(row) {
    const d = this.get();
    if (!Array.isArray(d.records)) d.records = [];
    d.records.push(Object.assign({ ts: Date.now() }, row));
    if (d.records.length > 3000) d.records.splice(0, d.records.length - 3000);
    this._markDirty();   // 高频写入，交给主进程定时 flush
    return d.records;
  }
  listRecords(n = 3000) {
    const d = this.get();
    const list = Array.isArray(d.records) ? d.records : [];
    return n > 0 ? list.slice(-n) : list;
  }

  /** 高频写入，不落盘；由主进程定时 flush，避免每条日志重写整个文件 */
  addLog(row) {
    const d = this.get();
    const entry = Object.assign({ ts: Date.now() }, row);
    d.logs.push(entry);
    // 界面只留最近 N 条；完整历史写 logs/YYYY-MM-DD.log（保留 logKeepDays 天）
    if (d.logs.length > UI_LOG_CAP) d.logs.splice(0, d.logs.length - UI_LOG_CAP);
    this._appendLogFile(entry);
    return d.logs;
  }
}

module.exports = { Store, DEFAULT_ACCOUNT_CFG, DEFAULT_GLOBAL, normalizeCfg, MODE_TO_TASKS, diffUnfollowers, localDate };

/**
 * 计算「取关者」：prev 里有、curr 里没有的 UID（保留昵称）。
 * 纯函数，便于单测，也供 task.js 的 _phaseUnfollowers 直接复用。
 * @param {Array<{mid:string|number,uname?:string}>} prev 上一次粉丝快照
 * @param {Array<{mid:string|number,uname?:string}>} curr 本次粉丝快照
 * @returns {Array<{mid:string,uname:string}>} 取关者（mid 归一为字符串）
 */
function diffUnfollowers(prev, curr) {
  const prevMap = {};
  (Array.isArray(prev) ? prev : []).forEach((x) => { if (x && x.mid != null) prevMap[String(x.mid)] = x; });
  const currSet = new Set((Array.isArray(curr) ? curr : []).map((x) => String(x && x.mid)));
  const lost = [];
  for (const mid of Object.keys(prevMap)) if (!currSet.has(mid)) lost.push({ mid: String(prevMap[mid].mid), uname: prevMap[mid].uname || '' });
  return lost;
}
