/**
 * 托盘图标与托盘菜单。
 * 托盘菜单是桌宠"找不到窗口"时的兜底入口（显示/隐藏/退出）。
 */
import { app, Menu, Tray, nativeImage } from 'electron';
import { logError } from './logger.js';

/**
 * @param {object} options
 * @param {() => import('electron').BrowserWindow|null} options.getWindow
 * @param {string} options.iconPath 托盘图标绝对路径
 * @param {string} [options.tooltip]
 * @param {() => void} [options.onOpenSettings] 打开设置窗口（与右键菜单同一个入口）
 * @returns {Tray|null} 创建失败返回 null（不影响主流程）
 */
export function createTray({ getWindow, iconPath, tooltip = '骆驼桌宠 CamelPet', onOpenSettings }) {
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      logError('create-tray', `托盘图标为空：${iconPath}`);
    }
    const tray = new Tray(image);

    tray.setToolTip(tooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '设置', click: () => onOpenSettings?.() },
        { type: 'separator' },
        { label: '显示', click: () => getWindow()?.show() },
        { label: '隐藏', click: () => getWindow()?.hide() },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ])
    );
    tray.on('click', () => {
      const window = getWindow();
      if (window) {
        window.isVisible() ? window.hide() : window.show();
      }
    });

    return tray;
  } catch (error) {
    logError('create-tray', error);
    return null;
  }
}
