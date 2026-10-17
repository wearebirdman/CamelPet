/**
 * 交互控制器。
 * 职责单一：把"鼠标按下 / 移动 / 松开"翻译成三种意图
 * - 左键按住 + 位移 ≥ 阈值 → 拖拽（移动整个窗口，可在屏幕任意位置摆放）
 * - 左键按住 + 位移 < 阈值 松开 → 单击（触发随机行为）
 * - 未按住左键                 → 忽略，绝不跟随鼠标
 *
 * 扩展点：
 * - behaviors 来自 config/dialogue.json / behavior.json，可配置台词池、可触发状态池与拖拽阈值
 * - setDragThreshold(px) 可即时调整拖拽判定阈值（设置界面「拖拽灵敏度」）
 * - setEnabled(false) 可在足球模式等玩法中临时禁用拖拽
 * - petAPI 缺失时（例如纯浏览器预览）自动降级为不可拖拽，不报错
 */
import { DRAG_THRESHOLD_PX } from '../shared/constants.js';

export function createInteractionController({
  animation,
  manifest,
  dialogue,
  behaviors = {},
  /** 单击触发语音时的回调（由 main.js 注入播放器）；返回是否真的出声 */
  onVoiceTrigger = null,
  petAPI = globalThis.petAPI,
}) {
  const defaultStateId = manifest.defaultState || 'idle';
  /** 台词池。设置界面可即时改写，所以必须是可变的 */
  let lines = Array.isArray(behaviors.lines) ? behaviors.lines : [];
  const statePool = resolveStatePool(behaviors.states, manifest, defaultStateId);
  /**
   * 单击时出台词 / 播动作 / 播语音。
   * 这三项与"单击触发"的另外两项构成三选一互斥（互斥由主进程保证），
   * 这里只负责"被打开的那一项才生效"。
   */
  let linesEnabled = behaviors.linesEnabled !== false;
  let actionsEnabled = behaviors.actionsEnabled !== false;
  let voiceEnabled = behaviors.voiceEnabled === true;

  let enabled = true;
  let pressing = false;
  let dragged = false;
  /**
   * 判定"拖拽"的最小位移（px）。设置界面可即时调整，所以是可变值，默认取共享常量。
   * 调大 → 手抖一点仍算单击；调小 → 稍微一动就开始拖。
   */
  let dragThresholdPx = Number.isFinite(Number(behaviors.dragThresholdPx))
    ? Math.max(1, Number(behaviors.dragThresholdPx))
    : DRAG_THRESHOLD_PX;
  /** @type {{x:number,y:number}|null} */
  let pressScreen = null;
  /** @type {{x:number,y:number}|null} */
  let windowOrigin = null;

  /** 单击行为：随机台词 / 随机动作 / 随机语音（各自受设置开关控制，三者互斥） */
  function randomClickBehavior() {
    if (linesEnabled) {
      const text = pick(lines);
      if (text) {
        dialogue?.show(text);
      }
    }
    if (actionsEnabled) {
      const stateId = pick(statePool);
      if (stateId) {
        animation.playState(stateId);
      }
    }
    if (voiceEnabled) {
      onVoiceTrigger?.();
    }
  }

  function onPointerDown(event) {
    if (!enabled || event.button !== 0) {
      return;
    }
    // 指针捕获：鼠标快速甩出窗口时，move/up 事件仍会送达，避免状态卡死
    try {
      event.target.setPointerCapture?.(event.pointerId);
    } catch (_) {
      /* 个别元素不支持捕获，忽略 */
    }
    pressing = true;
    dragged = false;
    pressScreen = { x: event.screenX, y: event.screenY };
    windowOrigin = { x: window.screenX, y: window.screenY };
  }

  function onPointerMove(event) {
    if (!enabled || !pressing) {
      return;
    }

    /**
     * 左键已经松开却还收到 pointermove —— 说明 pointerup 丢了（失焦/系统弹窗抢事件）。
     * 用 `buttons` 位掩码当判据比 blur 精确得多：光看窗口焦点，
     * 会把"拖动中弹了个通知"也误判成松手，桌面宠物就"拖到一半突然不跟了"（实测踩过）。
     */
    if (dragged && event.buttons === 0) {
      onPointerEnd(event, { cancelled: true });
      return;
    }

    const dx = event.screenX - pressScreen.x;
    const dy = event.screenY - pressScreen.y;
    if (!dragged && Math.hypot(dx, dy) < dragThresholdPx) {
      return; // 位移太小，仍按单击处理
    }

    dragged = true;
    petAPI?.moveWindow?.(windowOrigin.x + dx, windowOrigin.y + dy);
  }

  function onPointerEnd(event, { cancelled = false } = {}) {
    if (!pressing) {
      return;
    }
    const wasDragged = dragged;
    pressing = false;
    try {
      event?.target?.releasePointerCapture?.(event.pointerId);
    } catch (_) {
      /* ignore */
    }
    if (!cancelled && !wasDragged) {
      randomClickBehavior();
    }
    /**
     * 拖完通知主进程一次：要不要"自动停靠"由主进程按设置判断
     * （把拖到屏幕边沿或外面的桌宠挪回可见区）。
     * 放在松手这一刻做，而不是拖拽过程中 —— 中途改坐标会跟绝对式定位打架。
     *
     * 与拖拽解耦：通知只是"告知"，失败也不影响拖拽本身的状态收尾（pressing 已复位），
     * 所以这里吞掉异常，绝不因为一个附属通知把拖拽链路带崩。
     */
    if (wasDragged) {
      try {
        petAPI?.notifyWindowMoveEnded?.();
      } catch (error) {
        console.warn('[interaction] 通知拖拽结束失败（不影响拖拽本身）：', error?.message ?? error);
      }
    }
  }

  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', (event) => onPointerEnd(event));
  window.addEventListener('pointercancel', (event) => onPointerEnd(event, { cancelled: true }));
  // 失焦兜底：**只在没在拖动时**清状态。
  // 拖动中失焦多半是系统噪声（通知、输入法、切窗口的瞬间），照清不误会让
  // "拖到一半突然不跟"；真正松手的判据交给 onPointerMove 里的 `buttons === 0`，
  // 那条即使丢掉了 pointerup 也能在下一次移动时补上，不会"粘"在拖拽状态。
  window.addEventListener('blur', () => {
    if (!dragged) {
      pressing = false;
    }
  });

  return {
    randomClickBehavior,
    /**
     * 更新台词池（设置界面改「台词池」时即时生效，无需重启）。
     * 传空数组 = 单击不冒气泡。
     * @param {unknown} next
     */
    setLines(next) {
      lines = Array.isArray(next)
        ? next.filter((line) => typeof line === 'string' && line.trim())
        : [];
    },
    /** 当前台词池（调试/验证用） */
    get lines() {
      return lines;
    },
    /**
     * 更新单击行为开关（设置界面改「单击触发台词 / 动作 / 语音」时即时生效）。
     * @param {{lines?: boolean, actions?: boolean, voice?: boolean}} next
     */
    setClickEnabled(next = {}) {
      if ('lines' in next) {
        linesEnabled = Boolean(next.lines);
      }
      if ('actions' in next) {
        actionsEnabled = Boolean(next.actions);
      }
      if ('voice' in next) {
        voiceEnabled = Boolean(next.voice);
      }
    },
    /** 当前单击行为开关（调试/验证用） */
    get clickEnabled() {
      return { lines: linesEnabled, actions: actionsEnabled, voice: voiceEnabled };
    },
    /**
     * 更新拖拽判定阈值（设置界面「拖拽灵敏度」即时生效）。
     * 非数字、小于 1 的值一律忽略 —— 阈值被设成 0 会让"手一碰就开始拖"，单击彻底失灵。
     * @param {unknown} px
     */
    setDragThreshold(px) {
      const parsed = Number(px);
      if (Number.isFinite(parsed) && parsed >= 1) {
        dragThresholdPx = parsed;
      }
    },
    /** 当前拖拽阈值（调试/验证用） */
    get dragThresholdPx() {
      return dragThresholdPx;
    },
    /** 供后续玩法（足球模式、动画播放中）临时禁用拖拽与点击 */
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) {
        pressing = false;
      }
    },
    get isDragging() {
      return pressing && dragged;
    },
  };
}

/**
 * 点击可触发的状态池。
 * - behaviors.states 明确配置（含空数组）→ 尊重配置，空数组 = 点击只出台词不播动作
 * - 未配置（undefined）→ 回退到 manifest 中除默认状态外的全部状态
 * 注意环境小动作（ambient）不进这个池：它们由空闲调度器随机触发，不该被点击"召唤"
 */
function resolveStatePool(configured, manifest, defaultStateId) {
  if (Array.isArray(configured)) {
    return configured.filter((id) => manifest.states?.[id]);
  }
  return Object.keys(manifest.states ?? {}).filter(
    (id) => id !== defaultStateId && !manifest.states[id].ambient
  );
}

function pick(list) {
  return list.length > 0 ? list[Math.floor(Math.random() * list.length)] : undefined;
}
