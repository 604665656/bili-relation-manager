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

class Updater {
  /**
   * @param {(ev: {type:string, [k:string]:any}) => void} opts.onEvent
   *   available / progress / status / error
   */
  constructor(opts = {}) {
    this.onEvent = opts.onEvent || (() => {});
    this.downloading = false;
  }

  _emit(type, data) {
    try { this.onEvent(Object.assign({ type }, data || {})); } catch (e) { /* ignore */ }
  }

  _request(url, { timeout = CHECK_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = net.request({ url, method: 'GET' });
      req.setHeader('User-Agent', UA);
      req.setHeader('Accept', 'application/vnd.github+json');
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

  /** 流式下载（GitHub 资产会 302 跳转，Electron net 自动跟随） */
  _download(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
      const req = net.request({ url, method: 'GET' });
      req.setHeader('User-Agent', UA);
      req.on('response', (res) => {
        if (res.statusCode >= 400) {
          return done(reject, new Error(`下载失败（HTTP ${res.statusCode}）`));
        }
        const total = Number(res.headers['content-length'] || 0) || null;
        let received = 0;
        const ws = fs.createWriteStream(dest);
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

  /** 检查更新。永不抛异常，失败以 { hasUpdate:false, error } 返回 */
  async check() {
    let json = null;
    try {
      const r = await this._request(API_LATEST);
      if (r.status !== 200) return { hasUpdate: false, error: `检查更新失败：GitHub 返回 HTTP ${r.status}` };
      json = JSON.parse(r.body.toString('utf8'));
    } catch (e) {
      return { hasUpdate: false, error: '检查更新失败：' + (e && e.message || e) };
    }
    const latest = core.parseVer(json.tag_name);
    const current = core.parseVer(app.getVersion());
    if (!latest || !current) return { hasUpdate: false, error: '版本号解析失败（tag=' + json.tag_name + '）' };
    const currentTxt = core.fmt(current);
    const latestTxt = core.fmt(latest);
    // 用规整后的字符串比较（compareVer 也兼容对象，这里显式传字符串更直观）
    if (core.compareVer(currentTxt, latestTxt) >= 0) {
      return { hasUpdate: false, version: latestTxt, current: currentTxt };
    }
    const asset = core.pickAsset(json.assets || []);
    if (!asset) {
      return { hasUpdate: false, error: `最新版 v${latestTxt} 尚未附带可下载的 EXE，请稍后再试或到项目主页手动下载` };
    }
    return {
      hasUpdate: true,
      version: latestTxt,
      current: currentTxt,
      notes: String(json.body || '').slice(0, 4000),
      asset: { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 },
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
      const sizeMb = info.asset.size ? (info.asset.size / 1048576).toFixed(1) + ' MB' : '未知大小';
      this._emit('status', { msg: `正在下载 ${info.asset.name}（${sizeMb}）…` });
      const r = await this._download(info.asset.url, dest, (p) => this._emit('progress', p));
      if (r.size < 1024 * 1024) {
        try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
        throw new Error('下载的文件异常（体积过小），已中止更新');
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
