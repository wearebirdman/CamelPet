/**
 * 设置窗口。
 * 与桌宠窗口（window.js）刻意分开：两者窗口参数几乎全相反——
 * 桌宠是无边框/透明/不可缩放/跳过任务栏的小窗，设置窗口是带系统标题栏的正常窗口。
 * 把两套参数塞进同一个模块会互相污染，所以这里独立成第二类窗口。
 *
 * 生命周期：单例（重复打开只聚焦已有窗口）；关闭即销毁；关闭时把桌宠恢复成打开前的状态。
 */
import { BrowserWindow } from 'electron';
import { resolveFromRoot, resolveReadable } from './config.js';
import { logError } from './logger.js';

const RENDERER_ENTRY = resolveFromRoot('src', 'renderer', 'settings.html');
const PRELOAD_SCRIPT = resolveFromRoot('src', 'main', 'preload.cjs');
/** 窗口图标用 .ico：Windows 会按 DPI 自动挑选合适尺寸，不会糊 */
const APP_ICON = resolveReadable('assets', 'icons', 'app-icon.ico');

/** @type {import('electron').BrowserWindow|null} */
let settingsWindow = null;
/** 打开设置前桌宠是否可见 —— 关闭时要按原样恢复，不能把用户自己隐藏的桌宠"顺手弹出来" */
let petWasVisible = true;

export function getSettingsWindow() {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
}

/**
 * 打开设置窗口（已存在则聚焦）。
 * @param {object} options
 * @param {() => import('electron').BrowserWindow|null} options.getPetWindow
 * @returns {import('electron').BrowserWindow|null}
 */
export function openSettingsWindow({ getPetWindow } = {}) {
  const existing = getSettingsWindow();
  if (existing) {
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.show();
    existing.focus();
    return existing;
  }

  const petWindow = getPetWindow?.() ?? null;
  // 置顶的桌宠会浮在设置窗口之上遮挡内容，先把它收起来（记住原状态以便还原）
  if (petWindow) {
    petWasVisible = petWindow.isVisible();
    petWindow.hide();
  }

  try {
    settingsWindow = new BrowserWindow({
      width: 760,
      height: 540,
      minWidth: 600,
      minHeight: 420,
      frame: true,
      resizable: true,
      maximizable: false,
      skipTaskbar: false,
      alwaysOnTop: false,
      show: false,
      title: '骆驼桌宠 · 设置',
      icon: APP_ICON,
      backgroundColor: '#f6f7f9',
      webPreferences: {
        preload: PRELOAD_SCRIPT,
        contextIsolation: true,
        nodeIntegration: false,
        // preload 用 require，必须关掉 sandbox（与桌宠窗口一致）
        sandbox: false,
        // 设置页只走 IPC，不像桌宠那样要 fetch 本地素材，因此可以收紧安全策略
        webSecurity: true,
      },
    });

    // 设置窗口不需要应用菜单（File/Edit/View…），直接摘掉，避免 Alt 还能唤出来
    settingsWindow.setMenu(null);
    settingsWindow.once('ready-to-show', () => settingsWindow?.show());
    settingsWindow.on('closed', () => {
      settingsWindow = null;
      if (petWasVisible) {
        getPetWindow?.()?.show();
      }
    });
    settingsWindow.loadFile(RENDERER_ENTRY);

    return settingsWindow;
  } catch (error) {
    logError('open-settings', error);
    // 创建失败时别把桌宠留在隐藏状态
    if (petWindow && petWasVisible) {
      petWindow.show();
    }
    settingsWindow = null;
    return null;
  }
}
