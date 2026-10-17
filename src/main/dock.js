/**
 * 自动停靠：把桌宠挪回"看得见"的范围。
 *
 * 为什么需要这个：拖拽刻意**不做坐标夹取** —— 夹取会跟绝对式拖拽打架
 * （实测：夹到屏幕内会让"拖到一半突然不跟"，因为窗口一旦被夹就与光标永久错位）。
 * 于是用户可以自由把桌宠拖到屏幕边沿、甚至拖出去。拖出去本身是被允许的，
 * 问题是**之后就看不见它了**。
 *
 * 本模块提供的是**事后补救**，不是拖拽中拦截：
 *   切尺寸之后 / 拖动松手之后 / 启动时 / 刚打开开关时 —— 把窗口平移回可见区。
 * 这样既不影响拖拽手感，又能保证"挪出去的东西自己回来"。
 *
 * 目标范围取**工作区**（不含任务栏）：压到任务栏底下同样等于看不见。
 * 只做平移，不缩放不改尺寸；本来就在可见区内的窗口**不产生任何位移**
 * （这一条很重要：加固类改动不能顺手改变正常路径的行为）。
 *
 * 开关状态**现读 config/window.json**，不在内存里另存一份（真相只有一处）。
 * 键缺失时按"开"处理，与 settings.json 里该项 `default: true` 一致。
 */
import { screen } from 'electron';
import { loadConfig } from './config.js';
import { logError } from './logger.js';
import { getNominalWindowSize, normalizeWindowSize, toNativeCoord } from './window.js';

/** 自动停靠是否开启（配置里没写这个键时视为开） */
export function isAutoDockEnabled() {
  return loadConfig('window.json').autoDock !== false;
}

/**
 * 出屏多少像素以内就不管了。
 *
 * 为什么需要容差：无边框窗口上 `getBounds()`/`getSize()` 与实际落点之间有 ±1~2px 的
 * 回读误差（实测 getBounds 报 280 而 getSize 报 278）。没有容差时，一次停靠会让窗口
 * 内移 1~2px，下次再停靠又内移一次 —— 反复拖拽/切档就会看到桌宠缓慢往左上爬。
 */
const DOCK_TOLERANCE_PX = 2;

/**
 * 允许"露在工作区外"的最大比例（每个轴独立判断）。
 *
 * 这条是 2026-10-01 用户实测反馈后定下来的，很关键：
 * 第一版要求窗口**完全**落在工作区内，结果用户抱怨"屏幕右边下边都拖不过去" ——
 *   右边：窗口左右各有 8px 透明留白，贴着工作区右缘时宠物本体看起来还差 8px 才碰到边；
 *   下边：工作区不含任务栏，贴着工作区下缘时离屏幕底还差约 48px。
 * 用户要的是"**能挂在屏幕边沿上，只是别弄丢**"，不是"完全不许出界"。
 * 所以改成：**最多允许 2/3 露在外面**（即至少 1/3 还留在工作区里 —— 看得见、抓得着）。
 * 超过 2/3 才算"快看不见了"，此时才拉回来。
 */
const MAX_HIDDEN_RATIO = 2 / 3;

/**
 * 把窗口挪回"还看得见"的范围。
 *
 * 注意不是"完全挪进工作区"：允许挂在边沿外，只要**每个轴**至少有
 * `1 - MAX_HIDDEN_RATIO` 的比例留在工作区内。窗口比工作区还大时按左上角对齐。
 *
 * @param {import('electron').BrowserWindow|null} window
 * @returns {{docked: boolean, reason?: string, from?: number[], to?: number[]}}
 */
export function dockWindowIntoView(window) {
  if (!window || window.isDestroyed()) {
    return { docked: false, reason: 'no-window' };
  }

  /**
   * 名义尺寸从 **window.js** 取（"窗口该多大"是它的事），这里**不读任何配置** ——
   * 读 config/skin.json 等于把"停靠"耦合到"皮肤配置"上：那边一改一坏，停靠跟着坏。
   *
   * 用名义尺寸而不是实测值也是必须的：窗口移出屏外会让 getBounds() 的宽高虚胖且逐次累加，
   * 拿它算可见比例边界会一次比一次往屏幕中心缩（用户实测反馈过这个漂移）。
   */
  const sizeFixed = normalizeWindowSize(window); // 虚胖就顺手校正回来（位置不动）
  const nominal = getNominalWindowSize(window) ?? {
    width: Math.max(1, window.getBounds().width),
    height: Math.max(1, window.getBounds().height),
  };

  // 位置与尺寸必须来自**同一个来源**（都用 getBounds），否则算出来的目标会自相矛盾
  const bounds = window.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);

  /**
   * 单个轴上的允许区间：窗口至少要留 `1 - MAX_HIDDEN_RATIO` 的比例在工作区内。
   *   lo = 再往左/上挪就把可见部分吃光了；hi = 再往右/下挪同理。
   * 窗口比工作区还大（lo > hi）时退回"贴左上角"，至少保证能看见一角。
   *
   * 注意 `minVisible` 用的是**名义尺寸**（由档位推导），不是实测的 bounds 尺寸 ——
   * 后者会被 Windows 的隐形边框撑大并逐次累加，用它算边界会漂移。
   */
  const clampAxis = (pos, nominalSize, areaPos, areaSize) => {
    const minVisible = Math.max(1, Math.round(nominalSize * (1 - MAX_HIDDEN_RATIO)));
    const lo = areaPos + minVisible - nominalSize;
    const hi = areaPos + areaSize - minVisible;
    if (lo > hi) {
      return areaPos;
    }
    return Math.min(Math.max(pos, lo), hi);
  };

  // 一律过 toNativeCoord：小数缩放算出来的坐标可能带小数，也可能正好是 -0
  // （两者都会被 setPosition 拒收，见 window.js 的说明）
  const x = toNativeCoord(clampAxis(bounds.x, nominal.width, workArea.x, workArea.width));
  const y = toNativeCoord(clampAxis(bounds.y, nominal.height, workArea.y, workArea.height));
  if (x === null || y === null) {
    return { docked: false, reason: 'bad-coords', sizeFixed };
  }
  const dx = x - bounds.x;
  const dy = y - bounds.y;
  if (Math.abs(dx) <= DOCK_TOLERANCE_PX && Math.abs(dy) <= DOCK_TOLERANCE_PX) {
    return { docked: false, reason: 'already-visible', sizeFixed };
  }
  window.setPosition(x, y);
  return { docked: true, from: [bounds.x, bounds.y], to: [x, y], sizeFixed };
}

/**
 * 开关开着才停靠。调用点统一走这个，免得每处都自己判一次配置。
 *
 * **对外承诺：绝不抛异常。**
 * 自动停靠是一个独立功能 —— 它出问题绝不允许连带影响"换尺寸 / 拖拽 / 启动"这些主链路。
 * 把隔离做在这一处（而不是要求每个调用方各包一次 try/catch），
 * 调用方就永远不需要知道停靠内部会不会出错。
 *
 * @param {import('electron').BrowserWindow|null} window
 * @returns {{docked: boolean, reason?: string, from?: number[], to?: number[], message?: string}}
 */
export function dockIfEnabled(window) {
  try {
    if (!isAutoDockEnabled()) {
      return { docked: false, reason: 'disabled' };
    }
    return dockWindowIntoView(window);
  } catch (error) {
    logError('auto-dock', error);
    return { docked: false, reason: 'error', message: String(error?.message ?? error) };
  }
}
