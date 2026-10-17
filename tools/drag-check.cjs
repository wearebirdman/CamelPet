/**
 * 拖拽跟随回归测试（跑完即退，不留进程）。
 *
 * 为什么要专门一个脚本：2026-09-30 审查给 MOVE_WINDOW 加"坐标夹到屏幕内"后，
 * 用户实测报"拖到一半不跟 / 有硬边界 / 拖不到屏幕边沿"——核心交互被加固改动破坏。
 * 这条交互靠肉眼点几下很难保证不回归，用脚本把"跟手 / 能贴边 / 中途不掉链"钉死。
 *
 * 跑的是真实链路：合成 PointerEvent（screenX/screenY 精确可控，绕开真实鼠标硬件）
 *   → 真实 renderer/interaction.js → 真实 preload → 真实 src/main/ipc.js 的 MOVE_WINDOW
 *   → 真实 BrowserWindow.setPosition，逐步比对「期望位置 vs 实际位置」。
 *
 * 判据分层：150% 这类小数缩放下 DIP↔物理像素舍入会带来 ±1px 恒定偏差
 * （不累积、肉眼不可见），只有 |误差| > 容差才算真的没跟上。
 *
 * 用法：node tools/run-electron.cjs tools/drag-check.cjs
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WIN_W = 208; // computeWindowSize(192) 的真实值
const WIN_H = 260;
/** 允许的跟随误差（px）：小数缩放的像素舍入，不累积 */
const FOLLOW_TOLERANCE = 2;
/** 每步等待：够 IPC + setPosition 落地 */
const STEP_WAIT_MS = 60;
const STEP_PX = 40;

/**
 * 主进程未捕获异常必须算失败。
 *
 * 为什么专门抓它：`window.setPosition` 对参数极挑剔（小数 / NaN / undefined / null 都抛
 * "Error processing argument at index N, conversion failure from X"）。这种异常发生在
 * ipcMain 监听器里 → 只是**那一帧窗口不动**，脚本若不显式监听，看起来"只是没跟上"，
 * 很容易被漏判成通过（实测踩过：夹取算式在 150% 缩放下产出小数 → 撞界即抛 + 窗口不动）。
 */
const uncaught = [];
process.on('uncaughtException', (error) => uncaught.push(String(error?.message ?? error)));

app.disableHardwareAcceleration();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.log('看门狗超时：90s 未完成');
  app.exit(2);
}, 90000);

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` ｜ ${detail}` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
}

async function main() {
  const ipcModule = await import(pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'ipc.js')).href);
  const { bounds } = screen.getPrimaryDisplay();

  const startX = bounds.x + Math.round(bounds.width * 0.2);
  const startY = bounds.y + Math.round(bounds.height * 0.35);

  const window = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: startX,
    y: startY,
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

  /**
   * 让测试窗口**忽略真实鼠标事件**。
   *
   * 为什么必须（2026-10-01 实测踩到）：本脚本用 JS 合成 PointerEvent 驱动拖拽，
   * 而窗口是**可见**的 —— 用户此刻在用电脑（比如看抖音），真实鼠标点到/划过这个窗口，
   * 就会用真实的 pointer 事件打断合成拖拽：表现是"拖到第 14 步（约 560px）突然失效"，
   * 看起来像拖拽功能坏了，其实是环境干扰。
   *
   * 合成事件走 JS 派发，不经过系统鼠标路由，因此忽略真实鼠标不影响本测试。
   * 这与项目既有教训同源："验证不要依赖机器空闲"。
   */
  window.setIgnoreMouseEvents(true);

  // 真实 registerIpc —— MOVE_WINDOW 是生产代码本尊，其余依赖注入假实现
  ipcModule.registerIpc({
    getWindow: () => window,
    setSpriteSize: () => true,
    settingsService: {
      readAll: () => ({ schema: { categories: [] }, values: {} }),
      write: () => ({ ok: false, reason: 'rejected' }),
      preview: () => ({ ok: false, reason: 'no-preview' }),
    },
    voicePackService: {
      list: () => [],
      add: () => ({ ok: false }),
      remove: () => ({ ok: false }),
      setEnabled: () => ({ ok: false }),
    },
    playVoicePack: () => ({ ok: false }),
  });

  await window.loadFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'index.html'));
  await wait(3000);

  await window.webContents.executeJavaScript(`
    window.__blurCount = 0;
    window.addEventListener('blur', () => { window.__blurCount += 1; });
    window.__fire = (type, sx, sy, buttons = 1) => window.dispatchEvent(new PointerEvent(type, {
      screenX: sx, screenY: sy, clientX: 10, clientY: 10,
      button: 0, buttons, pointerId: 1, pointerType: 'mouse',
      isPrimary: true, bubbles: true, cancelable: true,
    }));
    'ok'
  `);

  const [wx0, wy0] = window.getPosition();
  const [gw, gh] = window.getSize();
  const anchorScreenX = wx0 + Math.round(gw / 2);
  const anchorScreenY = wy0 + Math.round(gh / 2);
  /** 期望窗口左缘 = 起点 + 鼠标总位移（与 interaction.js 的绝对式算法一致） */
  const expectX = (mouseX) => wx0 + (mouseX - anchorScreenX);

  const fire = (type, sx, sy, buttons = 1) =>
    window.webContents.executeJavaScript(`window.__fire('${type}', ${sx}, ${sy}, ${buttons}); 'ok'`);

  const sample = async () => {
    const [x, y] = window.getPosition();
    const dragging = await window.webContents.executeJavaScript(
      `String(window.__pet?.interaction?.isDragging)`
    );
    return { x, y, dragging: dragging === 'true' };
  };

  await fire('pointerdown', anchorScreenX, anchorScreenY);
  await wait(80);

  // ---- 阶段 1：向右拖到「窗口右缘正好贴屏幕右缘」----
  const targetMouseX = bounds.x + bounds.width - Math.round(gw / 2);
  let maxFollowError = 0;
  let stateLostAt = null;
  let stepIndex = 0;
  let mouseX = anchorScreenX;
  while (mouseX < targetMouseX) {
    mouseX = Math.min(targetMouseX, mouseX + STEP_PX);
    await fire('pointermove', mouseX, anchorScreenY);
    await wait(STEP_WAIT_MS);
    const s = await sample();
    maxFollowError = Math.max(maxFollowError, Math.abs(s.x - expectX(mouseX)));
    if (!s.dragging && stateLostAt === null) stateLostAt = stepIndex;
    stepIndex += 1;
  }
  const atRight = await sample();
  const rightEdgeGap = bounds.x + bounds.width - (atRight.x + gw);

  check(
    `向右拖 ${Math.round(targetMouseX - anchorScreenX)}px 全程跟手（最大误差 ${maxFollowError}px ≤ ${FOLLOW_TOLERANCE}）`,
    maxFollowError <= FOLLOW_TOLERANCE,
    `最大误差 ${maxFollowError}px`
  );
  check(
    '能把窗口拖到屏幕右边缘（右缘与屏幕右缘相差 ≤ 4px，不被夹在屏内）',
    Math.abs(rightEdgeGap) <= 4,
    `右缘还差 ${rightEdgeGap}px`
  );
  check('长距离拖动中拖拽状态未中途失效', stateLostAt === null, stateLostAt === null ? '' : `第 ${stateLostAt} 步失效`);

  // ---- 阶段 2：原路回拖到屏幕左缘，检查死区与反向 ----
  const leftTargetMouseX = bounds.x + Math.round(gw / 2);
  let deadZoneSteps = 0;
  let reverseSteps = 0;
  let prev = await sample();
  let prevMouseX = targetMouseX;
  mouseX = targetMouseX;
  while (mouseX > leftTargetMouseX) {
    mouseX = Math.max(leftTargetMouseX, mouseX - STEP_PX);
    await fire('pointermove', mouseX, anchorScreenY);
    await wait(STEP_WAIT_MS);
    const s = await sample();
    const dMouse = mouseX - prevMouseX;
    const dWin = s.x - prev.x;
    if (dMouse !== 0 && dWin === 0) deadZoneSteps += 1;
    if (dMouse !== 0 && dWin !== 0 && Math.sign(dMouse) !== Math.sign(dWin)) reverseSteps += 1;
    prev = s;
    prevMouseX = mouseX;
  }
  const atLeft = await sample();
  const leftEdgeGap = atLeft.x - bounds.x;

  check('回拖过程没有"鼠标在动而窗口不动"的死区', deadZoneSteps === 0, `死区步数 ${deadZoneSteps}`);
  check('回拖过程没有与鼠标方向相反的移动', reverseSteps === 0, `反向步数 ${reverseSteps}`);
  check(
    '能把窗口拖到屏幕左边缘（左缘与屏幕左缘相差 ≤ 4px）',
    Math.abs(leftEdgeGap) <= 4,
    `左缘差 ${leftEdgeGap}px`
  );

  // ---- 阶段 3：异常值防呆（渲染层 bug / 小数缩放都不该把窗口搞崩）----
  await fire('pointerup', mouseX, anchorScreenY, 0);
  await wait(80);
  const beforeEvil = await sample();

  // 3a. 离谱坐标：不该飞到找不回来的地方
  await window.webContents.executeJavaScript(`window.petAPI.moveWindow(1e9, 1e9); 'ok'`);
  await wait(150);
  const afterEvil = await sample();
  check(
    '异常坐标（1e9）被夹在安全范围内，窗口不会飞到找不回来的地方',
    Math.abs(afterEvil.x) <= 32768 && Math.abs(afterEvil.y) <= 32768,
    `窗口落点 [${afterEvil.x}, ${afterEvil.y}]`
  );

  // 3b. 小数坐标：必须被取整后正常应用（setPosition 收到小数会抛转换错误）
  const fractionalTarget = bounds.x + 200;
  await window.webContents.executeJavaScript(
    `window.petAPI.moveWindow(${fractionalTarget}.7, ${bounds.y + 150}.3); 'ok'`
  );
  await wait(150);
  const afterFractional = await sample();
  check(
    '小数坐标被取整后正常应用（setPosition 拒收小数，直接传会抛转换错误）',
    Math.abs(afterFractional.x - fractionalTarget) <= 1,
    `请求 ${fractionalTarget}.7 → 实到 ${afterFractional.x}`
  );

  // 3c. NaN / undefined：必须被忽略，窗口保持原位
  await window.webContents.executeJavaScript(
    `window.petAPI.moveWindow(NaN, NaN); window.petAPI.moveWindow(undefined, undefined); 'ok'`
  );
  await wait(150);
  const afterNaN = await sample();
  check(
    'NaN / undefined 坐标被忽略，窗口保持原位（不得抛异常）',
    afterNaN.x === afterFractional.x && afterNaN.y === afterFractional.y,
    `[${afterNaN.x}, ${afterNaN.y}]`
  );

  /**
   * 3d. **-0 坐标**：最阴的一种坏值（2026-10-01 实机踩到）。
   * `Math.round(-0.3)` 就是 `-0`：`Number.isFinite(-0)` 为真、看着像整数，
   * 但 Electron 原生参数转换**拒收 -0**，会抛
   * "Error processing argument at index 1, conversion failure from"。
   * 触发场景很常见：150% 缩放 + 把桌宠拖到屏幕左边缘附近（坐标落进 (-0.5, 0)）。
   */
  await window.webContents.executeJavaScript(`window.petAPI.moveWindow(-0.3, -0.4); 'ok'`);
  await wait(150);
  const afterNegZero = await sample();
  check(
    '-0 坐标被归一成 0 并正常应用（原生 API 拒收 -0）',
    afterNegZero.x === 0 && afterNegZero.y === 0,
    `请求 (-0.3,-0.4) → 实到 [${afterNegZero.x}, ${afterNegZero.y}]`
  );

  check(
    '全程没有主进程未捕获异常（setPosition 参数转换错误会在这里现形）',
    uncaught.length === 0,
    uncaught.join(' | ')
  );

  console.log(`\n=== 拖拽跟随回归：${passed} 项通过，${failed} 项失败 ===`);
  window.destroy();
  clearTimeout(watchdog);
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
