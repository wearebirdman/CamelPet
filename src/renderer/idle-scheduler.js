/**
 * 待机动作插播器。
 *
 * 职责单一：待机期间每隔一段**随机**时间，从"待机动作池"里挑一个插播；
 * 动作本身非循环（manifest 里 `loop: false`），播完由动画控制器自动回落 idle。
 *
 * 术语（重要，别按旧名字理解）：
 *   - 这里插播的是**待机动作**（manifest 里 `ambient: true` 的状态，目前只有"眨眼"），
 *     它是**待机状态自身的组成部分**，不是"一个动作" —— 所以它不出现在动作菜单 /
 *     「动作管理」里，用户感知到的只是"待机时会偶尔眨个眼"。
 *   - 普通"大动作"（庆祝、siuuu 之类）不走这里，由单击 / 定时随机 / 菜单触发。
 *   分类判定统一走 shared/action-catalog.js，不要在本文件里另写一套。
 *
 * 节奏由设置里的「待机动作频率」控制（off / 低 8~15 秒 / 中 3~7 秒 / 高 1~3 秒）。
 * 用户可拖值实时改档，所以档位是可变状态，由 setFrequency() 更新。
 *
 * 动作池完全由 manifest 驱动：状态加 `ambient: true` 即入池，本文件零改动。
 *
 * 让路规则：触发时若桌宠不在 idle（正在播放大动作 / 被菜单指定动作），
 * 直接跳过本次并重新排时 —— 大动作的优先级永远高于待机动作。
 */
import {
  DEFAULT_IDLE_FREQUENCY,
  IDLE_ACTION_FREQUENCIES,
} from '../shared/constants.js';
import { listIdleActions } from '../shared/action-catalog.js';

export function createIdleScheduler({ animation, manifest, frequency = DEFAULT_IDLE_FREQUENCY }) {
  const defaultStateId = manifest.defaultState || 'idle';
  /** @type {string[]} manifest 里标记了 ambient 的状态 id = 待机动作池 */
  const idleActionStates = listIdleActions(manifest);

  /** 当前档位；非法档位一律回退默认，避免配置写错导致永远不插播或一秒插十次 */
  let currentFrequency = Object.prototype.hasOwnProperty.call(IDLE_ACTION_FREQUENCIES, frequency)
    ? frequency
    : DEFAULT_IDLE_FREQUENCY;

  let timer = null;

  /** 当前档位对应的间隔区间；off 档返回 null */
  function delayRange() {
    return IDLE_ACTION_FREQUENCIES[currentFrequency] ?? null;
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function fire() {
    schedule(); // 先排下一次：即使这次没触发，节奏也不断
    if (animation.currentState !== defaultStateId) {
      return; // 正在播放其他动作（大动作/菜单指定），让路
    }
    if (idleActionStates.length === 0) {
      return;
    }
    animation.playState(pick(idleActionStates));
  }

  function schedule() {
    stop();
    const range = delayRange();
    if (!range) {
      return; // off 档：不排时，调度器彻底安静（而不是排一个永不触发的定时器）
    }
    const delay = range[0] + Math.random() * (range[1] - range[0]);
    timer = setTimeout(fire, delay);
  }

  function stop() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * 切换频率档位（设置界面「待机动作频率」即时生效）。
   * 改档后立刻按新节奏重排一次 —— 否则要等上一轮旧延迟走完才生效，
   * 用户拖完滑块会觉得"没反应"。
   * @param {unknown} next 档位 id（off / low / medium / high）
   */
  function setFrequency(next) {
    const normalized = Object.prototype.hasOwnProperty.call(IDLE_ACTION_FREQUENCIES, next)
      ? String(next)
      : DEFAULT_IDLE_FREQUENCY;
    if (normalized === currentFrequency) {
      return;
    }
    currentFrequency = normalized;
    schedule();
  }

  // 不自动排时：与 voice-scheduler 保持同一约定，由调用方在动画就绪后显式 schedule()，
  // 免得定时器在桌宠还没开始播放时就先跑起来。

  return {
    schedule,
    stop,
    setFrequency,
    /** 当前档位（调试/验证用） */
    get frequency() {
      return currentFrequency;
    },
    /** 当前档位对应的间隔区间，off 档为 null（调试/验证用） */
    get delayRange() {
      return delayRange();
    },
    /** 待机动作池（调试/验证用）：现在是 ['blink'] 这类 */
    get idleActions() {
      return [...idleActionStates];
    },
  };
}
