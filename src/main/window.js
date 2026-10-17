/**
 * 桌宠窗口模块。
 * 窗口尺寸由"精灵尺寸 + 留白"推导，因此切大中小档位时窗口自动适配；
 * config/window.json 里的 width/height 作为可选覆盖（不填就用推导值）。
 */
import { BrowserWindow } from 'electron';
import { getDataRoot, resolveFromRoot, resolveReadable } from './config.js';
import { DEFAULT_SPRITE_SIZE, FEET_MARGIN_PX } from '../shared/constants.js';

const RENDERER_ENTRY = resolveFromRoot('src', 'renderer', 'index.html');
const PRELOAD_SCRIPT = resolveFromRoot('src', 'main', 'preload.cjs');
/** 应用图标（与托盘、设置窗口统一） */
const APP_ICON = resolveReadable('assets', 'icons', 'app-icon.ico');

/**
 * 把可写数据根传给渲染层的参数前缀（preload 解析后暴露成 petAPI.dataRootUrl）。
 *
 * 渲染层要读 config/*.json 与皮肤级 dialogue.json 这些"用户可改"的配置，
 * 打包后它们在 userData 下、不在 app.asar 里，所以必须把数据根位置递进渲染进程。
 * 开发态数据根就是包根，渲染层拿到与否行为一致。
 */
const DATA_ROOT_ARG_PREFIX = '--pet-data-root=';

/** 左右各留一点余量，避免角色贴边 */
const H_PADDING_PX = 16;
/** 角色上方的气泡空间（气泡显示在头顶，窗口太矮会被裁） */
const BUBBLE_SPACE_PX = 64;
/** 窗口整体高度比角色多出的部分（底部留白 + 头顶气泡空间） */
const V_PADDING_PX = BUBBLE_SPACE_PX;

/**
 * 由精灵尺寸推导窗口尺寸。
 * @param {number} spriteSize 128/192/256
 * @returns {{width: number, height: number}}
 */
export function computeWindowSize(spriteSize = DEFAULT_SPRITE_SIZE) {
  return {
    width: spriteSize + H_PADDING_PX,
    height: spriteSize + V_PADDING_PX + FEET_MARGIN_PX,
  };
}

/**
 * 每个窗口的**名义尺寸**（不含 Windows 隐形边框撑出来的虚胖）。
 *
 * 为什么单独记一份，而不是让调用方自己去读配置：
 * "窗口该多大"这件事只有本模块知道（它负责创建与改尺寸），别的功能（如自动停靠）
 * 需要这个数时**只依赖本模块**，不该反过来去读 config/skin.json ——
 * 那等于把"停靠"耦合到"皮肤配置"上，皮肤配置一改或不在了，停靠就跟着坏。
 */
const nominalSizes = new WeakMap();

/**
 * 取窗口的名义尺寸（本模块创建/改尺寸时记录）。
 * @param {import('electron').BrowserWindow|null} window
 * @returns {{width: number, height: number}|null}
 */
export function getNominalWindowSize(window) {
  if (!window) {
    return null;
  }
  return nominalSizes.get(window) ?? null;
}

/**
 * 创建桌宠窗口。
 * @param {object} options
 * @param {import('../shared/types.js').WindowState} options.windowState config/window.json
 * @param {number} options.spriteSize 当前精灵尺寸
 * @returns {BrowserWindow}
 */
export function createPetWindow({ windowState, spriteSize }) {
  const derived = computeWindowSize(spriteSize);

  const window = new BrowserWindow({
    width: windowState.width || derived.width,
    height: windowState.height || derived.height,
    x: windowState.x,
    y: windowState.y,
    icon: APP_ICON,
    frame: false,
    transparent: windowState.transparent,
    alwaysOnTop: windowState.alwaysOnTop,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 渲染层需要以 fetch 读取本地素材（file://）后转成 data:/blob: URL
      webSecurity: false,
      // 可写数据根位置（打包态才有意义），渲染层读用户配置时用它做首选。
      // 路径统一成正斜杠：Windows 命令行里反斜杠的转义规则（反斜杠紧跟引号时会被吞）
      // 会把参数搅坏，正斜杠在 Windows 上同样有效且不参与转义。
      additionalArguments: [`${DATA_ROOT_ARG_PREFIX}${getDataRoot().replace(/\\/g, '/')}`],
    },
  });

  // 透明窗口需要持续接收鼠标事件（拖拽、右键菜单）
  window.setIgnoreMouseEvents(false);
  window.loadFile(RENDERER_ENTRY);

  // 不透明度来自 config/window.json（设置界面「不透明度」滑块）。
  // 夹到 [30,100]：低于 30% 基本看不见，用户会以为桌宠丢了。
  const opacity = Number(windowState.opacity);
  if (Number.isFinite(opacity)) {
    window.setOpacity(Math.min(1, Math.max(0.3, opacity / 100)));
  }

  // 记下名义尺寸：config/window.json 允许覆盖 width/height，这里以实际用的为准
  nominalSizes.set(window, {
    width: windowState.width || derived.width,
    height: windowState.height || derived.height,
  });

  if (process.env.NODE_ENV === 'development') {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  return window;
}

/**
 * 把像素坐标归一成 Electron 原生窗口 API 能接受的值。
 *
 * 为什么需要这个函数（2026-10-01 实测踩到）：
 * `Math.round(-0.3)` 得到的是 **`-0`** —— 它 `Number.isFinite` 为真、看起来就是个整数，
 * 所以任何"判有限 + 取整"的检查都会放行；但原生参数转换**拒绝 -0**：
 *
 *   win.setPosition(-0, -0)
 *   → TypeError: Error processing argument at index 1, conversion failure from
 *
 * 这个异常发生在 ipcMain 监听器里 → 变成主进程未捕获异常。
 * 触发条件很隐蔽：150% 这类小数缩放下 screenX 本身带小数，
 * 拖动时窗口坐标一落进 **(-0.5, 0)** 就中招（窗口贴着屏幕左边缘拖动时最容易）。
 * 穷举 19 组坏参数，只有 -0 会抛 —— 所以必须专门归一，不能指望 isFinite。
 *
 * @param {unknown} value
 * @returns {number|null} 安全整数；非法值返回 null（调用方应忽略这次移动）
 */
export function toNativeCoord(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) {
    return null;
  }
  return n === 0 ? 0 : n; // -0 → 0（两者在坐标上等价，但只有 0 能被原生 API 接受）
}

/**
 * 把窗口尺寸校正回名义值（仅在明显虚胖时动手）。
 *
 * 为什么要这个（2026-10-01 实测）：
 * 无边框窗口被移到**屏幕外**时，Windows/Electron 会给它加一条不可见的调整边框，
 * 于是 `getBounds()` / `getSize()` 报告的尺寸比实际大 —— 而且**每次移出屏外都会再累加**
 * （实测 208×260 移出屏外 10 次 → 218×260，+1px/次；只在屏内移动则完全不变；
 *   与 transparent 无关，普通无边框窗口同样如此）。
 *
 * 这个虚胖的尺寸会污染所有"用 getSize() 推算几何"的逻辑：
 *   - 自动停靠的可见比例边界会随之逐次内缩（用户报的"右边下边越来越往屏幕中心偏"）；
 *   - 切尺寸时的锚定补偿也会偏（`resizeForSpriteSize` 用 getSize 算位移）。
 *
 * 名义尺寸由本模块自己记着（创建/改尺寸时写入），调用方不需要知道"现在是什么档位"——
 * 少一个参数就少一处耦合。
 *
 * @param {import('electron').BrowserWindow|null} window
 * @param {number} [tolerancePx] 虚胖多少以内视为正常（避免每次调用都去动窗口）
 * @returns {boolean} 是否做了校正
 */
export function normalizeWindowSize(window, tolerancePx = 4) {
  if (!window || window.isDestroyed()) {
    return false;
  }
  const nominal = getNominalWindowSize(window);
  if (!nominal) {
    return false; // 没记录过名义尺寸（不是本模块创建的窗口）→ 不擅自改
  }
  const bounds = window.getBounds();
  if (
    Math.abs(bounds.width - nominal.width) <= tolerancePx &&
    Math.abs(bounds.height - nominal.height) <= tolerancePx
  ) {
    return false;
  }
  // 位置保持不变，只把被撑大的尺寸改回名义值
  window.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: nominal.width,
    height: nominal.height,
  });
  return true;
}

/**
 * 切换精灵尺寸时调整窗口大小。
 * 角色锚定在窗口"底部居中"，所以窗口变大时要向左上方补偿，
 * 否则桌宠会在屏幕上"跳"一下。
 * @param {BrowserWindow} window
 * @param {number} spriteSize
 */
export function resizeForSpriteSize(window, spriteSize) {
  if (!window || window.isDestroyed()) {
    return;
  }
  const { width, height } = computeWindowSize(spriteSize);
  const [x, y] = window.getPosition();
  const [measuredWidth, measuredHeight] = window.getSize();
  // 用"记下来的名义尺寸"算锚定补偿，而不是实测值：无边框窗口被移到屏外后
  // 实测尺寸会虚胖（见 normalizeWindowSize 的说明），拿它算位移会让桌宠换档时横向偏一点。
  const previous = getNominalWindowSize(window);
  const currentWidth = previous?.width ?? measuredWidth;
  const currentHeight = previous?.height ?? measuredHeight;

  window.setBounds({
    x: x + Math.round((currentWidth - width) / 2),
    y: y + (currentHeight - height),
    width,
    height,
  });
  nominalSizes.set(window, { width, height });
}
