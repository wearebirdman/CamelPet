/**
 * 开机自启动模块。
 *
 * 这是唯一一项「真相存在于应用之外」的设置：值写在操作系统的登录项里
 * （Windows 是 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 下的一个字符串值），
 * config/app.json 只是它的镜像。由此带来三个必须处理的问题，也正是本模块存在的理由：
 *
 * 1. 开发态必须显式给参数。
 *    未打包时 process.execPath 是 node_modules 里的 electron.exe，它自己不知道要跑哪个项目。
 *    直接把 exe 注册进去，开机时 Electron 会拿默认工作目录当应用，弹出一个空白窗口 ——
 *    现象很像"桌宠启动失败"，很难联想到是开机项写错了。必须把项目根目录作为第一个参数
 *    一起注册（等价于命令行 `electron.exe <项目根>`）。
 *
 * 2. 写完必须回读校验。
 *    setLoginItemSettings 在部分机器上会被安全软件或组策略静默拦掉 —— 不抛错、也不生效。
 *    只信"调用没报错"就会得到"开关是开的、重启后却没反应"这种最难查的故障。
 *
 * 3. 必须可注入。
 *    验证脚本每跑一次就会往真实注册表写一条开机项，绝不能有这种副作用。
 *    所有 Electron 依赖都从构造参数进来，测试传假实现即可，真实注册表一个字节都不碰。
 *
 * 不 import electron，保持纯 Node 可测。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 目前只支持 Windows：项目本身就是 Windows 桌宠，macOS 的登录项语义完全不同（不分 exe/args） */
const SUPPORTED_PLATFORMS = new Set(['win32']);

/** 开机项所在的注册表位置（Electron 写的就是这里） */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/**
 * 诊断"为什么开机项没写进去"。
 *
 * Electron 的 setLoginItemSettings 失败时**不抛错也不返回**，只靠回读是分不清
 * "没权限"和"被安全软件针对本程序拦截"的。这里直接拿 reg.exe 试写一个临时值。
 *
 * 注意**不能直接回显 reg.exe 的 stderr**：它在中文系统上输出 GBK，
 * 塞进 JSON 再显示出来就是一串 ?????（实测踩过）。这里按退出码转成固定文案。
 *
 * @returns {string|null} 失败原因；能写则返回 null
 */
function diagnoseRunKey() {
  const probeName = 'CamelPetStartupProbe';
  try {
    execFileSync('reg', ['add', RUN_KEY, '/v', probeName, '/t', 'REG_SZ', '/d', 'probe', '/f'], {
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (error) {
    // ERROR_ACCESS_DENIED = 5；其余情况按"被策略拦截"处理，避免把乱码抛给用户
    const code = error?.status;
    if (code === 1 || code === 5) {
      return '当前进程无权写入注册表（HKCU\\...\\Run 被拒绝）';
    }
    return '注册表写入被系统拒绝';
  }
  try {
    execFileSync('reg', ['delete', RUN_KEY, '/v', probeName, '/f'], { stdio: 'pipe', windowsHide: true });
  } catch (_) {
    /* 清理失败不影响结论 */
  }
  return null;
}

/**
 * 启动文件夹里的兜底启动项路径。
 *
 * 当 HKCU\Run 被策略/权限挡住时，往「启动」文件夹放一个 .cmd 往往仍然可行
 * （受限企业环境常见：注册表冻结但用户目录可写）。内容只是一行 start。
 * @param {string} [fileName]
 */
function startupFolderFile(fileName = 'CamelPet.cmd') {
  const appData = process.env.APPDATA || '';
  if (!appData) {
    return null;
  }
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', fileName);
}

/**
 * 写/删启动文件夹里的兜底项。
 * @param {boolean} enable
 * @param {string} entry 要启动的可执行文件
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function setStartupFolderItem(enable, entry) {
  const file = startupFolderFile();
  if (!file) {
    return { ok: false, reason: '找不到启动文件夹' };
  }
  try {
    if (enable) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `@echo off\r\nstart "" "${entry}"\r\n`, 'utf8');
      return { ok: true };
    }
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.code || error?.message || '未知错误' };
  }
}


/** 命令里带的路径可能含空格，按 Windows 命令行习惯加双引号，便于比对与排查 */
function quoteIfNeeded(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/**
 * 推导"开机时该怎么启动我们"。
 *
 * 打包后必须指向**启动器**（同目录的 CamelPet.exe），不能指向 CamelPetCore.exe：
 * 核心进程直接启动会跳过"沙箱初始化失败自动降级"的自检，在受限机器上开机就是
 * 一闪而过 —— 用户只会看到"开机自启没反应"。
 *
 * @param {object} options
 * @param {boolean} options.isPackaged 是否已打包（app.isPackaged）
 * @param {string} options.execPath 可执行文件路径（process.execPath）
 * @param {string} options.rootDir 项目根目录（仅开发态需要）
 * @returns {{path: string, args: string[], command: string}}
 */
export function resolveLoginCommand({ isPackaged, execPath, rootDir }) {
  if (isPackaged) {
    const dir = path.dirname(execPath);
    const launcher = path.join(dir, 'CamelPet.exe');
    let entry = execPath;
    try {
      if (launcher !== execPath && fs.existsSync(launcher)) {
        entry = launcher;
      }
    } catch (_) {
      /* 判断失败就用 core 自己 */
    }
    return { path: entry, args: [], command: entry };
  }
  const args = [rootDir];
  return {
    path: execPath,
    args,
    command: [execPath, ...args].map(quoteIfNeeded).join(' '),
  };
}

/**
 * 创建开机自启动控制器。
 * @param {object} options
 * @param {import('electron').App} options.electronApp 必须提供 get/setLoginItemSettings
 * @param {string} options.rootDir 项目根目录（开发态注册时要带上）
 * @param {string} [options.execPath] 可执行文件路径，默认 process.execPath
 * @param {string} [options.platform] 平台，默认 process.platform（测试用）
 * @returns {{
 *   supported: boolean,
 *   read: () => {supported: boolean, registered: boolean, matchesCurrent: boolean, stale: boolean, command: string},
 *   set: (enabled: unknown) => {ok: boolean, value?: boolean, message?: string, warning?: string},
 *   currentCommand: () => {path: string, args: string[], command: string},
 * }}
 */
export function createAutoLaunch({
  electronApp,
  rootDir,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (!electronApp || typeof electronApp.setLoginItemSettings !== 'function') {
    throw new Error('createAutoLaunch 需要一个提供了登录项 API 的 app 对象');
  }
  if (!rootDir || typeof rootDir !== 'string') {
    throw new Error('createAutoLaunch 需要项目根目录（开发态注册开机项必须带上）');
  }

  const supported = SUPPORTED_PLATFORMS.has(platform);

  /** 每次现算，避免把 isPackaged 的旧值缓存住 */
  function currentCommand() {
    return resolveLoginCommand({
      isPackaged: Boolean(electronApp.isPackaged),
      execPath,
      rootDir,
    });
  }

  /**
   * 读系统里的真实状态。两次查询各有用途，缺一不可：
   *
   * - 带上我们的 path+args 查：登记的那条是否**就是当前这种运行方式**。
   *   Windows 上 openAtLogin 会比较 args。
   * - 不带参数查：系统里**有没有**本应用的开机项（executableWillLaunchAtLogin 忽略 args）。
   *   开发态我们登记的 args = [项目根]，而不带参数查时 args = []，两者不等 ——
   *   只看第一次查询会把好好的开机项误判成"没登记"，进而把一次成功的写入报成失败。
   */
  function read() {
    if (!supported) {
      return { supported: false, registered: false, matchesCurrent: false, stale: false, command: '' };
    }
    const command = currentCommand();
    let specific = {};
    let any = {};
    try {
      specific = electronApp.getLoginItemSettings({ path: command.path, args: command.args }) ?? {};
    } catch (error) {
      console.error('[auto-launch] 读取登录项（带参数）失败：', error?.message ?? error);
    }
    try {
      any = electronApp.getLoginItemSettings() ?? {};
    } catch (error) {
      console.error('[auto-launch] 读取登录项失败：', error?.message ?? error);
    }

    const matchesCurrent = Boolean(specific.openAtLogin);
    // 启动文件夹里的兜底项同样算"已登记"：只看注册表会让开关在兜底模式下显示成关着
    let fallbackRegistered = false;
    try {
      const file = startupFolderFile();
      fallbackRegistered = Boolean(file && fs.existsSync(file));
    } catch (_) {
      fallbackRegistered = false;
    }
    const registered = Boolean(
      specific.openAtLogin || any.executableWillLaunchAtLogin || any.openAtLogin || fallbackRegistered
    );
    return {
      supported: true,
      registered,
      matchesCurrent: matchesCurrent || fallbackRegistered,
      /** 登记了开机项，但命令行跟当前运行方式对不上（以前留下的旧项之类） */
      stale: registered && !matchesCurrent && !fallbackRegistered,
      command: command.command,
    };
  }

  /**
   * 写入开机项，并**回读校验**后才算成功。
   * @param {unknown} enabled
   * @returns {{ok: true, value: boolean, warning?: string} | {ok: false, message: string}}
   */
  function set(enabled) {
    if (!supported) {
      return { ok: false, message: `当前系统（${platform}）暂不支持开机自启动设置` };
    }
    const flag = Boolean(enabled);
    const command = currentCommand();

    try {
      electronApp.setLoginItemSettings({
        openAtLogin: flag,
        path: command.path,
        args: command.args,
      });
    } catch (error) {
      return { ok: false, message: `写入开机项失败：${error?.message ?? String(error)}` };
    }

    // 回读校验。安全软件 / 组策略会把写入静默吃掉，不校验就查不出"开关开着但重启没反应"。
    const state = read();
    if (flag && !state.registered) {
      // 注册表被拒时改用「启动」文件夹——受限环境里这条往往还能走通
      const reason = diagnoseRunKey();
      const fallback = setStartupFolderItem(true, command.path);
      if (fallback.ok) {
        return {
          ok: true,
          value: true,
          warning: `注册表开机项被系统拒绝（${reason ?? '未知原因'}），已改用「启动」文件夹方式，开机仍会启动`,
        };
      }
      return {
        ok: false,
        message: `系统没有接受开机项：${reason ?? '写入被拦截'}；启动文件夹也不可写（${fallback.reason}）`,
      };
    }
    if (!flag && state.registered) {
      // 关掉时把兜底项一起清掉，否则会出现"关了但开机还启动"
      setStartupFolderItem(false, command.path);
      if (read().registered) {
        return { ok: false, message: '开机项没有被清除（可能被安全软件或组策略锁定）' };
      }
      return { ok: true, value: false };
    }
    if (flag && !state.matchesCurrent) {
      // 登记是登记上了，但命令行跟我们刚写的对不上 —— 重启后大概率不生效。
      // 不判失败：各版本 Electron 对 args 的比对口径不完全一致，直接拒会让用户彻底打不开这个开关；
      // 但必须把话说清楚，不能静默放过。
      return {
        ok: true,
        value: true,
        warning: `开机项已登记，但命令行与当前运行方式不一致（${state.command}），重启后可能不生效`,
      };
    }
    return { ok: true, value: flag };
  }

  return { supported, read, set, currentCommand };
}
