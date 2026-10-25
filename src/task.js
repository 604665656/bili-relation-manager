'use strict';
/** 多账号并发任务引擎：每个账号一条独立异步流水线，互不阻塞 */
const { EventEmitter } = require('events');
const { BiliClient, sleep } = require('./bilibili');

const MUTUAL = 4;   // attribute 位：TA关注了我（回关）
const FOLLOWED = 2; // attribute 位：我关注了TA
const BLOCKED = 128;

const MODE_NAME = {
  unfollow: '清理单向关注',
  followback: '回粉粉丝',
  search: '关键词搜索关注',
  fansof: '关注指定UP的粉丝'
};

/** 来源 key 的可读名称：'self' → 我的粉丝；'search:xx' → 搜索「xx」；数字 → UP xx */
function sourceLabel(key) {
  const k = String(key);
  if (k === 'self' || k === 'fans') return '我的粉丝';
  if (k.startsWith('search:')) return '搜索「' + k.slice(7) + '」';
  return 'UP ' + k;
}

/** 一句话描述当前账号要做哪些事（任务类型是多选的） */
function taskSummary(cfg) {
  const T = cfg.tasks || {};
  const S = cfg.sources || {};
  const parts = [];
  if (T.unfollow) parts.push('清理单向关注');
  if (T.follow) {
    const s = [];
    if (S.fans) s.push('我的粉丝');
    if (S.search) s.push('关键词搜索');
    if (S.ups) s.push('指定UP粉丝');
    parts.push('自动关注目标（' + (s.length ? s.join(' / ') : '未选来源') + '）');
  }
  return parts.length ? parts.join(' + ') : '未选择任务类型';
}

/**
 * 启动时自动恢复：返回应被自动启动的账号 id 列表。
 * 条件：全局开关 autoStartOnLaunch 打开 + 账号未禁用 + 至少勾选了一种任务类型。
 * 这样软件第二天 / 崩溃重启后，能按上次配置把任务接回，无需手动点「开始」。
 */
function accountsToAutoStart(store) {
  const g = (store.get().global) || {};
  if (!g.autoStartOnLaunch) return [];
  return store.listAccounts()
    .filter((a) => a.cfg && a.cfg.enabled !== false &&
      (a.cfg.tasks && (a.cfg.tasks.unfollow || a.cfg.tasks.follow)))
    .map((a) => a.id);
}
const FANS_MAX_PAGES = 20;

/** 关键词搜索：结果上限 1000 条（每页 50，故最多 20 页） */
const SEARCH_MAX_PAGES = 20;

/** 异常后自动重启：连续异常达到该次数后彻底停止，避免死循环反复报错 */
const MAX_ERR_RESTART = 6;

class Engine extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    /** @type {Map<string, {state:string, cancel:boolean, stats:object}>} */
    this.runners = new Map();
  }

  stateOf(id) {
    const r = this.runners.get(id);
    return r ? r : {
      state: 'idle', cancel: false,
      stats: { scanned: 0, dealt: 0, ok: 0, fail: 0, skip: 0, round: 0, phase: '' }
    };
  }

  isBusy() {
    for (const r of this.runners.values()) if (r.state === 'running' || r.state === 'waiting' || r.state === 'restart') return true;
    return false;
  }

  /** 同时启动多个账号（真正并行，各自独立限速） */
  startAll(ids) {
    for (const id of ids) {
      const acc = this.store.getAccount(id);
      if (!acc) continue;
      const cur = this.stateOf(id);
      if (cur.state === 'running' || cur.state === 'waiting') continue;
      this._launch(acc);
    }
  }

  stop(ids) {
    for (const id of ids) {
      const r = this.runners.get(id);
      if (r && (r.state === 'running' || r.state === 'waiting')) {
        r.cancel = true;
        this.emit('account', { id, state: 'stopping' });
      }
    }
  }

  stopAll() {
    for (const [id, r] of this.runners) {
      if (r.state === 'running' || r.state === 'waiting') {
        r.cancel = true;
        this.emit('account', { id, state: 'stopping' });
      }
    }
  }

  /* ══════════ 日志 / 事件 ══════════ */
  _log(id, level, msg) {
    this.store.addLog({ level, msg, accountId: id });
    this.emit('log', { accountId: id, level, msg, ts: Date.now() });
  }
  _stat(id, patch) {
    const r = this.runners.get(id);
    if (!r) return;
    Object.assign(r.stats, patch);
    this.emit('account', { id, state: r.state, stats: Object.assign({}, r.stats) });
  }
  _push(accountId, row) {
    const full = Object.assign({ ts: Date.now(), accountId }, row);
    this.emit('record', full);
  }
  _pushStats(id) {
    const a = this.store.getAccount(id);
    if (!a) return;
    this.emit('stats', { accountId: id, followStats: a.followStats, live: a.live, daily: a.daily });
  }

  /* ══════════ 主循环（含自动循环） ══════════ */
  async _launch(acc) {
    const id = acc.id;
    this.runners.set(id, {
      state: 'running', cancel: false,
      stats: { scanned: 0, dealt: 0, ok: 0, fail: 0, skip: 0, round: 0, phase: '' }
    });

    let round = 0;
    let attempt = 0;   // 异常自动重启的累计次数

    while (true) {
      attempt++;
      const run0 = this.runners.get(id);
      run0.state = 'running';
      this.emit('account', { id, state: 'running', stats: Object.assign({}, run0.stats) });
      try {
        while (true) {
          round++;
          this._stat(id, { round, scanned: 0, dealt: 0, ok: 0, fail: 0 });
          await this._runRound(acc, this.runners.get(id), round);

          const run = this.runners.get(id);
          if (run.cancel) break;

          const cur = this.store.getAccount(id);
          const cfg = cur.cfg;
          if (!cfg.autoLoop) break;
          if (cfg.dailyCap > 0 && cur.daily.ops >= cfg.dailyCap) {
            this._log(id, 'warn', `已达每日上限 ${cfg.dailyCap}，本账号停止循环`);
            break;
          }

          run.state = 'waiting';
          this.emit('account', { id, state: 'waiting', stats: Object.assign({}, run.stats) });
          this._log(id, 'info', `第 ${round} 轮结束，${cfg.loopIntervalMin} 分钟后开始第 ${round + 1} 轮`);

          const ok = await this._sleepCancelable(run, id, cfg.loopIntervalMin * 60000);
          if (!ok || run.cancel) break;
          run.state = 'running';
          this.emit('account', { id, state: 'running', stats: Object.assign({}, run.stats) });
        }
        const r = this.runners.get(id);
        r.state = 'done';
        this.emit('account', { id, state: 'done', stats: Object.assign({}, r.stats) });
        this._log(id, 'ok', `任务结束｜共 ${round} 轮｜末轮扫描 ${r.stats.scanned}｜处理 ${r.stats.dealt}｜成功 ${r.stats.ok}｜失败 ${r.stats.fail}`);
        break;   // 正常结束，退出外层的异常重启循环
      } catch (e) {
        const r = this.runners.get(id);
        r.state = 'error';
        this.emit('account', { id, state: 'error', stats: Object.assign({}, r.stats) });
        this._log(id, 'error', '任务异常：' + (e && e.message || e));

        const run = this.runners.get(id);
        if (run.cancel) { this._log(id, 'info', '已取消，不再尝试重启'); break; }

        const cfg = this.store.getAccount(id).cfg;
        const retryMin = Number(cfg.errRetryMin) || 0;
        if (retryMin <= 0) {
          this._log(id, 'info', '未设置「异常后自动重启」（errRetryMin=0），任务停止');
          break;
        }
        if (attempt >= MAX_ERR_RESTART) {
          this._log(id, 'error', `已累计异常 ${attempt} 次，达到上限 ${MAX_ERR_RESTART}，停止自动重启以防死循环`);
          break;
        }

        run.state = 'restart';
        this.emit('account', { id, state: 'restart', stats: Object.assign({}, run.stats) });
        this._log(id, 'warn', `将在 ${retryMin} 分钟后自动重启（第 ${attempt} 次自动重启，上限 ${MAX_ERR_RESTART} 次）`);

        const ok = await this._sleepCancelable(run, id, retryMin * 60000, 'restart');
        if (!ok || run.cancel) { this._log(id, 'info', '重启等待期间被取消，任务停止'); break; }

        this._log(id, 'info', `—— 开始第 ${attempt} 次自动重启 ——`);
        round = 0;   // 新一轮重启从 1 开始计数
        // 继续外层 while → 重新进入 try，相当于自动重启
      }
    }
  }

  /**
   * 看门狗（停滞检测，第 2 层防护）。
   * 监控本轮「扫描数 + 操作数」是否持续增长；若连续 stallMin 分钟无任何进展，则 reject，
   * 异常会冒泡到 _launch 的 catch，从而走「异常后自动重启」逻辑。
   * 注意：只在「本轮进行中」运行（_runRound 内部），不参与两轮之间的空闲等待，
   * 因此正常的 loopInterval 间隔不会误触发。
   * opts 允许测试覆盖 tickMs / stallMin。
   */
  _watchdog(run, id, opts = {}) {
    const tickMs = (opts.tickMs != null) ? opts.tickMs : 5000;
    const cfg = (opts.cfg || run.cfg || {});
    const stallMin = (opts.stallMin != null) ? opts.stallMin : (Number(cfg.watchdogStallMin) || 15);
    const stallMs = Math.max(tickMs, stallMin * 60000);
    return new Promise((resolve, reject) => {
      let lastProgress = (run.stats.scanned || 0) + (run.stats.dealt || 0);
      let lastAt = Date.now();
      const timer = setInterval(() => {
        const cur = (run.stats.scanned || 0) + (run.stats.dealt || 0);
        if (cur !== lastProgress) { lastProgress = cur; lastAt = Date.now(); }
        if (Date.now() - lastAt >= stallMs) {
          clearInterval(timer);
          reject(new Error(`看门狗检测到任务停滞超过 ${Math.round(stallMs / 60000)} 分钟（连续无扫描/操作进展），强制重启以恢复`));
        }
      }, tickMs);
      if (run._wdTimers) run._wdTimers.push(timer); else run._wdTimers = [timer];
    });
  }

  /** 可中断等待（每 1 秒检查取消）。state 为该等待阶段在界面上显示的状态（如 waiting / restart） */
  async _sleepCancelable(run, id, ms, state = 'waiting') {
    const step = 1000;
    let left = Math.max(0, Math.round(ms));
    let lastMin = -1;
    while (left > 0) {
      if (run.cancel) return false;
      const tick = Math.min(step, left);
      await sleep(tick);
      left -= tick;
      if (run.cancel) return false;
      const m = Math.ceil(left / 60000);
      if (m !== lastMin && left > 0) {
        lastMin = m;
        this.emit('account', { id, state, stats: Object.assign({}, run.stats), countdown: Math.round(left / 1000) });
      }
    }
    return true;
  }

  async _runRound(acc, run, round) {
    const id = acc.id;
    const cfg = acc.cfg;
    // 看门狗（停滞检测，第 2 层防护）：与本轮工作并行。
    // 若本轮连续 stallMin 分钟无任何「扫描/操作」进展，则 reject → 由 _launch 的 catch 走
    // 「异常后自动重启」逻辑（同样受 errRetryMin / MAX_ERR_RESTART 约束）。
    const wd = this._watchdog(run, id, { cfg: acc.cfg });
    const body = this._runRoundBody(acc, run, round);
    // 记录 body 可能的异常，但不在此吞掉——race 仍需拿到它的 reject；
    // 这样既保证 body 不会变成 unhandled rejection，又能让真实异常继续向上抛。
    let bodyErr = null;
    body.catch((e) => { bodyErr = e; });
    try {
      await Promise.race([ wd, body ]);
    } finally {
      // 无论正常结束还是抛错，都要清掉看门狗定时器，避免泄漏
      (run._wdTimers || []).forEach((tm) => clearInterval(tm));
      run._wdTimers = [];
    }
    if (bodyErr) throw bodyErr;   // body 自身异常（非看门狗）→ 仍走 restart 逻辑
  }

  async _runRoundBody(acc, run, round) {
    const id = acc.id;
    const cfg = acc.cfg;
    const client = new BiliClient(acc.cookie);
    if (!client.isLoggedCookie) throw new Error('Cookie 不完整，请重新登录');

    const nav = await client.nav();
    if (nav.code !== 0) throw new Error(`登录态失效：${nav.message} (code=${nav.code})`);
    const p = nav.data || {};
    if (p.mid) client.mid = p.mid;

    // 设备指纹：搜索接口没有 buvid3 会被 -412 拦；拿到后回写账号，下一轮就不用再申请
    if (!client.hasBuvid) {
      const ok = await client.ensureBuvid();
      if (ok) {
        this.store.patchAccount(acc.id, { cookie: client.cookie });
        this._log(id, 'info', '已补充设备指纹 buvid3（关键词搜索接口需要）');
      } else {
        this._log(id, 'warn', '未能获取设备指纹 buvid3，关键词搜索可能被风控拦截');
      }
    }

    // 实时统计：关注数 / 粉丝数
    await this._refreshLive(id, client);

    this._log(id, 'info',
      `第 ${round} 轮开始｜${taskSummary(cfg)}｜延迟 ${cfg.delayMin}~${cfg.delayMax}ms｜上限 ${cfg.maxOps}` +
      `${cfg.dryRun ? '｜【演练模式】' : ''}${cfg.autoLoop ? `｜自动循环 每 ${cfg.loopIntervalMin} 分钟` : ''}`);

    // 先核验历史关注对象是否回关（更新回关率）
    if (!cfg.dryRun) await this._verifyBack(id, client);

    const T = cfg.tasks || {};
    const S = cfg.sources || {};
    if (!T.unfollow && !T.follow) {
      this._log(id, 'warn', '未勾选任何任务类型，本轮空跑');
    }

    if (T.unfollow) await this._phaseUnfollow(acc, run, client);

    if (T.follow && !run.cancel) {
      // ── 关注上限保护 / 满关自救 ──
      // B站普通账号关注上限 5000，满了之后任何关注请求都会被拒（22016）。
      // 开启「满关自救」时，暂停线提前到「上限 − 预留」：留出缓冲名额，
      // 既避免硬闯触发致命错误，也保证清理阶段每天都有名额可腾。
      const cap = Number((this.store.get().global || {}).followCap) || 0;
      const reserve = (cfg.capGuard !== false) ? Math.max(0, Number(cfg.capGuardReserve) || 0) : 0;
      const blockAt = cap > 0 ? Math.max(0, cap - reserve) : 0;
      let followBlocked = false;
      if (cap > 0) {
        const s = await client.stat(client.mid);
        const cur = (s && s.code === 0) ? s.following : null;
        if (cur != null && cur >= blockAt) {
          followBlocked = true;
          const guardTxt = (reserve > 0 && blockAt < cap) ? `（满关自救：上限 ${cap} − 预留 ${reserve}）` : '';
          this._log(id, 'warn', `关注数已达上限 ${cur}（≥ ${blockAt}）${guardTxt}，本轮跳过「自动关注」以免被 B 站拒绝；请先「清理单向关注」释放名额`);
        } else if (cur != null && cur >= blockAt - 100) {
          const lineTxt = (reserve > 0 && blockAt < cap) ? `（满关自救线 ${blockAt}）` : '';
          this._log(id, 'warn', `关注数 ${cur} 已接近上限 ${cap}${lineTxt}，建议优先「清理单向关注」腾出名额`);
        }
      }
      if (!followBlocked) {
        if (S.fans) await this._phaseFollowBack(acc, run, client);
        if (S.search && !run.cancel) await this._phaseSearch(acc, run, client);
        if (S.ups && !run.cancel) await this._phaseFansOf(acc, run, client);
        if (!S.fans && !S.search && !S.ups) {
          this._log(id, 'warn', '已勾选「自动关注目标」但未选任何来源，跳过关注阶段');
        }
      }
    }

    this._pushStats(id);
  }

  async _refreshLive(id, client) {
    try {
      const s = await client.stat(client.mid);
      const following = s.code === 0 ? s.following : (client.profile && client.profile.following);
      const follower = s.code === 0 ? s.follower : (client.profile && client.profile.follower);
      if (following == null && follower == null) return;
      const d = this.store.setLive(id, following, follower);
      if (d) {
        this.emit('stat', { accountId: id, live: this.store.getAccount(id).live });
        const sign = (n) => (n > 0 ? '+' + n : String(n));
        this._log(id, 'info', `实时统计｜关注 ${d.following}（${sign(d.dFollowing)}）｜粉丝 ${d.follower}（${sign(d.dFollower)}）`);
      }
    } catch (e) { /* 统计失败不影响主流程 */ }
  }

  /* ══════════ 通用过滤 ══════════ */
  _skipReason(acc, it, cfg, client) {
    if (String(it.mid) === String(client.mid)) return '自己';
    if ((this.store.get().global.whiteList || []).map(String).includes(String(it.mid))) return '白名单';
    if (this.store.inNeverFollow(it.mid)) return '不再关注名单';
    if (cfg.skipOfficial && it.official_verify && it.official_verify.type > 0 && it.official_verify.desc) return '认证账号';
    // 「特别关注」字段：新接口为 special，旧接口为 special_attention
    if (cfg.skipSpecial && (it.special === 1 || it.special_attention === 1)) return '特别关注';
    return null;
  }

  _jitter(cfg) {
    const lo = Math.max(1000, Number(cfg.delayMin) || 3000);
    const hi = Math.max(lo, Number(cfg.delayMax) || 6000);
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }

  /** 操作前检查每日上限；true 表示可以继续 */
  _dailyOk(acc) {
    const cur = this.store.getAccount(acc.id);
    const cap = Number(cur.cfg.dailyCap) || 0;
    if (cap <= 0) return true;
    return cur.daily.ops < cap;
  }

  /* ══════════ 阶段一：清理单向关注（可限制关注满 N 天；满关时自救立即清） ══════════ */
  async _phaseUnfollow(acc, run, client) {
    const cfg = acc.cfg;
    run.stats.phase = MODE_NAME.unfollow;

    // ── 满关自救 ──
    // 关注数贴近上限时，忽略「关注满 N 天」门槛立即清理：
    // 满员账号最缺的就是名额，等 N 天只会一直撞上限；立即清才能保证每天都能腾出名额。
    const g = this.store.get().global || {};
    const cap = Number(g.followCap) || 0;
    const reserve = (cfg.capGuard !== false) ? Math.max(0, Number(cfg.capGuardReserve) || 0) : 0;
    const guardAt = cap > 0 ? Math.max(0, cap - reserve) : 0;
    let guard = false;
    if (cfg.capGuard !== false && cap > 0) {
      try {
        const s = await client.stat(client.mid);
        const cur = (s && s.code === 0) ? s.following : null;
        if (cur != null && cur >= guardAt) {
          guard = true;
          this._log(acc.id, 'warn', `关注数 ${cur} 已达满关自救线 ${guardAt}（上限 ${cap} − 预留 ${reserve}）：本轮忽略「关注满 ${cfg.minFollowDays} 天」门槛立即清理，保证每天都能腾名额`);
        }
      } catch (e) { /* 统计失败不阻塞清理，按普通模式执行 */ }
    }
    const effOnlyAfterDays = !!cfg.onlyAfterDays && !guard;

    this._log(acc.id, 'info', `—— 进入：${MODE_NAME.unfollow}${effOnlyAfterDays ? `（仅处理关注满 ${cfg.minFollowDays} 天）` : ''}${guard ? '｜【满关自救】立即清理' : ''} ——`);

    let done = 0, pn = 1, total = Infinity;
    const nowSec = Date.now() / 1000;
    const needDays = Number(cfg.minFollowDays) || 7;
    const gapSec = needDays * 86400;

    while (!run.cancel && done < cfg.maxOps && (pn - 1) * 50 < total) {
      if (!this._dailyOk(acc)) { this._log(acc.id, 'warn', '已达每日操作上限'); break; }
      const j = await client.followings(pn, 50, client.mid, '');
      if (!j || j.code !== 0) {
        this._log(acc.id, 'error', `关注列表拉取失败：${j && j.message} (code=${j && j.code})`);
        if (j && (j.code === -352 || j.code === -509 || j.code === -101)) return;
        break;
      }
      if (typeof j.data.total === 'number') { total = j.data.total; }
      const list = j.data.list || [];
      if (!list.length) break;

      for (const it of list) {
        if (run.cancel || done >= cfg.maxOps) break;
        this._tick(acc, run);

        const reason = this._skipReason(acc, it, cfg, client);
        if (reason) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: reason }); continue; }

        let attr = (typeof it.attribute === 'number') ? it.attribute : null;
        if (attr === null) { attr = await client.relation(it.mid); await sleep(300); }
        if (attr === null) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '关系查询失败' }); continue; }
        if (attr & BLOCKED) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '已拉黑' }); continue; }
        if (attr & MUTUAL) continue; // 已互粉

        // ── 关注时长门槛（满关自救时忽略，立即清理腾名额）──
        if (effOnlyAfterDays) {
          const mtime = Number(it.mtime) || 0;
          if (!mtime) {
            this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '接口未返回关注时间' });
            continue;
          }
          const heldDays = Math.floor((nowSec - mtime) / 86400);
          if ((nowSec - mtime) < gapSec) {
            this._push(acc.id, {
              uname: it.uname, mid: it.mid, result: '跳过',
              detail: `关注仅 ${heldDays} 天，未满 ${needDays} 天`
            });
            continue;
          }
        }

        if (cfg.dryRun) {
          this._push(acc.id, { uname: it.uname, mid: it.mid, result: '待取关', detail: '演练模式' });
          this._log(acc.id, 'info', `[演练] 将取关 ${it.uname} (${it.mid})`);
        } else {
          const r = await client.modify(it.mid, 2);
          if (r.ok) {
            run.stats.ok++;
            this.store.addNeverFollow(it.mid);   // 取关后进入「不再关注」名单
            this._log(acc.id, 'ok', `已取关 ${it.uname} (${it.mid})｜已加入不再关注名单`);
            this._push(acc.id, { uname: it.uname, mid: it.mid, result: '已取关', detail: '已加入不再关注名单' });
            this.store.bumpDaily(acc.id, 1);
          } else {
            run.stats.fail++;
            this._log(acc.id, 'error', `取关失败 ${it.uname}：${r.message}`);
            this._push(acc.id, { uname: it.uname, mid: it.mid, result: '失败', detail: r.message });
            if (r.kind === 'fatal') { this._log(acc.id, 'error', '遇到致命错误码，本账号任务终止'); return; }
            await this._coolDown(acc.id, run, r);
          }
        }
        done++;
        run.stats.dealt = done;
        this._stat(acc.id, { dealt: done });
        await sleep(this._jitter(cfg));
      }
      pn++;
      await sleep(this.store.get().global.pageGap || 1200);
    }
    this._log(acc.id, 'info', `${MODE_NAME.unfollow} 结束｜本轮操作 ${done} 个`);
  }

  /* ══════════ 阶段：回粉我的粉丝（来源 = 我的粉丝列表） ══════════ */
  async _phaseFollowBack(acc, run, client) {
    const cfg = acc.cfg;
    run.stats.phase = sourceLabel('self');
    this._log(acc.id, 'info', `—— 进入：${sourceLabel('self')}（在粉丝列表里找还没互粉的人） ——`);

    let done = 0, pn = 1, total = Infinity;
    let mutual = 0, pending = 0;   // 已互粉人数 / 待回粉人数
    while (!run.cancel && done < cfg.maxOps && (pn - 1) * 50 < total) {
      if (!this._dailyOk(acc)) { this._log(acc.id, 'warn', '已达每日操作上限'); break; }
      const j = await client.followers(pn, 50, client.mid);
      if (!j || j.code !== 0) {
        this._log(acc.id, 'error', `粉丝列表拉取失败：${j && j.message} (code=${j && j.code})`);
        if (j && (j.code === -352 || j.code === -509 || j.code === -101)) return;
        break;
      }
      if (typeof j.data.total === 'number') { total = j.data.total; }
      const list = j.data.list || [];
      if (!list.length) break;

      for (const it of list) {
        if (run.cancel || done >= cfg.maxOps) break;
        this._tick(acc, run);

        const reason = this._skipReason(acc, it, cfg, client);
        if (reason) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: reason }); continue; }

        let attr = (typeof it.attribute === 'number') ? it.attribute : null;
        if (attr === null) { attr = await client.relation(it.mid); await sleep(300); }
        if (attr === null) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '关系查询失败' }); continue; }
        if (attr & BLOCKED) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '已拉黑' }); continue; }
        if (attr & FOLLOWED) { mutual++; continue; }   // 粉丝列表里 attribute 含 2 位 = 已互粉

        pending++;
        done += await this._doFollow(acc, run, client, it, 'self');
      }
      pn++;
      await sleep(this.store.get().global.pageGap || 1200);
    }
    this._log(acc.id, 'info',
      `${sourceLabel('self')} 结束｜扫描到已互粉 ${mutual} 人｜本次回粉 ${done} 人` +
      `${pending - done > 0 ? `｜未处理 ${pending - done} 人` : ''}`);
  }

  /* ══════════ 阶段：关键词搜索用户并关注（自动寻找目标，无需填 UID） ══════════ */
  async _phaseSearch(acc, run, client) {
    const cfg = acc.cfg;
    run.stats.phase = '关键词搜索';
    const kws = String(cfg.searchKeywords || '').split(/[\s,，;；\n]+/).filter(Boolean);
    if (!kws.length) {
      this._log(acc.id, 'warn', '已选「关键词搜索」但没填关键词，跳过该阶段');
      return;
    }

    const maxPages = Math.max(1, Math.min(SEARCH_MAX_PAGES, Number(cfg.searchMaxPages) || 2));
    this._log(acc.id, 'info',
      `—— 进入：关键词搜索｜${kws.length} 个关键词：${kws.join('、')}｜每个最多翻 ${maxPages} 页（每页 50 人） ——` +
      (cfg.searchMaxFans > 0 ? `｜只关注粉丝数 ≤ ${cfg.searchMaxFans} 的账号` : '') +
      (cfg.searchMinLevel > 0 ? `｜跳过 Lv${cfg.searchMinLevel} 以下` : ''));
    // 自动关注（搜索/UP）的目标是「没关注过你的陌生人」；
    // 若对方已是你的粉丝（attribute 含 4 位），不在此处关注——回粉请走「我的粉丝列表」来源
    this._log(acc.id, 'info', '该来源只关注「没关注过你的陌生人」，已自动排除你自己的粉丝（回粉请单独勾选「我的粉丝列表」）');

    // 先用本地关注列表建索引，避免对每个人再发一次关系查询（省请求、降风控）
    this._log(acc.id, 'info', '正在读取你的关注列表，用于跳过已关注的人…');
    const followed = await this._followingSet(client, 1000);
    this._log(acc.id, 'info', `已载入关注列表 ${followed.size} 人（最多读前 1000 条）`);

    const seen = new Set();
    let done = 0;

    for (const kw of kws) {
      if (run.cancel || done >= cfg.maxOps) break;
      const key = 'search:' + kw;
      if (this._sourceBlocked(acc.id, key)) continue;

      for (let pn = 1; pn <= maxPages; pn++) {
        if (run.cancel || done >= cfg.maxOps) break;
        if (!this._dailyOk(acc)) { this._log(acc.id, 'warn', '已达每日操作上限'); return; }

        const j = await this._searchWithRetry(client, kw, pn, acc.id);
        if (!j || j.code !== 0) {
          this._log(acc.id, 'error', `搜索「${kw}」第 ${pn} 页失败：${j && j.message} (code=${j && j.code})`);
          if (j && (j.code === -352 || j.code === -101)) return;
          break;
        }
        const list = j.list || [];
        if (!list.length) break;

        this._log(acc.id, 'info', `搜索「${kw}」第 ${pn} 页：返回 ${list.length} 人（共 ${j.total} 条结果）`);

        for (const it of list) {
          if (run.cancel || done >= cfg.maxOps) break;
          this._tick(acc, run);

          const mk = String(it.mid);
          if (seen.has(mk)) continue;
          seen.add(mk);

          const reason = this._skipReason(acc, it, cfg, client);
          if (reason) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: reason, source: key }); continue; }
          if (followed.has(mk)) {
            this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '已关注过', source: key });
            continue;
          }
          // 粉丝数上限：中小号更容易回关
          if (Number(cfg.searchMaxFans) > 0 && it.fans > Number(cfg.searchMaxFans)) {
            this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: `粉丝 ${it.fans} 超过上限`, source: key });
            continue;
          }
          if (it.level < Number(cfg.searchMinLevel || 0)) {
            this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: `等级 Lv${it.level} 过低`, source: key });
            continue;
          }
          // 搜索结果不带 attribute，这里补一次精确查询，避免重复关注
          const attr = await client.relation(it.mid);
          await sleep(300);
          if (attr === null) {
            this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '关系查询失败', source: key });
            continue;
          }
          if (attr & BLOCKED) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '已拉黑', source: key }); continue; }
          // ★ 排除已是粉丝的人：自动关注的定位是「陌生人」，回粉属于「我的粉丝列表」来源的职责
          if (attr & MUTUAL) {
            this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '已是你的粉丝（回粉请在「我的粉丝列表」来源）', source: key });
            continue;
          }
          if (attr & FOLLOWED) { followed.add(mk); continue; }

          done += await this._doFollow(acc, run, client, it, key);
        }
        await sleep(this.store.get().global.pageGap || 1200);
      }
      this._log(acc.id, 'info', `关键词「${kw}」扫描完毕，目前本轮关注 ${done} 人`);
    }

    this._pushStats(acc.id);
    this._log(acc.id, 'info', `关键词搜索 结束｜本轮关注 ${done} 人`);
  }

  /** 拉取自己的关注列表建 Set（判断「已关注」用），最多 cap 条 */
  async _followingSet(client, cap = 500) {
    const set = new Set();
    const pages = Math.max(1, Math.ceil(cap / 50));
    for (let pn = 1; pn <= pages; pn++) {
      const j = await client.followings(pn, 50, client.mid, '');
      if (!j || j.code !== 0) break;
      const list = (j.data && j.data.list) || [];
      list.forEach((x) => set.add(String(x.mid)));
      const total = (j.data && j.data.total) || 0;
      if (list.length < 50 || pn * 50 >= total) break;
      await sleep(this.store.get().global.pageGap || 1200);
    }
    return set;
  }

  /** 搜索接口会偶发 -412 限流，退避重试 */
  async _searchWithRetry(client, kw, pn, accId) {
    let last = null;
    for (let i = 0; i < 3; i++) {
      const j = await client.searchUsers(kw, pn, 50);
      if (j.code === 0) return j;
      last = j;
      if (j.code === -412 || j.code === -509 || j.code === -799) {
        // -412 多半是设备指纹缺失/失效，重试前先补一次
        if (j.code === -412) await client.ensureBuvid();
        const wait = 5000 * Math.pow(2, i);
        this._log(accId, 'warn', `搜索被限流（${j.message}），${Math.round(wait / 1000)}s 后重试第 ${i + 1}/3 次`);
        await sleep(wait);
        continue;
      }
      return j;
    }
    return last || { code: -1, message: '搜索失败', list: [] };
  }

  /** 该来源是否因回关率过低被停用 */
  _sourceBlocked(accId, key) {
    const a = this.store.getAccount(accId);
    const by = (a && a.followStats && a.followStats.bySource) || {};
    const s = by[String(key)];
    if (!s || !s.stopped) return false;
    const rate = s.sample ? Math.round((s.back / s.sample) * 100) : 0;
    this._log(accId, 'warn',
      `来源「${sourceLabel(key)}」回关率 ${rate}%（${s.back}/${s.sample}）低于阈值，已停止继续关注该来源`);
    return true;
  }

  /* ══════════ 阶段：关注指定 UP 的粉丝（定向来源，可选） ══════════ */
  async _phaseFansOf(acc, run, client) {
    const cfg = acc.cfg;
    run.stats.phase = MODE_NAME.fansof;
    this._log(acc.id, 'info', `—— 进入：${MODE_NAME.fansof} ——`);
    // 自动关注（搜索/UP）只关注「还不是你粉丝的人」，已是粉丝的留给「我的粉丝列表」回粉
    this._log(acc.id, 'info', '该来源只关注「还不是你粉丝的人」，已自动排除你自己的粉丝（回粉请单独勾选「我的粉丝列表」）');

    const ups = String(cfg.targetUps || '').split(/[\s,，;；]+/).filter(Boolean);
    if (!ups.length) { this._log(acc.id, 'warn', '未填写目标 UP 的 UID，跳过该阶段'); return; }

    let done = 0;
    for (const up of ups) {
      if (run.cancel || done >= cfg.maxOps) break;

      const stats = this.store.getAccount(acc.id).followStats || {};
      const src = (stats.bySource || {})[String(up)];
      if (src && src.stopped && this._sourceBlocked(acc.id, up)) continue;

      this._log(acc.id, 'info', `开始扫描 UP ${up} 的粉丝列表（接口上限前 ${FANS_MAX_PAGES * 50} 条）`);
      let pn = 1, total = Infinity;

      while (pn <= FANS_MAX_PAGES && !run.cancel && done < cfg.maxOps && (pn - 1) * 50 < total) {
        if (!this._dailyOk(acc)) { this._log(acc.id, 'warn', '已达每日操作上限'); return; }
        const j = await client.fansOf(Number(up), pn, 50);
        if (!j || j.code !== 0) {
          const msg = (j && j.code === 22118) ? '对方隐藏了粉丝列表' : (j && j.message);
          this._log(acc.id, 'error', `UP ${up} 粉丝列表拉取失败：${msg} (code=${j && j.code})`);
          if (j && (j.code === -352 || j.code === -509 || j.code === -101)) return;
          break;
        }
        if (typeof j.data.total === 'number') total = j.data.total;
        const list = j.data.list || [];
        if (!list.length) break;

        for (const it of list) {
          if (run.cancel || done >= cfg.maxOps) break;
          this._tick(acc, run);

          const reason = this._skipReason(acc, it, cfg, client);
          if (reason) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: reason, source: up }); continue; }

          let attr = (typeof it.attribute === 'number') ? it.attribute : null;
          if (attr === null) { attr = await client.relation(it.mid); await sleep(300); }
          if (attr === null) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '关系查询失败', source: up }); continue; }
          if (attr & BLOCKED) { this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '已拉黑', source: up }); continue; }
          // ★ 排除已是粉丝的人：自动关注的定位是「陌生人」，回粉属于「我的粉丝列表」来源的职责
          if (attr & MUTUAL) {
            this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '已是你的粉丝（回粉请在「我的粉丝列表」来源）', source: up });
            continue;
          }
          if (attr & FOLLOWED) continue;

          done += await this._doFollow(acc, run, client, it, String(up));
        }
        pn++;
        await sleep(this.store.get().global.pageGap || 1200);
      }
      this._log(acc.id, 'info', `UP ${up} 扫描完毕，目前本轮关注 ${done} 人`);
    }
    this._pushStats(acc.id);
    this._log(acc.id, 'info', `${MODE_NAME.fansof} 结束｜本轮操作 ${done} 个`);
  }

  /** 执行关注并登记待核验 / 回关率统计。返回 1 表示计入一次操作 */
  async _doFollow(acc, run, client, it, source) {
    const cfg = acc.cfg;
    const srcKey = String(source);
    const srcText = source === 'self' || source === 'fans' ? '' : ` 来源：${sourceLabel(source)}`;
    const doneText = (source === 'self' || source === 'fans') ? '已回粉' : '已关注';

    if (cfg.dryRun) {
      this._push(acc.id, { uname: it.uname, mid: it.mid, result: '待关注', detail: '演练模式' + srcText, source });
      this._log(acc.id, 'info', `[演练] 将关注 ${it.uname} (${it.mid})${srcText}`);
      await sleep(this._jitter(cfg));
      return 1;
    }

    const r = await client.modify(it.mid, 1);
    if (r.ok) {
      run.stats.ok++;
      this.store.bumpDaily(acc.id, 1);
      this.store.withFollowStats(acc.id, (s) => {
        s.tried = (s.tried || 0) + 1;
        s.bySource = s.bySource || {};
        if (!s.bySource[srcKey]) s.bySource[srcKey] = { tried: 0, back: 0, sample: 0, stopped: false };
        s.bySource[srcKey].tried++;
        s.pendingVerify = s.pendingVerify || [];
        s.pendingVerify.push({ fid: it.mid, uname: it.uname, source: srcKey, at: Date.now() });
      });
      this._log(acc.id, 'ok', `已关注 ${it.uname} (${it.mid})${srcText}`);
      this._push(acc.id, { uname: it.uname, mid: it.mid, result: doneText, detail: srcText.trim(), source });
    } else {
      // 22007 = 重复操作（其实已经关注了）——多半是本地关注索引没覆盖到，不算失败
      if (r.code === 22007) {
        this._push(acc.id, { uname: it.uname, mid: it.mid, result: '跳过', detail: '已关注过', source });
        return 0;
      }
      run.stats.fail++;
      this._log(acc.id, 'error', `关注失败 ${it.uname}：${r.message}`);
      this._push(acc.id, { uname: it.uname, mid: it.mid, result: '失败', detail: r.message, source });
      if (r.kind === 'fatal') { this._log(acc.id, 'error', '遇到致命错误码，本账号任务终止'); throw new Error(r.message); }
      await this._coolDown(acc.id, run, r);
      return 0;
    }
    run.stats.dealt = (run.stats.dealt || 0) + 1;
    this._stat(acc.id, { dealt: run.stats.dealt });
    await sleep(this._jitter(cfg));
    return 1;
  }

  /* ══════════ 回关核验 + 回关率计算 ══════════ */
  async _verifyBack(accId, client) {
    const g = this.store.get().global;
    const batch = 20;
    const gapH = Number(g.rateVerifyGapHours) || 24;
    const minSample = Number(g.rateMinSample) || 20;
    const threshold = Number(g.rateThreshold) || 0.15;
    const cutoff = Date.now() - gapH * 3600 * 1000;

    const acc = this.store.getAccount(accId);
    const queue = (acc.followStats && acc.followStats.pendingVerify) || [];
    const due = queue.filter((x) => x.at <= cutoff).slice(0, batch);
    if (!due.length) return;

    this._log(accId, 'info', `核验回关情况：待核验 ${queue.length} 条，本轮检查 ${due.length} 条`);
    const retry = [];
    let checked = 0;

    for (const item of due) {
      const r = await client.didFollowBack(item.fid);
      if (r === null) { retry.push(item); await sleep(500); continue; }   // 查询失败，留到下轮
      checked++;
      this.store.withFollowStats(accId, (s) => {
        s.sample = (s.sample || 0) + 1;
        s.bySource = s.bySource || {};
        const key = String(item.source);
        if (!s.bySource[key]) s.bySource[key] = { tried: 0, back: 0, sample: 0, stopped: false };
        s.bySource[key].sample++;
        if (r) { s.backed = (s.backed || 0) + 1; s.bySource[key].back++; }
      });
      await sleep(700);
    }

    // 回写队列：移除已核验成功的，保留查询失败的
    const retryIds = new Set(retry.map((x) => String(x.fid)));
    const doneIds = new Set(due.map((x) => String(x.fid)));
    this.store.withFollowStats(accId, (s) => {
      s.pendingVerify = (s.pendingVerify || [])
        .filter((x) => !doneIds.has(String(x.fid)) || retryIds.has(String(x.fid)));
    });

    // 评估各来源回关率
    const stopNotes = [];
    this.store.withFollowStats(accId, (s) => {
      for (const key of Object.keys(s.bySource || {})) {
        const b = s.bySource[key];
        if (b.stopped) continue;
        if (b.sample >= minSample) {
          const rate = b.back / b.sample;
          b.rate = Math.round(rate * 1000) / 1000;
          if (rate < threshold) {
            b.stopped = true;
            stopNotes.push(`来源「${sourceLabel(key)}」回关率 ${Math.round(rate * 100)}%（${b.back}/${b.sample}）低于 ${Math.round(threshold * 100)}%，已停止继续关注该来源`);
          }
        }
      }
    });
    stopNotes.forEach((n) => this._log(accId, 'warn', n));
    this._pushStats(accId);
    if (checked) this._log(accId, 'info', `回关核验完成：本次核验 ${checked} 人`);
  }

  /* ══════════ 限流冷却 ══════════ */
  async _coolDown(accId, run, r) {
    if (!r || r.kind !== 'ratelimit') return;
    const wait = 60000;
    this._log(accId, 'warn', `触发限流，本账号暂停 ${wait / 1000}s 后继续…`);
    this.emit('account', { id: accId, state: 'paused', stats: Object.assign({}, run.stats) });
    await this._sleepCancelable(run, accId, wait);
    this.emit('account', { id: accId, state: 'running', stats: Object.assign({}, run.stats) });
  }

  /** 扫描计数 +1 */
  _tick(acc, run) {
    run.stats.scanned = (run.stats.scanned || 0) + 1;
    this._stat(acc.id, { scanned: run.stats.scanned });
  }
}

module.exports = { Engine, MODE_NAME, sourceLabel, taskSummary, accountsToAutoStart };
