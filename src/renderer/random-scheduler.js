/**
 * 分钟级「定时随机触发」调度器（通用版）。
 *
 * 与 idle-scheduler（秒级待机插播）、voice-scheduler（随机语音）是同一个节奏模型，
 * 差别只在触发时干什么 —— 由 onFire 注入：
 *   - 定时随机对话：onFire = 从台词池挑一句进气泡
 *   - 定时随机动作：onFire = 待机时挑一个大动作播
 *
 * 档位与设置界面的「随机频率」下拉一致（'1-3' / '3-6' / '6-10' 分钟），
 * 与主进程 RANDOM_INTERVAL_CHOICES / voice.json 的 randomInterval 同一套取值。
 *
 * API 形状刻意与 voice-scheduler 完全一致（schedule / stop / triggerNow /
 * setEnabled / setInterval / status），验证脚本可以用同一套手法驱动。
 */

const INTERVAL_SECONDS = {
  '1-3': [60, 180],
  '3-6': [180, 360],
  '6-10': [360, 600],
};
const DEFAULT_INTERVAL = '3-6';

/**
 * @param {object} options
 * @param {boolean} [options.enabled=false]
 * @param {'1-3'|'3-6'|'6-10'} [options.interval]
 * @param {() => boolean} [options.onFire] 触发时干什么；返回是否真的触发了
 *        （池子为空 / 让路等情况下返回 false，节奏照常继续）
 */
export function createRandomScheduler({ enabled = false, interval = DEFAULT_INTERVAL, onFire } = {}) {
  let active = Boolean(enabled);
  let current = INTERVAL_SECONDS[interval] ? interval : DEFAULT_INTERVAL;
  let timer = null;

  const rangeMs = () => {
    const [min, max] = INTERVAL_SECONDS[current] ?? INTERVAL_SECONDS[DEFAULT_INTERVAL];
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
      return; // 关着就不排时：不挂"永不触发"的定时器
    }
    const [min, max] = rangeMs();
    const delay = min + Math.random() * (max - min);
    timer = setTimeout(fire, delay);
  }

  function fire() {
    schedule(); // 先排下一次，保证节奏不受本次是否真的触发影响
    if (!active) {
      return false;
    }
    try {
      return Boolean(onFire?.());
    } catch (error) {
      console.error('[random-scheduler] 触发回调异常：', error);
      return false;
    }
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
      const value = INTERVAL_SECONDS[String(next)] ? String(next) : DEFAULT_INTERVAL;
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
