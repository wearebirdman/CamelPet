/**
 * IPC 通道注册。
 * 通道名统一来自 shared/ipc-channels.cjs，与 preload 暴露的 API 一一对应。
 *
 * 设置相关通道由 settingsService（src/main/settings.js）承接：
 * 读走 schema，写按白名单路由到 applier，未登记 applier 的项一律拒绝，
 * 保证不会出现「界面改了但没人处理」的静默失效。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import channels from '../shared/ipc-channels.cjs';
import { logError } from './logger.js';
import { dockIfEnabled } from './dock.js';
import { toNativeCoord } from './window.js';
import { ROOT_DIR, getDataRoot } from './config.js';
import { ALLOWED_EXTENSIONS } from './voicepacks.js';

/** 交给渲染层处理前的体积上限，与 voicepacks.js 的单包上限保持一致 */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/**
 * 窗口坐标的宽松上限（DIP）。只为挡住异常值（渲染层 bug 传来的 1e9），
 * 远超任何真实桌面范围，正常拖动（鼠标出不了屏幕）永远不会碰到它。
 */
const SAFE_COORD = 32768;

/**
 * 把事件广播给所有窗口（设置变更后桌宠与设置窗口都要知道）。
 * @param {string} channel
 * @param {*} payload
 */
export function broadcastToAll(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

/**
 * @param {object} options
 * @param {() => import('electron').BrowserWindow|null} options.getWindow
 * @param {(size: number) => boolean} options.setSpriteSize 切换精灵尺寸（大中小）
 * @param {{readAll: Function, write: Function}} options.settingsService 设置读写服务
 * @param {{list: Function, add: Function, remove: Function, setEnabled: Function}} options.voicePackService
 *        语音包服务（清单读写 + 音频复制入库）
 * @param {(id: string) => {ok: boolean, message?: string}} options.playVoicePack
 *        让桌宠窗口播放指定语音包（与右键菜单里点包名共用同一实现）
 */
export function registerIpc({
  getWindow,
  setSpriteSize,
  settingsService,
  voicePackService,
  playVoicePack,
  listSkins,
  setSkin,
}) {
  ipcMain.handle(channels.GET_APP_PATH, () => app.getPath('userData'));

  /**
   * 皮肤列表与切换。
   * 设置窗口的 webSecurity 是开着的（只有桌宠窗口为读素材关了），
   * 所以目录列表不能靠页面 fetch，必须走 IPC —— 与 GET_ACTION_CATALOG 同理。
   * 切换走主进程的 setSkin：它负责落盘 + 广播，界面不碰文件。
   */
  ipcMain.handle(channels.GET_SKINS, () => listSkins?.() ?? []);
  ipcMain.handle(channels.SET_SKIN, (_event, skinId) => setSkin?.(skinId) ?? { ok: false });

  ipcMain.handle(channels.WRITE_DIAGNOSTICS, async (_event, filePath, bytes) => {
    try {
      await fs.promises.writeFile(filePath, Buffer.from(bytes), { flag: 'a' });
    } catch (error) {
      logError('write-diagnostics', error);
    }
  });

  /**
   * 拖拽：把窗口移动到鼠标位移后的屏幕坐标。
   *
   * 关于坐标校验的历史（别再把这里改回"夹到屏幕内"）：
   *   - 2026-09-30 审查 L4 曾把坐标夹到 `getDisplayMatching().bounds`（单屏内、窗口完整可见）。
   *     实测被否 —— 用户明确要"能把桌宠拖到屏幕边沿（甚至部分移出屏外）"，
   *     夹取制造了肉眼可见的硬边界，且撞界后"鼠标在动窗口不动"（拖拽是绝对式：
   *     按下时窗口原点 + 鼠标总位移，一旦被夹就与光标错位，松手重按还会跳）。
   *   - 现在只保留 `Number.isFinite` + 一个**宽松到鼠标不可能拖到**的范围夹取：
   *     正常拖动（鼠标出不了屏幕）永不触发，只挡渲染层 bug 传来的 1e9 这类异常值，
   *     避免窗口被送到用户找不回来的地方。
   */
  ipcMain.on(channels.MOVE_WINDOW, (_event, x, y) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    /**
     * 参数必须归一成整数再交给 setPosition —— Electron 的原生绑定对参数极挑剔：
     * **小数、NaN、undefined、null、非数字字符串、超 int32、以及 `-0`**都会抛
     * `TypeError: Error processing argument at index N, conversion failure from X`。
     * 而这个异常发生在 ipcMain 监听器里 → 变成主进程未捕获异常 → 弹系统错误框。
     *
     * 实测踩过两次：① 150% 缩放下 bounds/getSize 带小数，算出来的坐标是小数；
     * ② `Math.round(-0.3)` 得到 `-0`（isFinite 为真、看着像整数，但原生转换拒收）。
     * 归一逻辑统一在 window.js 的 toNativeCoord，这里只再夹一次范围。
     */
    const safeInt = (value) => {
      const n = toNativeCoord(value);
      if (n === null) {
        return null;
      }
      return Math.min(Math.max(n, -SAFE_COORD), SAFE_COORD);
    };
    const nx = safeInt(x);
    const ny = safeInt(y);
    if (nx === null || ny === null) {
      // 留下证据（非法坐标本身就是异常情况，正常拖动不会走到这里）
      logError('move-window', `忽略非法坐标：x=${String(x)} y=${String(y)}`);
      return;
    }
    window.setPosition(nx, ny);
  });

  /**
   * 一次拖拽结束（松手/取消）→ 让主进程决定要不要自动停靠。
   *
   * 只有"拖完"这一个时机可以动窗口：拖拽过程中改坐标会与绝对式拖拽打架
   * （实测"拖到一半突然不跟"），所以停靠只能事后做。
   *
   * 与拖拽功能解耦：`dockIfEnabled` 自身承诺不抛异常，所以这个监听器里
   * 不存在"停靠出问题 → 拖拽链路受影响"的路径。
   */
  ipcMain.on(channels.MOVE_WINDOW_END, () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      dockIfEnabled(window);
    }
  });

  // 切换精灵尺寸（设置界面「精灵尺寸」用；该通道是唯一已打通的"改配置并即时生效"链路）
  ipcMain.handle(channels.SET_SPRITE_SIZE, (_event, size) => setSpriteSize(size));

  // —— 设置界面 ——
  ipcMain.handle(channels.GET_SETTINGS, () => settingsService.readAll());
  ipcMain.handle(channels.SET_SETTING, (_event, key, value) => settingsService.write(key, value));

  /**
   * 拖动滑块期间的临时预览：只广播，不落盘。
   *
   * 没有它的话，滑块要等松手（change）才提交，用户拖动过程中看到的只是数字在变、
   * 声音纹丝不动 —— 很容易被当成"这个设置没作用"。松手后仍走 SET_SETTING 正式落盘，
   * 所以这里不需要（也不应该）写配置。
   */
  ipcMain.handle(channels.PREVIEW_SETTING, (_event, key, value) => {
    const allowed = settingsService.preview(key, value);
    if (!allowed.ok) {
      return allowed;
    }
    broadcastToAll(channels.SETTINGS_CHANGED, { key, value, transient: true });
    return allowed;
  });
  ipcMain.handle(channels.GET_APP_INFO, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    userDataPath: app.getPath('userData'),
    appPath: app.getAppPath(),
    rootPath: ROOT_DIR,
    /** 可写数据根：打包态在 userData 下，开发态与 rootPath 相同（排查"设置改不进去"看这里） */
    dataRoot: getDataRoot(),
  }));

  /**
   * 可管理的动作目录已移除：设置界面的「动作管理」是未接入的占位功能，
   * 现在动作只由皮肤 manifest 决定（右键菜单「动作」段实时跟随 manifest）。
   */

  // —— 语音包 ——

  /** 清单变更后广播：设置界面刷新列表、桌宠刷新可播池 */
  const broadcastPacks = () => {
    const packs = voicePackService.list();
    broadcastToAll(channels.VOICE_PACKS_CHANGED, { packs });
    return packs;
  };

  ipcMain.handle(channels.GET_VOICE_PACKS, () => voicePackService.list());

  /**
   * 系统文件选择框。
   * 挂到发起请求的那个窗口上（sender），这样对话框是模态的、不会跑到别的窗口后面去。
   */
  ipcMain.handle(channels.PICK_AUDIO_FILE, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: '选择语音文件',
      properties: ['openFile'],
      filters: [
        { name: '音频文件', extensions: ALLOWED_EXTENSIONS.map((ext) => ext.replace('.', '')) },
        { name: '全部文件', extensions: ['*'] },
      ],
    };
    try {
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const filePath = result.filePaths[0];
      return { path: filePath, name: path.basename(filePath, path.extname(filePath)) };
    } catch (error) {
      logError('pick-audio', error);
      return null;
    }
  });

  /**
   * 读取音频文件的原始字节。
   *
   * 为什么要多这一趟：响度归一化要解码音频，而解码只能用渲染层的 Web Audio，
   * 主进程没有这个能力。所以主进程负责"读文件"（它有 fs 权限），
   * 渲染层负责"解码 + 处理"，处理完把成品字节交回来写盘。
   */
  ipcMain.handle(channels.READ_AUDIO_FILE, async (_event, filePath) => {
    try {
      const resolved = path.resolve(String(filePath ?? ''));
      if (!fs.existsSync(resolved)) {
        return { ok: false, message: '找不到该文件' };
      }
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        return { ok: false, message: '不是文件' };
      }
      if (stat.size > MAX_AUDIO_BYTES) {
        return {
          ok: false,
          message: `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 过大，无法处理`,
        };
      }
      // 返回 ArrayBuffer 本体（Buffer 是它的视图，slice 出来保证不被后续改动影响）
      const buffer = await fs.promises.readFile(resolved);
      const copied = new ArrayBuffer(buffer.byteLength);
      Buffer.from(copied).set(buffer);
      return { ok: true, bytes: copied, size: buffer.byteLength };
    } catch (error) {
      logError('read-audio-file', error);
      return { ok: false, message: '读取音频文件失败' };
    }
  });

  /**
   * 添加语音包。
   * 第三个参数是渲染层处理后回传的成品；没有它就走原样复制（降级路径）。
   */
  ipcMain.handle(channels.ADD_VOICE_PACK, (_event, name, srcPath, optimized) => {
    const result = voicePackService.add({
      name,
      src: srcPath,
      bytes: optimized?.bytes ?? null,
      ext: optimized?.ext ?? null,
      // 解码测得的时长一并带上：主进程据它做时长守门（成品 WAV 头是另一道）
      duration: Number.isFinite(Number(optimized?.duration)) ? Number(optimized.duration) : null,
    });
    if (result.ok) {
      broadcastPacks();
    }
    return result;
  });

  ipcMain.handle(channels.REMOVE_VOICE_PACK, (_event, id) => {
    const result = voicePackService.remove(id);
    if (result.ok) {
      broadcastPacks();
    }
    return result;
  });

  ipcMain.handle(channels.SET_VOICE_PACK_ENABLED, (_event, id, enabled) => {
    const result = voicePackService.setEnabled(id, enabled);
    if (result.ok) {
      broadcastPacks();
    }
    return result;
  });

  /**
   * 试听：不在设置窗口里放播放器，而是让**桌宠窗口**播 ——
   * 走的是和随机触发完全相同的播放链路，听到的就是真实效果。
   */
  ipcMain.handle(channels.PREVIEW_VOICE_PACK, (_event, id) => playVoicePack(id));
}
