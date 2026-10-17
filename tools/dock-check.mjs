/**
 * 自动停靠验证（跑完即退）。
 *
 * 语义（2026-10-01 按用户反馈定稿）：
 *   桌宠**可以**被拖到屏幕边沿外挂着 —— 只有"露出不足 1/3"（快看不见了）才拉回来。
 *   第一版要求完全落在工作区内，结果用户抱怨"屏幕右边下边都拖不过去"：
 *     右边差窗口自带的 8px 透明留白；下边差任务栏那 ~48px（工作区不含任务栏）。
 *
 * 触发时机：切尺寸 / 拖拽松手 / 启动 / 刚打开开关（拖拽过程中绝不拦截）。
 *
 * 跑真实链路：静态 import 真 index.js（真 IPC、真 applier、真 setSpriteSize），
 * 通过真 petAPI 驱动，不自己复刻逻辑。
 *
 * 两个坑（免得下次又中）：
 *   1. `setSpriteSize` 对"同尺寸"提前返回 → 切档前必须先读当前档位，切到**不同**档位；
 *   2. 无边框窗口的 `getBounds()` 与 `getSize()` 差 2~3px → 判定可见性必须与 dock.js
 *      用同一个来源（getBounds）。
 *
 * 用法：node tools/run-electron.cjs tools/dock-check.mjs
 */
import { app, BrowserWindow, screen } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import '../src/main/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.log('看门狗超时'); app.exit(2); }, 150000);

/** 「还看得见」的判定下限：至少 1/3 在工作区内（与 dock.js 的 MAX_HIDDEN_RATIO 对应） */
const MIN_VISIBLE_RATIO = 1 / 3;
/** 边界回读误差容差 */
const TOL_PX = 4;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ｜ ${detail}` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
}

const petWinOf = () =>
  BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && w.webContents.getURL().includes('renderer/index.html')
  );

function state() {
  const w = petWinOf();
  const b = w.getBounds(); // 与 dock.js 同一来源
  const wa = screen.getDisplayMatching(b).workArea;
  const overlapX = Math.max(0, Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x));
  const overlapY = Math.max(0, Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y));
  return {
    ...b,
    wa,
    ratioX: overlapX / b.width,
    ratioY: overlapY / b.height,
    fullyInside:
      b.x >= wa.x - TOL_PX &&
      b.y >= wa.y - TOL_PX &&
      b.x + b.width <= wa.x + wa.width + TOL_PX &&
      b.y + b.height <= wa.y + wa.height + TOL_PX,
  };
}

async function main() {
  await wait(3200);
  const win = petWinOf();
  if (!win) throw new Error('找不到桌宠窗口');
  const ask = (code) => win.webContents.executeJavaScript(code);

  const configModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'config.js')).href
  );
  const originalSize = Number(configModule.loadConfig('skin.json').spriteSize) || 192;
  const otherSize = originalSize === 256 ? 128 : 256;

  const base = state();
  const { wa, width: W, height: H } = base;
  console.log(`工作区 ${wa.width}×${wa.height}｜窗口 ${W}×${H}｜当前档位 ${originalSize}\n`);

  /** 按"露出比例"把窗口放到右/下边沿外 */
  const parkAtRatio = (ratio, axis) => {
    const x = axis === 'x' ? Math.round(wa.x + wa.width - W * ratio) : wa.x + 120;
    const y = axis === 'y' ? Math.round(wa.y + wa.height - H * ratio) : wa.y + 120;
    win.setPosition(x, y);
  };

  /* ---------- 1. 允许挂在右边沿外（用户的核心诉求） ---------- */
  parkAtRatio(0.45, 'x');
  await wait(250);
  const beforeRight = state();
  await ask(`window.petAPI.notifyWindowMoveEnded()`);
  await wait(450);
  const afterRight = state();
  check(
    '拖到右边沿外挂着（露出 45%）时**不干预**：位置保持不动',
    afterRight.x === beforeRight.x && afterRight.y === beforeRight.y,
    `(${beforeRight.x},${beforeRight.y}) → (${afterRight.x},${afterRight.y}) 露出 ${(afterRight.ratioX * 100).toFixed(0)}%`
  );

  /* ---------- 2. 允许挂在下边沿外 ---------- */
  parkAtRatio(0.45, 'y');
  await wait(250);
  const beforeBottom = state();
  await ask(`window.petAPI.notifyWindowMoveEnded()`);
  await wait(450);
  const afterBottom = state();
  check(
    '拖到下边沿外挂着（露出 45%）时**不干预**：位置保持不动',
    afterBottom.y === beforeBottom.y && afterBottom.x === beforeBottom.x,
    `(${beforeBottom.x},${beforeBottom.y}) → (${afterBottom.x},${afterBottom.y}) 露出 ${(afterBottom.ratioY * 100).toFixed(0)}%`
  );

  /* ---------- 3. 快看不见了才拉回来（露出 10%） ---------- */
  parkAtRatio(0.1, 'x');
  await wait(250);
  const nearlyGone = state();
  await ask(`window.petAPI.notifyWindowMoveEnded()`);
  await wait(450);
  const rescued = state();
  check(
    '露出不足 1/3（这里 10%）时被拉回来，保证还看得见',
    nearlyGone.ratioX < MIN_VISIBLE_RATIO && rescued.ratioX >= MIN_VISIBLE_RATIO - 0.02,
    `${(nearlyGone.ratioX * 100).toFixed(0)}% → ${(rescued.ratioX * 100).toFixed(0)}%`
  );
  check(
    '拉回后**不是**完全塞进屏内（只补到刚好看得见，不破坏"挂边沿"的观感）',
    !rescued.fullyInside,
    `露出 ${(rescued.ratioX * 100).toFixed(0)}%`
  );

  /* ---------- 4. 切尺寸也会校正 ---------- */
  parkAtRatio(0.05, 'y');
  await wait(250);
  await ask(`window.petAPI.setSpriteSize(${otherSize})`);
  await wait(800);
  const afterResize = state();
  check(
    '切尺寸时同样校正：几乎出屏的桌宠被拉回到"看得见"',
    afterResize.ratioY >= MIN_VISIBLE_RATIO - 0.02,
    `露出 ${(afterResize.ratioY * 100).toFixed(0)}%`
  );

  /* ---------- 5. 连续停靠无漂移 ---------- */
  parkAtRatio(0.05, 'x');
  await wait(250);
  await ask(`window.petAPI.notifyWindowMoveEnded()`);
  await wait(400);
  const settled = win.getBounds();
  for (let i = 0; i < 5; i += 1) {
    await ask(`window.petAPI.notifyWindowMoveEnded()`);
    await wait(120);
  }
  const after5 = win.getBounds();
  check(
    '已经"看得见"之后，连续 5 次停靠不产生位移（边界回读误差被容差吃掉）',
    settled.x === after5.x && settled.y === after5.y,
    `(${settled.x},${settled.y}) → (${after5.x},${after5.y})`
  );

  /**
   * 5b. **反复"推到屏外深处 + 停靠"不许漂移**（用户实测报过的 bug）。
   *
   * 根因：无边框窗口移出屏外时，Windows 会给它加隐形边框，`getBounds().width`
   * 逐次虚胖（实测 +1px/次）→ 用"实测宽/3"算边界就会一次比一次往屏幕中心缩。
   * 修法是边界改用**名义尺寸**（由档位推导）+ 虚胖时校正回来。
   * 这条断言直接把"右/下不许内缩"钉死。
   */
  const driftAxis = async (axis) => {
    const out = [];
    for (let i = 0; i < 8; i += 1) {
      // 推到屏外深处
      if (axis === 'x') {
        win.setPosition(wa.x + wa.width + 60, wa.y + 300);
      } else {
        win.setPosition(wa.x + 300, wa.y + wa.height + 40);
      }
      await wait(120);
      await ask(`window.petAPI.notifyWindowMoveEnded()`);
      await wait(160);
      out.push(axis === 'x' ? win.getBounds().x : win.getBounds().y);
    }
    return out;
  };
  const rightSeq = await driftAxis('x');
  check(
    '反复推到右侧屏外再停靠 8 次：落点不漂移（不会越来越往屏幕中心偏）',
    new Set(rightSeq).size === 1 || Math.max(...rightSeq) - Math.min(...rightSeq) <= 2,
    rightSeq.join(' → ')
  );
  const bottomSeq = await driftAxis('y');
  check(
    '反复推到下侧屏外再停靠 8 次：落点不漂移',
    new Set(bottomSeq).size === 1 || Math.max(...bottomSeq) - Math.min(...bottomSeq) <= 2,
    bottomSeq.join(' → ')
  );

  /* ---------- 5c. 左右允许的溢出量应当对称 ---------- */
  const spanOf = async (dir) => {
    if (dir === 'right') {
      win.setPosition(wa.x + wa.width + 60, wa.y + 300);
    } else {
      win.setPosition(wa.x - W - 60, wa.y + 300);
    }
    await wait(120);
    await ask(`window.petAPI.notifyWindowMoveEnded()`);
    await wait(160);
    const b = win.getBounds();
    return dir === 'right' ? b.x + b.width - (wa.x + wa.width) : wa.x - b.x;
  };
  const overflowRight = await spanOf('right');
  const overflowLeft = await spanOf('left');
  check(
    '左右两侧允许的"挂出屏外"幅度基本对称（不再只有左边能溢出）',
    Math.abs(overflowRight - overflowLeft) <= 8,
    `右 ${overflowRight}px vs 左 ${overflowLeft}px`
  );

  /* ---------- 6. 完全在屏内时不动（加固不影响正常路径） ---------- */
  win.setPosition(wa.x + 150, wa.y + 150);
  await wait(300);
  const beforeNormal = win.getPosition();
  await ask(`window.petAPI.notifyWindowMoveEnded()`);
  await wait(400);
  const afterNormal = win.getPosition();
  check(
    '完全在屏内：停靠不产生任何位移',
    beforeNormal[0] === afterNormal[0] && beforeNormal[1] === afterNormal[1],
    `(${beforeNormal}) → (${afterNormal})`
  );

  /* ---------- 7. 开关 OFF：尊重设置，不干预 ---------- */
  const off = await ask(`window.petAPI.setSetting('autoDock', false)`);
  await wait(300);
  parkAtRatio(0.05, 'x');
  await wait(250);
  const offPark = state();
  await ask(`window.petAPI.notifyWindowMoveEnded()`);
  await wait(450);
  const offAfter = state();
  check(
    '开关关闭时露出 5% 也不干预（完全交给用户）',
    off?.ok === true && offAfter.x === offPark.x && offAfter.y === offPark.y,
    `露出 ${(offAfter.ratioX * 100).toFixed(0)}%`
  );

  /* ---------- 8. 重新打开开关：立刻见效 ---------- */
  const onAgain = await ask(`window.petAPI.setSetting('autoDock', true)`);
  await wait(600);
  const afterToggle = state();
  check(
    '重新打开开关：立刻把快看不见的桌宠拉回来',
    onAgain?.ok === true && afterToggle.ratioX >= MIN_VISIBLE_RATIO - 0.02,
    `露出 ${(afterToggle.ratioX * 100).toFixed(0)}%`
  );

  /* ---------- 9. 收尾：配置还原 ---------- */
  await ask(`window.petAPI.setSpriteSize(${originalSize})`);
  await wait(600);
  const cfg = await ask(`window.petAPI.getSettings()`);
  check(
    '收尾：autoDock=true、档位回到进场值',
    cfg?.values?.autoDock === true && Number(cfg?.values?.spriteSize) === originalSize,
    `autoDock=${JSON.stringify(cfg?.values?.autoDock)} spriteSize=${cfg?.values?.spriteSize}`
  );

  console.log(`\n=== 自动停靠验证：${passed} 项通过，${failed} 项失败 ===`);
  clearTimeout(watchdog);
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((e) => {
  console.error(e);
  app.exit(1);
});
