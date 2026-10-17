/**
 * 预加载脚本（CJS）。
 * 渲染层不直接接触 Electron API，只通过 window.petAPI 这一层薄桥接访问主进程能力。
 * 新增能力时：在 ipc-channels.cjs 登记通道 → 主进程注册 handler → 这里暴露一个方法。
 */
const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');
const channels = require('../shared/ipc-channels.cjs');

/**
 * 可写数据根的 file:// URL（带结尾斜杠），取自主进程通过 webPreferences.additionalArguments
 * 传进来的 `--pet-data-root=<绝对路径>`。
 *
 * 为什么走进程参数而不是 IPC：渲染层在 bootstrap 一开始就要 fetch 配置，异步 IPC 会让
 * "先读配置再装配"多出一层等待，而且挂具脚本（capture 系列 / settings-shot）不需要跟着改。
 * 没有这个参数时返回空串 —— 开发态与挂具下渲染层一切走应用包根，与改造前完全一致。
 * @returns {string}
 */
function resolveDataRootUrl() {
  const prefix = '--pet-data-root=';
  const arg = (process.argv || []).find(
    (item) => typeof item === 'string' && item.startsWith(prefix)
  );
  const dir = arg ? arg.slice(prefix.length) : '';
  if (!dir) {
    return '';
  }
  try {
    const url = pathToFileURL(dir).href;
    return url.endsWith('/') ? url : `${url}/`;
  } catch (_) {
    return '';
  }
}

contextBridge.exposeInMainWorld('petAPI', {
  /**
   * 可写数据根 URL（打包态才有值；开发态为空串 → 渲染层回落应用包根）。
   * 渲染层读"用户可改的配置"时用它做首选，读不到再回落包内。
   */
  dataRootUrl: resolveDataRootUrl(),

  /** 应用数据目录（诊断日志落盘位置） */
  getAppPath: () => ipcRenderer.invoke(channels.GET_APP_PATH),
  /** 追加写诊断日志 */
  writeDiagnostics: (filePath, bytes) =>
    ipcRenderer.invoke(channels.WRITE_DIAGNOSTICS, filePath, bytes),
  /** 把桌宠窗口移动到指定屏幕坐标（拖拽专用） */
  moveWindow: (x, y) => ipcRenderer.send(channels.MOVE_WINDOW, Math.round(x), Math.round(y)),
  /**
   * 通知主进程"这次拖拽结束了"。
   * 主进程据此决定要不要自动停靠（把拖到屏幕边沿/外面的桌宠挪回可见区）——
   * 判断依据（开关状态）在主进程侧，渲染层不需要知道。
   */
  notifyWindowMoveEnded: () => ipcRenderer.send(channels.MOVE_WINDOW_END),
  /** 订阅右键菜单项点击事件 */
  onMenuAction: (callback) =>
    ipcRenderer.on(channels.MENU_ITEM_CLICKED, (_event, item) => callback(item)),
  /** 请求切换精灵尺寸档位（128/192/256），返回是否成功 */
  setSpriteSize: (size) => ipcRenderer.invoke(channels.SET_SPRITE_SIZE, size),
  /** 订阅精灵尺寸变更事件（主进程切换后通知渲染层换素材） */
  onSpriteSizeChanged: (callback) =>
    ipcRenderer.on(channels.SPRITE_SIZE_CHANGED, (_event, size) => callback(size)),
  /** 读取设置 schema 与各项当前值（设置界面用） */
  getSettings: () => ipcRenderer.invoke(channels.GET_SETTINGS),
  /** 写入某项设置，返回 { ok, value?, reason? }（设置界面用） */
  setSetting: (key, value) => ipcRenderer.invoke(channels.SET_SETTING, key, value),
  /**
   * 拖动滑块期间临时应用某项设置（不落盘，只广播）。
   * 松手仍要调 setSetting 正式提交，否则改动不会保存。
   */
  previewSetting: (key, value) => ipcRenderer.invoke(channels.PREVIEW_SETTING, key, value),
  /** 读取版本号/路径等关于信息（设置界面用） */
  getAppInfo: () => ipcRenderer.invoke(channels.GET_APP_INFO),
  /** 订阅"某项设置已变更"广播（设置界面与桌宠都可用来同步 UI） */
  onSettingsChanged: (callback) =>
    ipcRenderer.on(channels.SETTINGS_CHANGED, (_event, payload) => callback(payload)),

  // —— 皮肤 ——
  /**
   * 读取可用皮肤列表（设置界面「皮肤」下拉的选项来源）。
   * @returns {Promise<Array<{id: string, label: string}>>}
   */
  getSkins: () => ipcRenderer.invoke(channels.GET_SKINS),
  /**
   * 切换皮肤：形象素材 + 台词 + 语音包整套换。
   * @returns {Promise<{ok: boolean, skinId: string, reason?: string}>}
   */
  setSkin: (skinId) => ipcRenderer.invoke(channels.SET_SKIN, skinId),
  /**
   * 订阅"皮肤已切换"广播。桌宠窗口收到后整体重载渲染层 ——
   * 动画/菜单/台词池/调度器都是启动时按 manifest 装配的，整体重建比逐个更新可靠。
   */
  onSkinChanged: (callback) =>
    ipcRenderer.on(channels.SKIN_CHANGED, (_event, payload) => callback(payload)),

  // —— 语音包 ——
  /** 读取语音包清单 */
  getVoicePacks: () => ipcRenderer.invoke(channels.GET_VOICE_PACKS),
  /** 弹出系统文件选择框挑音频，返回 { path, name } 或 null */
  pickAudioFile: () => ipcRenderer.invoke(channels.PICK_AUDIO_FILE),
  /**
   * 读取音频文件的原始字节（返回 { ok, bytes: ArrayBuffer, size }）。
   * 解码与响度处理只能在渲染层做，所以由这里把字节取过来。
   */
  readAudioFile: (filePath) => ipcRenderer.invoke(channels.READ_AUDIO_FILE, filePath),
  /**
   * 添加语音包。
   * @param {string} name 语音包名称（必须唯一）
   * @param {string} srcPath 用户选择的原始文件路径（只记进 source 备查）
   * @param {{bytes: ArrayBuffer, ext: string}|null} optimized 处理后的成品，null 表示原样复制
   */
  addVoicePack: (name, srcPath, optimized) =>
    ipcRenderer.invoke(channels.ADD_VOICE_PACK, name, srcPath, optimized ?? null),
  /** 删除语音包 */
  removeVoicePack: (id) => ipcRenderer.invoke(channels.REMOVE_VOICE_PACK, id),
  /** 启用/停用语音包 */
  setVoicePackEnabled: (id, enabled) =>
    ipcRenderer.invoke(channels.SET_VOICE_PACK_ENABLED, id, enabled),
  /** 试听（交由桌宠窗口播放，与真实触发链路一致） */
  previewVoicePack: (id) => ipcRenderer.invoke(channels.PREVIEW_VOICE_PACK, id),
  /** 订阅语音包清单变更 */
  onVoicePacksChanged: (callback) =>
    ipcRenderer.on(channels.VOICE_PACKS_CHANGED, (_event, payload) => callback(payload)),
  /** 订阅"请播放某个语音包"（桌宠窗口用） */
  onPlayVoice: (callback) =>
    ipcRenderer.on(channels.PLAY_VOICE, (_event, payload) => callback(payload)),
});
