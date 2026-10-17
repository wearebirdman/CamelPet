/**
 * 气泡（对话/表情）渲染。
 * 只负责"怎么显示"，不关心"何时显示"——触发条件由交互层决定。
 * 位置会自动避让窗口边缘：头顶放不下时改到脚下，并始终限制在窗口内。
 */
import { DEFAULT_BUBBLE_MS } from '../shared/constants.js';

const GAP_PX = 8;

export function createDialogueRenderer({ container, petElement, durationMs = DEFAULT_BUBBLE_MS }) {
  /** 默认停留时长。可由设置界面即时修改，所以不能是常量 */
  let defaultDurationMs = durationMs;
  /** 当前显示中的气泡 —— 同一时刻只保留一个 */
  let activeBubble = null;

  /**
   * 显示一条气泡。
   * 连续触发（例如反复单击桌宠）时**替换**而不是叠加：
   * 叠加会让多个气泡互相遮挡、文字读不清，阴影也会互相加深。
   * @param {string} text
   * @param {{ durationMs?: number }} [options]
   */
  function show(text, options = {}) {
    if (!text) {
      return null;
    }

    if (activeBubble) {
      activeBubble.remove();
      activeBubble = null;
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    container.appendChild(bubble);
    activeBubble = bubble;

    place(bubble);

    setTimeout(() => {
      bubble.remove();
      if (activeBubble === bubble) {
        activeBubble = null;
      }
    }, options.durationMs ?? defaultDurationMs);
    return bubble;
  }

  function place(bubble) {
    const petRect = petElement.getBoundingClientRect();
    const maxLeft = container.clientWidth - bubble.offsetWidth;
    const maxTop = container.clientHeight - bubble.offsetHeight;

    let top = petRect.top - bubble.offsetHeight - GAP_PX;
    if (top < 0) {
      top = petRect.bottom + GAP_PX; // 头顶空间不足，改到脚下
    }

    bubble.style.left = `${clamp(petRect.left, 0, maxLeft)}px`;
    bubble.style.top = `${clamp(top, 0, maxTop)}px`;
  }

  return {
    show,
    /**
     * 更新默认停留时长（设置界面改「气泡显示时长」时即时生效，无需重启）。
     * @param {number} next 毫秒
     */
    setDuration(next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        defaultDurationMs = parsed;
      }
    },
    /** 当前默认停留时长（调试/验证用） */
    get durationMs() {
      return defaultDurationMs;
    },
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}
