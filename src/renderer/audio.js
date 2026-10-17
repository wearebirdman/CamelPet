/**
 * 语音播放器（桌宠窗口）。
 *
 * 只做三件事：维护一份"可播语音包"列表、把静音/音量翻译成 <audio> 的属性、
 * 播放时保证不叠音。触发时机（单击 / 定时随机 / 设置里试听）由外部决定。
 *
 * 复用同一个 <audio> 元素而不是每次 new Audio()：连续触发时旧元素没人持有引用，
 * 既可能继续出声也可能一直挂着不释放。
 *
 * 音量约定：配置里是 0~100 的整数（设置界面滑块），这里换算成 0~1。
 */

/** 静音/音量未知时的兜底（配置缺失时不至于完全没声） */
const DEFAULT_VOLUME = 70;

export function createAudioPlayer({ petAPI = globalThis.petAPI } = {}) {
  const element = new Audio();
  element.preload = 'auto';

  /** 0~100 */
  let volume = DEFAULT_VOLUME;
  let muted = false;
  /** 当前可播列表（enabled 且文件存在），由主进程清单同步而来 */
  let packs = [];

  const toGain = () => Math.max(0, Math.min(1, volume / 100));

  function applyGain() {
    element.volume = toGain();
  }
  applyGain();

  return {
    /**
     * 播放指定语音包。
     * @param {{url?: string, name?: string}|null} pack
     * @returns {boolean} 是否真的开始播放（静音/无 URL 时返回 false）
     */
    play(pack) {
      if (muted || !pack?.url) {
        // 早退前先把元素清干净：否则上一首的 src 一直挂在元素上，
        // 资源释放不掉（Windows 上会一直占着文件句柄，删除语音包就删不动）
        this.stop();
        return false;
      }
      try {
        element.pause();
        element.src = pack.url;
        applyGain();
        // play() 返回 Promise：自动播放策略、解码失败等都会走 reject，
        // 这里必须吞掉，否则渲染层控制台会冒未捕获异常
        const started = element.play();
        started?.catch((error) => {
          console.warn('[audio] 播放失败：', pack.name, error?.message ?? error);
        });
        return true;
      } catch (error) {
        console.warn('[audio] 播放异常：', error?.message ?? error);
        return false;
      }
    },

    /** 随机播一个可播语音包；没有可用包时返回 false */
    playRandom() {
      const usable = packs.filter((pack) => pack.enabled !== false && pack.url);
      if (usable.length === 0) {
        return false;
      }
      return this.play(usable[Math.floor(Math.random() * usable.length)]);
    },

    stop() {
      try {
        element.pause();
        element.removeAttribute('src');
        // 只有 load() 能把 readyState 归 0 并真正释放资源句柄：
        // 实测 removeAttribute 只清属性，readyState 停在 4、currentSrc 仍指旧文件，
        // 元素继续持有文件 → 删除语音包会被占用，只能靠上层 300ms 重试兜底。
        element.load();
      } catch (_) {
        /* ignore */
      }
    },

    /**
     * 拉取最新语音包清单（添加/删除/启停后主进程会广播，那时也需要刷新）。
     * @returns {Promise<Array>}
     */
    async refresh() {
      try {
        const list = await petAPI?.getVoicePacks?.();
        if (Array.isArray(list)) {
          packs = list;
        }
      } catch (error) {
        console.warn('[audio] 读取语音包失败：', error?.message ?? error);
      }
      return packs;
    },

    /** 直接注入清单（VOICE_PACKS_CHANGED 广播里带的就是完整清单，省一次 IPC） */
    setPacks(list) {
      if (Array.isArray(list)) {
        packs = list;
      }
      /**
       * 元素上还挂着已被删除/停用的音频就主动摘掉。
       *
       * 否则 `currentSrc` 会一直指着已经不存在的文件：我们自己的状态检查
       * （readyState / error / duration）会读到上一个包的数据，看起来像"删掉的包还在"。
       * 本模块是唯一持有旧资源引用的地方，删除后的残留就出在这里。
       */
      if (element.src && !packs.some((pack) => pack.url && pack.url === element.src)) {
        this.stop();
      }
    },

    /** 试听之前先确保清单是最新的（避免刚添加完点试听却找不到） */
    async playById(id) {
      await this.refresh();
      const pack = packs.find((candidate) => candidate.id === id);
      return this.play(pack ?? null);
    },

    /** @param {number} next 0~100 */
    setVolume(next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) {
        volume = Math.max(0, Math.min(100, Math.round(parsed)));
        applyGain();
      }
    },

    setMuted(next) {
      muted = Boolean(next);
      if (muted) {
        this.stop();
      }
    },

    /** 调试/验证用：当前可播数量与状态 */
    get status() {
      return {
        muted,
        volume,
        gain: toGain(),
        // 播放器内部记的 gain 只是"算出来的期望值"，真正决定响度的是元素上的 volume。
        // 排查"调了音量却没变化"这类问题时，必须能看到元素的实际取值：
        // 浏览器会把越界值夹到 [0,1] 并可能静默忽略非法赋值，只看 gain 会得出错误结论。
        elementVolume: element.volume,
        elementMuted: element.muted,
        total: packs.length,
        playable: packs.filter((pack) => pack.enabled !== false && pack.url).length,
        // 判"真的在播"用 readyState ≥ 3（HAVE_FUTURE_DATA）：
        // 刚设完 src 时 currentTime 还是 0，用 currentTime > 0 会误判"未播"
        playing: !element.paused && !element.ended && element.readyState >= 3,
        // 注意 currentSrc 在 load() 后仍会保留旧 URL 字符串（Chromium 行为，规范允许），
        // 只是过期字符串、不代表还持有资源 —— readyState=0 时如实报空，免得调试时被误导
        currentSrc: element.readyState === 0 ? '' : element.currentSrc || element.src || '',
        // readyState ≥ 2 (HAVE_CURRENT_DATA) 说明资源真的加载并解码成功了，
        // 不只是"设置了 src" —— 验证脚本用它区分「链路通了」和「只是没报错」
        readyState: element.readyState,
        duration: Number.isFinite(element.duration) ? element.duration : 0,
        paused: element.paused,
        errorCode: element.error?.code ?? null,
      };
    },
  };
}
