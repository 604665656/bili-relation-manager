'use strict';
/**
 * B 站 Web 接口客户端（Node / Electron 主进程通用，无任何第三方依赖）
 *
 * 关键接口：
 *   关系列表  GET  /x/relation/followings   /x/relation/followers   —— 需 WBI 签名
 *   关系变更  POST /x/relation/modify       act=1 关注 / act=2 取关 / act=5 拉黑 / act=7 踢粉
 *   单用户关系 GET /x/relation?fid=          —— 兜底查询 attribute
 * attribute 位掩码： 2=我关注了TA   4=TA关注了我   6=互粉   128=拉黑
 */
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const getMixinKey = (o) => MIXIN_KEY_ENC_TAB.map((n) => o[n]).join('').slice(0, 32);

/** 常见风控/错误码的可读说明 */
const ERR_TEXT = {
  0: '成功',
  '-101': '账号未登录',
  '-111': 'CSRF 校验失败（bili_jct 失效，请重新登录）',
  '-352': '风控拦截，请停止并等待一段时间',
  '-403': '访问权限不足',
  '-412': '请求被拦截（搜索接口限流），需退避重试',
  '-509': '请求过于频繁，已触发限流',
  '-799': '请求过于频繁，请放慢速度',
  22007: '重复操作（已是该状态）',
  22009: '关注失败，可能已达上限或对方设置限制',
  22015: '关注数量已达账号上限',
  22016: '关注数已达上限，无法继续关注'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 单次请求的最长等待时间：超过则视为卡死，抛错走「异常后自动重启」逻辑 */
const REQUEST_TIMEOUT_MS = 30000;

/** 搜索结果里的昵称/签名带 <em class="keyword"> 高亮标签，要清掉 */
const stripTag = (s) => String(s || '').replace(/<[^>]+>/g, '');

/** 接口返回的头像是 //i2.hdslb.com/... 形式，补协议 */
const normUrl = (u) => {
  const s = String(u || '').trim();
  if (!s) return '';
  return s.startsWith('//') ? 'https:' + s : s;
};


function parseCookieMap(cookie) {
  const m = {};
  String(cookie || '').split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) m[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  return m;
}

class BiliClient {
  /**
   * @param {string} cookie 形如 "SESSDATA=xxx; bili_jct=yyy; DedeUserID=123"
   */
  constructor(cookie) {
    this.cookie = String(cookie || '').trim();
    this._cm = parseCookieMap(this.cookie);
    this._wbi = null;
    this.mid = Number(this._cm.DedeUserID || 0);
    this.profile = null;
  }

  get csrf() { return this._cm.bili_jct || ''; }
  get isLoggedCookie() { return !!(this._cm.SESSDATA && this._cm.bili_jct && this._cm.DedeUserID); }
  get hasBuvid() { return !!this._cm.buvid3; }

  /**
   * 补设备指纹 buvid3 / buvid4。
   * 实测：没有 buvid3 时搜索接口直接返回 -412 request was banned；
   * 调 /x/frontend/finger/spi 拿到并带上后立即恢复 200。
   * 成功后 cookie 字符串会被补全，可回写到账号里持久化。
   */
  async ensureBuvid() {
    if (this._cm.buvid3) return true;
    try {
      const j = await this.request('https://api.bilibili.com/x/frontend/finger/spi', {
        referer: 'https://www.bilibili.com/'
      });
      const b3 = j && j.data && j.data.b_3;
      const b4 = j && j.data && j.data.b_4;
      if (!b3) return false;
      const extra = `buvid3=${b3}` + (b4 ? `; buvid4=${b4}` : '');
      this.cookie = this.cookie ? `${this.cookie}; ${extra}` : extra;
      this._cm.buvid3 = b3;
      if (b4) this._cm.buvid4 = b4;
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- 底层请求 ---------------- */
  async request(url, { method = 'GET', params = null, form = null, referer = null, timeoutMs = null } = {}) {
    let full = url;
    if (params && Object.keys(params).length) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) q.append(k, String(v));
      full += (url.includes('?') ? '&' : '?') + q.toString();
    }

    const headers = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: referer || 'https://space.bilibili.com/',
      Origin: 'https://space.bilibili.com'
    };
    if (this.cookie) headers.Cookie = this.cookie;

    const init = { method, headers };
    if (form) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) body.append(k, String(v));
      init.body = body;
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    // 看门狗第 1 层：单次请求挂死（如 fetch 永远不返回）→ 超时抛错，
    // 由上层 _runRound 的 catch 转成「异常后自动重启」流程。
    const tmo = (timeoutMs != null) ? Number(timeoutMs) : (this.requestTimeoutMs || REQUEST_TIMEOUT_MS);
    init.signal = AbortSignal.timeout(tmo);
    try {
      const res = await fetch(full, init);
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch (e) { throw Object.assign(new Error('响应不是合法 JSON：' + text.slice(0, 120)), { code: -9999 }); }
      return json;
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        const err = new Error(`请求超时（${Math.round(tmo / 1000)}s 无响应）：${url}`);
        err.code = -9998; err.kind = 'timeout';
        throw err;
      }
      throw e;
    }
  }

  /* ---------------- 账号 & 签名 ---------------- */
  async nav() {
    const j = await this.request('https://api.bilibili.com/x/web-interface/nav');
    if (j.code !== 0) return j;
    this.profile = {
      mid: j.data.mid,
      uname: j.data.uname,
      face: j.data.face,
      level: j.data.level_info && j.data.level_info.current_level,
      vip: j.data.vip && j.data.vip.status === 1,
      following: j.data.following,
      follower: j.data.follower
    };
    this.mid = j.data.mid;
    return j;
  }

  async getWbiKeys() {
    if (this._wbi) return this._wbi;
    const j = await this.request('https://api.bilibili.com/x/web-interface/nav');
    // 实测：匿名或未登录时 code=-101，但仍会返回 wbi_img，照常可用
    const img = j && j.data && j.data.wbi_img && j.data.wbi_img.img_url;
    const sub = j && j.data && j.data.wbi_img && j.data.wbi_img.sub_url;
    if (!img || !sub) {
      throw Object.assign(
        new Error((j && j.message || 'nav 失败') + ` (code=${j && j.code})`),
        { code: j && j.code }
      );
    }
    this._wbi = {
      img: img.substring(img.lastIndexOf('/') + 1, img.lastIndexOf('.')),
      sub: sub.substring(sub.lastIndexOf('/') + 1, sub.lastIndexOf('.')),
      at: Date.now()
    };
    if (j.data && j.data.mid) this.mid = j.data.mid;
    return this._wbi;
  }

  async signParams(params) {
    const k = await this.getWbiKeys();
    const mixin = getMixinKey(k.img + k.sub);
    const p = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
    const chr = /[!'()*]/g;
    const query = Object.keys(p).sort().map((key) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(String(p[key]).replace(chr, ''))}`
    ).join('&');
    return query + '&w_rid=' + md5(query + mixin);
  }

  /* ---------------- 关系列表 ---------------- */
  /** 自己的关注列表（vmid 默认自己；他人仅可见前 100） */
  async followings(pn = 1, ps = 50, vmid = this.mid, orderType = '') {
    await this.getWbiKeys();
    const params = { vmid, pn, ps, order: 'desc' };
    if (orderType) params.order_type = orderType;
    const q = await this.signParams(params);
    return await this.request('https://api.bilibili.com/x/relation/followings?' + q, {
      referer: `https://space.bilibili.com/${vmid}/relation/follow`
    });
  }

  /** 粉丝列表。他人粉丝列表上限：前 1000 条（pn ≤ 20），22118 = 对方隐藏了粉丝列表 */
  async followers(pn = 1, ps = 50, vmid = this.mid) {
    await this.getWbiKeys();
    const q = await this.signParams({
      vmid, pn, ps, order: 'desc', order_type: 'attention'
    });
    return await this.request('https://api.bilibili.com/x/relation/followers?' + q, {
      referer: `https://space.bilibili.com/${vmid}/relation/fans`
    });
  }

  /** 取某个 UP 主的粉丝（用于「关注 TA 的粉丝」） */
  async fansOf(vmid, pn = 1, ps = 50) { return await this.followers(pn, ps, vmid); }

  /**
   * 搜索用户 —— 「自动寻找关注目标」的核心接口
   *
   * 实测要点（2026-10 验证）：
   *   · 必须用 /x/web-interface/search/type，**不能带 wbi 签名**，否则返回 -412 request was banned
   *   · search_type=bili_user；page_size 最大 50；结果上限 1000 条（numPages ≤ 20）
   *   · 偶发 -412 属于限流，退避后重试可恢复
   *   · 返回项无 attribute 字段，判断「是否已关注」需另查或本地比对关注列表
   *
   * @returns {{code:number, list:Array, total:number, pages:number, message?:string}}
   */
  async searchUsers(keyword, page = 1, pageSize = 50) {
    await this.ensureBuvid();   // 没有 buvid3 会被 -412 直接拦
    const j = await this.request('https://api.bilibili.com/x/web-interface/search/type', {
      params: { search_type: 'bili_user', keyword, page, page_size: pageSize },
      referer: 'https://search.bilibili.com/'
    });
    if (!j || j.code !== 0) {
      return {
        code: j ? j.code : -1,
        message: (j && j.message) || ERR_TEXT[String(j && j.code)] || '搜索失败',
        list: [], total: 0, pages: 0
      };
    }
    const d = j.data || {};
    const raw = Array.isArray(d.result) ? d.result : [];
    const list = raw.map((x) => ({
      mid: x.mid,
      uname: stripTag(x.uname),
      face: normUrl(x.upic),
      sign: stripTag(x.usign),
      fans: Number(x.fans) || 0,
      videos: Number(x.videos) || 0,
      level: Number(x.level) || 0,
      official_verify: x.official_verify || { type: -1, desc: '' },
      is_live: !!x.is_live,
      attribute: (typeof x.attribute === 'number') ? x.attribute : null
    }));
    return { code: 0, list, total: Number(d.numResults) || 0, pages: Number(d.numPages) || 0 };
  }


  /** 关注数 / 粉丝数实时统计 */
  async stat(vmid = this.mid) {
    await this.getWbiKeys();
    const q = await this.signParams({ vmid });
    const j = await this.request('https://api.bilibili.com/x/relation/stat?' + q, {
      referer: `https://space.bilibili.com/${vmid}/`
    });
    if (j && j.code === 0 && j.data) {
      return { code: 0, following: j.data.following, follower: j.data.follower };
    }
    return { code: j ? j.code : -1, following: null, follower: null, message: j && j.message };
  }

  /** 单用户的精确关系，列表缺 attribute 字段时兜底；返回 null 表示查询失败 */
  async relation(fid) {
    await this.getWbiKeys();
    const q = await this.signParams({ fid });
    const j = await this.request('https://api.bilibili.com/x/relation?' + q, {
      referer: `https://space.bilibili.com/${fid}/`
    });
    if (j.code === 0 && j.data) return j.data.attribute;
    return null;
  }

  /** 是否已互粉（TA 是否回关了我） */
  async didFollowBack(fid) {
    const attr = await this.relation(fid);
    if (attr === null) return null;
    return (attr & 4) !== 0;
  }

  /* ---------------- 写操作 ---------------- */
  /**
   * @param {number} fid 目标 UID
   * @param {number} act 1=关注 2=取关 5=拉黑 6=取消拉黑 7=移除粉丝
   * @returns {{ok:boolean, code:number, message:string, kind:'ok'|'skip'|'ratelimit'|'fatal'}}
   */
  async modify(fid, act) {
    const j = await this.request('https://api.bilibili.com/x/relation/modify', {
      method: 'POST',
      form: { fid, act, re_src: 11, jsonp: 'jsonp', csrf: this.csrf },
      referer: `https://space.bilibili.com/${fid}/`
    });
    const code = Number(j.code);
    const message = j.message || ERR_TEXT[String(code)] || '未知错误';
    if (code === 0) return { ok: true, code, message, kind: 'ok' };
    if (code === -509 || code === -799) return { ok: false, code, message, kind: 'ratelimit' };
    if (code === -352 || code === -111 || code === -101) return { ok: false, code, message, kind: 'fatal' };
    if (code === 22015 || code === 22016) return { ok: false, code, message, kind: 'fatal' };
    return { ok: false, code, message, kind: 'skip' };
  }
}

module.exports = { BiliClient, md5, getMixinKey, MIXIN_KEY_ENC_TAB, parseCookieMap, sleep, ERR_TEXT };
