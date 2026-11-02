'use strict';
/**
 * 应用内热更新（零第三方依赖）：
 *   1. check()              查 GitHub Releases 最新版，与当前版本比较
 *   2. downloadAndApply()   下载新版「便携版」单文件 EXE 到临时目录，
 *                           生成一个纯 ASCII 的 cmd 守护脚本（中文路径走命令行参数传递，无编码问题），
 *                           等当前进程退出后把新 EXE 覆盖旧 EXE 并重启。
 *
 * 为什么不用 electron-updater：本软件主打「便携版单文件 EXE」，而 electron-updater
 * 不支持 portable 目标的原地更新；自实现只有 ~150 行，行为完全可控。
 *
 * 镜像加速（v2.1.17）：GitHub 在国内访问不稳，热更新容易失败。这里内置一组
 * 反代镜像前缀，检查更新与下载均自动探测可用镜像、按最快来源回退，用户也可
 * 在「全局设置 → 热更新下载镜像」里指定「直连」或填自己的代理前缀。
 */
const { net, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const core = require('./updater-core');

const REPO = '604665656/bili-relation-manager';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_TIMEOUT_MS = 15000;
const UA = 'bili-relation-manager';

/**
 * 内置镜像/代理前缀，直接拼到完整的 github.com 链接前（ghproxy 等「反代」约定）。
 * 空串 '' 表示直连。若用户填了自定义前缀，则只使用该前缀。
 */
const MIRROR_PREFIXES = [
  '',                                   // 直连 GitHub
  'https://ghproxy.com/',
  'https://mirror.ghproxy.com/',
  'https://ghproxy.net/',
  'https://gh.api.99988866.xyz/',
  'https://github.moeyy.xyz/',
  'https://gh.idayer.com/'
];

class Updater {
  /**
   * @param {(ev: {type:string, [k:string]:any}) => void} opts.onEvent
   *   available / progress / status / error
   */
  constructor(opts = {}) {
    this.onEvent = opts.onEvent || (() => {});
    this.downloading = false;
    this.mirrorPref = 'auto';   // 'auto' | 'direct' | 自定义 http(s) 前缀
  }

  /** 设置下载镜像偏好（来自全局设置） */
  setMirror(pref) {
    if (pref === 'direct' || pref === 'auto' ||
        (typeof pref === 'string' && /^https?:\/\//i.test(pref))) {
      this.mirrorPref = pref;
    } else {
      this.mirrorPref = 'auto';
    }
  }

  _emit(type, data) {
    try { this.onEvent(Object.assign({ type }, data || {})); } catch (e) { /* ignore */ }
  }

  _request(url, opts = {}) {
    const { timeout = CHECK_TIMEOUT_MS, range = null, method = 'GET', accept = '*/*' } = opts;
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = net.request({ url, method });
      req.setHeader('User-Agent', UA);
      req.setHeader('Accept', accept);
      if (range) req.setHeader('Range', range);
      const timer = setTimeout(() => {
        try { req.abort(); } catch (e) { /* ignore */ }
        if (!settled) { settled = true; reject(new Error('网络请求超时')); }
      }, timeout);
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
        });
        res.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
      });
      req.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
      req.end();
    });
  }

  /** 流式下载（GitHub 资产会 302 跳转，Electron net 自动跟随）；支持断点续传（RB13） */
  async _download(url, dest, onProgress, opts = {}) {
    const maxRetries = opts.maxRetries || 1;
    let lastErr = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this._downloadOnce(url, dest, onProgress, opts);
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetries - 1) {
          this._emit('status', { msg: `下载中断，正在重试（${attempt + 1}/${maxRetries - 1}）…` });
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  _downloadOnce(url, dest, onProgress, opts = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
      let start = 0;
      if (opts.resume) {
        try { const st = fs.statSync(dest); if (st.size > 0) start = st.size; } catch (e) { /* 无旧文件 */ }
      }
      const req = net.request({ url, method: 'GET' });
      req.setHeader('User-Agent', UA);
      if (start > 0) req.setHeader('Range', `bytes=${start}-`);
      req.on('response', (res) => {
        if (res.statusCode === 416) {
          // 断点文件与服务器不一致：清掉临时文件，让用户重试一次全量下载
          try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
          return done(reject, new Error('断点续传区间失效，已清理临时文件，请重试'));
        }
        if (res.statusCode >= 400) {
          return done(reject, new Error(`下载失败（HTTP ${res.statusCode}）`));
        }
        const appending = start > 0 && res.statusCode === 206;
        if (start > 0 && res.statusCode === 200) start = 0;   // 服务器不支持 Range，从头下
        const len = Number(res.headers['content-length'] || 0) || 0;
        const total = (len + (appending ? start : 0)) || null;
        let received = appending ? start : 0;
        const ws = fs.createWriteStream(dest, appending ? { flags: 'a' } : {});
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) {
            try { onProgress({ received, total, pct: total ? Math.floor((received * 100) / total) : null }); } catch (e) { /* ignore */ }
          }
        });
        res.on('end', () => ws.end(() => done(resolve, { size: received })));
        res.on('error', (e) => { try { ws.destroy(); } catch (e2) { /* ignore */ } done(reject, e); });
        ws.on('error', (e) => done(reject, e));
      });
      req.on('error', (e) => done(reject, e));
      req.end();
    });
  }

  /** 并行探测各镜像对 baseUrl 的可达性与延迟；auto 模式下按最快排序返回，全部失败则退化为全量顺序尝试 */
  async _resolveCandidates(baseUrl) {
    const pref = this.mirrorPref || 'auto';
    if (pref === 'direct') return [baseUrl];
    if (typeof pref === 'string' && /^https?:\/\//i.test(pref)) {
      return [pref.replace(/\/+$/, '/') + baseUrl];
    }
    const results = await Promise.allSettled(MIRROR_PREFIXES.map((p) => this._probeOne(p, baseUrl)));
    const ok = [];
    results.forEach((r) => { if (r.status === 'fulfilled' && r.value) ok.push(r.value); });
    if (ok.length) {
      ok.sort((a, b) => a.ms - b.ms);
      return ok.map((o) => o.url);
    }
    return MIRROR_PREFIXES.map((p) => (p ? p + baseUrl : baseUrl));
  }

  async _probeOne(prefix, baseUrl) {
    const url = prefix ? prefix + baseUrl : baseUrl;
    const t0 = Date.now();
    try {
      const r = await this._request(url, { timeout: 6000, range: 'bytes=0-0', accept: '*/*' });
      if (r.status === 200 || r.status === 206) return { url, ms: Date.now() - t0 };
    } catch (e) { /* 该镜像不可达，忽略 */ }
    return null;
  }

  _mirrorLabel(url, directUrl) {
    if (url === directUrl) return 'GitHub 直连';
    try { return '镜像 ' + new URL(url).host; } catch (e) { return '镜像'; }
  }

  /** 检查更新。永不抛异常，失败以 { hasUpdate:false, error } 返回 */
  async check() {
    let json = null, lastErr = null;
    const candidates = MIRROR_PREFIXES.map((p) => p + API_LATEST);
    for (const url of candidates) {
      try {
        const r = await this._request(url, { timeout: CHECK_TIMEOUT_MS });
        if (r.status !== 200) continue;
        const j = JSON.parse(r.body.toString('utf8'));
        if (!j || !j.tag_name) continue;
        json = j; break;
      } catch (e) { lastErr = e; }
    }
    if (!json) {
      return { hasUpdate: false, error: '检查更新失败：无法连接 GitHub（直连与各镜像均失败）' + (lastErr ? '：' + (lastErr.message || lastErr) : '') };
    }
    const latest = core.parseVer(json.tag_name);
    const current = core.parseVer(app.getVersion());
    if (!latest || !current) return { hasUpdate: false, error: '版本号解析失败（tag=' + json.tag_name + '）' };
    const currentTxt = core.fmt(current);
    const latestTxt = core.fmt(latest);
    if (core.compareVer(currentTxt, latestTxt) >= 0) {
      return { hasUpdate: false, version: latestTxt, current: currentTxt };
    }
    const asset = core.pickAsset(json.assets || []);
    if (!asset) {
      return { hasUpdate: false, error: `最新版 v${latestTxt} 尚未附带可下载的 EXE，请稍后再试或到项目主页手动下载` };
    }
    const cs = (json.assets || []).find((a) => /^sha256sums\.txt$/i.test(a && a.name || ''));
    return {
      hasUpdate: true,
      version: latestTxt,
      current: currentTxt,
      notes: String(json.body || '').slice(0, 4000),
      asset: { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 },
      checksums: cs ? { name: cs.name, url: cs.browser_download_url } : null,
      pageUrl: json.html_url || `https://github.com/${REPO}/releases`
    };
  }

  /** 下载并触发热替换；返回 { ok } 或 { ok:false, error } */
  async downloadAndApply() {
    if (this.downloading) return { ok: false, error: '正在下载中，请稍候' };
    if (!app.isPackaged) {
      return { ok: false, error: '开发模式（未打包）不支持热替换，请直接 npm start 运行源码' };
    }
    this.downloading = true;
    try {
      const info = await this.check();
      if (!info.hasUpdate) {
        const msg = info.error || `已是最新版本 v${info.version || core.fmt(app.getVersion())}`;
        this._emit('status', { msg });
        return { ok: false, error: msg };
      }
      const dest = path.join(os.tmpdir(), `brm-update-${info.version}.exe`);

      // RB1：先取发布侧 sha256sums.txt 的期望哈希（多镜像回退；取不到则退化为仅体积校验）
      let expected = '';
      if (info.checksums && info.checksums.url) {
        const csCandidates = await this._resolveCandidates(info.checksums.url);
        for (const url of csCandidates) {
          try {
            const cs = await this._request(url, { timeout: 20000 });
            if (cs.status === 200) {
              expected = core.findHash(core.parseChecksums(cs.body.toString('utf8')), info.asset.name);
              if (expected) break;
            }
          } catch (e) { /* 尝试下一个镜像 */ }
        }
      }

      const sizeMb = info.asset.size ? (info.asset.size / 1048576).toFixed(1) + ' MB' : '未知大小';
      this._emit('status', { msg: '正在探测可用下载镜像…' });
      const assetCandidates = await this._resolveCandidates(info.asset.url);

      let saved = false, lastErr = null;
      for (const url of assetCandidates) {
        const label = this._mirrorLabel(url, info.asset.url);
        this._emit('status', { msg: `正在从 ${label} 下载 ${info.asset.name}（${sizeMb}）…` });
        try {
          const r = await this._download(url, dest, (p) => this._emit('progress', Object.assign({ mirror: label }, p)), { resume: true, maxRetries: 3 });
          if (r.size < 1024 * 1024) {
            try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
            throw new Error('下载的文件异常（体积过小），已中止更新');
          }
          saved = true; break;
        } catch (e) {
          lastErr = e;
          this._emit('status', { msg: `${label} 下载失败，尝试下一个镜像…` });
        }
      }
      if (!saved) throw new Error((lastErr && lastErr.message) || '所有镜像下载均失败');

      // RB1：SHA256 校验，不匹配立即中止并删除，绝不替换
      if (expected) {
        const actual = await core.sha256File(dest);
        if (actual !== expected) {
          try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
          throw new Error(`更新包校验失败（SHA256 不匹配，已中止）。期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`);
        }
        this._emit('status', { msg: '完整性校验通过（SHA256 一致）' });
      } else {
        this._emit('status', { msg: '⚠ 发布未附带 SHA256 校验文件，本次仅校验体积' });
      }
      this._emit('status', { msg: '下载完成，正在替换并重启…' });
      this._applySwap(dest);
      this._emit('status', { msg: '已触发热更新，应用即将重启' });
      return { ok: true };
    } catch (e) {
      const msg = String((e && e.message) || e);
      this._emit('error', { msg });
      return { ok: false, error: msg };
    } finally {
      this.downloading = false;
    }
  }

  /**
   * 替换当前 EXE 并重启。Windows 上运行中的 EXE 被锁定，不能原地覆盖，
   * 所以生成一个守护脚本：等本进程（按 PID）退出后 move 覆盖再启动新文件。
   * 脚本内容纯 ASCII；含中文的文件路径一律经命令行参数（UTF-16）传入，避免编码踩坑。
   */
  _applySwap(newExe) {
    const target = process.execPath;
    const cmd = path.join(os.tmpdir(), 'brm-update.cmd');
    const script = [
      '@echo off',
      'setlocal',
      'set "TARGET=%~1"',
      'set "NEW=%~2"',
      'set "PID=%~3"',
      ':wait',
      'tasklist /nh /fi "pid eq %PID%" 2>nul | find "%PID%" >nul',
      'if %errorlevel%==0 (timeout /t 1 /nobreak >nul & goto wait)',
      'move /y "%NEW%" "%TARGET%" >nul',
      'if exist "%TARGET%" start "" "%TARGET%"',
      'del "%~f0"',
      'exit'
    ].join('\r\n');
    fs.writeFileSync(cmd, script, 'utf8');
    const child = execFile('cmd', ['/c', cmd, target, newExe, String(process.pid)], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    // 给守护脚本一点启动时间再退出，避免 tasklist 还没轮到本进程
    setTimeout(() => app.exit(0), 500);
  }
}

module.exports = { Updater, REPO, API_LATEST };
