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

/** 按数值比较（2.10.0 > 2.9.9）；任一无法解析时返回 0（视为相同，不误升级） */
function compareVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
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
 */
function pickAsset(assets) {
  const exes = (assets || []).filter((a) =>
    a && typeof a.name === 'string' && /\.exe$/i.test(a.name) && !/\.blockmap$/i.test(a.name));
  if (!exes.length) return null;
  const portable = exes.find((a) => /便携版/.test(a.name));
  if (portable) return portable;
  return exes.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0];
}

module.exports = { parseVer, compareVer, fmt, pickAsset };
