'use strict';
/**
 * B 站平台适配器：把既有 BiliClient 适配到统一的 RelationAdapter 接口。
 * 当前 task.js 仍直接 new BiliClient，本适配器用于：
 *   1) 验证平台抽象接口是否覆盖 B 站全部所需能力；
 *   2) 为后续挂载微博/抖音/小红书提供同构模板（仅本地授权、无云端代登录）。
 */
const { BiliClient } = require('../bilibili.js');

class BilibiliAdapter {
  constructor(cookie) {
    this.platform = 'bilibili';
    this.client = new BiliClient(cookie);
  }

  async nav() {
    const j = await this.client.nav();
    if (!j || j.code !== 0) return { code: j ? j.code : -1, uname: '', following: null, follower: null };
    return {
      code: 0,
      uname: j.data.uname,
      following: j.data.following,
      follower: j.data.follower
    };
  }

  async followings(pn = 1, ps = 50) { return this.client.followings(pn, ps, this.client.mid, ''); }
  async followers(pn = 1, ps = 50) { return this.client.followers(pn, ps, this.client.mid); }

  async modify(fid, act) { return this.client.modify(Number(fid), act); }
  async spaceProfile(mid) { return this.client.spaceProfile(mid); }
  async recentPosts(mid, probe = 3) { return this.client.recentVideo(mid, probe); }
}

module.exports = { BilibiliAdapter };
