'use strict';
/**
 * 平台适配器抽象层（P2-G 奠基）。
 *
 * 设计意图：把「账号关系管理」的核心能力（登录校验 / 拉关注 / 拉粉丝 / 取关 / 关注 / 画像 / 活跃度）
 * 抽象成统一接口，让 B 站、微博、抖音、小红书等平台以「适配器」形式挂载，复用同一套
 * 筛选 / 风控 / 审计 / UI。当前仅实现 BilibiliAdapter（包装既有 BiliClient），其余平台为预留挂载点。
 *
 * 合规红线：任何适配器都不得做「云端代登录 / 凭据托管」；登录态只在本机、由用户授权取得。
 */

/**
 * @typedef {Object} RelationAdapter
 * @property {string} platform   平台标识：'bilibili' | 'weibo' | 'douyin' | 'xiaohongshu'
 * @property {Function} nav       校验登录态，返回 { code, uname, following, follower }
 * @property {Function} followings 拉关注列表（分页）
 * @property {Function} followers  拉粉丝列表（分页）
 * @property {Function} modify     关系变更 act: 1=关注 2=取关
 * @property {Function} spaceProfile 用户空间画像
 * @property {Function} recentPosts  最近投稿（活跃度判定）
 */

/** 适配器注册表：platform -> factory(cookie) => adapter 实例 */
const REGISTRY = new Map();

/**
 * 注册一个平台适配器工厂。
 * @param {string} platform
 * @param {(cookie:string)=>RelationAdapter} factory
 */
function registerAdapter(platform, factory) {
  REGISTRY.set(platform, factory);
}

/** 取适配器工厂；未注册返回 null */
function getAdapterFactory(platform) {
  return REGISTRY.get(platform) || null;
}

/** 是否支持某平台 */
function hasPlatform(platform) {
  return REGISTRY.has(platform);
}

/** 列出已挂载平台 */
function listPlatforms() {
  return Array.from(REGISTRY.keys());
}

module.exports = { registerAdapter, getAdapterFactory, hasPlatform, listPlatforms, REGISTRY };
