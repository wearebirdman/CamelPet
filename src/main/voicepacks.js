/**
 * 语音包服务。
 *
 * 数据模型（config/voicepacks.json）：
 *   { "packs": [{ id, name, file, source, addedAt, enabled }] }
 *   - `file` 是 assets/audio/ 下的**文件名**，不是绝对路径 —— 项目整体拷走后仍然有效。
 *   - `source` 只作来源备查（用户当初选了哪个文件），不参与播放。
 *
 * 新增音频采用**复制入库**而不是引用任意路径：桌宠换机器、用户挪动或删除原始文件，
 * 语音包都不会失效。这也是「存入」在语义上更贴近的做法。
 *
 * 对外只暴露纯 Node 能力（不 import electron），这样服务本身可以单独测；
 * 选文件对话框那种 GUI 动作留在 ipc.js 里做。
 * 音频目录与清单路径都可在构造时注入，便于测试在临时目录里跑，不碰真实数据。
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { MAX_AUDIO_SECONDS } from '../shared/constants.js';
import { resolveFromRoot } from './config.js';
import { logError } from './logger.js';

const PACKS_FILE = 'voicepacks.json';
const AUDIO_DIR = resolveFromRoot('assets', 'audio');
const PACKS_PATH = resolveFromRoot('config', PACKS_FILE);

/** 只接受浏览器能直接播的容器格式（Chromium 支持这几种） */
const ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];

/** 单包上限：时长上限已经卡在 30 秒（未压缩 WAV 约 1.9MB），20MB 是防呆的体积兜底 */
const MAX_BYTES = 20 * 1024 * 1024;

const MAX_NAME_LENGTH = 24;
const MAX_PACKS = 50;

/** 删除失败后的重试延迟（ms）：留给渲染层释放文件句柄的时间，详见 remove() 的注释 */
const UNLINK_RETRY_MS = 300;

/**
 * 从 WAV 字节里读出格式与时长。
 *
 * 解析 RIFF 块而不是按"固定 44 字节头"读：合法 WAV 在 fmt 之前可以有
 * LIST/INFO 等附加块，固定偏移会把采样率读成别的值（进而把时长算错）。
 *
 * @returns {{sampleRate: number, channels: number, bits: number, duration: number}|null}
 */
function readWavInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    return null;
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataLength = Math.min(size, Math.max(0, buffer.length - body));
    }
    // 块长度按偶数字节对齐（奇数长度块后有 1 字节填充）
    offset = body + size + (size % 2);
  }
  const bytesPerSecond = sampleRate * channels * (bits / 8);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return null;
  }
  return { sampleRate, channels, bits, duration: dataLength / bytesPerSecond };
}

/** 读取原始清单（文件缺失或损坏一律当空清单，绝不让坏配置卡死应用） */
function readPacksFrom(packsPath) {
  try {
    const raw = fs.readFileSync(packsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.packs) ? parsed.packs : [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logError('read-voicepacks', error);
    }
    return [];
  }
}

/** 原子落盘：先写临时文件再改名，避免进程中断留下半截 JSON */
function writePacksTo(packsPath, packs) {
  // 临时名带 pid + 随机串：固定名在多写者/上次残留时会互相截断，原子性退化（审查 M5）
  const tmp = `${packsPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.mkdirSync(path.dirname(packsPath), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify({ packs }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, packsPath);
}

/**
 * 由名称派生一个安全 id。
 * 中文名要保留（用户就是要用中文命名），但路径分隔符、控制字符必须挡掉 ——
 * id 会直接当文件名用，混进 `..` 或 `/` 就能写到目录外面去。
 */
function slugify(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|]/g, '') // Windows 非法文件名字符
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\.+$/, '') // 结尾的点在 Windows 上会被静默吞掉
    .trim();
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/**
 * 生成不与现有 id 冲突的唯一 id。
 *
 * 比较**必须忽略大小写**：文件名由 id 派生，而 Windows / macOS 的文件系统不区分大小写，
 * 于是 "SIUUU" 与 "siuuu" 会落到同一个文件上 —— 后添加的包直接把前一个包的音频覆盖掉，
 * 两个包从此播同一个声音，删掉其中一个还会连带删掉另一个正在用的文件（实测踩过）。
 */
function uniqueId(base, taken) {
  const seed = base || 'voice';
  const lower = new Set([...taken].map((id) => String(id).toLowerCase()));
  if (!lower.has(seed.toLowerCase())) {
    return seed;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${seed}-${index}`;
    if (!lower.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${seed}-${Date.now().toString(36)}`;
}

/**
 * 已被占用的文件名集合（小写）。
 * id 唯一并不等于文件名唯一 —— 清单可以被手工编辑，这里再兜一层，
 * 保证任何情况下都不会有两条记录指向同一个音频文件。
 */
function takenFileNames(packs) {
  return new Set(packs.map((pack) => String(pack.file ?? '').toLowerCase()));
}

function safeStat(absPath) {
  try {
    return fs.statSync(absPath).size;
  } catch (_) {
    return 0;
  }
}

export function createVoicePackService({
  /**
   * 路径解析回调：**每次操作前现算**，而不是构造时固定。
   * 语音包是随皮肤走的（换皮肤 = 换一套清单与音频），构造时定死路径会导致
   * 换完皮肤还在读写上一套皮肤的数据。缺省回落到全局的 config/voicepacks.json
   * + assets/audio/（皮肤没自带语音包时的行为，与换皮肤功能之前完全一致）。
   */
  /**
   * 显式指定目录与清单路径（测试注入 / 固定场景用）。
   * **优先级低于 resolvePaths**：后者是"按当前皮肤现算"，是换皮肤功能的主路径；
   * 这里保留是为了不破坏既有的注入式测试（voicepack-test 传的就是这一对）。
   */
  audioDir,
  packsPath,
  resolvePaths,
  /**
   * 删除文件的实现，可注入。
   * 存在的理由：unlink 失败（被占用/权限/安全软件拦截）是一条**必须验证**的分支，
   * 而在真实磁盘上制造"删不掉"要依赖平台与权限（Windows 只读可失败、POSIX 未必），
   * 测试里注入一个必然抛错的实现才是稳定的验证方式。
   */
  unlink = (target) => fs.unlinkSync(target),
} = {}) {
  /** 现算当前皮肤（或全局回落）的音频目录与清单路径 */
  const paths = () => {
    const bySkin = typeof resolvePaths === 'function' ? resolvePaths() : null;
    return {
      audioDir: bySkin?.audioDir || audioDir || AUDIO_DIR,
      packsPath: bySkin?.packsPath || packsPath || PACKS_PATH,
    };
  };
  const readPacks = () => readPacksFrom(paths().packsPath);
  const writePacks = (packs) => writePacksTo(paths().packsPath, packs);

  /** 补全为播放/界面可用的形态 */
  const decorate = (pack) => {
    const file = String(pack.file ?? '');
    const absPath = path.join(paths().audioDir, file);
    const exists = Boolean(file) && fs.existsSync(absPath);
    return {
      id: pack.id,
      name: pack.name,
      file,
      enabled: pack.enabled !== false,
      source: pack.source ?? '',
      addedAt: pack.addedAt ?? '',
      /** 导入时是否做过响度归一化（没做过就说明是直接复制的原始文件） */
      optimized: pack.optimized === true,
      exists,
      /** 供渲染层直接喂给 <audio>；文件不存在时给空串，播放端据此跳过 */
      url: exists ? pathToFileURL(absPath).href : '',
      /** 文件体积（字节），文件不存在时为 0 */
      bytes: exists ? safeStat(absPath) : 0,
    };
  };

  /** 清单一律以磁盘为准，不在这里缓存 —— 用户可能手改 JSON，缓存会造成两处不一致 */
  const readAll = () => readPacks().map(decorate);

  return {
    /** 全部语音包（含文件是否存在、可播 URL） */
    list() {
      return readAll();
    },

    /** 只取启用且文件确实存在的包 —— 播放端用这个 */
    playable() {
      return readAll().filter((pack) => pack.enabled && pack.exists);
    },

    /** 对应的绝对路径（主进程侧用，如需要） */
    absPath(pack) {
      return path.join(paths().audioDir, pack.file);
    },

    /**
     * 添加语音包：把音频复制进 assets/audio/ 并登记。
     *
     * `bytes` 是渲染层做完响度处理后回传的成品（单声道 WAV）。给了它就写它，
     * 没给就原样复制源文件 —— 后者是降级路径（比如浏览器解不开这种编码），
     * 保证"处理失败"不会变成"加不进来"。
     *
     * @param {{name?: string, src?: string, bytes?: ArrayBuffer, ext?: string, duration?: number}} input
     *        `duration` 是渲染层解码后测得的时长（秒），作为成品 WAV 头之外的第二来源
     * @returns {{ok: true, pack: object} | {ok: false, reason: string, message: string}}
     */
    add({ name, src, bytes, ext, duration } = {}) {
      const label = String(name ?? '').trim();
      if (!label) {
        return { ok: false, reason: 'empty-name', message: '请填写语音包名称' };
      }
      if (label.length > MAX_NAME_LENGTH) {
        return { ok: false, reason: 'name-too-long', message: `名称请控制在 ${MAX_NAME_LENGTH} 个字以内` };
      }

      const source = String(src ?? '').trim();
      if (!source) {
        return { ok: false, reason: 'empty-src', message: '请选择音频文件' };
      }

      let stat;
      try {
        stat = fs.statSync(source);
      } catch (_) {
        return { ok: false, reason: 'src-missing', message: '找不到该音频文件，请重新选择' };
      }
      if (!stat.isFile()) {
        return { ok: false, reason: 'src-not-file', message: '请选择一个音频文件而不是文件夹' };
      }

      const sourceExt = path.extname(source).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(sourceExt)) {
        return {
          ok: false,
          reason: 'bad-format',
          message: `不支持的格式 ${sourceExt || '（无扩展名）'}，请用 ${ALLOWED_EXTENSIONS.join(' / ')}`,
        };
      }
      if (stat.size > MAX_BYTES) {
        return {
          ok: false,
          reason: 'too-large',
          message: `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_BYTES / 1024 / 1024}MB 上限`,
        };
      }

      /**
       * 处理后的成品。体积要单独再校验一次 —— 归一化会转成未压缩的 WAV，
       * 比原 mp3 大好几倍，源文件没超限不代表成品也没超。
       */
      const optimized = bytes ? Buffer.from(bytes) : null;
      if (optimized && optimized.length > MAX_BYTES) {
        return {
          ok: false,
          reason: 'too-large',
          message: `优化后的音频 ${(optimized.length / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_BYTES / 1024 / 1024}MB 上限`,
        };
      }
      const targetExt = optimized ? String(ext ?? '.wav').toLowerCase() : sourceExt;

      /**
       * 时长守门。
       *
       * 两个来源按可信度排序：① 即将落盘的成品 WAV 头（最可信，直接算字节）
       * ② 渲染层解码后回传的 duration。两者都拿不到时（原样复制的降级路径）
       * 只剩体积上限兜底 —— 那种情况下主进程拿不到时长信息，这是已知的能力边界。
       *
       * 为什么必须在这里再拦一次：渲染层的校验会被"处理失败→原样导入"的降级路径绕过，
       * 而界面校验更是随便就能跳过。**真正的守门人必须是不受界面影响的那一层。**
       */
      const wavInfo = optimized ? readWavInfo(optimized) : null;
      /**
       * 降级路径（原样复制）拿不到渲染层的时长，但如果源本身就是 WAV，
       * 主进程可以直接读它的头 —— 这类文件最容易超长（未压缩、体积大）。
       */
      let sourceWavInfo = null;
      if (!optimized && sourceExt === '.wav') {
        try {
          sourceWavInfo = readWavInfo(fs.readFileSync(source));
        } catch (error) {
          logError('read-source-wav', error);
        }
      }
      const measured =
        wavInfo?.duration ??
        sourceWavInfo?.duration ??
        (Number.isFinite(Number(duration)) ? Number(duration) : null);
      if (measured !== null && measured > MAX_AUDIO_SECONDS) {
        return {
          ok: false,
          reason: 'too-long',
          message: `音频时长 ${measured.toFixed(1)} 秒，超过 ${MAX_AUDIO_SECONDS} 秒上限，请裁剪后再导入`,
        };
      }

      const packs = readPacks();
      if (packs.length >= MAX_PACKS) {
        return { ok: false, reason: 'too-many', message: `最多 ${MAX_PACKS} 个语音包` };
      }

      /**
       * 名称必须唯一。
       * 语音包在右键菜单里是**靠名字认的** —— 早先允许同名（内部 id 自动加序号），
       * 结果菜单里并排出现三个一模一样的「喊一句」，用户根本分不清哪个是哪个。
       * 比较忽略大小写与首尾空白：用户视角里 "SIUUU" 和 "siuuu" 就是同一个名字。
       */
      const wanted = label.toLowerCase();
      const conflict = packs.find(
        (pack) => String(pack.name ?? '').trim().toLowerCase() === wanted
      );
      if (conflict) {
        return {
          ok: false,
          reason: 'duplicate-name',
          message: `已存在同名语音包「${conflict.name}」，请换个名字`,
        };
      }

      // 下面这套 id / 文件名去重保留着当兜底：清单一律以磁盘为准，可能被手工编辑过
      const taken = new Set(packs.map((pack) => String(pack.id)));
      const id = uniqueId(slugify(label), taken);

      // 文件名一律小写：这样"文件系统不区分大小写"从隐患变成前提，
      // 不会再有 SIUUU.mp3 覆盖 siuuu.mp3 这种事
      const base = id.toLowerCase();
      let fileName = `${base}${targetExt}`;
      const used = takenFileNames(packs);
      for (let suffix = 2; used.has(fileName); suffix += 1) {
        fileName = `${base}-${suffix}${targetExt}`;
      }
      const target = path.join(paths().audioDir, fileName);

      try {
        fs.mkdirSync(paths().audioDir, { recursive: true });
        if (optimized) {
          fs.writeFileSync(target, optimized);
        } else if (path.resolve(source) !== path.resolve(target)) {
          // 源文件已经在素材目录里且目标就是它自己 → 不需要复制，直接登记
          fs.copyFileSync(source, target);
        }
      } catch (error) {
        logError('copy-voicepack', error);
        return { ok: false, reason: 'copy-failed', message: '写入音频到素材目录失败' };
      }

      const pack = {
        id,
        name: label,
        file: fileName,
        source,
        addedAt: new Date().toISOString(),
        enabled: true,
        /** 是否经过导入处理（响度归一化 + 噪声门）。界面上用来区分素材来源 */
        optimized: Boolean(optimized),
      };
      writePacks([...packs, pack]);
      return { ok: true, pack: decorate(pack) };
    },

    /**
     * 删除语音包。同时删掉复制进来的音频文件 —— 那个文件本来就是本服务创建的，
     * 留着只会变成永远没人引用的垃圾。用户原始文件不受影响。
     */
    remove(id) {
      const packs = readPacks();
      const index = packs.findIndex((pack) => String(pack.id) === String(id));
      if (index === -1) {
        return { ok: false, reason: 'not-found', message: '语音包不存在' };
      }
      const [removed] = packs.splice(index, 1);
      writePacks(packs);

      const file = path.join(paths().audioDir, String(removed.file ?? ''));
      // 还有别的包指着同一个文件时绝不能删 —— 否则那个包会立刻变成"文件已丢失"。
      // 比较同样忽略大小写：老数据里存在两个包共用一份文件的情况。
      const stillReferenced = packs.some(
        (pack) => String(pack.file ?? '').toLowerCase() === String(removed.file ?? '').toLowerCase()
      );
      let fileRemoved = false;
      let unlinkError = null;
      let retryScheduled = false;
      let inDir = false;
      let existsOnDisk = false;
      if (removed.file) {
        inDir = path.dirname(path.resolve(file)) === path.resolve(paths().audioDir);
        try {
          existsOnDisk = fs.existsSync(file);
        } catch (_) {
          existsOnDisk = false;
        }
      }
      // 双保险：只删素材目录内的文件，且确实存在
      if (removed.file && !stillReferenced && inDir && existsOnDisk) {
        try {
          unlink(file);
          fileRemoved = true;
        } catch (error) {
          logError('unlink-voicepack', error);
          unlinkError = error.message;
          /**
           * 删不掉时排一次延迟重试。
           *
           * 失败十有八九是"文件正被占用"——Windows 不允许删除已打开的文件，
           * 而桌宠的 `<audio>` 元素此刻可能还挂在这个文件上（用户常是刚试听完就删）。
           *
           * 关键在于**时序**：本函数返回后，IPC 层立刻广播"清单已变"，
           * 渲染层收到后会 stop() 从而释放句柄。所以等一步再删，绝大多数情况就能删干净。
           * 旧实现只写一条日志就返回成功，用户看到"已删除"、文件却永久留在磁盘上。
           */
          retryScheduled = true;
          setTimeout(() => {
            try {
              unlink(file);
              console.info(`[voicepacks] 重试删除成功：${path.basename(file)}`);
            } catch (retryError) {
              logError('unlink-voicepack-retry', retryError);
            }
          }, UNLINK_RETRY_MS);
        }
      }
      /**
       * 文件没删掉**绝不能静默返回成功**。
       *
       * 包已经从清单摘掉，界面上再也看不到它 —— 这时文件若还留在磁盘上，
       * 就成了一份"没有记录、也没人知道它存在"的残留（即"删了包但文件还在"）。
       * 清单更新成功与文件删除成功是两件事，必须分开如实回报。
       */
      /**
       * keptReason 把"文件为什么还在"说清楚（审查 M3）：
       * 界面据此区分"有意保留"（共用 / 不在素材目录）与"想删没删掉"（占用），
       * 这两种情况给用户的提示应该完全不同。
       */
      let keptReason = null;
      let warning;
      if (fileRemoved) {
        keptReason = null; // 删干净了，没有"保留"一说
      } else if (stillReferenced) {
        keptReason = 'shared';
        warning = `已删除「${removed.name}」，音频文件被其他语音包共用，已保留`;
      } else if (!removed.file) {
        keptReason = 'no-file'; // 记录本身没挂文件，无从删起
      } else if (!existsOnDisk) {
        keptReason = 'missing'; // 文件本来就不在磁盘上（可能早被手动删了），无残留
      } else if (!inDir) {
        keptReason = 'out-of-dir';
        warning = `已删除「${removed.name}」，音频文件不在素材目录内，未自动删除`;
      } else {
        // 走到这里 = inDir && exists && !shared && !fileRemoved → unlink 失败
        keptReason = 'unlink-failed';
        warning = `音频文件当时被占用，已在后台自动重试删除（${unlinkError}）`;
      }
      return {
        ok: true,
        id: removed.id,
        /** 文件此刻仍留在磁盘上（unlink-failed 时重试可能稍后成功） */
        fileKept: Boolean(keptReason === 'shared' || keptReason === 'out-of-dir' || keptReason === 'unlink-failed'),
        keptReason,
        fileRemoved,
        retryScheduled,
        warning,
      };
    },

    /**
     * 列出素材目录里**没有被任何清单记录引用**的音频文件（孤儿）。
     *
     * 存在的意义：删除动作可能失败（文件被占用、权限、安全软件拦截），
     * 而那一刻清单已经更新，这个文件就再也不会被任何界面提到 —— 只能靠扫描发现。
     * 也用于验证脚本断言"删除后目录里不留残余"。
     *
     * 只报告、不删除：素材目录里的文件也可能是用户自己放进去的，
     * 是否清理由调用方决定（删除属于不可逆操作）。
     *
     * @returns {Array<{file: string, bytes: number}>}
     */
    listOrphans() {
      const referenced = new Set(
        readPacks()
          .map((pack) => String(pack.file ?? '').toLowerCase())
          .filter(Boolean)
      );
      let entries = [];
      try {
        entries = fs.readdirSync(paths().audioDir);
      } catch (_) {
        return [];
      }
      return entries
        .filter((name) => !name.startsWith('.'))
        .filter((name) => !referenced.has(name.toLowerCase()))
        .filter((name) => {
          try {
            return fs.statSync(path.join(paths().audioDir, name)).isFile();
          } catch (_) {
            return false;
          }
        })
        .map((name) => ({ file: name, bytes: safeStat(path.join(paths().audioDir, name)) }));
    },

    /** 启用 / 停用（停用的包不参与随机播放，但保留在列表里） */
    setEnabled(id, enabled) {
      const packs = readPacks();
      const pack = packs.find((candidate) => String(candidate.id) === String(id));
      if (!pack) {
        return { ok: false, reason: 'not-found', message: '语音包不存在' };
      }
      pack.enabled = Boolean(enabled);
      writePacks(packs);
      return { ok: true, id: pack.id, enabled: pack.enabled };
    },
  };
}

export { AUDIO_DIR, ALLOWED_EXTENSIONS, MAX_PACKS, MAX_NAME_LENGTH, readWavInfo };
