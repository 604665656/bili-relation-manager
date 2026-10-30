// 构建后校验：确认 asar 内文件齐全且包含当前版本的关键实现标记
// 用法: node tools/verify-asar.js [asar路径]
const asar = require('@electron/asar');
const path = require('path');

const file = process.argv[2] || path.join('dist', 'win-unpacked', 'resources', 'app.asar');
const raw = asar.listPackage(file);
const norm = raw.map((p) => p.split(path.sep).join('/').replace(/^\//, ''));

const need = [
  'main.js',
  'preload.js',
  'src/store.js',
  'src/task.js',
  'src/updater.js',
  'src/updater-core.js',
  'renderer/app.js',
  'renderer/index.html',
  'renderer/styles.css',
];

const marks = [
  '源健康度·日志落盘',
  'upHealth',
  'hiddenUntil',
  'deadUsers',
  'upCursor',
  '冷却中',
  'capGuard',
  'updater:apply',
  'logKeepDays',
  'pruneLogFiles',
  '已注销 / 不可关注',
  '"version": "2.1.8"',
];

let ok = true;
console.log('asar:', file);
console.log('条目数:', norm.length);

console.log('\n-- 关键文件 --');
for (const n of need) {
  const hit = norm.includes(n);
  if (!hit) ok = false;
  console.log(`${hit ? '[OK]  ' : '[MISS]'} ${n}`);
}

const text = norm
  .filter((p) => /\.(js|html|css|json)$/.test(p))
  .map((p) => asar.extractFile(file, p.split('/').join(path.sep)).toString('utf8'))
  .join('\n');

console.log('\n-- 版本标记 --');
for (const m of marks) {
  const hit = text.includes(m);
  if (!hit) ok = false;
  console.log(`${hit ? '[OK]  ' : '[MISS]'} ${m}`);
}

console.log('\n结果:', ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
