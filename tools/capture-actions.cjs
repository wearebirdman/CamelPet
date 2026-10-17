/**
 * 动作实机截图验证（跑完即退，不留进程）。
 * 用途：四个新大动作（cheer/cheer2/dive/dive2）整合后，实机播放各抓一帧，
 *       肉眼确认：画布加高生效（头顶不被裁）、脚底对齐、素材真的加载了。
 * 用法：node tools/capture-actions.cjs
 *
 * 实现与 capture-sizes.cjs 相同：系统级 CopyFromScreen（capturePage 在本机 GPU
 * 环境下会挂起），窗口 show:true 出现在屏幕左上角。
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'temp', 'capture');
const SIZE = 192;                       // 用中档验证（默认档位）
const H_PADDING = 16;
const V_PADDING = 64;
const FEET_MARGIN = 4;
const WIN_X = 60;
const WIN_Y = 60;
/** 每个动作截两帧：入场段（1.2s）与中段（2.6s），兼顾站立帧与高潮帧 */
const SHOTS = [1200, 2600];

app.disableHardwareAcceleration();

ipcMain.handle('get-app-path', () => app.getPath('userData'));
ipcMain.handle('write-diagnostics', () => true);
// 渲染层启动时会拉一次语音包清单（audio player refresh），不挂 handler 会刷
// "No handler registered for 'get-voice-packs'"（与 scheduler-check.cjs 同款挂具）
ipcMain.handle('get-voice-packs', () => []);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`[capture ${new Date().toISOString().slice(11, 23)}] ${msg}`);

function grabScreen(x, y, width, height, outFile) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing;',
    `$b = New-Object System.Drawing.Bitmap(${width}, ${height});`,
    '$g = [System.Drawing.Graphics]::FromImage($b);',
    `$g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size);`,
    `$b.Save('${outFile.replace(/\\/g, '\\\\')}');`,
    '$g.Dispose(); $b.Dispose();',
  ].join(' ');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
}

const watchdog = setTimeout(() => {
  log('看门狗超时：60s 未完成，强制退出');
  app.exit(2);
}, 60000);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const window = new BrowserWindow({
    width: SIZE + H_PADDING,
    height: SIZE + V_PADDING + FEET_MARGIN,
    x: WIN_X,
    y: WIN_Y,
    show: true,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(PROJECT_ROOT, 'src', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  window.webContents.on('console-message', (_e, _l, m) => log(`[renderer] ${m}`));
  window.webContents.on('render-process-gone', (_e, d) => log(`[renderer-gone] ${JSON.stringify(d)}`));
  window.webContents.on('did-fail-load', (_e, c, d) => log(`[did-fail-load] ${c} ${d}`));
  const askRenderer = (code, timeoutMs = 5000) =>
    Promise.race([
      window.webContents.executeJavaScript(code),
      wait(timeoutMs).then(() => '<<renderer-timeout>>'),
    ]);

  await window.loadFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'index.html'));
  await wait(2700);                          // bootstrap + idle 首帧
  /**
   * 抓屏期间临时置顶（与 settings-shot / capture-sizes 同一手法）：
   * 用户在看抖音之类的全屏窗口时 moveTop() 顶不过它，截出来的会是抖音画面。
   */
  window.setAlwaysOnTop(true);
  window.moveTop();
  window.focus();
  await wait(400);
  const dpr = screen.getPrimaryDisplay().scaleFactor;
  const px = Math.round((SIZE + H_PADDING) * dpr);
  const py = Math.round((SIZE + V_PADDING + FEET_MARGIN) * dpr);

  const states = ['cheer', 'cheer2', 'dive', 'dive2'];
  for (const state of states) {
    const info = await askRenderer(
      `window.__pet?.animation.playState('${state}'); 'ok'`);
    for (let k = 0; k < SHOTS.length; k++) {
      await wait(k === 0 ? SHOTS[0] : SHOTS[k] - SHOTS[k - 1]);
      window.moveTop();
      await wait(150);
      grabScreen(Math.round(WIN_X * dpr), Math.round(WIN_Y * dpr), px, py,
        path.join(OUT_DIR, `action-${state}-${k}.png`));
    }
    const layout = await askRenderer(
      `(() => { const el = document.getElementById('pet');
        return JSON.stringify({ nat: [el.naturalWidth, el.naturalHeight],
          css: [el.style.width, el.style.height] }); })()`);
    log(`${state}: play=${info} 截图 x${SHOTS.length}｜素材/显示 = ${layout}`);
    await askRenderer(`window.__pet?.animation.startIdle(); 'ok'`);
    await wait(300);
  }

  window.destroy();
  clearTimeout(watchdog);
  app.exit(0);
}

app.whenReady().then(main);
