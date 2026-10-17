/**
 * 定时随机语音调度器。
 *
 * 与 idle-scheduler（待机小动作）的区别：那个是几秒级的插播，这个是**分钟级**的
 * "偶尔叫一声"。频率档位与设置界面「随机语音频率」的三个选项一一对应。
 *
 * 关于打断：语音包的长度上限是 30 秒（`MAX_AUDIO_SECONDS`，导入时校验），
 * 而最快档位是 1 分钟，所以理论上不会出现"上一句还没播完又开一句"。这里仍然加一道保险 ——
 * 触发时若检测到正在播放就跳过本次（宁可少叫一次，也不要叠音）。
 */
const INTERVAL_SECONDS = {
  '1-3': [60, 180],
  '3-6': [180, 360],
  '6-10': [360, 600],
};
const DEFAULT_INTERVAL = '3-6';
/** 档位非法时回退到的档位，与 settings.json 的 default 保持一致 */
const FALLBACK_INTERVAL = DEFAULT_INTERVAL;

export function createVoiceScheduler({ player, enabled = false, interval = DEFAULT_INTERVAL }) {
  let active = Boolean(enabled);
  let current = INTERVAL_SECONDS[interval] ? interval : FALLBACK_INTERVAL;
  let timer = null;

  const rangeMs = () => {
    const [min, max] = INTERVAL_SECONDS[current] ?? INTERVAL_SECONDS[FALLBACK_INTERVAL];
    return [min * 1000, max * 1000];
  };

  function stop() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule() {
    stop();
    if (!active) {
      return;
    }
    const [min, max] = rangeMs();
    const delay = min + Math.random() * (max - min);
    timer = setTimeout(fire, delay);
  }

  function fire() {
    schedule(); // 先排下一次，保证节奏不受本次是否真的出声影响
    if (!active) {
      return false;
    }
    if (player?.status?.playing) {
      return false; // 正在播放，本次让路
    }
    return Boolean(player?.playRandom());
  }

  return {
    schedule,
    stop,
    /** 立即触发一次（调试 / 验证用，避免真等几分钟） */
    triggerNow: fire,
    /** @param {boolean} next */
    setEnabled(next) {
      const value = Boolean(next);
      if (value === active) {
        return;
      }
      active = value;
      if (active) {
        schedule();
      } else {
        stop();
      }
    },
    /** @param {'1-3'|'3-6'|'6-10'} next */
    setInterval(next) {
      const value = INTERVAL_SECONDS[String(next)] ? String(next) : FALLBACK_INTERVAL;
      if (value === current) {
        return;
      }
      current = value;
      if (active) {
        schedule(); // 换档立即按新档重新排时，不必等旧定时器走完
      }
    },
    get status() {
      return { enabled: active, interval: current, scheduled: timer !== null };
    },
  };
}
