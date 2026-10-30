'use strict';
/**
 * 热更新的纯逻辑（不依赖 electron，可在普通 node 下单测）：
 * 版本号解析 / 比较 + 从 GitHub Release 资产中挑安装包。
 */

/** 'v2.1.7' / '2.1.7-beta' → { major:2, minor:1, patch:7 }；无法解析返回 null */
function parseVer(v) {
  const m = String(v == null ? '' : v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/**
 * 按数值比较（2.10.0 > 2.9.9）；任一无法解析时返回 0（视为相同，不误升级）。
 * 参数既可以是字符串（'2.1.6'），也可以是 parseVer 的结果（{major,minor,patch}）——
 * 早先只认字符串，调用方传了已解析的对象，String({}) 解析失败 → 返回 0 →
 * 「当前版本 >= 最新版」恒成立 → 永远提示「已是最新版本」，热更新一次都没弹过。
 */
function compareVer(a, b) {
  const norm = (v) => (v && typeof v === 'object' && v.major != null && v.minor != null && v.patch != null
    ? v
    : parseVer(v));
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  return (x.major - y.major) || (x.minor - y.minor) || (x.patch - y.patch);
}

function fmt(v) {
  const p = parseVer(v) || v;
  if (p && typeof p === 'object') return `${p.major}.${p.minor}.${p.patch}`;
  return String(p || '0.0.0');
}

/**
 * 挑要下载的资产：优先「便携版」单文件 EXE（用户实际在用的形态，替换最干净），
 * 没有便携版就取体积最大的 .exe；.blockmap 等辅助文件不算。
 * 名称标记同时认中文「便携版」与 ASCII「portable」，防止资产名被环境转码后失配。
 */
function pickAsset(assets) {
  const exes = (assets || []).filter((a) =>
    a && typeof a.name === 'string' && /\.exe$/i.test(a.name) && !/\.blockmap$/i.test(a.name));
  if (!exes.length) return null;
  const portable = exes.find((a) => /便携版|portable/i.test(a.name));
  if (portable) return portable;
  if (exes.length === 1) return exes[0];
  return exes.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0];
}

module.exports = { parseVer, compareVer, fmt, pickAsset };
