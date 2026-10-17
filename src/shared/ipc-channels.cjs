/**
 * IPC 通道名统一定义。
 * 主进程（ESM import）与 preload（CJS require）共用，避免通道名散落导致拼写错误。
 */
module.exports = {
  /** 获取应用数据目录（诊断日志用） */
  GET_APP_PATH: 'get-app-path',
  /** 追加写诊断日志（诊断日志用） */
  WRITE_DIAGNOSTICS: 'write-diagnostics',
  /** 移动桌宠窗口到指定屏幕坐标（拖拽用） */
  MOVE_WINDOW: 'move-window',
  /**
   * 渲染层 → 主进程：一次拖拽结束了（松手/取消）。
   * 主进程据此判断要不要自动停靠（把跑到屏幕边沿或外面的桌宠挪回可见区）。
   * 为什么不在拖拽过程中拦：拖拽是绝对式定位，中途修正位置会与光标错位（实测"拖到一半不跟"）。
   */
  MOVE_WINDOW_END: 'move-window-end',
  /** 主进程 → 渲染层：菜单项被点击 */
  MENU_ITEM_CLICKED: 'menu-item-clicked',
  /** 主进程 → 渲染层：精灵尺寸已变更（大中小切换，渲染层需重新加载素材） */
  SPRITE_SIZE_CHANGED: 'sprite-size-changed',
  /** 渲染层 → 主进程：请求切换精灵尺寸（设置界面用，返回是否成功） */
  SET_SPRITE_SIZE: 'set-sprite-size',
  /** 渲染层 → 主进程：读取设置 schema 与各项当前值（设置界面打开时调用） */
  GET_SETTINGS: 'get-settings',
  /** 渲染层 → 主进程：写入某项设置 (key, value) → { ok, value?, reason? } */
  SET_SETTING: 'set-setting',
  /** 渲染层 → 主进程：读取关于页信息（版本号、路径等） */
  GET_APP_INFO: 'get-app-info',
  /**
   * 渲染层 → 主进程：读取"可管理的动作"目录（设置界面「动作管理」的选项）。
   *
   * 为什么要走 IPC 而不是渲染层直接 fetch manifest：设置窗口是 `webSecurity: true` 的，
   * file:// 页面里 fetch 本地文件会被 CORS 拦掉（桌宠窗口是靠把 webSecurity 关掉才读得到素材的，
   * 设置窗口不该为一个选项列表去松安全策略）。顺带也保证动作分类判定只有主进程一份。
   */
  /**
   * 渲染层 → 主进程：读取可用皮肤列表 [{ id, label }]。
   * 走 IPC 的原因与 GET_ACTION_CATALOG 相同：设置窗口 webSecurity 开着，
   * file:// 页面读不到本地目录列表。
   */
  GET_SKINS: 'get-skins',
  /**
   * 渲染层 → 主进程：切换皮肤 (skinId) → { ok, skinId, reason? }。
   * 主进程落盘后广播 SKIN_CHANGED，桌宠窗口据此重新加载整套素材。
   */
  SET_SKIN: 'set-skin',
  /**
   * 主进程 → 所有窗口：皮肤已切换 { skinId }。
   * 台词 / 语音包 / 动作全部随皮肤走，所以接收方整体重载（见 renderer/main.js）。
   */
  SKIN_CHANGED: 'skin-changed',
  /**
   * 渲染层 → 主进程：拖动滑块期间"临时应用"某项设置 (key, value)。
   * 只广播、不落盘 —— 松手时仍走 SET_SETTING 正式提交。
   * 目的是让音量这类需要即时反馈的设置拖起来有反应。
   */
  PREVIEW_SETTING: 'preview-setting',
  /** 主进程 → 所有窗口：某项设置已变更 { key, value } */
  SETTINGS_CHANGED: 'settings-changed',

  // —— 语音包 ——
  /** 渲染层 → 主进程：读取语音包清单（含可播 URL、启用状态） */
  GET_VOICE_PACKS: 'get-voice-packs',
  /** 渲染层 → 主进程：弹出系统文件选择框挑音频，返回 { path, name } 或 null */
  PICK_AUDIO_FILE: 'pick-audio-file',
  /**
   * 渲染层 → 主进程：读取音频文件的原始字节（ArrayBuffer）。
   * 解码与响度处理只能在渲染层做（依赖 Web Audio），所以先把字节交给渲染层。
   */
  READ_AUDIO_FILE: 'read-audio-file',
  /** 渲染层 → 主进程：添加语音包 (name, srcPath, optimized?) → { ok, pack?, message? } */
  ADD_VOICE_PACK: 'add-voice-pack',
  /** 渲染层 → 主进程：删除语音包 (id) → { ok, message? } */
  REMOVE_VOICE_PACK: 'remove-voice-pack',
  /** 渲染层 → 主进程：启用/停用语音包 (id, enabled) */
  SET_VOICE_PACK_ENABLED: 'set-voice-pack-enabled',
  /** 渲染层 → 主进程：试听 (packId) —— 由主进程转给桌宠窗口播放 */
  PREVIEW_VOICE_PACK: 'preview-voice-pack',
  /** 主进程 → 所有窗口：语音包清单已变更 { packs } */
  VOICE_PACKS_CHANGED: 'voice-packs-changed',
  /** 主进程 → 桌宠窗口：请立即播放某个语音包 { pack } */
  PLAY_VOICE: 'play-voice',
};
