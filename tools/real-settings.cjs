/**
 * 端到端验证：真实主进程 + 设置窗口。
 * 与 settings-shot.cjs 的分工：
 *   settings-shot  = 隔离验证设置界面本身（schema 渲染、控件、IPC、落盘）
 *   本脚本          = 起真正的应用（src/main/index.js），验证「打开设置窗口」这条
 *                    只在真实主进程里存在的链路，以及桌宠的隐藏/恢复行为
 * 用法：npm run real-settings
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'temp', 'capture');
const USER_DATA_DIR = path.join(PROJECT_ROOT, 'temp', 'electron-userdata-real');

fs.mkdirSync(OUT_DIR, { recursive: true });

const electronPath = require(path.join(PROJECT_ROOT, 'node_modules', 'electron'));
const env = { ...process.env, CAMEL_PET_OPEN_SETTINGS: '1' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electronPath,
  ['.', `--user-data-dir=${USER_DATA_DIR}`, '--no-sandbox', '--disable-gpu'],
  { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env }
);
let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));

const log = (msg) => console.log(`[real-settings] ${msg}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (_) {
    /* 可能已自行退出 */
  }
}

/** 主进程是否还活着（比查进程表更直接可靠：被 kill 或崩溃时 exitCode 会变成数字） */
function isAlive() {
  return child.exitCode === null && !child.killed;
}

(async () => {
  await wait(9000); // 等主进程就绪 + ready-to-show

  const alive = isAlive();
  log(`真实主进程存活：${alive}`);
  log(output.trim() ? `主进程输出：\n${output.trim()}` : '主进程输出：（空，无报错）');

  const fatal = /ERR_MODULE_NOT_FOUND|Cannot find module|is not a function|undefined is not/.test(output);
  if (fatal) {
    log('检测到致命错误，见上方输出');
  }

  // 截全屏，肉眼确认桌宠已隐藏、设置窗口已出现
  const shot = path.join(OUT_DIR, 'real-settings.png');
  const ps = [
    'Add-Type -AssemblyName System.Drawing;',
    '$b = New-Object System.Drawing.Bitmap(1920, 1080);',
    '$g = [System.Drawing.Graphics]::FromImage($b);',
    '$g.CopyFromScreen(0, 0, 0, 0, $b.Size);',
    `$b.Save('${shot.replace(/\\/g, '\\\\')}');`,
    '$g.Dispose(); $b.Dispose();',
  ].join(' ');
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    log(`全屏截图：${shot}`);
  } catch (error) {
    log(`截图失败：${error.message}`);
  }

  killTree(child.pid);
  await wait(800);

  const pass = alive && !fatal;
  log(pass ? '结果: PASS（真实主进程存活，设置窗口已打开）' : '结果: FAIL');
  process.exit(pass ? 0 : 1);
})();
