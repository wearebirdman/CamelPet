/**
 * 直接以某个脚本作为 Electron 主进程入口启动（绕开 npm start 的 '.' 入口）。
 * 用法：node tools/run-electron.cjs <相对项目根的入口脚本> [脚本自己的参数...]
 *
 * 入口脚本之后的参数会**原样转发**给该脚本 —— 少了这一步，
 * audio-import-test 之类带文件参数的验证脚本永远只能跑内置默认值（实测踩过）。
 *
 * 两个环境坑在这里统一处理：
 * - 去掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会退化成纯 Node
 * - 附加 --no-sandbox --disable-gpu，保证 AI 沙箱与普通桌面都能跑
 */
const { spawn } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const entry = process.argv[2];
if (!entry) {
  console.error('用法：node tools/run-electron.cjs <入口脚本> [参数...]');
  process.exit(1);
}
const scriptArgs = process.argv.slice(3);

const electronPath = require(path.join(PROJECT_ROOT, 'node_modules', 'electron'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// 隔离的 userData：避免验证脚本与实机运行的实例共抢 Chromium 锁/缓存
const USER_DATA_DIR = path.join(PROJECT_ROOT, 'temp', 'electron-userdata');

const child = spawn(
  electronPath,
  [
    path.resolve(PROJECT_ROOT, entry),
    ...scriptArgs,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-sandbox',
    '--disable-gpu',
  ],
  { cwd: PROJECT_ROOT, stdio: 'inherit', env }
);

child.on('exit', (code) => process.exit(code ?? 0));
