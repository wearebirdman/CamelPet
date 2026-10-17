/**
 * 设置窗口专项验证。
 * 用途：npm run smoke 覆盖不到设置窗口（它只启动桌宠主进程），这里补上集成验证。
 * 用法：npm run settings-shot
 *
 * 设计要点：
 * - 加载**真实的** settings.html + 真实 preload + 真实 settings.js，不另写一套测试界面。
 * - 用动态 import 加载**真实的** src/main/settings.js 服务，注册真实 IPC handler，
 *   所以测的是真 schema、真路由、真落盘。
 * - 截屏走系统级 CopyFromScreen（本机 GPU 环境下 webContents.capturePage 会永远挂起）。
 * - 会修改 config 里的值做断言，**测试结束前一律还原**。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const OUT_DIR = path.join(PROJECT_ROOT, 'temp', 'capture');
const WIN_X = 80;
const WIN_Y = 80;
const WIN_W = 760;
const WIN_H = 540;
/** 与 src/main/ipc.js 的上限保持一致：超过它的文件不给渲染层处理 */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

app.disableHardwareAcceleration();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`[settings-shot ${new Date().toISOString().slice(11, 23)}] ${msg}`);

const failures = [];
let total = 0;
function check(name, ok, detail = '') {
  total += 1;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  › ' + detail : ''}`);
  if (!ok) failures.push(name);
}

function readConfig(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8'));
  } catch (_) {
    return {};
  }
}

function grabScreen(x, y, width, height, outFile) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing;',
    `$b = New-Object System.Drawing.Bitmap(${width}, ${height});`,
    '$g = [System.Drawing.Graphics]::FromImage($b);',
    `$g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size);`,
    `$b.Save('${outFile.replace(/\\/g, '\\\\')}');`,
    '$g.Dispose(); $b.Dispose();',
  ].join(' ');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
}

const watchdog = setTimeout(() => {
  log('看门狗超时：120s 未完成，强制退出');
  app.exit(2);
}, 120000);

/**
 * 造一段最简 WAV（44 字节头 + 16bit PCM 单声道正弦波）。
 * 测试「添加音频」需要一个真实可解码的音频文件；用代码生成比往仓库里塞一个音频二进制干净得多。
 *
 * 默认前后各留一段极轻的底噪（leadMs / tailMs / floor），而不是只有一段纯正弦：
 * 纯正弦的每一帧电平都一样，噪声门与增益都无从下手，处理链路等于没走到。
 * 有静音段 + 合理信噪比，才会真的触发「压间隙底噪 → 提主体」这两步。
 */
function makeWav(seconds, frequency, sampleRate = 8000, { leadMs = 0, tailMs = 0, floor = 0 } = {}) {
  const lead = Math.round((sampleRate * leadMs) / 1000);
  const tail = Math.round((sampleRate * tailMs) / 1000);
  const tone = Math.round(sampleRate * seconds);
  const total = lead + tone + tail;
  const data = Buffer.alloc(total * 2);
  const floorValue = Math.round(floor * 32767);
  for (let index = 0; index < total; index += 1) {
    const inTone = index >= lead && index < lead + tone;
    const value = inTone
      ? Math.round(Math.sin((2 * Math.PI * frequency * (index - lead)) / sampleRate) * 8000)
      : floorValue;
    data.writeInt16LE(value, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 读 WAV 头里的采样率；不是 RIFF 就返回 0 */
function wavSampleRate(file) {
  const head = fs.readFileSync(file).subarray(0, 28);
  return head.subarray(0, 4).toString('ascii') === 'RIFF' ? head.readUInt32LE(24) : 0;
}

/** 读 16bit PCM 的峰值幅度（0~1）。用来确认"增益真的落到了波形上"，而不是只看记录里的标记位 */
function wavPeak(file) {
  const buffer = fs.readFileSync(file);
  let peak = 0;
  for (let offset = 44; offset + 1 < buffer.length; offset += 2) {
    const value = Math.abs(buffer.readInt16LE(offset)) / 32768;
    if (value > peak) peak = value;
  }
  return peak;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const channels = require(path.join(PROJECT_ROOT, 'src', 'shared', 'ipc-channels.cjs'));
  // 广播需要 BrowserWindow 遍历所有窗口，这里直接复用 ipc.js 的实现
  const { broadcastToAll } = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'ipc.js')).href
  );
  const settingsModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'settings.js')).href
  );
  const configModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'config.js')).href
  );
  const voicepacksModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'voicepacks.js')).href
  );
  /** 档位表与动作分类判定都从真实模块取，避免在测试里另抄一份口径 */
  const constantsModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'shared', 'constants.js')).href
  );
  const actionCatalogModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'shared', 'action-catalog.js')).href
  );
  /** 自动停靠（与 index.js 共用同一实现，避免这里另写一份判断逻辑） */
  const dockModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'dock.js')).href
  );
  const { IDLE_ACTION_FREQUENCIES, DEFAULT_IDLE_FREQUENCY } = constantsModule;
  const { createSettingsService, readSettingsValues } = settingsModule;
  const { createVoicePackService } = voicepacksModule;
  const { saveConfig } = configModule;

  // 记录原始配置，测试结束还原
  const originalSkin = readConfig('skin.json');
  const originalVoice = readConfig('voice.json');
  const originalWindow = readConfig('window.json');
  const originalDialogue = readConfig('dialogue.json');
  const originalBehavior = readConfig('behavior.json');
  const originalVoicePacks = readConfig('voicepacks.json');
  const originalApp = readConfig('app.json');
  /**
   * `assets/audio/` 的文件名快照（小写）。收尾清扫以它为准，见文末"还原配置"一节：
   * 靠清单推算扫不到"已被摘掉记录、文件却还在"的孤儿，靠目录快照才补得上这个洞。
   */
  const baselineAudioFiles = new Set(
    fs.readdirSync(path.join(PROJECT_ROOT, 'assets', 'audio')).map((name) => name.toLowerCase())
  );

  // 与 index.js 保持一致的 applier（尺寸走专用通道，不在这里）
  const persistSwitch = (file, configKey, settingId) => (value) => {
    const flag = Boolean(value);
    saveConfig([file], { [configKey]: flag });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: settingId, value: flag });
    return true;
  };
  const INTERVALS = ['1-3', '3-6', '6-10'];
  const persistInterval = (file, configKey, settingId) => (value) => {
    const interval = INTERVALS.includes(String(value)) ? String(value) : INTERVALS[1];
    saveConfig([file], { [configKey]: interval });
    broadcastToAll(channels.SETTINGS_CHANGED, { key: settingId, value: interval });
    return { value: interval };
  };

  /**
   * 开机自启动的**假实现**。这里必须造假，没有别的选择：
   * 真实实现每跑一次就会往 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 写一条开机项 ——
   * 一个验证脚本绝不该有这种副作用（用户会莫名其妙多出一堆开机启动项）。
   *
   * 假实现严格照 Windows 的真实语义来，否则测出来的"通过"没有意义：
   *   - 写入：把整条命令行记下来（`exe 参数...`）
   *   - 带 { path, args } 查 → 比较整条命令行（Electron 的 openAtLogin 会比较 args）
   *   - 不带参数查     → 只问"有没有开机项"，忽略 args（executableWillLaunchAtLogin）
   *   - dropping 开关模拟"被安全软件/组策略静默吃掉"：不抛错、也不生效
   */
  const loginItemFake = { value: '', dropping: false };
  const fakeAutoLaunchApp = {
    isPackaged: false,
    setLoginItemSettings(options = {}) {
      if (loginItemFake.dropping) {
        return;
      }
      loginItemFake.value = options.openAtLogin
        ? [options.path, ...(options.args ?? [])].join(' ')
        : '';
    },
    getLoginItemSettings(options) {
      const has = loginItemFake.value !== '';
      if (!options) {
        return { openAtLogin: has, executableWillLaunchAtLogin: has };
      }
      const wanted = [options.path, ...(options.args ?? [])].join(' ');
      return { openAtLogin: has && wanted === loginItemFake.value };
    },
  };
  const autoLaunchModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'auto-launch.js')).href
  );
  const autoLaunchService = autoLaunchModule.createAutoLaunch({
    electronApp: fakeAutoLaunchApp,
    rootDir: PROJECT_ROOT,
    platform: 'win32',
  });

  const settingsService = createSettingsService({
    applySetting: {
      bubbleDurationMs: (value) => {
        const duration = Math.max(500, Math.min(6000, Math.round(Number(value))));
        saveConfig(['dialogue.json'], { bubbleDurationMs: duration });
        broadcastToAll(channels.SETTINGS_CHANGED, { key: 'bubbleDurationMs', value: duration });
        return true;
      },
      clickLines: (value) => {
        const lines = (Array.isArray(value) ? value : [])
          .filter((line) => typeof line === 'string')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 60)
          .map((line) => line.slice(0, 80));
        saveConfig(['dialogue.json'], { click: { lines } });
        broadcastToAll(channels.SETTINGS_CHANGED, { key: 'clickLines', value: lines });
        return { value: lines };
      },
      voiceMuted: (value) => {
        saveConfig(['voice.json'], { muted: Boolean(value) });
        return true;
      },
      voiceVolume: (value) => {
        // 与 src/main/index.js 的 clampNumber(value, 0, 100, 70) 同语义：
        // NaN 必须在落盘前被拦下，否则 JSON 里写进 null，读回变 0（审查 H3）
        const parsed = Number(value);
        const volume = Number.isFinite(parsed)
          ? Math.max(0, Math.min(100, Math.round(parsed)))
          : 70;
        saveConfig(['voice.json'], { volume });
        broadcastToAll(channels.SETTINGS_CHANGED, { key: 'voiceVolume', value: volume });
        return true;
      },
      clickLinesEnabled: persistSwitch('dialogue.json', 'clickLinesEnabled', 'clickLinesEnabled'),
      clickActionsEnabled: persistSwitch('dialogue.json', 'clickActionsEnabled', 'clickActionsEnabled'),
      clickVoiceEnabled: persistSwitch('voice.json', 'clickTriggerEnabled', 'clickVoiceEnabled'),
      idleDialogueEnabled: persistSwitch('dialogue.json', 'idleDialogueEnabled', 'idleDialogueEnabled'),
      idleDialogueInterval: persistInterval('dialogue.json', 'idleDialogueInterval', 'idleDialogueInterval'),
      idleActionEnabled: persistSwitch('behavior.json', 'idleActionEnabled', 'idleActionEnabled'),
      idleActionInterval: persistInterval('behavior.json', 'idleActionInterval', 'idleActionInterval'),
      voiceRandomEnabled: persistSwitch('voice.json', 'randomEnabled', 'voiceRandomEnabled'),
      voiceRandomInterval: persistInterval('voice.json', 'randomInterval', 'voiceRandomInterval'),

      // —— 通用（三个 applier 与 src/main/index.js 同语义）——
      /**
       * 开机自启动，走上面那个假实现。
       * 顺序被打断就是 bug：必须**系统写成功**才落镜像文件。
       */
      autoLaunch: (value) => {
        const result = autoLaunchService.set(value);
        if (!result.ok) {
          return result; // { ok:false, message } 直通界面
        }
        saveConfig(['app.json'], { autoLaunch: result.value });
        broadcastToAll(channels.SETTINGS_CHANGED, { key: 'autoLaunch', value: result.value });
        return result.warning
          ? { value: result.value, warning: result.warning }
          : { value: result.value };
      },
      /**
       * 窗口置顶。除了落盘，真的作用到一个窗口上（用与桌宠同参数的窗口代替），
       * 这样"改动即时生效"是被观察到的窗口状态，而不是只信一行广播。
       */
      alwaysOnTop: (value) => {
        const flag = Boolean(value);
        petWindowRef?.setAlwaysOnTop(flag);
        saveConfig(['window.json'], { alwaysOnTop: flag });
        broadcastToAll(channels.SETTINGS_CHANGED, { key: 'alwaysOnTop', value: flag });
        return true;
      },
      autoDock: (value) => {
        // 与 src/main/index.js 同语义：落盘 + 广播；开关打开时立刻停靠一次
        const flag = Boolean(value);
        saveConfig(['window.json'], { autoDock: flag });
        broadcastToAll(channels.SETTINGS_CHANGED, { key: 'autoDock', value: flag });
        if (flag && petWindowRef) {
          dockModule.dockIfEnabled(petWindowRef);
        }
        return true;
      },
      dragThresholdPx: (value) => {
        const parsed = Number(value);
        const threshold = Number.isFinite(parsed) ? Math.max(2, Math.min(12, Math.round(parsed))) : 4;
        saveConfig(['behavior.json'], { dragThresholdPx: threshold });
        broadcastToAll(channels.SETTINGS_CHANGED, { key: 'dragThresholdPx', value: threshold });
        return { value: threshold };
      },
      /**
       * 待机动作频率（与 index.js 同语义）：档位表来自 shared/constants.js，
       * 不在这里另抄一份区间 —— 抄一份就会出现"界面显示的区间和实际插播节奏对不上"。
       */
      idleFrequency: (value) => {
        const frequency = Object.prototype.hasOwnProperty.call(IDLE_ACTION_FREQUENCIES, value)
          ? String(value)
          : DEFAULT_IDLE_FREQUENCY;
        saveConfig(['behavior.json'], { idleFrequency: frequency });
        broadcastToAll(channels.SETTINGS_CHANGED, { key: 'idleFrequency', value: frequency });
        return { value: frequency };
      },
    },
  });

  // ---- 注册真实 IPC ----
  const voicePackService = createVoicePackService();
  /** 桌宠窗口在下面才创建；试听通道要用到，所以先声明（IPC handler 在运行时才解引用） */
  let petWindowRef = null;

  /** 语音包清单变更 → 广播（与 src/main/ipc.js 的语义一致） */
  const broadcastPacks = () => {
    const packs = voicePackService.list();
    broadcastToAll(channels.VOICE_PACKS_CHANGED, { packs });
    return packs;
  };

  ipcMain.handle(channels.GET_SETTINGS, () => settingsService.readAll());
  ipcMain.handle(channels.SET_SETTING, (_e, key, value) => settingsService.write(key, value));
  ipcMain.handle(channels.GET_VOICE_PACKS, () => voicePackService.list());
  ipcMain.handle(channels.ADD_VOICE_PACK, (_e, name, src, optimized) => {
    // 第三个参数是渲染层做完响度处理后回传的成品（单声道 WAV）；为 null 时原样复制源文件
    const result = voicePackService.add({
      name,
      src,
      bytes: optimized?.bytes ?? null,
      ext: optimized?.ext ?? null,
    });
    if (result.ok) broadcastPacks();
    return result;
  });
  ipcMain.handle(channels.REMOVE_VOICE_PACK, (_e, id) => {
    const result = voicePackService.remove(id);
    if (result.ok) broadcastPacks();
    return result;
  });
  ipcMain.handle(channels.SET_VOICE_PACK_ENABLED, (_e, id, enabled) => {
    const result = voicePackService.setEnabled(id, enabled);
    if (result.ok) broadcastPacks();
    return result;
  });
  /**
   * 「浏览本地文件」用桩替代：真弹系统对话框会卡住无人值守的验证。
   * 桩的行为与真实一致 —— 返回 { path, name } 或 null（取消）。
   */
  let pickStub = null;
  ipcMain.handle(channels.PICK_AUDIO_FILE, () => pickStub);
  ipcMain.handle(channels.PREVIEW_VOICE_PACK, (_e, id) => {
    const pack = voicePackService.list().find((candidate) => candidate.id === id);
    if (!pack?.exists) {
      return { ok: false, message: '音频文件已丢失' };
    }
    if (!petWindowRef || petWindowRef.isDestroyed()) {
      return { ok: false, message: '桌宠窗口不可用' };
    }
    petWindowRef.webContents.send(channels.PLAY_VOICE, { pack });
    return { ok: true, pack };
  });
  /**
   * 音频读取通道（与 src/main/ipc.js 同语义）：把源文件字节交给渲染层做响度处理。
   * 少了这个 handler，渲染层会走 catch 分支静默退化成「原样复制」——
   * 功能上不算崩，但整条处理链路就没被验证到。
   */
  ipcMain.handle(channels.READ_AUDIO_FILE, async (_e, filePath) => {
    try {
      const resolved = path.resolve(String(filePath ?? ''));
      if (!fs.existsSync(resolved)) return { ok: false, message: '找不到该文件' };
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return { ok: false, message: '不是文件' };
      if (stat.size > MAX_AUDIO_BYTES) {
        return { ok: false, message: `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 过大，无法处理` };
      }
      const buffer = await fs.promises.readFile(resolved);
      const copied = new ArrayBuffer(buffer.byteLength);
      Buffer.from(copied).set(buffer);
      return { ok: true, bytes: copied, size: buffer.byteLength };
    } catch (_) {
      return { ok: false, message: '读取音频文件失败' };
    }
  });
  /** 拖动滑块时的即时预览通道：只做白名单校验 + 广播，不落盘 */
  ipcMain.handle(channels.PREVIEW_SETTING, (_e, key, value) => {
    const allowed = settingsService.preview(key, value);
    if (!allowed.ok) return allowed;
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
    rootPath: configModule.ROOT_DIR,
  }));
  // 尺寸通道：复刻 index.js 的语义（校验 → 落盘 → 广播）
  ipcMain.handle(channels.SET_SPRITE_SIZE, (_e, size) => {
    const parsed = Number(size);
    if (![128, 192, 256].includes(parsed)) return false;
    saveConfig(['skin.json'], { spriteSize: parsed });
    return true;
  });
  ipcMain.handle(channels.GET_APP_PATH, () => app.getPath('userData'));
  ipcMain.handle(channels.WRITE_DIAGNOSTICS, () => true);
  /**
   * 动作目录（与 src/main/ipc.js 同语义）：主进程读皮肤 manifest 后返回"大动作"。
   * 现在真实 manifest 里一个都没有（眨眼已并入待机、待机不是动作），所以这里是空数组 ——
   * 这正是要验的：空目录时界面得给出提示，而不是一片空白。
   */
  ipcMain.handle(channels.GET_ACTION_CATALOG, () =>
    actionCatalogModule.listBigActions(configModule.loadSkinManifest())
  );
  // 皮肤列表与切换：挂具要用与生产一致的真实实现（设置页「皮肤」下拉是 live 项了）
  ipcMain.handle(channels.GET_SKINS, () => configModule.listSkins());
  ipcMain.handle(channels.SET_SKIN, (_e, skinId) => configModule.saveActiveSkin(skinId));

  // ---- 打开真实设置页 ----
  const window = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: WIN_X,
    y: WIN_Y,
    show: true,
    title: '骆驼桌宠 · 设置（验证）',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(PROJECT_ROOT, 'src', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  // 与真实设置窗口保持一致：去掉应用菜单，否则截图里会多出一条 File/Edit 菜单栏
  window.setMenu(null);

  const consoleErrors = [];
  window.webContents.on('console-message', (_e, level, message) => {
    // 只看 error 级；Electron 自身的 CSP/安全提示是开发期噪音，打包后不出现（桌宠页面同样有）
    const isElectronNotice = message.includes('Electron Security Warning');
    if (level >= 3 && !isElectronNotice) consoleErrors.push(message);
    log(`[renderer] ${message.split('\n')[0]}`);
  });
  window.webContents.on('render-process-gone', (_e, details) =>
    log(`[renderer-gone] ${JSON.stringify(details)}`)
  );

  const ask = (code, timeoutMs = 5000) =>
    Promise.race([
      window.webContents.executeJavaScript(code),
      wait(timeoutMs).then(() => '<<renderer-timeout>>'),
    ]);

  await window.loadFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'settings.html'));
  await wait(1500);
  window.moveTop();
  await wait(800);

  // ---- 额外开一个桌宠窗口：验证「设置改动 → 桌宠即时生效」的广播链路 ----
  // （桌宠与设置是两个独立渲染进程，只测设置侧无法覆盖这条链路）
  // 窗口参数必须与 src/main/window.js 的桌宠窗口一致，否则布局不同，气泡位置验证会失真
  const petWindow = new BrowserWindow({
    width: 208,
    height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(PROJECT_ROOT, 'src', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false, // 桌宠要 fetch 本地素材
    },
  });
  petWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) log(`[pet-renderer] ${message.split('\n')[0]}`);
  });
  petWindowRef = petWindow;
  await petWindow.loadFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'index.html'));
  await wait(2500); // 等桌宠 bootstrap + 预加载帧

  const petReady = await petWindow.webContents.executeJavaScript(
    `Boolean(window.__pet?.dialogue)`
  );
  check('桌宠窗口已就绪（可读取对话控制器）', petReady === true);

  // ---- 断言 1：schema 里 4 个分类 ----
  const categoryCount = await ask(`document.querySelectorAll('.nav-item').length`);
  check('左侧导航渲染出 4 个分类', categoryCount === 4, `实际 ${categoryCount}`);

  // ---- 断言 2：逐个分类点击后内容区非空 ----
  const perCategory = await ask(`(async () => {
    const buttons = [...document.querySelectorAll('.nav-item')];
    const out = [];
    for (const button of buttons) {
      button.click();
      await new Promise((r) => setTimeout(r, 120));
      const content = document.getElementById('content');
      out.push({ label: button.textContent, len: content.textContent.trim().length });
    }
    return JSON.stringify(out);
  })()`);
  const details = JSON.parse(perCategory === '<<renderer-timeout>>' ? '[]' : perCategory);
  check(
    '每个分类点击后内容区都有内容',
    details.length === 4 && details.every((entry) => entry.len > 0),
    details.map((entry) => `${entry.label}:${entry.len}`).join(' ')
  );

  // ---- 断言：行为分类按小标题分成三组 ----
  await ask(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent === '行为')?.click()`);
  await wait(250);
  const groups = await ask(
    `JSON.stringify([...document.querySelectorAll('#content .group-title')].map((e) => e.textContent))`
  );
  check(
    '行为分类渲染出「对话 / 动作 / 语音」三个分组',
    groups === JSON.stringify(['对话', '动作', '语音']),
    String(groups)
  );

  // ---- 断言：占位功能已清理，「动作管理」「气泡样式」不再出现在 schema 里 ----
  const removedItems = await ask(`JSON.stringify(
    window.__settings.items
      .filter((i) => ['actionEnabled', 'bubbleStyle'].includes(i.id))
      .map((i) => i.id)
  )`);
  check('未接入的「动作管理 / 气泡样式」已从 schema 中移除', removedItems === '[]', String(removedItems));

  // ---- 断言：「不透明度」已从占位转为真实设置项 ----
  const opacityItem = JSON.parse(await ask(`JSON.stringify(window.__settings.findItem('opacity'))`));
  check(
    '「不透明度」是滑块项且不再有占位标记',
    opacityItem?.control === 'slider' && opacityItem?.status === undefined,
    JSON.stringify(opacityItem)
  );

  // ---- 断言 3：大小下拉初值 === 配置文件里的值（该项已从通用移到外观） ----
  await ask(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent === '外观')?.click()`);
  await wait(250);
  const expectedSize = String(readSettingsValues().spriteSize);
  const sizeValue = await ask(
    `document.querySelector('#content select')?.value ?? 'none'`
  );
  check('「大小」下拉初值与配置一致', sizeValue === expectedSize, `${sizeValue} vs ${expectedSize}`);

  // ---- 断言 4：改尺寸会真实落盘 ----
  const targetSize = expectedSize === '256' ? '192' : '256';
  await ask(`(() => {
    const item = window.__settings.findItem('spriteSize');
    return window.__settings.setValue(item, ${targetSize});
  })()`);
  await wait(400);
  const savedSize = String(readConfig('skin.json').spriteSize);
  check('改尺寸后 skin.json 已落盘', savedSize === targetSize, `skin.json=${savedSize}`);

  // ---- 断言 5：改静音会真实落盘 ----
  await ask(`(() => {
    const item = window.__settings.findItem('voiceMuted');
    return window.__settings.setValue(item, true);
  })()`);
  await wait(400);
  check('改静音后 voice.json 已落盘', readConfig('voice.json').muted === true);
  /**
   * 断言完立刻恢复成非静音。
   * 播放器在静音时 play() 会**直接短路**（连 element.src 都不设，readyState 停在 0），
   * 于是后面「试听 / 右键菜单播放」的用例会全部挂在这个残留状态上 ——
   * 上一轮就是这么把 voice.json 的 muted 留成 true、又让三条播放断言一起变红的。
   * 用例之间不该靠执行顺序互相喂状态。
   */
  await ask(`(() => {
    const item = window.__settings.findItem('voiceMuted');
    return window.__settings.setValue(item, false);
  })()`);
  await wait(400);

  // ---- 断言：改气泡时长会落盘，并即时下发到桌宠 ----
  const petDurationBefore = await petWindow.webContents.executeJavaScript(
    `window.__pet?.dialogue?.durationMs ?? null`
  );
  await ask(`(() => {
    const item = window.__settings.findItem('bubbleDurationMs');
    return window.__settings.setValue(item, 3200);
  })()`);
  await wait(600);
  const petDurationAfter = await petWindow.webContents.executeJavaScript(
    `window.__pet?.dialogue?.durationMs ?? null`
  );
  check(
    '改气泡时长后 dialogue.json 已落盘',
    readConfig('dialogue.json').bubbleDurationMs === 3200,
    `dialogue.json=${readConfig('dialogue.json').bubbleDurationMs}`
  );
  check(
    '气泡时长改动即时下发到桌宠（广播链路）',
    petDurationAfter === 3200,
    `${petDurationBefore} -> ${petDurationAfter}`
  );
  check(
    '改时长未破坏 dialogue.json 的其他字段',
    Array.isArray(readConfig('dialogue.json').click?.lines),
    `click.lines=${readConfig('dialogue.json').click?.lines?.length} 条`
  );

  // ---- 断言：台词池可写、可规范化、并即时下发到桌宠 ----
  const dirtyLines = ['  自律使我变强。  ', '', '   ', '拿捏。', 'x'.repeat(120)];
  await ask(`(() => {
    const item = window.__settings.findItem('clickLines');
    return window.__settings.setValue(item, ${JSON.stringify(dirtyLines)});
  })()`);
  await wait(600);
  const savedLines = readConfig('dialogue.json').click?.lines ?? [];
  check(
    '台词池已落盘且去掉了空行/首尾空白',
    savedLines.length === 3 && savedLines[0] === '自律使我变强。' && savedLines[1] === '拿捏。',
    JSON.stringify(savedLines.map((line) => line.slice(0, 12)))
  );
  check('超长台词被截断到 80 字', savedLines[2]?.length === 80, `长度 ${savedLines[2]?.length}`);
  const petLines = await petWindow.webContents.executeJavaScript(
    `JSON.stringify(window.__pet?.interaction?.lines ?? [])`
  );
  check(
    '台词池改动即时下发到桌宠（广播链路）',
    JSON.parse(petLines).length === 3,
    petLines.slice(0, 60)
  );

  // ---- 断言：气泡样式与叠加行为（用户反馈的两个问题） ----
  const bubbleProbe = await petWindow.webContents.executeJavaScript(`(() => {
    const d = window.__pet.dialogue;
    d.show('第一句'); d.show('第二句'); d.show('第三句');
    const bubbles = document.querySelectorAll('.bubble');
    const style = getComputedStyle(bubbles[0]);
    return JSON.stringify({
      count: bubbles.length,
      text: bubbles[0]?.textContent,
      boxShadow: style.boxShadow,
    });
  })()`);
  const probe = JSON.parse(bubbleProbe);
  check('连点只保留一个气泡（不叠加）', probe.count === 1, `实际 ${probe.count} 个`);
  check('气泡显示的是最新一句', probe.text === '第三句', String(probe.text));
  check(
    '气泡没有模糊阴影（透明窗口下会形成灰圈）',
    probe.boxShadow === 'none',
    probe.boxShadow
  );

  // ---- 视觉留证：气泡的实际渲染效果（透明窗口 + 桌面背景） ----
  const petX = 120;
  const petY = 120;
  const petW = 208;
  const petH = 260;
  petWindow.setBounds({ x: petX, y: petY, width: petW, height: petH });
  petWindow.show();
  petWindow.moveTop();
  await wait(500);
  await petWindow.webContents.executeJavaScript(
    `window.__pet.dialogue.show('自律使我变强。')`
  );
  await wait(300);
  grabScreen(
    Math.round(petX * 1.5),
    Math.round(petY * 1.5),
    Math.round(petW * 1.5),
    Math.round(petH * 1.5),
    path.join(OUT_DIR, 'bubble.png')
  );
  log('气泡效果截图：temp/capture/bubble.png');
  petWindow.hide();

  // ---- 断言：单击触发三选一互斥 ----
  const askPet = (code, timeoutMs = 5000) =>
    Promise.race([
      petWindow.webContents.executeJavaScript(code),
      wait(timeoutMs).then(() => '<<pet-timeout>>'),
    ]);

  await ask(`window.__settings.selectCategory('behavior')`);
  await wait(300);
  const setItem = (id, value) =>
    ask(`(() => {
      const item = window.__settings.findItem('${id}');
      return window.__settings.setValue(item, ${JSON.stringify(value)});
    })()`);
  const clickState = () =>
    ask(`JSON.stringify({
      lines: window.__settings.values.clickLinesEnabled,
      actions: window.__settings.values.clickActionsEnabled,
      voice: window.__settings.values.clickVoiceEnabled,
      violations: window.__settings.exclusiveViolations(),
    })`);

  await setItem('clickLinesEnabled', true);
  await wait(250);
  await setItem('clickActionsEnabled', true);
  await wait(450);
  const afterAction = JSON.parse(await clickState());
  check(
    '打开「单击触发动作」后另两项自动关闭',
    afterAction.actions === true && afterAction.lines === false && afterAction.voice === false,
    JSON.stringify(afterAction)
  );

  await setItem('clickVoiceEnabled', true);
  await wait(450);
  const afterVoice = JSON.parse(await clickState());
  check(
    '打开「单击触发语音」后另两项自动关闭',
    afterVoice.voice === true && afterVoice.actions === false && afterVoice.lines === false,
    JSON.stringify(afterVoice)
  );
  check(
    '互斥组任何时刻都不会有两个同时打开',
    afterVoice.violations.length === 0,
    JSON.stringify(afterVoice.violations)
  );
  check(
    '互斥结果已落盘',
    readConfig('voice.json').clickTriggerEnabled === true &&
      readConfig('dialogue.json').clickActionsEnabled === false,
    `voice=${readConfig('voice.json').clickTriggerEnabled} dialogue=${readConfig('dialogue.json').clickActionsEnabled}`
  );

  // ---- 断言：开关 + 子控件显隐 ----
  // 先归一到「关」再开始断言：初始值跟着用户配置走（可能本来就开着），
  // 断言不能依赖运行时的配置初值（收尾会把 dialogue.json 整体还原回用户原值）
  await setItem('idleDialogueEnabled', false);
  await wait(350);
  const childBefore = await ask(`String(window.__settings.isItemVisible('idleDialogueInterval'))`);
  await setItem('idleDialogueEnabled', true);
  await wait(350);
  const childAfter = await ask(`String(window.__settings.isItemVisible('idleDialogueInterval'))`);
  check('「定时随机对话」关闭时频率子控件隐藏', childBefore === 'false', childBefore);
  check('「定时随机对话」打开后频率子控件显示', childAfter === 'true', childAfter);
  await setItem('idleDialogueEnabled', false);
  await wait(350);
  const childBack = await ask(`String(window.__settings.isItemVisible('idleDialogueInterval'))`);
  check('再次关闭后频率子控件重新隐藏', childBack === 'false', childBack);

  // ---- 断言：随机频率三档取值与落盘 ----
  const intervalOptions = await ask(`(() => {
    const row = document.querySelector('[data-item-id="idleDialogueInterval"]');
    return JSON.stringify([...row.querySelectorAll('option')].map((o) => o.value));
  })()`);
  check(
    '随机频率为 1~3 / 3~6 / 6~10 三档',
    intervalOptions === JSON.stringify(['1-3', '3-6', '6-10']),
    String(intervalOptions)
  );
  await setItem('idleDialogueInterval', '6-10');
  await wait(350);
  check(
    '随机频率改动已落盘',
    readConfig('dialogue.json').idleDialogueInterval === '6-10',
    String(readConfig('dialogue.json').idleDialogueInterval)
  );
  const badInterval = await ask(`(() => {
    const item = window.__settings.findItem('idleDialogueInterval');
    return window.__settings.setValue(item, 'not-a-choice');
  })()`);
  await wait(350);
  check(
    '非法频率被夹回合法档位',
    readConfig('dialogue.json').idleDialogueInterval === '3-6',
    `传 not-a-choice → 落盘 ${readConfig('dialogue.json').idleDialogueInterval}`
  );

  // ---- 断言：待机动作频率（眨眼间隔）真的接进了插播调度器 ----
  const petIdleScheduler = () =>
    askPet(`JSON.stringify(window.__pet?.idleScheduler
      ? { frequency: window.__pet.idleScheduler.frequency,
          delayRange: window.__pet.idleScheduler.delayRange,
          idleActions: window.__pet.idleScheduler.idleActions }
      : null)`);

  const idleBefore = JSON.parse((await petIdleScheduler()) || 'null');
  check(
    '桌宠启动时按 behavior.json 的档位初始化插播节奏',
    idleBefore?.frequency === readConfig('behavior.json').idleFrequency,
    JSON.stringify(idleBefore)
  );
  check(
    '待机动作池就是 manifest 里标记 ambient 的状态（眨眼被并入待机）',
    JSON.stringify(idleBefore?.idleActions) === JSON.stringify(['blink']),
    JSON.stringify(idleBefore?.idleActions)
  );

  await setItem('idleFrequency', 'high');
  await wait(500);
  const idleHigh = JSON.parse((await petIdleScheduler()) || 'null');
  check(
    '改档后 behavior.json 已落盘',
    readConfig('behavior.json').idleFrequency === 'high',
    JSON.stringify(readConfig('behavior.json'))
  );
  check(
    '改档即时下发到桌宠（广播链路）',
    idleHigh?.frequency === 'high',
    `${idleBefore?.frequency} -> ${idleHigh?.frequency}`
  );
  check(
    '档位换算出的间隔区间与共享常量一致（不是抄了一份）',
    JSON.stringify(idleHigh?.delayRange) === JSON.stringify(IDLE_ACTION_FREQUENCIES.high),
    `${JSON.stringify(idleHigh?.delayRange)} vs ${JSON.stringify(IDLE_ACTION_FREQUENCIES.high)}`
  );

  // off 档：不是"间隔无穷大"，而是彻底停掉调度器（不留一个永不触发的定时器）
  await setItem('idleFrequency', 'off');
  await wait(500);
  const idleOff = JSON.parse((await petIdleScheduler()) || 'null');
  check(
    'off 档把间隔区间变成 null（调度器停排，而非排一个永不触发的定时器）',
    idleOff?.frequency === 'off' && idleOff?.delayRange === null,
    JSON.stringify(idleOff)
  );
  await setItem('idleFrequency', 'medium');
  await wait(500);
  check(
    '恢复中档后区间回到共享常量里的值',
    JSON.stringify(JSON.parse((await petIdleScheduler()) || 'null')?.delayRange) ===
      JSON.stringify(IDLE_ACTION_FREQUENCIES.medium),
    String(await petIdleScheduler())
  );

  const badIdleFrequency = await setItem('idleFrequency', 'not-a-choice');
  await wait(400);
  check(
    '非法档位回退到默认（中档），不会把调度器卡在不插播上',
    badIdleFrequency?.value === DEFAULT_IDLE_FREQUENCY &&
      readConfig('behavior.json').idleFrequency === DEFAULT_IDLE_FREQUENCY,
    `传 not-a-choice → ${JSON.stringify(badIdleFrequency)}`
  );

  // ---- 断言：单击触发开关确实下发到了桌宠 ----
  await setItem('clickLinesEnabled', true);
  await wait(500);
  const petClick = await askPet(`JSON.stringify(window.__pet?.interaction?.clickEnabled ?? null)`);
  check(
    '单击触发开关已下发到桌宠',
    petClick !== '<<pet-timeout>>' && JSON.parse(petClick || 'null')?.lines === true,
    String(petClick)
  );
  await setItem('clickLinesEnabled', false);
  await wait(500);
  const petClickOff = await askPet(`JSON.stringify(window.__pet?.interaction?.clickEnabled ?? null)`);
  check(
    '关闭后桌宠同步收到',
    JSON.parse(petClickOff || 'null')?.lines === false,
    String(petClickOff)
  );
  await setItem('clickLinesEnabled', true);
  await wait(300);

  // ---- 断言：语音包管理（列表 / 添加 / 校验 / 启停 / 删除 / 试听） ----
  await ask(`window.__settings.selectCategory('behavior')`);
  await wait(300);
  // 语音分组在行为分类靠下，先滚过去，保证控件都在渲染视口里
  await ask(`(() => {
    const content = document.getElementById('content');
    const target = [...document.querySelectorAll('.group-title')].find((el) => el.textContent === '语音');
    if (content && target) {
      content.scrollTop += target.getBoundingClientRect().top - content.getBoundingClientRect().top - 70;
    }
    return 'ok';
  })()`);
  await wait(500);

  const readPacks = () => readConfig('voicepacks.json').packs ?? [];
  const listRows = async () =>
    JSON.parse(await ask(`JSON.stringify(window.__settings.voicePackRows())`));
  const dialogError = async () =>
    ask(`(() => { const e = document.getElementById('voice-error'); return e.hidden ? '' : e.textContent; })()`);

  /**
   * 以跑脚本时的既有清单为基线，后面的断言一律相对它来算。
   * 曾经这里写死了 'siuuu'，用户自己又加了个语音包之后整段断言全部 FAIL ——
   * 脚本该验的是功能，不该被用户的素材数量绑住。
   */
  const baselineIds = readPacks().map((pack) => pack.id);
  const baselineCount = baselineIds.length;
  check(
    '跑语音包用例前至少有一个已入库的语音包',
    baselineCount > 0,
    `基线 ${baselineCount} 个：${JSON.stringify(baselineIds)}`
  );

  const rows0 = await listRows();
  check(
    '语音包管理列出全部已入库的语音包',
    rows0.length === baselineCount && rows0.every((row) => Boolean(row.name)),
    `${rows0.length} 行 / 基线 ${baselineCount} 个`
  );

  const rowActions = await ask(`(() => {
    const row = document.querySelector('.voice-pack-row[data-pack-id="${baselineIds[0]}"]');
    return row ? JSON.stringify([...row.querySelectorAll('[data-action]')].map((el) => el.dataset.action)) : 'missing';
  })()`);
  check(
    '语音包行含 启用开关 / 试听 / 删除',
    rowActions === JSON.stringify(['preview', 'remove', 'toggle']),
    String(rowActions)
  );

  /**
   * 测试素材：0.1s 底噪 + 0.25s 660Hz 正弦 + 0.1s 底噪，8kHz 单声道。
   * 刻意造成"有静音段 + 信噪比够高"，噪声门与增益才会真的动作 ——
   * 一段连续纯正弦每帧电平都一样，处理链路等于没被走到。
   *
   * 名称带时间戳：同名会被主进程拒（这正是下面要验的行为），
   * 若上一轮跑崩留下残留包，用固定名字会让本次直接挂在第一步。
   */
  const PROBE_NAME = `probe-${Date.now().toString(36)}`;
  const fixtureDir = path.join(PROJECT_ROOT, 'temp', 'voice-fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const wavPath = path.join(fixtureDir, 'probe-source.wav');
  fs.writeFileSync(wavPath, makeWav(0.25, 660, 8000, { leadMs: 100, tailMs: 100, floor: 8 / 32767 }));
  const txtPath = path.join(fixtureDir, 'not-audio.txt');
  fs.writeFileSync(txtPath, 'definitely not audio');

  // 成品采样率从真实模块里取，避免把 32000 抄一份在这里、两边改不同步
  const outputSampleRate = (
    await import(pathToFileURL(path.join(PROJECT_ROOT, 'src', 'renderer', 'audio-import.js')).href)
  ).OUTPUT_SAMPLE_RATE;

  // —— 打开对话框 + 浏览本地文件（桩）——
  pickStub = { path: wavPath, name: PROBE_NAME };
  await ask(`window.__settings.openVoiceDialog()`);
  await wait(250);
  const dialogOpen = await ask(`String(!document.getElementById('voice-dialog').hidden)`);
  check('点「添加音频」弹出对话框', dialogOpen === 'true', dialogOpen);

  await ask(`document.getElementById('voice-browse').click()`);
  await wait(400);
  const filled = JSON.parse(
    await ask(`JSON.stringify({
      path: document.getElementById('voice-path').value,
      name: document.getElementById('voice-name').value,
    })`)
  );
  check(
    '浏览后自动填入音频地址与名称',
    filled.path === wavPath && filled.name === PROBE_NAME,
    JSON.stringify(filled)
  );

  // —— 提交添加：源文件 → 渲染层处理 → 主进程写成品 ——
  const addResult = await ask(`window.__settings.submitVoiceDialog()`);
  await wait(700);
  check('提交后对话框关闭', (await ask(`String(document.getElementById('voice-dialog').hidden)`)) === 'true');
  check('添加成功返回 true', addResult === true, String(addResult));

  const probePack = readPacks().find((pack) => pack.name === PROBE_NAME) ?? null;
  check(
    '新语音包已落盘',
    Boolean(probePack),
    JSON.stringify(readPacks().map((pack) => pack.id))
  );
  check(
    '导入时做过响度处理，包上留下 optimized 标记',
    probePack?.optimized === true,
    JSON.stringify(probePack)
  );
  const probeFile = probePack ? path.join(PROJECT_ROOT, 'assets', 'audio', String(probePack.file)) : '';
  check(
    '落盘的是处理后的单声道 WAV，而不是源文件的副本',
    Boolean(probeFile) &&
      fs.existsSync(probeFile) &&
      wavSampleRate(probeFile) === outputSampleRate &&
      wavSampleRate(probeFile) !== wavSampleRate(wavPath),
    `成品 ${probePack?.file} @ ${probeFile ? wavSampleRate(probeFile) : '-'}Hz / 源 ${wavSampleRate(wavPath)}Hz`
  );
  // 源素材峰值约 0.24（-12dBFS），处理管线会把主体提到 -1dBFS 附近。
  // 只有真的跑了增益这一条断言才会过 —— 光看 optimized 标记位是查不出"处理了个寂寞"的。
  check(
    '增益真的落到了波形上（成品峰值≈-1dBFS）',
    probeFile && wavPeak(probeFile) >= 0.85,
    `峰值 ${probeFile ? wavPeak(probeFile).toFixed(3) : '-'}`
  );
  const toastText = await ask(`document.querySelector('.toast')?.textContent ?? ''`);
  check(
    '添加成功的提示里说明了程序对音频做了什么',
    /dB|底噪|电平/.test(String(toastText)),
    String(toastText)
  );
  const rows1 = await listRows();
  check(
    '列表即时出现新语音包（广播驱动）',
    rows1.some((row) => row.name === PROBE_NAME),
    JSON.stringify(rows1.map((row) => row.name))
  );

  // —— 同名再添加：直接拒绝（菜单里靠名字认人，堆同名等于让人分不清） ——
  pickStub = { path: wavPath, name: PROBE_NAME };
  await ask(`window.__settings.openVoiceDialog()`);
  await wait(200);
  await ask(`document.getElementById('voice-browse').click()`);
  await wait(350);
  const dupResult = await ask(`window.__settings.submitVoiceDialog()`);
  await wait(400);
  const dupMsg = await dialogError();
  check(
    '同名再添加被拒并提示重名',
    dupResult === false && /同名/.test(dupMsg),
    dupMsg || '(无提示)'
  );
  check(
    '被拒后对话框保持打开（不让用户白填一遍）',
    (await ask(`String(!document.getElementById('voice-dialog').hidden)`)) === 'true'
  );
  check(
    '被拒后清单没有多出第二个同名的包',
    readPacks().filter((pack) => pack.name === PROBE_NAME).length === 1,
    JSON.stringify(readPacks().map((pack) => pack.name))
  );

  // —— 只差大小写也算重名（"SIUUU" 与 "siuuu" 在用户视角就是同一个名字） ——
  await ask(
    `document.getElementById('voice-name').value = ${JSON.stringify(PROBE_NAME.toUpperCase())}`
  );
  const caseResult = await ask(`window.__settings.submitVoiceDialog()`);
  await wait(400);
  check(
    '只改大小写的同名同样被拒',
    caseResult === false && readPacks().filter((pack) => /^probe-/i.test(pack.name)).length === 1,
    await dialogError()
  );

  // —— 非法格式被拒 ——
  pickStub = { path: txtPath, name: 'not-audio' };
  await ask(`window.__settings.openVoiceDialog()`);
  await wait(200);
  await ask(`document.getElementById('voice-browse').click()`);
  await wait(350);
  const badFormat = await ask(`window.__settings.submitVoiceDialog()`);
  await wait(300);
  const badFormatMsg = await dialogError();
  check(
    '非法格式被拒且对话框给出原因',
    badFormat === false && /不支持/.test(badFormatMsg),
    badFormatMsg || '(无提示)'
  );

  // —— 空名称被拒 ——
  await ask(`window.__settings.openVoiceDialog()`);
  await wait(200);
  await ask(`document.getElementById('voice-path').value = ${JSON.stringify(wavPath)}`);
  const emptyName = await ask(`window.__settings.submitVoiceDialog()`);
  await wait(250);
  const emptyNameMsg = await dialogError();
  check(
    '空名称被拒且对话框给出原因',
    emptyName === false && /名称/.test(emptyNameMsg),
    emptyNameMsg || '(无提示)'
  );
  await ask(`window.__settings.closeVoiceDialog()`);
  await wait(200);
  check(
    '取消后对话框关闭且未新增语音包',
    (await ask(`String(document.getElementById('voice-dialog').hidden)`)) === 'true' &&
      readPacks().length === baselineCount + 1,
    JSON.stringify(readPacks().map((pack) => pack.id))
  );

  // —— 启用 / 停用 ——
  const toggleSelector = (id) =>
    `.voice-pack-row[data-pack-id="${id}"] input[data-action="toggle"]`;
  await ask(`document.querySelector('${toggleSelector(baselineIds[0])}').click()`);
  await wait(500);
  check(
    '停用后 enabled=false 已落盘',
    readPacks().find((pack) => pack.id === baselineIds[0])?.enabled === false,
    JSON.stringify(readPacks().find((pack) => pack.id === baselineIds[0]))
  );
  await ask(`document.querySelector('${toggleSelector(baselineIds[0])}').click()`);
  await wait(500);
  check(
    '重新启用后 enabled=true 已落盘',
    readPacks().find((pack) => pack.id === baselineIds[0])?.enabled === true,
    JSON.stringify(readPacks().find((pack) => pack.id === baselineIds[0]))
  );

  // —— 删除（先把确认框桩成"确定"，否则模态 confirm 会把无人值守的验证卡死）——
  await ask(`window.confirm = () => true; 'patched'`);
  /**
   * 只删本次用例造出来的包。曾经这里写死了 ['test-tone-2','test-tone']：
   * 同名被拒之后 test-tone-2 根本不存在，querySelector 返回 null，取 .closest 直接抛异常，
   * 整个脚本当场中断、还原逻辑也没跑到 —— 测试脚本自己反倒成了污染源。
   * 以「基线之外」为准，就不存在"猜哪几个 id 会存在"这件事。
   */
  const probeRows = readPacks().filter(
    (pack) => !baselineIds.some((id) => String(id).toLowerCase() === String(pack.id).toLowerCase())
  );
  check('本次用例只新增了 1 个探针包（删除用例前置）', probeRows.length === 1, JSON.stringify(probeRows.map((r) => r.id)));
  const probeFiles = probeRows.map((pack) => String(pack.file ?? ''));
  for (const pack of probeRows) {
    await ask(`document.querySelector('${toggleSelector(pack.id)}').closest('.voice-pack-row')
      .querySelector('[data-action="remove"]').click()`);
    await wait(500);
  }
  const idsAfterRemove = readPacks().map((pack) => pack.id);
  check(
    '删除探针包后清单回到基线',
    JSON.stringify(idsAfterRemove) === JSON.stringify(baselineIds),
    `${JSON.stringify(idsAfterRemove)} / 基线 ${JSON.stringify(baselineIds)}`
  );
  check(
    '删除时连带清掉 assets/audio 里的副本',
    probeFiles.length > 0 &&
      probeFiles.every(
        (file) => !fs.existsSync(path.join(PROJECT_ROOT, 'assets', 'audio', file))
      ),
    JSON.stringify(probeFiles)
  );

  // —— 试听链路：设置窗口 → 主进程 → 桌宠窗口播放 ——
  // 静音时播放器直接短路（不设 src），先把静音确保关掉再验链路；
  // 用户自己的静音取值在最后统一还原，不会被这里改坏。
  await setItem('voiceMuted', false);
  await wait(500);
  const previewTarget = voicePackService.playable()[0] ?? null;
  check(
    '基线里至少有一个可播语音包（试听用例前置）',
    Boolean(previewTarget),
    previewTarget?.id ?? '无'
  );
  const previewResult = await ask(`window.petAPI.previewVoicePack('${previewTarget?.id}')`);
  check('试听返回成功', previewResult?.ok === true, JSON.stringify(previewResult));
  await wait(900);
  const petAudio = JSON.parse(
    await askPet(`JSON.stringify(window.__pet?.player?.status ?? null)`)
  );
  check(
    '语音包已送达桌宠渲染层',
    typeof petAudio?.currentSrc === 'string' &&
      petAudio.currentSrc.includes(previewTarget?.file ?? '\u0000'),
    JSON.stringify(petAudio)
  );
  check(
    '桌宠侧可播池计数与清单一致',
    petAudio?.playable === voicePackService.playable().length &&
      petAudio?.total === voicePackService.list().length,
    JSON.stringify({ playable: petAudio?.playable, total: petAudio?.total })
  );
  check(
    '音频在桌宠渲染层真的加载解码成功（readyState ≥ 2）',
    Number(petAudio?.readyState) >= 2 && Number(petAudio?.duration) > 0,
    `readyState=${petAudio?.readyState} duration=${petAudio?.duration} errorCode=${petAudio?.errorCode}`
  );

  // ---- 断言：右键菜单的「语音包」段随语音包有无整段出现 / 消失 ----
  const menuModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'menu.js')).href
  );
  const sectionModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'menu-dynamic.js')).href
  );
  const menuConfig = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'menu.json'), 'utf8'));

  /** 点菜单项时的动作：与 src/main/index.js 的 playVoicePackToPet 语义一致 */
  let menuClickedPackId = null;
  const playVoiceViaMenu = (id) => {
    const pack = voicePackService.list().find((candidate) => candidate.id === id);
    petWindowRef.webContents.send(channels.PLAY_VOICE, { pack });
    menuClickedPackId = id;
  };

  /** 用真实的 menu.json + 真实的动态段构造器生成菜单模板（只生成不弹出，弹出会阻塞） */
  const buildMenuWith = (getManifest, onForward) => {
    const sections = sectionModule.createMenuDynamicSections({
      voicePackService,
      onPlayVoicePack: playVoiceViaMenu,
      getManifest,
    });
    return menuModule
      .createMenuManager({
        menuConfig,
        actions: {},
        getWindow: () => null,
        resolveDynamic: (name) => sections[name]?.(),
        forwardToRenderer: (item) => onForward?.(item),
      })
      .build();
  };
  const buildMenu = () => buildMenuWith(configModule.loadSkinManifest);

  // ---- 断言：菜单「动作」段（现在是动态段，由皮肤 manifest 决定） ----
  const topLabels = (items) =>
    items.map((item) => (item.type === 'separator' ? '---' : item.label));

  check(
    'menu.json 里不再写死任何动作项（待机 / 眨眼都不在配置里）',
    !JSON.stringify(menuConfig.items).includes('"眨眼"') &&
      !JSON.stringify(menuConfig.items).includes('"待机"') &&
      !menuConfig.items.some((item) => Array.isArray(item.items) &&
        item.items.some((child) => child.id === 'idle' || child.id === 'blink')),
    JSON.stringify(menuConfig.items.map((item) => item.label ?? item.dynamic ?? item.type))
  );
  check(
    '「动作」段已改成动态段占位',
    menuConfig.items.some((item) => item.dynamic === 'actions'),
    JSON.stringify(menuConfig.items.map((item) => item.dynamic ?? item.label))
  );
  const realMenuItems = buildMenu();
  const realActionNode = realMenuItems.find((item) => item.label === '动作');
  check(
    '真实 manifest 下菜单出现「动作」子菜单，收着四个大动作（2026-09-29 入库后不再是空段）',
    topLabels(realMenuItems).includes('动作') &&
      JSON.stringify((realActionNode?.submenu ?? []).map((child) => child.label)) ===
        JSON.stringify(['庆祝', '庆祝2', '跳水', '跳水2']),
    JSON.stringify(topLabels(realMenuItems))
  );

  /**
   * 注入一份带大动作的假 manifest，验"加了动作菜单自动多出来"这条分支 ——
   * 四个真动作只能证明现在这份 manifest 是对的，预留接口本身要靠假数据独立验证。
   */
  const fakeManifest = {
    defaultState: 'idle',
    states: {
      idle: { loop: true },
      blink: { ambient: true },
      celebration: { loop: false, label: '庆祝' },
    },
  };
  const fakeMenuLabels = topLabels(buildMenuWith(() => fakeManifest));
  check(
    '给出带大动作的 manifest 后，菜单自动出现「动作」段（大动作收进子菜单，不占顶层）',
    JSON.stringify(fakeMenuLabels) === JSON.stringify(['设置', '---', '动作', '语音', '---', '退出']),
    JSON.stringify(fakeMenuLabels)
  );

  /**
   * 动作项**故意不带 action 字段**，靠 menu.js 的兜底分发转给渲染层，
   * 由 renderer/menu.js 的 handleMenuAction 按 id 播 manifest 状态。
   * Electron 的菜单模板里不带 id（id 只用于分发），所以这里直接点一下看转发出去的是什么 ——
   * 这也顺带证明"点庆祝真的会走到桌宠"，而不只是菜单长得对。
   * 2026-09-30 起大动作收进「动作」子菜单，要从 submenu 里找再点。
   */
  const forwarded = [];
  const fakeMenu = buildMenuWith(() => fakeManifest, (item) => forwarded.push(item));
  const fakeActionItem = fakeMenu
    .find((item) => item.label === '动作')
    ?.submenu?.find((child) => child.label === '庆祝');
  fakeActionItem?.click();
  check(
    '点「动作」子菜单里的菜单项会按状态 id 转发给渲染层（复用既有播放通道，不新增代码路径）',
    forwarded.length === 1 && forwarded[0].id === 'celebration',
    JSON.stringify(forwarded.map((item) => item.id))
  );

  const voiceSubmenuLabels = () => {
    const submenu = buildMenu().find((item) => item.label === '语音')?.submenu ?? [];
    return submenu.map((item) => (item.type === 'separator' ? '---' : item.label));
  };

  /** 期望出现在菜单里的包名：与动态段用的是同一个过滤条件 */
  const menuPackNames = () =>
    voicePackService.list().filter((pack) => pack.enabled && pack.exists).map((pack) => pack.name);
  const expectedWithPacks = () => ['静音', '---', '音量', '---', '语音包', ...menuPackNames()];

  check(
    '有语音包时「语音」子菜单在音量后列出语音包',
    JSON.stringify(voiceSubmenuLabels()) === JSON.stringify(expectedWithPacks()),
    JSON.stringify(voiceSubmenuLabels())
  );

  // 停用全部语音包 → 该段应整体消失（连分隔线一起，不留悬空分隔线）
  const enabledSnapshot = voicePackService
    .list()
    .map((pack) => ({ id: pack.id, enabled: pack.enabled }));
  for (const pack of voicePackService.list()) {
    voicePackService.setEnabled(pack.id, false);
  }
  check(
    '没有可用语音包时只剩静音与音量（无「语音包（未上线）」）',
    JSON.stringify(voiceSubmenuLabels()) === JSON.stringify(['静音', '---', '音量']),
    JSON.stringify(voiceSubmenuLabels())
  );

  // 还原每一行的启用状态（用户可能本来就停用了某些包）
  for (const item of enabledSnapshot) {
    voicePackService.setEnabled(item.id, item.enabled);
  }
  check(
    '恢复启用状态后语音包段回来',
    JSON.stringify(voiceSubmenuLabels()) === JSON.stringify(expectedWithPacks()),
    JSON.stringify(voiceSubmenuLabels())
  );

  // 点菜单里的包名 → 真的送到桌宠播放（与设置界面试听同一条链路）
  const menuTarget = voicePackService.playable()[0] ?? null;
  const menuSubmenu = buildMenu().find((item) => item.label === '语音')?.submenu ?? [];
  const packItem = menuSubmenu.find((item) => item.label === menuTarget?.name);
  await askPet(`window.__pet?.player?.stop(); 'ok'`);
  await wait(200);
  packItem?.click();
  await wait(900);
  const afterMenuClick = JSON.parse(
    await askPet(`JSON.stringify(window.__pet?.player?.status ?? null)`)
  );
  check(
    '点菜单里的语音包会送到桌宠播放',
    menuClickedPackId === menuTarget?.id &&
      String(afterMenuClick?.currentSrc ?? '').includes(menuTarget?.file ?? '\u0000') &&
      Number(afterMenuClick?.readyState) >= 2,
    `clicked=${menuClickedPackId} src=${afterMenuClick?.currentSrc}`
  );
  await askPet(`window.__pet?.player?.stop(); 'ok'`);

  // —— 断言 6：清理后不再有"只改界面不保存"的占位项 ——
  // 以前这里验证的是「占位项被拒且不碰配置文件」；占位机制已整体移除，
  // 改为断言：界面上每一项都能找到对应的主进程 applier（不存在"点了没反应"的项）。
  const unapplied = await ask(`JSON.stringify(
    window.__settings.items
      .filter((i) => i.control !== 'switchList')
      .map((i) => i.id)
  )`);
  const unappliedList = JSON.parse(unapplied === '<<renderer-timeout>>' ? '[]' : unapplied);
  check(
    '设置项清单非空（清理后仍然有真实可写的项）',
    unappliedList.length >= 8,
    `count=${unappliedList.length}`
  );

  // ---- 断言 8：通用分类的项都已由占位转为真实可写 ----
  const generalIds = ['autoLaunch', 'alwaysOnTop', 'autoDock', 'dragThresholdPx'];
  const generalSchema = JSON.parse(
    await ask(`JSON.stringify(
      window.__settings.items
        .filter((i) => ${JSON.stringify(generalIds)}.includes(i.id))
        .map((i) => ({ id: i.id, control: i.control }))
    )`)
  );
  check(
    '通用四项（开机自启动 / 窗口置顶 / 自动停靠 / 拖拽灵敏度）仍在 schema 里',
    generalSchema.length === 4 && generalSchema.every((item) => Boolean(item.control)),
    JSON.stringify(generalSchema)
  );
  const droppedItems = await ask(`JSON.stringify(
    window.__settings.items
      .filter((i) => ['mousePassthrough', 'minimizeToTray'].includes(i.id))
      .map((i) => i.id)
  )`);
  check('鼠标穿透 / 最小化到托盘已从 schema 中移除', droppedItems === '[]', String(droppedItems));

  await ask(`window.__settings.selectCategory('general')`);
  await wait(350);
  const generalRendered = await ask(
    `JSON.stringify([...document.querySelectorAll('#content [data-item-id]')].map((el) => el.dataset.itemId))`
  );
  check(
    '通用分类渲染出的行与 schema 完全一致（3 行）',
    generalRendered === JSON.stringify(['autoLaunch', 'alwaysOnTop', 'autoDock', 'dragThresholdPx']),
    String(generalRendered)
  );

  // —— 通用 · 开机自启动：系统是真相，配置文件只是镜像 ——
  const launchCommand = [process.execPath, PROJECT_ROOT].join(' ');
  await setItem('autoLaunch', true);
  await wait(450);
  check(
    '开启后系统里登记的是一条完整命令行（exe + 项目根）',
    loginItemFake.value === launchCommand,
    `登记：${loginItemFake.value || '(空)'}`
  );
  check(
    '开启后 config/app.json 已落盘',
    readConfig('app.json').autoLaunch === true,
    JSON.stringify(readConfig('app.json'))
  );
  const launchState = autoLaunchService.read();
  check(
    '回读校验认得出「登记的就是当前这种运行方式」',
    launchState.registered === true && launchState.matchesCurrent === true && launchState.stale === false,
    JSON.stringify(launchState)
  );

  await setItem('autoLaunch', false);
  await wait(450);
  check('关闭后系统里的开机项被清除', loginItemFake.value === '', loginItemFake.value || '(空)');
  check(
    '关闭后 config/app.json 同步落盘',
    readConfig('app.json').autoLaunch === false,
    JSON.stringify(readConfig('app.json'))
  );

  /**
   * 失败路径：写入被静默吃掉（安全软件 / 组策略的常态）。
   * 这条用例真正的价值在**副作用**上 —— 系统没写成，config/app.json 就绝不能被改成 true。
   * 否则界面显示一个骗人的"已开启"，而下次启动的镜像同步又会把它抹掉，
   * 用户永远查不出为什么"开关是开的、重启却没反应"。
   */
  loginItemFake.dropping = true;
  const launchBlocked = await setItem('autoLaunch', true);
  await wait(450);
  loginItemFake.dropping = false;
  check(
    '系统拒收时设置界面返回失败（而不是假装成功）',
    launchBlocked?.ok === false && /拦截|没有接受/.test(String(launchBlocked?.message)),
    JSON.stringify(launchBlocked)
  );
  check(
    '系统拒收时 config/app.json 保持 false（不留假象）',
    readConfig('app.json').autoLaunch === false,
    JSON.stringify(readConfig('app.json'))
  );
  const blockedToast = await ask(`document.querySelector('.toast')?.textContent ?? ''`);
  check(
    '失败原因透到了界面提示里（不是只显示一个 rejected）',
    /拦截|没有接受/.test(String(blockedToast)),
    String(blockedToast)
  );
  const packagedCommand = autoLaunchModule.resolveLoginCommand({
    isPackaged: true,
    execPath: path.join(PROJECT_ROOT, 'dist', 'CamelPet.exe'),
    rootDir: PROJECT_ROOT,
  });
  check(
    '打包后注册的命令行不带项目路径（exe 自带应用路径）',
    packagedCommand.args.length === 0,
    packagedCommand.command
  );

  // —— 通用 · 窗口置顶：改完立刻反映到窗口状态，并且落盘 ——
  await setItem('alwaysOnTop', true);
  await wait(450);
  check('开启窗口置顶后桌宠窗口真的置顶了', petWindowRef.isAlwaysOnTop() === true);
  check(
    '窗口置顶已落盘',
    readConfig('window.json').alwaysOnTop === true,
    JSON.stringify(readConfig('window.json'))
  );
  await setItem('alwaysOnTop', false);
  await wait(450);
  check('关闭窗口置顶后桌宠窗口立即取消置顶（无需重启）', petWindowRef.isAlwaysOnTop() === false);

  // —— 通用 · 拖拽灵敏度：落盘 + 即时下发到桌宠渲染层 ——
  const thresholdBefore = await askPet(`window.__pet?.interaction?.dragThresholdPx ?? null`);
  await setItem('dragThresholdPx', 10);
  await wait(550);
  check(
    '拖拽灵敏度已落盘',
    readConfig('behavior.json').dragThresholdPx === 10,
    JSON.stringify(readConfig('behavior.json'))
  );
  const thresholdAfter = await askPet(`window.__pet?.interaction?.dragThresholdPx ?? null`);
  check(
    '拖拽阈值即时下发到桌宠（广播链路）',
    Number(thresholdAfter) === 10,
    `${thresholdBefore} -> ${thresholdAfter}`
  );
  await setItem('dragThresholdPx', 999);
  await wait(400);
  check(
    '超出上限的阈值被夹到 12（滑块之外的值/手改配置都挡得住）',
    readConfig('behavior.json').dragThresholdPx === 12,
    `传 999 → ${readConfig('behavior.json').dragThresholdPx}`
  );
  await setItem('dragThresholdPx', 'abc');
  await wait(400);
  check(
    '非数字阈值回退到默认 4（不会把配置写成 null）',
    readConfig('behavior.json').dragThresholdPx === 4,
    `传 abc → ${JSON.stringify(readConfig('behavior.json').dragThresholdPx)}`
  );

  // —— 语音 · 音量：NaN 注入必须被拦在落盘前（审查 H3 的防护验证）——
  // 旧实现 voiceVolume 没走 clampNumber：Math.round(NaN)=NaN → JSON null → 读回变 0，
  // 音量会静默归零。这里主动注入反例，验证新防护真的存在
  await setItem('voiceVolume', 'abc');
  await wait(400);
  const volumeAfterNaN = readConfig('voice.json').volume;
  check(
    '非数字音量回退到默认 70（NaN 不会穿透成 null，音量不会静默归零）',
    volumeAfterNaN === 70,
    `传 abc → ${JSON.stringify(volumeAfterNaN)}`
  );
  await setItem('voiceVolume', 250);
  await wait(400);
  check(
    '超出上限的音量被夹到 100（滑块之外的值/手改配置都挡得住）',
    readConfig('voice.json').volume === 100,
    `传 250 → ${readConfig('voice.json').volume}`
  );

  // ---- 断言 7：无渲染层错误 ----
  check('渲染层无 error 级日志', consoleErrors.length === 0, consoleErrors.join(' | '));

  // ---- 截图（通用页 + 含真实控件的语音页） ----
  // ---- 截图（外观页 + 行为页两段 + 语音段） ----
  // 先把定时随机语音打开，好让"开关 + 绑定子控件"的联动效果出现在截图里
  await setItem('voiceRandomEnabled', true);
  await wait(300);

  const dpr = 1.5;
  const shot = async (name) => {
    /**
     * 抓屏是系统级的：抓的是屏幕上真实显示的像素，不是这个窗口的内容。
     *
     * 实测连踩两次：用户在看抖音（全屏窗口盖在上面）时跑验证，
     * isFocused() 依然返回 true —— 键盘焦点状态 ≠ 窗口可见，这个检查根本拦不住，
     * 截出来的"证据"其实是抖音画面（两页不同内容的截图还能 md5 相同）。
     *
     * 所以改为**抓屏期间把窗口临时置顶**，抓完立刻还原。
     * 这么做之后截图是否干净就不再取决于用户此刻在干什么。
     */
    window.setAlwaysOnTop(true);
    window.moveTop();
    window.focus();
    await wait(400);
    grabScreen(
      Math.round(WIN_X * dpr),
      Math.round(WIN_Y * dpr),
      Math.round(WIN_W * dpr),
      Math.round(WIN_H * dpr),
      path.join(OUT_DIR, name)
    );
    window.setAlwaysOnTop(false);
  };

  // 通用分类（本轮刚打通的三项）—— 导航第一项，正好也是用户第一眼看到的一屏
  await ask(`window.__settings.selectCategory('general')`);
  await wait(350);
  await shot('settings-general.png');

  await ask(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent === '外观')?.click()`);
  await wait(300);
  await shot('settings.png');

  await ask(
    `[...document.querySelectorAll('.nav-item')].find((b) => b.textContent === '行为')?.click()`
  );
  await wait(300);
  await shot('settings-behavior.png');
  // 行为分类较长，把「动作管理」整块滚到内容区靠上位置再拍（多开关列表是检查重点）
  await ask(`(() => {
    const content = document.getElementById('content');
    const target = document.querySelector('.item-stacked');
    if (!content || !target) return 'missing';
    content.scrollTop += target.getBoundingClientRect().top - content.getBoundingClientRect().top - 70;
    return 'ok';
  })()`);
  await wait(400);
  await shot('settings-behavior-2.png');

  // 滚到「语音」分组，展示"开关打开后频率子控件出现"的联动
  await ask(`(() => {
    const content = document.getElementById('content');
    const groups = [...document.querySelectorAll('.group-title')];
    const target = groups.find((el) => el.textContent === '语音');
    if (!content || !target) return 'missing';
    content.scrollTop += target.getBoundingClientRect().top - content.getBoundingClientRect().top - 70;
    return 'ok';
  })()`);
  await wait(400);
  await shot('settings-voice.png');

  // 语音包管理整块（列表 + 添加音频入口）
  await ask(`(() => {
    const content = document.getElementById('content');
    const target = document.querySelector('[data-item-id="voicePackManage"]');
    if (!content || !target) return 'missing';
    content.scrollTop += target.getBoundingClientRect().top - content.getBoundingClientRect().top - 80;
    return 'ok';
  })()`);
  await wait(450);
  await shot('settings-voicepacks.png');

  // 「添加音频」对话框：填好内容再拍，方便看清两个字段与浏览入口
  await ask(`window.__settings.openVoiceDialog()`);
  await wait(250);
  await ask(`document.getElementById('voice-name').value = '进球庆祝'`);
  // 填一个真实存在的音频路径，截图更贴近实际使用；没有可用包时退回测试素材
  const samplePack = voicePackService.list().find((pack) => pack.exists);
  await ask(
    `document.getElementById('voice-path').value = ${JSON.stringify(
      samplePack ? voicePackService.absPath(samplePack) : wavPath
    )}`
  );
  await wait(450);
  await shot('settings-voice-dialog.png');
  await ask(`window.__settings.closeVoiceDialog()`);
  await wait(200);

  log(
    '截图已保存 settings-general.png / settings.png / settings-behavior.png / ' +
      'settings-behavior-2.png / settings-voice.png / settings-voicepacks.png / settings-voice-dialog.png'
  );

  // ---- 还原配置 ----
  /**
   * 收尾清扫以「开跑时的目录快照」为准，而不是「从当前清单里推算」。
   *
   * 早先的做法是挑出"基线之外的包"、删它指向的文件 —— 但那条路只在"包还留在清单里"时成立。
   * 测试的删除用例本来就会把探针包从清单里摘掉，于是文件一旦因为任何原因没被连带删掉，
   * 这个洞就永远补不上：清单里已经查无此包，扫描自然扫不到。
   * （实测漏过一次：`assets/audio/` 里躺着一个 `probe-*.wav` 孤儿，而脚本报了 PASS。）
   *
   * 现在：凡是不在快照里、又不被"还原后的清单"引用的文件，一律清掉。
   * 无论文件是谁、在哪一步写出来的都跑不掉；而用户原有素材都在快照里，绝不会被误删。
   */
  const keepFiles = new Set([
    ...baselineAudioFiles,
    ...((originalVoicePacks.packs ?? []) || []).map((pack) => String(pack.file ?? '').toLowerCase()),
  ]);
  const audioDir = path.join(PROJECT_ROOT, 'assets', 'audio');
  for (const name of fs.readdirSync(audioDir)) {
    if (keepFiles.has(name.toLowerCase())) continue;
    fs.unlinkSync(path.join(audioDir, name));
    log(`清理测试残留音频：assets/audio/${name}`);
  }

  saveConfig(['skin.json'], originalSkin);
  saveConfig(['voice.json'], originalVoice);
  saveConfig(['window.json'], originalWindow);
  saveConfig(['dialogue.json'], originalDialogue);
  saveConfig(['behavior.json'], originalBehavior);
  saveConfig(['voicepacks.json'], originalVoicePacks);
  saveConfig(['app.json'], originalApp);
  fs.rmSync(path.join(PROJECT_ROOT, 'temp', 'voice-fixture'), { recursive: true, force: true });
  log(
    `配置已还原：skin=${JSON.stringify(readConfig('skin.json'))} ` +
      `dialogue.bubbleDurationMs=${readConfig('dialogue.json').bubbleDurationMs} ` +
      `behavior.dragThresholdPx=${readConfig('behavior.json').dragThresholdPx} ` +
      `app=${JSON.stringify(readConfig('app.json'))} ` +
      `voicepacks=${readConfig('voicepacks.json').packs?.length ?? 0} 个`
  );

  /**
   * 收尾自检：跑完必须和开跑前一模一样。
   * 有这一步，"漏文件"才会当场炸出来，而不是等某天发现目录里堆了一串没人认领的 probe-*.wav。
   */
  const leftover = fs
    .readdirSync(audioDir)
    .filter((name) => !baselineAudioFiles.has(name.toLowerCase()));
  check(
    '本次运行没有在 assets/audio 留下多余文件',
    leftover.length === 0,
    leftover.length ? JSON.stringify(leftover) : `快照 ${baselineAudioFiles.size} 个文件，全部对齐`
  );

  petWindow.destroy();
  window.destroy();
  clearTimeout(watchdog);

  log(
    failures.length === 0
      ? `结果: PASS（共 ${total} 项断言）`
      : `结果: FAIL（${failures.length}/${total} 项失败：${failures.join(' / ')}）`
  );
  app.exit(failures.length === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error('设置窗口验证失败：', error);
    app.exit(1);
  })
);
