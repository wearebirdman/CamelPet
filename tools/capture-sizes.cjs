/**
 * 尺寸档位截图验证。
 * 用途：实机渲染 128/192/256 三档待机形象，各抓一张截图，肉眼确认素材真的加载到了、像素没有被非整数缩放撕裂。
 * 用法：npm run capture
 *
 * 实现要点：
 * - 不另写一套界面，直接加载真实的 src/renderer/index.html + preload，
 *   由主进程按真实链路 setBounds + 发 sprite-size-changed，所以抓到的是桌宠的实际渲染结果。
 * - 截屏走系统级 CopyFromScreen，而不是 webContents.capturePage()：
 *   本机 GPU 环境下隐藏/可见窗口的 capturePage 都会永远挂起（合成器不出帧），
 *   系统截屏拿到的正是"用户眼睛里看到的物理像素"，对判断撕裂问题反而更准确。
 * - 窗口以 show:true 出现，务必保证它在最前且没被遮挡。
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'temp', 'capture');
const SIZES = [128, 192, 256];
const H_PADDING = 16;
const V_PADDING = 64;
const FEET_MARGIN = 4;
const WIN_X = 60;
const WIN_Y = 60;

app.disableHardwareAcceleration();

// 渲染层的 diagnostics 会调用这两个通道，截图环境里给个空实现避免刷报错
ipcMain.handle('get-app-path', () => app.getPath('userData'));
ipcMain.handle('write-diagnostics', () => true);
// 渲染层启动时会拉一次语音包清单（audio player refresh），不挂 handler 会刷
// "No handler registered for 'get-voice-packs'"（与 scheduler-check.cjs 同款挂具）
ipcMain.handle('get-voice-packs', () => []);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`[capture ${new Date().toISOString().slice(11, 23)}] ${msg}`);

/** 用系统截屏抓取屏幕上的一块矩形（物理像素坐标） */
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

// 看门狗：任何一步卡死也能拿到诊断信息并退出
const watchdog = setTimeout(() => {
  log('看门狗超时：截图流程 60s 未完成，强制退出');
  app.exit(2);
}, 60000);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const window = new BrowserWindow({
    width: SIZES[1] + H_PADDING,
    height: SIZES[1] + V_PADDING + FEET_MARGIN,
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

  log('加载渲染层页面…');
  // 把渲染层的 console 和崩溃事件转发出来，否则渲染层内部问题在主进程侧完全不可见
  window.webContents.on('console-message', (_e, _level, message) => log(`[renderer] ${message}`));
  window.webContents.on('render-process-gone', (_e, details) => log(`[renderer-gone] ${JSON.stringify(details)}`));
  window.webContents.on('did-fail-load', (_e, code, desc) => log(`[did-fail-load] ${code} ${desc}`));
  // executeJavaScript 兜底超时：渲染进程无响应时不能把整个流程挂死
  const askRenderer = (code, timeoutMs = 5000) =>
    Promise.race([
      window.webContents.executeJavaScript(code),
      wait(timeoutMs).then(() => '<<renderer-timeout>>'),
    ]);

  await window.loadFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'index.html'));
  await wait(1500);
  window.moveTop();
  log('等待 bootstrap 完成…');
  await wait(1200);

  const dpr = screen.getPrimaryDisplay().scaleFactor;
  log(`屏幕缩放 scaleFactor = ${dpr}`);
  log('渲染层自检：' + (await askRenderer(
    `(() => { const el = document.getElementById('pet');
       return JSON.stringify({ dpr: window.devicePixelRatio, hooked: !!window.__pet,
         nat: [el.naturalWidth, el.naturalHeight], css: [el.style.width, el.style.height],
         state: window.__pet?.animation?.currentState }); })()`
  )));

  /**
   * 抓屏期间把窗口**临时置顶**（抓完不用还原，本脚本的窗口一次性）。
   *
   * 为什么必须这么做（实测踩过两次，与 settings-shot 同一坑）：
   * 用户正在看抖音之类的全屏窗口时，moveTop() 顶不过它 —— 截出来的"证据"
   * 其实是抖音画面（2026-10-01 复现：size-256.png 里是抖音推荐页）。
   * 置顶后截图是否干净就不再取决于用户此刻在干什么。
   */
  window.setAlwaysOnTop(true);
  window.moveTop();
  window.focus();
  await wait(400);

  for (const size of SIZES) {
    window.setBounds({ x: WIN_X, y: WIN_Y, width: size + H_PADDING, height: size + V_PADDING + FEET_MARGIN });
    window.webContents.send('sprite-size-changed', size);
    await wait(900); // 等换素材 + 布局 + 首帧落位
    window.moveTop();
    await wait(200);

    const px = Math.round((size + H_PADDING) * dpr);
    const py = Math.round((size + V_PADDING + FEET_MARGIN) * dpr);
    grabScreen(Math.round(WIN_X * dpr), Math.round(WIN_Y * dpr), px, py, path.join(OUT_DIR, `size-${size}.png`));

    const info = await askRenderer(
      `(() => { const el = document.getElementById('pet');
         return JSON.stringify({ nat: [el.naturalWidth, el.naturalHeight], css: [el.style.width, el.style.height] }); })()`
    );
    log(`size=${size} 已截屏（物理 ${px}×${py}）｜素材/显示 = ${info}`);

    // 顺手验证插播动作链路：触发眨眼并在"全闭"帧截屏
    await askRenderer(`window.__pet?.animation.playState('blink')`);
    await wait(120);
    grabScreen(Math.round(WIN_X * dpr), Math.round(WIN_Y * dpr), px, py, path.join(OUT_DIR, `size-${size}-blink.png`));
  }

  window.destroy();
  clearTimeout(watchdog);
  log('全部完成');
  app.quit();
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error('截图验证失败：', error);
    app.exit(1);
  })
);
