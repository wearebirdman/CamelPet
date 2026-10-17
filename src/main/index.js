/**
 * CamelPet（骆驼桌宠）主进程入口。
 * 只负责装配：加载配置 → 建桌宠窗口 → 建托盘 → 注册 IPC → 绑定右键菜单 → 装配设置服务。
 * 具体实现分散在 config/logger/window/tray/menu/ipc/settings/settings-window 各模块，便于单独扩展。
 */
import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT_DIR,
  loadConfig,
  loadConfigOrDefault,
  loadSkinConfig,
  loadSkinManifest,
  resolveReadable,
  resolveVoicePaths,
  saveActiveSkin,
  saveConfig,
  saveSkinDialogue,
  saveSpriteSize,
  setupDataRoot,
  listSkins,
} from './config.js';
import { logError } from './logger.js';
import { createPetWindow, resizeForSpriteSize } from './window.js';
import { createTray } from './tray.js';
import { createMenuManager } from './menu.js';
import { registerIpc, broadcastToAll } from './ipc.js';
import { openSettingsWindow } from './settings-window.js';
import { createSettingsService } from './settings.js';
import { createAutoLaunch } from './auto-launch.js';
import { dockIfEnabled } from './dock.js';
import { createVoicePackService } from './voicepacks.js';
import { createMenuDynamicSections } from './menu-dynamic.js';
import {
  DEFAULT_IDLE_FREQUENCY,
  DEFAULT_SPRITE_SIZE,
  DRAG_THRESHOLD_PX,
  IDLE_ACTION_FREQUENCIES,
  SPRITE_SIZES,
} from '../shared/constants.js';
import channels from '../shared/ipc-channels.cjs';

/**
 * 老版本这里无条件 `app.disableHardwareAcceleration()`，理由是"规避部分显卡/远程桌面下的
 * GPU 崩溃与透明窗口合成问题"。2026-10-17 实测发现它反而会造成更严重的问题：
 *
 *   关掉硬件加速后，`transparent: true` 的窗口**不再参与桌面合成** ——
 *   窗口句柄存在、`IsWindowVisible` 为真、`capturePage` 抓到的画面里骆驼清清楚楚，
 *   但屏幕上什么都看不到（截屏里该位置是桌面背景）。用户看到的就是"双击没反应"。
 *
 * 对比实验（同一台机器、同一份二进制）：
 *   GPU 关闭 → 屏幕上透明，什么都看不见
 *   GPU 开启 → 骆驼正常显示
 *
 * 所以默认**保留**硬件加速。真遇到 GPU 崩溃/花屏时，用 CAMEL_PET_DISABLE_GPU=1 关掉，
 * 不必改代码。
 */
if (process.env.CAMEL_PET_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

/**
 * 关于 Chromium 沙箱（重要，别再踩一遍）
 *
 * 在某些受限环境（例如装有 CodexSandboxUsers 这类沙箱管控的 Windows）里，
 * 直接双击本程序会**完全没有反应**：没有窗口、没有 main.log，进程退出码 0x80000003。
 * 底层原因是 Chromium 初始化沙箱 IPC（命名管道）时被拒（`platform_channel.cc Check failed: 拒绝访问`）。
 *
 * 实测结论：崩溃发生在 Electron 原生初始化阶段，**早于 main.js 的第一行**，
 * 因此 `app.commandLine.appendSwitch('no-sandbox')` 在这里**无效**（已验证过，不要加回来）。
 * 唯一有效的办法是启动时在命令行上带 `--no-sandbox`，由根目录的 CamelPet.exe（自检启动器）负责。
 * 桌宠只加载打包内的本地页面、不加载远程内容，所以该机器上关沙箱是可接受的权衡。
 */

/**
 * 一次性迁移旧的数据目录。
 *
 * 旧版本把应用名当成目录名，用户数据落在 `%APPDATA%\骆驼桌宠`；
 * 现在统一改成纯英文的 `%APPDATA%\CamelPet`（路径不掺中文，跨工具更稳）。
 * 只有新目录里还没有 data 时才搬一次，失败也不影响启动。
 */
try {
  const legacyData = path.join(app.getPath('appData'), '骆驼桌宠', 'data');
  const currentData = path.join(app.getPath('userData'), 'data');
  if (!fs.existsSync(currentData) && fs.existsSync(legacyData)) {
    fs.cpSync(legacyData, currentData, { recursive: true });
    console.log(`[bootstrap] 已迁移旧数据目录：${legacyData} -> ${currentData}`);
  }
} catch (_) {
  /* 迁移是尽力而为 */
}

/**
 * 数据根定位（必须在**任何** loadConfig / loadSkinConfig 之前跑完）。
 *
 * 打包后 config/ 在 app.asar 里是只读的，用户改设置、导入语音包都会失败，
 * 所以可写数据全部改落 userData。开发态下 setupDataRoot 直接判定为"不分离"，
 * 数据根仍是仓库根 —— 行为与改造前逐字节一致。
 *
 * 注意位置：下面那句 `let spriteSize = normalizeSpriteSize(loadSkinConfig()...)`
 * 是**模块求值期**就读配置的，所以这段不能等到 app.whenReady()（那时它早就读过了）。
 * app.isPackaged / app.getPath('userData') 在 ready 之前都可用。
 *
 * CAMEL_PET_DATA_ROOT 是给验证脚本用的显式覆盖（tools/userdata-check.js），
 * 用来在不打包的前提下复现"可写数据与包分离"这条链路；不设就没有任何影响。
 */
{
  const { dataRoot, separate, copied } = setupDataRoot({
    packaged: app.isPackaged,
    userDataDir: app.getPath('userData'),
    override: process.env.CAMEL_PET_DATA_ROOT,
  });
  if (separate) {
    console.log(`[bootstrap] 可写数据根：${dataRoot}（播种 ${copied} 个文件）`);
  }
}

/**
 * 主进程未捕获异常 / 未处理 Promise 拒绝的兜底。
 *
 * 为什么需要：Electron 默认会给未捕获异常弹一个
 * "A JavaScript error occurred in the main process" 系统对话框 —— 对一个常驻桌宠来说，
 * 用户看到这个框只会一头雾水，而且关掉之后**什么记录都没留下**，事后根本没法排查。
 * 这里统一落到 main.log（并打控制台），既不影响继续运行，也保住了证据。
 */
process.on('uncaughtException', (error) => {
  logError('uncaught-exception', error);
});
process.on('unhandledRejection', (reason) => {
  logError('unhandled-rejection', reason instanceof Error ? reason : String(reason));
});

/** @type {import('electron').BrowserWindow|null} */
let mainWindow = null;
/** @type {import('electron').Tray|null} */
let tray = null;

const getWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

/** 当前精灵尺寸（大中小），来源于 config/skin.json，可被菜单即时切换 */
let spriteSize = normalizeSpriteSize(loadSkinConfig().spriteSize) ?? DEFAULT_SPRITE_SIZE;

/** 只接受 manifest 支持的档位，避免配置文件写错值导致素材 404 */
function normalizeSpriteSize(size) {
  const parsed = Number(size);
  return SPRITE_SIZES.includes(parsed) ? parsed : null;
}

/**
 * 切换精灵尺寸：落盘（下次启动仍生效）+ 调整窗口 + 通知渲染层换素材。
 * @param {number} size
 * @returns {boolean} 是否发生了切换
 */
function setSpriteSize(size) {
  const normalized = normalizeSpriteSize(size);
  if (!normalized) {
    logError('set-sprite-size', `不支持的尺寸：${size}`);
    return false;
  }
  if (normalized === spriteSize) {
    return true;
  }

  spriteSize = normalized;
  try {
    saveSpriteSize(normalized);
  } catch (error) {
    logError('save-sprite-size', error);
  }

  const window = getWindow();
  if (window) {
    resizeForSpriteSize(window, normalized);
    // 换档后补一次自动停靠（开关关着则是空操作）。
    // 放在广播**之前**是有意的：停靠只影响窗口坐标，换素材的通知必须照发 ——
    // dockIfEnabled 承诺不抛异常，所以这里不存在"停靠失败导致换档失败"的可能。
    dockIfEnabled(window);
    window.webContents.send(channels.SPRITE_SIZE_CHANGED, normalized);
  }
  return true;
}

/**
 * 切换皮肤。
 *
 * 皮肤 = 一整套资源：形象素材（manifest + sprites）、台词（dialogue.json）、
 * 语音包（voicepacks.json + audio/）。所以切换要做三件事，少一样就会出现
 * "换了形象却还是上一套的声音/台词"：
 *   1. 落盘 activeSkin（下次启动生效）；
 *   2. 广播 SKIN_CHANGED —— 桌宠窗口据此**整体重载**渲染层
 *      （动画/菜单/台词池/调度器都是启动时按 manifest 装配的，整体重建比逐个更新可靠）；
 *   3. 广播 VOICE_PACKS_CHANGED —— 语音包清单随皮肤换了，播放器要重取。
 * 菜单不需要重建：menu-dynamic 的 actions 段每次弹菜单都现读 manifest。
 *
 * @param {string} skinId
 * @returns {{ok: boolean, skinId: string, reason?: string}}
 */
function setSkin(skinId) {
  const result = saveActiveSkin(skinId);
  if (!result.ok) {
    logError('set-skin', `未知皮肤：${skinId}`);
    return result;
  }

  const packs = voicePackService.list();
  broadcastToAll(channels.SKIN_CHANGED, { skinId: result.skinId });
  // 语音包清单是皮肤级的：紧跟在 SKIN_CHANGED 之后发，避免播放器还握着上一套的 URL
  broadcastToAll(channels.VOICE_PACKS_CHANGED, { packs });
  return result;
}

function ensureWindow() {
  const existing = getWindow();
  if (existing) {
    return existing;
  }
  try {
    mainWindow = createPetWindow({
      windowState: loadConfig('window.json'),
      spriteSize,
    });
  } catch (error) {
    logError('create-window', error);
    return null;
  }
  // 启动即补一次停靠：换了显示器/拔了副屏之后，配置里的坐标可能已经落在可见区之外。
  // 刻意放在 try 之外 —— 自动停靠是独立功能，即便它出问题也不能让"窗口创建"被判成失败
  // （dockIfEnabled 自身也承诺不抛异常，这里只是把边界划清楚）。
  dockIfEnabled(mainWindow);
  return mainWindow;
}

/**
 * 设置项 applier 表：登记在此的键才允许被设置界面写入（未登记一律拒绝）。
 * 每个 applier 自己负责「落盘 + 广播」，因为不同设置生效方式不同
 * （尺寸要调窗口并让桌宠换素材，语音只是记个值等播放器来读）。
 */

/** 台词池上限，防止界面粘进超长内容把气泡撑爆 */
const MAX_CLICK_LINES = 60;
const MAX_LINE_LENGTH = 80;

/** 「随机频率」下拉的三个选项，与 settings.json 里的 value 一一对应 */
const RANDOM_INTERVAL_CHOICES = ['1-3', '3-6', '6-10'];

/** 气泡时长区间，与 settings.json 里的 min/max 一致 */
const BUBBLE_MIN_MS = 500;
const BUBBLE_MAX_MS = 6000;

/** 拖拽阈值区间，与 settings.json 里的 min/max 一致 */
const DRAG_MIN_PX = 2;
const DRAG_MAX_PX = 12;

/**
 * 把任意输入夹进 [min, max] 并取整；拿不到有效数字时回退 fallback。
 * 光用 Math.min/Math.max 不行 —— NaN 会把整个结果污染成 NaN，
 * 落盘后就是 JSON 里的 null，等界面读回来滑块直接显示空白。
 */
function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

/**
 * 开机自启动控制器。
 * 它的"值"存在操作系统的登录项里，config/app.json 只是给设置界面看的镜像。
 * 所有 Electron 依赖都从这里注入，方便验证脚本用假实现（不能真往注册表写）。
 */
const autoLaunchService = createAutoLaunch({ electronApp: app, rootDir: ROOT_DIR });

/**
 * 把系统里真实的开机项状态同步回 config/app.json。
 *
 * 为什么启动时要同步：用户可能在任务管理器 / 系统设置里关掉了开机自启动，
 * 也可能换了 exe 路径 —— 此时配置文件里那个 true 就是过期信息，界面会显示"开着"但实际不会启动。
 * 系统是真相，配置只是镜像，所以每次启动都以系统为准覆盖一次。
 */
function syncAutoLaunchFromSystem() {
  try {
    const state = autoLaunchService.read();
    if (!state.supported) {
      return;
    }
    const mirrored = loadConfigOrDefault({ autoLaunch: false }, 'app.json').autoLaunch;
    if (Boolean(mirrored) !== state.registered) {
      saveConfig(['app.json'], { autoLaunch: state.registered });
    }
    if (state.stale) {
      logError('auto-launch', `系统里的开机项与当前运行方式不一致：${state.command}`);
    }
  } catch (error) {
    logError('sync-auto-launch', error);
  }
}

/**
 * 生成一个"开关型"设置的 applier：落盘到指定配置文件的某个键，并广播出去。
 * 这些开关本身没有复杂副作用，真正消费它们的逻辑（随机触发、语音播放等）在别处监听广播。
 */
/**
 * 按配置文件名落盘：台词类（dialogue.json）**随皮肤走**，其余仍在 config/ 下。
 * 这样换皮肤后改台词写的是当前皮肤自己的 dialogue.json，不会串到别的皮肤上。
 */
function saveByFile(file, patch) {
  return file === 'dialogue.json' ? saveSkinDialogue(patch) : saveConfig([file], patch);
}

function persistSwitch(file, configKey, settingId) {
  return (value) => {
    const flag = Boolean(value);
    saveByFile(file, { [configKey]: flag });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: settingId, value: flag });
    return true;
  };
}

/** 生成一个"频率档位"设置的 applier，顺带把非法值夹回合法档位 */
function persistInterval(file, configKey, settingId) {
  return (value) => {
    const interval = RANDOM_INTERVAL_CHOICES.includes(String(value))
      ? String(value)
      : RANDOM_INTERVAL_CHOICES[1];
    saveByFile(file, { [configKey]: interval });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: settingId, value: interval });
    return { value: interval };
  };
}

const applySetting = {
  bubbleDurationMs(value) {
    // 夹到 schema 声明的区间，避免滑块之外的值（或手改配置）把气泡卡死或一闪而过
    const duration = clampNumber(value, BUBBLE_MIN_MS, BUBBLE_MAX_MS, 1800);
    saveSkinDialogue({ bubbleDurationMs: duration });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'bubbleDurationMs', value: duration });
    return true;
  },
  clickLines(value) {
    // 规范化：只保留非空字符串，去空白、限条数、限单条长度。
    // 界面上容易粘进空行或超长文本，不处理会撑爆气泡。
    const lines = (Array.isArray(value) ? value : [])
      .filter((line) => typeof line === 'string')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_CLICK_LINES)
      .map((line) => line.slice(0, MAX_LINE_LENGTH));
    // 台词是皮肤级的：写当前皮肤的 dialogue.json
    // （default 没自带 → 回落 config/dialogue.json，行为与之前一致）
    saveSkinDialogue({ click: { lines } });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'clickLines', value: lines });
    return { value: lines }; // 把规范化结果回传界面，避免界面显示与落盘内容不一致
  },
  voiceMuted(value) {
    const muted = Boolean(value);
    saveConfig(['voice.json'], { muted });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'voiceMuted', value: muted });
    return true;
  },
  voiceVolume(value) {
    // 必须走 clampNumber：直接 Math.max/min/round 链会让 NaN 穿透，
    // 落盘成 JSON null，下次读回 Number(null)=0 → 音量静默变 0（审查 H3）
    const volume = clampNumber(value, 0, 100, 70);
    saveConfig(['voice.json'], { volume });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'voiceVolume', value: volume });
    return true;
  },

  // —— 通用 ——

  /**
   * 开机自启动。
   * 顺序很重要：先写系统登录项，**写成功了**才落镜像文件。
   * 反过来的话，写入被安全软件拦掉时会留下"配置文件说开着、系统里其实没有"的假象，
   * 而界面读的正是配置文件 —— 用户会看到一个骗人的开关。
   */
  autoLaunch(value) {
    const result = autoLaunchService.set(value);
    if (!result.ok) {
      return result; // { ok: false, message } 直通界面，让用户看到具体原因
    }
    saveConfig(['app.json'], { autoLaunch: result.value });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'autoLaunch', value: result.value });
    return result.warning ? { value: result.value, warning: result.warning } : { value: result.value };
  },

  /**
   * 窗口置顶：支持运行时切换，不需要重启（`setAlwaysOnTop` 随时可调）。
   * 同时落盘 —— 窗口是按 config/window.json 建的，不落盘的话下次启动又变回去了。
   * 窗口不存在也不报错：设置窗口比桌宠活得久的情况是存在的，落盘本身就完成了使命。
   */
  alwaysOnTop(value) {
    const flag = Boolean(value);
    getWindow()?.setAlwaysOnTop(flag);
    saveConfig(['window.json'], { alwaysOnTop: flag });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'alwaysOnTop', value: flag });
    return true;
  },

  /**
   * 不透明度。
   * 运行时立即生效（setOpacity 随时可调），同时落盘给下次启动用。
   * 夹到 [30,100]：与设置界面的滑块范围一致，低到看不见就等于桌宠消失了。
   */
  opacity(value) {
    const percent = clampNumber(value, 30, 100, 100);
    getWindow()?.setOpacity(percent / 100);
    saveConfig(['window.json'], { opacity: percent });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'opacity', value: percent });
    return { value: percent };
  },

  /**
   * 自动停靠。
   * 关注的是"桌宠被挪到屏幕边沿或外面、用户看不见了"这件事：
   * 开关打开后，切尺寸、拖完松手、开机启动这几个时机都会把窗口平移回可见区
   * （拖拽过程中**不**拦截 —— 那会跟绝对式拖拽打架，实测会让"拖到一半不跟"）。
   * 打开开关时立刻停靠一次，让用户当场看到效果，而不是等下次拖出去才发现。
   */
  autoDock(value) {
    const flag = Boolean(value);
    saveConfig(['window.json'], { autoDock: flag });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'autoDock', value: flag });
    if (flag) {
      dockIfEnabled(getWindow());
    }
    return true;
  },

  /**
   * 拖拽灵敏度。
   * 纯行为参数：落盘 + 广播，真正的判定在渲染层 interaction.js。
   * 调大 = 允许手抖得更多才算拖拽（更容易触发单击）；调小 = 稍微一动就开始拖。
   */
  dragThresholdPx(value) {
    const threshold = clampNumber(value, DRAG_MIN_PX, DRAG_MAX_PX, DRAG_THRESHOLD_PX);
    saveConfig(['behavior.json'], { dragThresholdPx: threshold });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'dragThresholdPx', value: threshold });
    return { value: threshold };
  },

  /**
   * 待机动作频率。
   * 控制的是"待机时多久眨一次眼"的间隔，不是单次眨眼的快慢 —— 后者写死在 blink 的帧时长里。
   * off 档不是"间隔无穷大"，而是"不插播"：渲染层的调度器会直接停掉，不留空转的定时器。
   * 非法档位夹回默认，避免配置写坏导致永远不眨眼或一秒眨十次。
   */
  idleFrequency(value) {
    const frequency = Object.prototype.hasOwnProperty.call(IDLE_ACTION_FREQUENCIES, value)
      ? String(value)
      : DEFAULT_IDLE_FREQUENCY;
    saveConfig(['behavior.json'], { idleFrequency: frequency });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'idleFrequency', value: frequency });
    return { value: frequency };
  },

  // —— 单击触发：三选一（互斥组 clickTrigger，由 settings.js 保证最多开一个）——
  /**
   * 切换皮肤：形象素材 + 台词 + 语音包整套换掉（落盘由 setSkin 负责，applier 只补广播）。
   * 界面拿到的失败原因是 unknown-skin（皮肤不存在），不会误报成"保存失败"。
   */
  activeSkin(value) {
    const result = setSkin(value);
    if (!result.ok) {
      return { ok: false, reason: result.reason, message: '皮肤不存在' };
    }
    broadcastToAll(channels.SETTINGS_CHANGED, { key: 'activeSkin', value: result.skinId });
    return true;
  },
  clickLinesEnabled: persistSwitch('dialogue.json', 'clickLinesEnabled', 'clickLinesEnabled'),
  clickActionsEnabled: persistSwitch('dialogue.json', 'clickActionsEnabled', 'clickActionsEnabled'),
  clickVoiceEnabled: persistSwitch('voice.json', 'clickTriggerEnabled', 'clickVoiceEnabled'),

  // —— 定时随机：对话 / 动作 / 语音，各带一个频率档位 ——
  idleDialogueEnabled: persistSwitch('dialogue.json', 'idleDialogueEnabled', 'idleDialogueEnabled'),
  idleDialogueInterval: persistInterval('dialogue.json', 'idleDialogueInterval', 'idleDialogueInterval'),
  idleActionEnabled: persistSwitch('behavior.json', 'idleActionEnabled', 'idleActionEnabled'),
  idleActionInterval: persistInterval('behavior.json', 'idleActionInterval', 'idleActionInterval'),
  voiceRandomEnabled: persistSwitch('voice.json', 'randomEnabled', 'voiceRandomEnabled'),
  voiceRandomInterval: persistInterval('voice.json', 'randomInterval', 'voiceRandomInterval'),
};

const settingsService = createSettingsService({ applySetting });

/**
 * 语音包服务：清单与音频目录**随皮肤走**（皮肤目录里自带就用皮肤的，
 * 否则回落 config/voicepacks.json + assets/audio/），所以路径是每次现算的。
 */
const voicePackService = createVoicePackService({
  resolvePaths: () => resolveVoicePaths(),
});

/**
 * 让桌宠窗口播放指定语音包。
 *
 * 设置界面的「试听」与右键菜单里点包名共用这一条链路 —— 两处各写一遍迟早会不一致
 * （比如一边记得查 exists、另一边忘了）。
 * @param {string} id
 * @returns {{ok: true, pack: object} | {ok: false, message: string}}
 */
function playVoicePackToPet(id) {
  const pack = voicePackService.list().find((candidate) => candidate.id === id);
  if (!pack) {
    return { ok: false, message: '语音包不存在' };
  }
  if (!pack.exists) {
    return { ok: false, message: '音频文件已丢失，请重新添加' };
  }
  const window = getWindow();
  if (!window || window.isDestroyed()) {
    return { ok: false, message: '桌宠窗口不可用' };
  }
  window.webContents.send(channels.PLAY_VOICE, { pack });
  return { ok: true, pack };
}

/** 语音音量的可选档位（Electron 菜单不支持滑条，只能用档位单选） */
const VOLUME_LEVELS = [0, 25, 50, 75, 100];

/** 读取语音配置（缺字段时回退默认值） */
const readVoiceConfig = () => loadConfigOrDefault({ muted: false, volume: 70 }, 'voice.json');

/** 主进程内置动作表：新增内置动作只需在此登记，menu.json 用 action 字段引用 */
const menuActions = {
  quit: () => app.quit(),
  hide: () => getWindow()?.hide(),
  show: () => getWindow()?.show(),
  'settings:open': () => openSettingsWindow({ getPetWindow: getWindow }),
  // 菜单里的语音项与设置界面共用同一批 applier，保证两处行为一致
  'voice:toggle-mute': () => applySetting.voiceMuted(!readVoiceConfig().muted),
  ...Object.fromEntries(
    VOLUME_LEVELS.map((level) => [`voice:volume:${level}`, () => applySetting.voiceVolume(level)])
  ),
};

/**
 * 菜单勾选态的数据源。
 * menu.json 里的项通过 checkedFrom 引用这些 key，弹菜单时实时求值 —— 这样勾选状态
 * 永远跟配置文件同步，不需要在别处手工维护。
 */
const menuCheckSources = {
  voiceMuted: () => Boolean(readVoiceConfig().muted),
  voiceVolume: () => Number(readVoiceConfig().volume),
};

/**
 * 菜单里的动态段。
 * menu.json 用 { "dynamic": "voicePacks" } / { "dynamic": "actions" } 占位，每次弹菜单时现算 ——
 * 语音包是运行期增删的、动作是随皮肤 manifest 走的，都不能在启动时就把菜单结构定死。
 * 返回空数组表示"整段消失（连分隔线一起）"，所以：
 *   - 一个语音包都没有时，「语音」子菜单里只剩静音与音量
 *   - 还没有"大动作"时，菜单里连「动作」这一项都不出现（待机不进菜单、眨眼已并入待机）
 */
const menuDynamicSections = createMenuDynamicSections({
  voicePackService,
  onPlayVoicePack: playVoicePackToPet,
  // 现读 manifest 而不是启动时读一次：换皮肤后不必重启菜单结构
  getManifest: loadSkinManifest,
});

/** 给菜单项挂上动态勾选态（checkedFrom + 可选 checkedValue 精确匹配） */
function decorateChecked(items) {
  return items.map((item) => {
    const decorated = { ...item };
    if (typeof decorated.checkedFrom === 'string') {
      const read = menuCheckSources[decorated.checkedFrom];
      const expected = decorated.checkedValue;
      decorated.checked = () => {
        const actual = read?.();
        return expected === undefined ? Boolean(actual) : actual === expected;
      };
    }
    if (Array.isArray(decorated.items)) {
      decorated.items = decorateChecked(decorated.items);
    }
    return decorated;
  });
}

function setupContextMenu() {
  const rawMenuConfig = loadConfig('menu.json');
  const menu = createMenuManager({
    menuConfig: { ...rawMenuConfig, items: decorateChecked(rawMenuConfig.items) },
    actions: menuActions,
    getWindow,
    resolveDynamic: (name) => menuDynamicSections[name]?.(),
    forwardToRenderer: (item) => {
      getWindow()?.webContents.send(channels.MENU_ITEM_CLICKED, item);
    },
  });

  getWindow()?.webContents.on('context-menu', () => {
    menu.popup(getWindow());
  });
}

// 单实例保护。
// 桌宠重复启动会出现两个形象在桌面上，而且两个实例会争抢同一个 userData 目录的
// Chromium 单例锁与 GPU 缓存，表现为 cache_util_win "拒绝访问" 并双双退出。
/**
 * 启动留痕。
 *
 * 放在抢锁之前：若"双击没反应"发生在更早的阶段（Electron 根本没跑到 main），
 * 这条日志就不会出现 —— 这本身就是关键信息，能直接把"应用层问题"和"根本没启动"分开。
 */
logError('boot', `pid=${process.pid} packaged=${app.isPackaged} exec=${process.execPath}`);

/**
 * 启动时记一条"运行环境体检"。
 *
 * 背景：托盘建不出来、开机项写不进去这两个问题，最终都指向"进程拿到的权限"。
 * 用户自己的终端是 Medium 完整性、能写注册表，但应用进程却报"拒绝访问" ——
 * 光看表面分不清是代码问题还是被别的上下文拉起的。
 * 这里把完整性级别、是否在 AppContainer 里、能不能写 HKCU\Run 直接落到 main.log，
 * 以后一眼就能判断。
 */
function logEnvironment() {
  const parts = [];
  try {
    const raw = execFileSync('whoami', ['/groups'], { windowsHide: true });
    const text = raw.toString('latin1'); // 只取 SID 与 ASCII 段，避开中文编码问题
    const integrity = /S-1-16-(\d+)/.exec(text);
    const LEVELS = { 4096: 'Low', 8192: 'Medium', 12288: 'High', 16384: 'System' };
    parts.push(`integrity=${integrity ? LEVELS[integrity[1]] ?? integrity[1] : 'unknown'}`);
    parts.push(`appContainer=${/S-1-15-2-\d+/.test(text)}`);
  } catch (_) {
    parts.push('integrity=query-failed');
  }
  try {
    execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', 'CamelPetEnvProbe', '/t', 'REG_SZ', '/d', 'probe', '/f'], { stdio: 'pipe', windowsHide: true });
    execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', 'CamelPetEnvProbe', '/f'], { stdio: 'pipe', windowsHide: true });
    parts.push('runKeyWritable=true');
  } catch (_) {
    parts.push('runKeyWritable=false');
  }
  parts.push(`userData=${app.getPath('userData')}`);
  logError('env', parts.join(' '));
}

try {
  logEnvironment();
} catch (_) {
  /* 体检本身不能影响启动 */
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  /**
   * 抢不到锁就退出，但**必须留痕**。
   *
   * 这条分支以前是完全静默的：用户双击图标没反应时，日志里没有一行记录，
   * 看上去和应用崩溃一模一样，实际上只是"已经有一个实例在跑"。
   * 现在写进 main.log，下次再遇到"打不开"能一眼分清是锁冲突还是真崩溃。
   */
  logError('single-instance', '已有实例在运行，本次启动退出（不会出现第二个桌宠）');
  app.quit();
} else {
  // 第二次启动时把已有桌宠唤到前面，而不是再开一个
  app.on('second-instance', () => {
    /**
     * 这里必须走 ensureWindow 而不是只用 getWindow：
     * 窗口可能已经被销毁（渲染层崩溃、或被系统回收），此时 `window?.show()` 是空操作，
     * 结果就是"双击没反应、但进程确实在跑"，而且再双击也没用 —— 锁一直在旧实例手上。
     * 重建一个窗口才是用户按预期想要的结果。
     */
    const window = ensureWindow();
    if (!window) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  });

  app.whenReady().then(() => {
    // 开机项的真身在系统里，启动时先以系统为准校正一次镜像文件，
    // 免得界面把用户在系统设置里手动关掉的开机自启动显示成"开着"
    syncAutoLaunchFromSystem();

    const window = ensureWindow();
    if (window) {
      setupContextMenu();
      const trayIconPath = resolveReadable('assets', 'icons', 'tray-icon.png');
      tray = createTray({
        getWindow,
        iconPath: trayIconPath,
        onOpenSettings: () => openSettingsWindow({ getPetWindow: getWindow }),
      });
      /**
       * 托盘创建结果要留痕。
       *
       * Electron 的 Tray 即使 Shell_NotifyIcon 失败也不会抛错，只在 Chromium 日志里
       * 打一行 WARNING —— 用户看到的就是"托盘里没有图标"，而 main.log 一片空白。
       * 这里明确记录用的是哪个图标、有没有建成功，便于事后判断是"图标路径问题"
       * 还是"当前会话不允许建托盘"（受限令牌下 Shell_NotifyIcon 会被拒绝）。
       */
      logError(
        'tray',
        tray
          ? `托盘已创建，图标=${trayIconPath}`
          : `托盘创建失败（createTray 返回 null），图标=${trayIconPath}`
      );
    }

    registerIpc({
      getWindow,
      setSpriteSize,
      settingsService,
      voicePackService,
      playVoicePack: playVoicePackToPet,
      listSkins,
      setSkin,
    });

    // 开发便利：CAMEL_PET_OPEN_SETTINGS=1 启动即打开设置窗口，调设置界面时不用每次右键
    if (process.env.CAMEL_PET_OPEN_SETTINGS === '1') {
      openSettingsWindow({ getPetWindow: getWindow });
    }

    app.on('activate', () => {
      // 有了设置窗口之后不能再判 getAllWindows().length：设置窗口开着时会被误判成
      // "桌宠还在"，导致桌宠被关闭后无法重建。改为直接判桌宠窗口本身。
      if (!getWindow()) {
        if (ensureWindow()) {
          setupContextMenu();
        }
      }
    });
  });

  app.on('window-all-closed', () => {
    /**
     * 这里一定要留痕：桌宠窗口被销毁后如果没人拦，应用会安静地退出。
     * 用户看到的现象是"双击后什么都没发生"，而日志里一行都没有 —— 最难查的一类。
     */
    logError('window-all-closed', `平台=${process.platform}，窗口已全部关闭`);
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('will-quit', () => {
    logError('will-quit', '主进程即将退出');
  });
}
