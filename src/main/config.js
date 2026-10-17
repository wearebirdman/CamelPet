/**
 * 配置加载与路径解析。所有运行时配置都以 JSON 形式维护。
 *
 * ## 两个根目录（打包后的可写性所迫，2026-10-11）
 *
 *   - **APP_ROOT = `ROOT_DIR`**：应用包根。开发态就是仓库根；打包后位于 `app.asar` 内部，
 *     **只读**（asar 是只读归档，往里写必然失败）。皮肤素材、图标、菜单/窗口等只读配置住这里。
 *   - **DATA_ROOT = `getDataRoot()`**：**可写**数据根。开发态**等于 APP_ROOT** ——
 *     于是开发态的一切行为与改造前逐字节一致，9 套回归基线一个都不受影响；
 *     打包态指向 `%APPDATA%/<应用名>/data`，装在 Program Files 里也照样能写。
 *
 * 读写规则（照这个来，别混）：
 *   - **读**：先 DATA_ROOT，读不到再回落 APP_ROOT。打包后首次运行用户目录还是空的，
 *     读到的是包内的出厂默认值；用户改过之后就以用户那份为准。
 *   - **写**：只走 DATA_ROOT。写包内必然失败。
 *
 * 另外 `seedUserData()` 会在打包态首次运行时把包内的**可写默认数据**播种到 DATA_ROOT
 * （只补缺、绝不覆盖），这样语音包这类"清单 + 音频文件"的成对数据不会出现
 * "清单在用户目录、音频还在包里"的错位。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_SKIN_ID } from '../shared/constants.js';

/** 应用包根目录（src/main/config.js → 上溯两级）。打包后位于 app.asar 内，只读。 */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 皮肤配置文件名（记录当前皮肤与精灵尺寸档位） */
const SKIN_CONFIG_FILE = 'skin.json';

/**
 * **只读 schema 白名单**：应用自带的"结构定义"，用户改不了，也绝不能被用户目录里的一份盖住。
 *
 * 为什么必须显式列出来（这是"数据根优先"读法的唯一致命坑）：
 *   settings.json 是设置界面的 schema、menu.json 是菜单结构，两者都**随版本升级而变**。
 *   如果它们被播种到用户目录并优先命中，用户升级后就永远看不到新增的设置项/菜单项
 *   ——升级了却"界面没变"，且没有任何报错，极难排查。所以这两个永远只从包内读。
 * 相应地，seedUserData() 也不播种它们。
 */
const READONLY_CONFIG_FILES = new Set(['settings.json', 'menu.json']);

/** 可写数据根。默认等于包根（开发态）；打包态由 setupDataRoot() 改指 userData。 */
let dataRoot = ROOT_DIR;

/**
 * 把相对**包根**的路径片段拼成绝对路径（只读资源用：素材、图标、源码）。
 * @param {...string} segments
 * @returns {string}
 */
export function resolveFromRoot(...segments) {
  return path.join(ROOT_DIR, ...segments);
}

/**
 * 解析**只读资源**在磁盘上真实可读的位置。
 *
 * 打包后 `assets/icons/**` 被 asarUnpack 到了 `app.asar.unpacked/`，
 * 而 `resolveFromRoot()` 给的是 `app.asar/...` 这个"逻辑路径"。
 * Electron 的 fs 层会做重定向，但 **nativeImage.createFromPath / BrowserWindow icon
 * 这类原生接口不做**——传 asar 路径会得到一张空图，托盘图标就会"创建了但看不见"。
 *
 * 所以这里优先返回 unpacked 下的真实文件；开发态或没有 unpacked 时原样返回。
 * @param {...string} segments
 * @returns {string}
 */
export function resolveReadable(...segments) {
  const packedPath = resolveFromRoot(...segments);
  const sep = path.sep;
  const marker = `${sep}app.asar${sep}`;
  if (!packedPath.includes(marker)) {
    return packedPath; // 开发态：本来就在真实目录里
  }
  const unpackedPath = packedPath.replace(marker, `${sep}app.asar.unpacked${sep}`);
  try {
    return fs.existsSync(unpackedPath) ? unpackedPath : packedPath;
  } catch (_) {
    return packedPath;
  }
}

/**
 * 把相对**可写数据根**的路径片段拼成绝对路径（用户可改的配置与数据用）。
 * 开发态与 resolveFromRoot 等价。
 * @param {...string} segments
 * @returns {string}
 */
export function resolveFromData(...segments) {
  return path.join(dataRoot, ...segments);
}

/** 当前可写数据根的绝对路径 */
export function getDataRoot() {
  return dataRoot;
}

/** 数据根是否已与包根分离（打包态 true；开发态 false） */
export function hasSeparateDataRoot() {
  return dataRoot !== ROOT_DIR;
}

/**
 * 直接指定可写数据根。传空/非法值退回包根。
 * 一般不用直接调，走 setupDataRoot()。
 * @param {string} [dir]
 * @returns {string} 生效后的数据根
 */
export function setDataRoot(dir) {
  dataRoot = typeof dir === 'string' && dir.trim() ? path.resolve(dir) : ROOT_DIR;
  return dataRoot;
}

/**
 * 按运行形态决定数据根，并播种出厂默认数据。
 *
 * 抽成一个纯函数（不直接读 electron 的 app）是为了让验证脚本能在不启动 Electron 的
 * 前提下复现"可写数据与包分离"这条链路 —— 见 tools/userdata-check.js。
 *
 * @param {object} options
 * @param {boolean} options.packaged 是否打包运行（app.isPackaged）
 * @param {string} [options.userDataDir] 打包态的用户数据目录（app.getPath('userData')）
 * @param {string} [options.override] 显式覆盖（验证用，优先级最高）
 * @returns {{dataRoot: string, separate: boolean, copied: number}}
 */
export function setupDataRoot({ packaged, userDataDir, override } = {}) {
  const target = override || (packaged && userDataDir ? path.join(userDataDir, 'data') : null);
  setDataRoot(target);
  return { dataRoot, separate: hasSeparateDataRoot(), copied: seedUserData() };
}

/**
 * config/ 下某文件的候选路径：可写根优先、包内兜底。
 * 开发态两者是同一路径，只留一条（行为与改造前完全一致）。
 * 只读 schema（settings.json / menu.json）只有包内一条 —— 见 READONLY_CONFIG_FILES。
 */
function configCandidates(segments) {
  const inPackage = resolveFromRoot('config', ...segments);
  if (READONLY_CONFIG_FILES.has(segments.join('/'))) {
    return [inPackage];
  }
  const inData = resolveFromData('config', ...segments);
  return inData === inPackage ? [inData] : [inData, inPackage];
}

/**
 * 读取 config/ 下的 JSON 配置。
 *
 * 可写根优先、包内兜底：打包后首次运行用户目录还没有这份配置，读到的是出厂默认值。
 * 两份都没有时抛出（与改造前"文件不存在就抛"的语义一致，调用方用 loadConfigOrDefault 兜）。
 * @param {...string} segments 相对 config/ 的路径片段，如 loadConfig('window.json')
 * @returns {any}
 */
export function loadConfig(...segments) {
  let lastError = null;
  for (const file of configCandidates(segments)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      lastError = error;
      if (error.code !== 'ENOENT') {
        throw error; // 文件在但内容坏了：与改造前一致，直接抛给上层
      }
    }
  }
  throw lastError;
}

/** 读取配置，失败时返回默认值（用于可选配置） */
export function loadConfigOrDefault(fallback, ...segments) {
  try {
    return loadConfig(...segments);
  } catch (error) {
    return fallback;
  }
}

/** 读取皮肤配置（当前皮肤 id、精灵尺寸档位） */
export function loadSkinConfig() {
  return loadConfigOrDefault({}, SKIN_CONFIG_FILE);
}

/**
 * 读取当前皮肤的 manifest。
 *
 * 为什么主进程也要读它：右键菜单的「动作」段要按 manifest 里声明的状态动态生成
 * （动作是随皮肤走的，不能在 menu.json 里写死），而菜单结构由主进程构建。
 *
 * 读失败返回 `{ states: {} }` 而不是抛错：manifest 读不到时菜单少一段是小事，
 * 让整个主进程起不来是大事。
 * @returns {object} 皮肤 manifest
 */
export function loadSkinManifest() {
  const skinId = loadSkinConfig().activeSkin || DEFAULT_SKIN_ID;
  try {
    return JSON.parse(
      fs.readFileSync(resolveFromRoot('assets', 'skins', skinId, 'manifest.json'), 'utf8')
    );
  } catch (error) {
    console.error('[config] 读取皮肤 manifest 失败：', skinId, error.message);
    return { states: {} };
  }
}

/**
 * 扫描 assets/skins/ 下所有"有 manifest.json 的目录"，不做任何过滤。
 *
 * 这是唯一一处目录枚举逻辑：`listSkins()`（给界面的列表）与 `seedUserData()`
 * （出厂数据播种）都基于它。
 * **不能只让界面用的那份去播种** —— hidden 皮肤（回归测试用的 sample-camel）
 * 同样需要把自带台词/语音播到用户数据目录，否则测试和全新安装都会缺数据。
 *
 * @returns {Array<{id: string, label: string, hidden: boolean}>}
 */
function readSkinManifests() {
  const dir = resolveFromRoot('assets', 'skins');
  const skins = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    console.error('[config] 读取皮肤目录失败：', dir, error.message);
    return skins;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const id = entry.name;
    if (!fs.existsSync(path.join(dir, id, 'manifest.json'))) {
      continue;
    }
    let label = id;
    let hidden = false;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8'));
      hidden = manifest.hidden === true;
      // 展示名优先取 manifest.name（与皮肤自身的写法一致），再退 label，最后退 id
      const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
      const alias = typeof manifest.label === 'string' ? manifest.label.trim() : '';
      label = name || alias || id;
    } catch (_) {
      /* manifest 坏了就只显示 id，列表本身不该因此中断 */
    }
    skins.push({ id, label, hidden });
  }
  return skins;
}

/**
 * 列出可用皮肤（设置界面「皮肤」下拉的选项）。
 *
 * 一个目录算一套皮肤 = 里面有 manifest.json。目录名就是皮肤 id。
 * 读不到 skins 目录时回落到默认皮肤（配置写错了也不会让设置界面开天窗）。
 *
 * manifest 里标了 `hidden: true` 的目录不进这个列表：仓库里的 sample-camel 是
 * 脚本回归用的数据样本，不该出现在用户的「皮肤」下拉里。
 * 它仍会被 resolveSkinId、seedUserData 等按目录枚举的路径正常处理。
 * @returns {Array<{id: string, label: string}>}
 */
export function listSkins() {
  const skins = readSkinManifests()
    .filter((skin) => !skin.hidden)
    .map(({ id, label }) => ({ id, label }));
  return skins.length ? skins : [{ id: DEFAULT_SKIN_ID, label: DEFAULT_SKIN_ID }];
}

/**
 * 取皮肤 id（配置的 activeSkin，非法则回落默认）。
 * @param {string} [skinId] 不传就读当前配置
 */
export function resolveSkinId(skinId) {
  const configured = skinId ?? loadSkinConfig().activeSkin;
  if (typeof configured === 'string' && configured.trim()
      && fs.existsSync(resolveFromRoot('assets', 'skins', configured, 'manifest.json'))) {
    return configured;
  }
  return DEFAULT_SKIN_ID;
}

/**
 * 取皮肤目录下的资源路径（**读**用）；皮肤没有自带该资源时**回落到全局**。
 *
 * 为什么是"皮肤优先 + 全局回落"而不是强制皮肤自带：
 *   现有这套 default 皮肤的台词/语音包都在 config/ 与 assets/audio/ 下，
 *   强制自带等于要迁移一遍（破坏现有测试与数据）。回落让旧布局继续可用，
 *   新皮肤想自带台词/语音/音频时，在自己目录里放同名文件即可，代码不用改。
 *
 * 候选顺序：可写数据根下的皮肤目录 → 包内的皮肤目录 → 全局（音频目录 / config/）。
 * 开发态前两者是同一路径，整体行为与改造前完全一致。
 *
 * @param {string} skinId
 * @param {'dialogue.json'|'voicepacks.json'|'audio'} asset
 * @returns {string} 绝对路径
 */
export function resolveSkinAsset(skinId, asset) {
  const id = resolveSkinId(skinId);
  for (const local of [
    resolveFromData('assets', 'skins', id, asset),
    resolveFromRoot('assets', 'skins', id, asset),
  ]) {
    if (fs.existsSync(local)) {
      return local;
    }
  }
  return asset === 'audio' ? globalAudioDir() : resolveFromData('config', asset);
}

/**
 * 取某个"可写资源"在当前皮肤下的**落盘位置** —— 一定在可写数据根下。
 *
 * 为什么读和写要分开两个函数：读可以回落到只读的包内，写不行（asar 拒写）。
 * 语义与 resolveSkinAsset 保持一致：皮肤自带该资源（包里或数据根里有）→ 皮肤级，
 * 否则落到全局的 config/ 或 assets/audio/。判断"自带"时**要连包内那份一起看**，
 * 否则打包后 default 皮肤会误判成"没自带台词"，把本来该写进皮肤目录的东西写到全局去。
 *
 * @param {string} skinId
 * @param {'dialogue.json'|'voicepacks.json'|'audio'} asset
 * @returns {string} 绝对路径（在可写数据根下，可能尚不存在）
 */
function resolveWritableSkinAsset(skinId, asset) {
  const id = resolveSkinId(skinId);
  const inData = resolveFromData('assets', 'skins', id, asset);
  if (fs.existsSync(inData) || fs.existsSync(resolveFromRoot('assets', 'skins', id, asset))) {
    return inData;
  }
  return asset === 'audio' ? globalAudioDir() : resolveFromData('config', asset);
}

/** 全局音频目录（可写根下） */
function globalAudioDir() {
  return resolveFromData('assets', 'audio');
}

/**
 * 通用 JSON 写入（指定绝对路径）：读现有 → 深合并 → 原子落盘。
 * 与 saveConfig 的区别只是路径来源：那个固定落在 config/ 下，这个给皮肤级配置用
 * （皮肤自带的 dialogue.json 在 assets/skins/<id>/ 下）。
 */
export function saveJsonFile(file, patch) {
  const merged = mergeDeep(readJsonSafe(file), patch);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return merged;
}

/** 读取任意 JSON 文件，不存在/损坏时返回空对象（与 readConfigSafe 同策略） */
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch (_) { /* 备份失败不阻断 */ }
      console.error('[config] 配置损坏，已备份并重建：', file, error.message);
    }
    return {};
  }
}

/**
 * 写当前皮肤的台词配置（dialogue.json）。
 * default 皮肤没有自带 dialogue.json → 落到 config/dialogue.json，与旧行为完全一致。
 * 落盘位置一定在可写数据根下（打包后包内是只读的）。
 */
export function saveSkinDialogue(patch, skinId) {
  return saveJsonFile(resolveWritableSkinAsset(skinId, 'dialogue.json'), patch);
}

/** 当前皮肤的语音包路径（供 voicepacks 服务每次现算；读写都在可写数据根下） */
export function resolveVoicePaths(skinId) {
  return {
    audioDir: resolveWritableSkinAsset(skinId, 'audio'),
    packsPath: resolveWritableSkinAsset(skinId, 'voicepacks.json'),
  };
}

/**
 * 设置界面「读配置」的统一入口，与写侧 saveByFile / saveSkinDialogue 用同一套解析。
 *
 * 为什么需要它：台词（dialogue.json）是**皮肤级**的 —— 写侧走 saveSkinDialogue
 * （当前皮肤自带就写皮肤的），读侧如果还固定读 config/dialogue.json，就会出现
 * 「改动能保存、重开设置又弹回旧值」的读写不一致：换到自带 dialogue.json 的皮肤
 * （如 sample-camel）后，设置页的台词池/气泡时长显示的永远是上一套的值。
 * 其余配置文件都是全局的，行为与之前完全一致。
 * @param {string} file 配置文件名（settings.json 各项 source.file 的取值）
 * @returns {object}
 */
export function loadSettingsSourceFile(file) {
  if (file === 'dialogue.json') {
    try {
      return JSON.parse(fs.readFileSync(resolveSkinAsset(undefined, 'dialogue.json'), 'utf8'));
    } catch (error) {
      return {}; // 皮肤级台词缺失/损坏时按空配置处理，各项回落 schema default
    }
  }
  return loadConfigOrDefault({}, file);
}

/**
 * 切换当前皮肤并落盘。
 * 只写 activeSkin；尺寸档位不动（素材尺寸由各皮肤自己的 availableSizes 决定）。
 * @param {string} skinId
 * @returns {{ok: boolean, skinId: string, reason?: string}}
 */
export function saveActiveSkin(skinId) {
  const candidates = listSkins();
  const wanted = String(skinId ?? '').trim();
  if (!candidates.some((candidate) => candidate.id === wanted)) {
    return { ok: false, skinId: resolveSkinId(), reason: 'unknown-skin' };
  }
  saveConfig(['skin.json'], { activeSkin: wanted });
  return { ok: true, skinId: wanted };
}

/**
 * 递归深合并：补丁只覆盖显式给出的键，其余原样保留。
 * 数组按整体替换（配置里的数组都是"整份列表"，没有按下标合并的语义）。
 */
function mergeDeep(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch;
  }
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? mergeDeep(out[key], value)
      : value;
  }
  return out;
}

/**
 * 读取配置；文件不存在或内容损坏时返回空对象（损坏的文件会被备份，便于事后排查）。
 *
 * 可写根优先、包内兜底（与 loadConfig 同一套候选顺序）：
 * 打包后首次运行用户目录还没有这份配置，读的是包内的出厂默认值，
 * 于是"读现有 → 合并补丁"不会把出厂默认整体丢掉。
 * @param {string[]} segments 相对 config/ 的路径片段
 */
function readConfigSafe(segments) {
  for (const file of configCandidates(segments)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      // 文件损坏：备份后继续尝试下一个候选（都没了才从空对象重建），
      // 避免整个应用因为一份坏配置而卡死
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch (_) {
        /* 备份失败不阻断，下面仍按空对象继续 */
      }
      console.error('[config] 配置损坏，已备份并重建：', file, error.message);
    }
  }
  return {};
}

/**
 * 通用配置写入：读现有 → 深合并补丁 → 原子落盘。
 * 写入走 "临时文件 + rename" 而非直接覆盖，避免进程中断时留下半截 JSON。
 *
 * **只写可写数据根**：打包后 config/ 在 app.asar 里，是只读的。
 * @param {string[]} segments 相对 config/ 的路径片段，如 ['window.json']
 * @param {object} patch 要合并的补丁（只写指定键）
 * @returns {object} 合并后的完整配置
 */
export function saveConfig(segments, patch) {
  const file = resolveFromData('config', ...segments);
  const merged = mergeDeep(readConfigSafe(segments), patch);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  // 可写根可能是刚建出来的空目录（用户删过/首次运行没播种成功），先补齐目录
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return merged;
}

/**
 * 更新皮肤配置中的精灵尺寸档位并落盘（下次启动生效）。
 * 只改 spriteSize，其余键原样保留。
 * @param {number} size
 */
export function saveSpriteSize(size) {
  return saveConfig([SKIN_CONFIG_FILE], { spriteSize: size });
}

/**
 * 把包内的**可写默认数据**播种到可写数据根。
 *
 * 播什么：
 *   - `config/` 下**除只读 schema 外**的全部文件（settings.json / menu.json 不播，
 *     否则升级后新增的设置项会被用户目录里的旧 schema 挡住 —— 见 READONLY_CONFIG_FILES）；
 *   - `assets/audio/*` —— 全局语音素材（自带的那几个 wav）；
 *   - 各皮肤目录下的 `dialogue.json` / `voicepacks.json` / `audio/*`。
 * 不播什么：`sprites/` 与 `manifest.json` —— 那是只读素材（本案 60 MB 级），
 * 留在包里由 asar 直接读，一来省空间，二来装完就能跑不用先等一次几百兆的拷贝。
 *
 * 为什么非要播种（光靠"读回落包内"不够）：
 *   语音包是"清单 + 音频文件"的**成对**数据。清单若落在数据根、音频还在包里，
 *   `decorate()` 的 `exists` 检查就会false → 自带语音包在界面上显示成"文件已丢失"。
 *   播一遍让两者同处一个根，路径解析只有一条规则，没有特例。
 *
 * 只补缺、**绝不覆盖**：升级安装后用户改过的配置必须原样保留。
 * 拷贝失败只打日志不抛 —— 播不动最多是"回到出厂默认"，不该让桌宠起不来。
 *
 * @returns {number} 播种的文件数（0 表示无需播种或没播到）
 */
export function seedUserData() {
  if (!hasSeparateDataRoot()) {
    return 0; // 开发态：数据根就是包根，本来就是同一份文件，无需播种
  }
  let copied = 0;
  const seed = (source, target) => {
    try {
      copied += copyMissing(source, target);
    } catch (error) {
      console.error('[config] 播种默认数据失败（忽略）：', source, error.message);
    }
  };

  // 1) config/ 下**除只读 schema 外**的全部条目（用户可改的设置）
  const configSource = resolveFromRoot('config');
  const configTarget = resolveFromData('config');
  let entries = [];
  try {
    entries = fs.readdirSync(configSource, { withFileTypes: true });
  } catch (error) {
    console.error('[config] 读取出厂配置目录失败：', configSource, error.message);
  }
  for (const entry of entries) {
    if (READONLY_CONFIG_FILES.has(entry.name)) {
      continue; // schema 只认包内那份，播一份旧的过去反而会盖住升级
    }
    seed(path.join(configSource, entry.name), path.join(configTarget, entry.name));
  }

  // 2) 全局语音素材 + 3) 皮肤级的可写数据（清单与音频必须同处一个根，否则会互相找不到）
  seed(resolveFromRoot('assets', 'audio'), resolveFromData('assets', 'audio'));
  for (const skin of readSkinManifests()) {
    for (const asset of ['dialogue.json', 'voicepacks.json', 'audio']) {
      seed(
        resolveFromRoot('assets', 'skins', skin.id, asset),
        resolveFromData('assets', 'skins', skin.id, asset)
      );
    }
  }
  return copied;
}

/**
 * 递归把 source 里**目标不存在**的文件/目录复制到 target。
 * 已存在的目标一律不动（用户数据优先）。
 * @returns {number} 复制的文件数
 */
function copyMissing(source, target) {
  let stat;
  try {
    stat = fs.statSync(source);
  } catch (_) {
    return 0; // 源不存在（比如该皮肤没自带台词）→ 无事可做
  }
  if (stat.isDirectory()) {
    let copied = 0;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copied += copyMissing(path.join(source, entry.name), path.join(target, entry.name));
    }
    return copied;
  }
  if (fs.existsSync(target)) {
    return 0;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.copyFileSync(source, target);
  } catch (error) {
    /**
     * 打包态 source 在 app.asar 里，而 Electron 的 asar 层不支持 copyFileSync
     * （会报 ENOENT: config\config\xxx.json not found in ...app.asar）。
     * 这会让整个"出厂数据播种"静默失败：配置与自带语音包都播不过去，
     * 全新安装时语音包会显示成"文件已丢失"。退回"读出来再写"即可。
     */
    if (error.code !== 'ENOENT') {
      throw error;
    }
    fs.writeFileSync(target, fs.readFileSync(source));
  }
  return 1;
}
