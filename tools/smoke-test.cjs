/**
 * 冒烟测试工具。
 * 用途：重构 / 改素材 / 改配置后，快速确认"主进程能启动、渲染层能引导、素材能加载"。
 * 用法：npm run smoke           （默认运行 8 秒）
 *       SMOKE_RUN_MS=5000 npm run smoke
 *
 * 判定标准（全部满足才算 PASS）：
 *   1. 渲染层写出 bootstrap-end，且没有 bootstrap-error
 *   2. 主进程 main.log 没有新增错误
 *   3. 控制台没有未捕获异常 / 图片加载失败
 *
 * 说明：脚本会自动去掉 ELECTRON_RUN_AS_NODE 并附加 --no-sandbox --disable-gpu，
 *      因此在 AI 沙箱与普通桌面环境下都能运行。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUN_MS = Number(process.env.SMOKE_RUN_MS || 8000);
// 隔离的 userData：与实机运行的实例分开，否则两边共抢 Chromium 的锁/缓存，
// 会把正在跑的桌宠挤掉，日志也会互相污染
const USER_DATA_DIR = path.join(PROJECT_ROOT, 'temp', 'electron-userdata');
const DIAGNOSTICS_LOG = path.join(USER_DATA_DIR, 'diagnostics.log');
const MAIN_LOG = path.join(USER_DATA_DIR, 'main.log');

const electronPath = require(path.join(PROJECT_ROOT, 'node_modules', 'electron'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 否则 electron.exe 会退化成纯 Node 模式

const startedAt = new Date();
const mainLogSizeBefore = fileSize(MAIN_LOG);

const child = spawn(
  electronPath,
  ['.', `--user-data-dir=${USER_DATA_DIR}`, '--no-sandbox', '--disable-gpu', '--enable-logging'],
  { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env }
);

let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));

setTimeout(() => {
  killTree(child.pid);
  setTimeout(report, 1200);
}, RUN_MS);

function killTree(pid) {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch (_) {
    /* 进程可能已自行退出 */
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
}

function readNewDiagnostics() {
  try {
    const lines = fs.readFileSync(DIAGNOSTICS_LOG, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines
      .map((line) => {
        const spaceAt = line.indexOf(' ');
        return { time: line.slice(0, spaceAt), payload: line.slice(spaceAt + 1) };
      })
      .filter((item) => new Date(item.time) >= startedAt);
  } catch (_) {
    return [];
  }
}

/**
 * 启动留痕类日志（每次启动都会写）不算错误。
 *
 * 应用在 main.log 里加了 [boot] / [single-instance] / [window-all-closed] / [will-quit]，
 * 目的是让"双击没反应"这类问题事后能查。冒烟测试若把它们当成错误，
 * 每次都会红 —— 这里按阶段名白名单过滤，只把真正的错误行算数。
 */
const INFO_STAGES = /\[(boot|env|tray|single-instance|window-all-closed|will-quit)\]/;

function readNewMainLogErrors() {
  try {
    const buf = fs.readFileSync(MAIN_LOG);
    return buf
      .slice(mainLogSizeBefore)
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() && !INFO_STAGES.test(line));
  } catch (_) {
    return [];
  }
}

function report() {
  const diagnostics = readNewDiagnostics();
  const bootStarted = diagnostics.some((d) => d.payload.includes('bootstrap-start'));
  const bootEnded = diagnostics.some((d) => d.payload.includes('bootstrap-end'));
  const bootFailed = diagnostics.filter((d) => d.payload.includes('bootstrap-error'));
  const mainLogErrors = readNewMainLogErrors();
  const mainLogGrew = mainLogErrors.length > 0;

  const consoleErrors = output
    .split(/\r?\n/)
    .filter((line) => /Uncaught|加载失败|[Ee]rror:|无法|失败/.test(line))
    .filter((line) => !/gpu_process_host|GPU process/.test(line));

  console.log('=== 冒烟测试报告 ===');
  console.log(`运行时长       : ${RUN_MS}ms`);
  console.log(`启动引导       : ${bootStarted ? '有 bootstrap-start' : '无'}`);
  console.log(`引导完成       : ${bootEnded ? '有 bootstrap-end' : '无'}`);
  console.log(`渲染层错误     : ${bootFailed.length ? bootFailed.map((d) => d.payload).join(' | ') : '无'}`);
  console.log(`主进程错误日志 : ${mainLogGrew ? `\n  ${mainLogErrors.join('\n  ')}` : '无新增'}`);
  console.log(`控制台异常     : ${consoleErrors.length ? `\n  ${consoleErrors.join('\n  ')}` : '无'}`);
  console.log('--- 本次新增的诊断记录 ---');
  console.log(diagnostics.map((d) => `${d.time} ${d.payload}`).join('\n') || '(无)');

  const pass = bootEnded && bootFailed.length === 0 && !mainLogGrew && consoleErrors.length === 0;
  console.log(`\n结果: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(pass ? 0 : 1);
}
