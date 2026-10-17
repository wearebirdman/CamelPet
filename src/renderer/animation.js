/**
 * 帧动画控制器。
 * 职责：
 * - 按皮肤 manifest 的状态定义播放帧序列
 * - 切换状态时以 token 作废旧循环，避免异步竞态
 * - 播放前预加载该状态全部帧（利用素材缓存），避免逐帧请求造成闪烁
 * - 按 manifest 的 anchor/baseScale 计算角色在窗口内的布局
 */
import { DEFAULT_FRAME_MS, FEET_MARGIN_PX } from '../shared/constants.js';

export function createAnimationController({ element, container, manifest, resolver, spriteSize }) {
  const defaultStateId = manifest.defaultState || 'idle';
  /** 显示尺寸跟随所选精灵档位（大中小切换时由 setSpriteSize 更新） */
  let currentSize = spriteSize || manifest.designSize || manifest.width || 128;
  /** 素材解析器可替换（切换尺寸档位时整体换一套素材） */
  let activeResolver = resolver;

  let currentStateId = null;
  let timer = null;
  /** 每次切换状态自增；异步回调靠它判断自己是否已被作废 */
  let token = 0;
  /**
   * 当前状态的素材画布（256 基准的宽×高）。
   * 大动作有垂直位移（起跳/下蹲），方形画布装不下 —— manifest 给 state 写
   * `canvas: { width, height }` 后，元素宽度仍等于尺寸档位、高度按比例放大，
   * 多出来的高度全在头顶方向（窗口上方的气泡空间），脚底线不动。
   * 不写 `canvas` 的状态（idle/blink）按正方形处理。
   */
  let currentCanvas = null;

  /** 按当前尺寸与锚点把角色摆放到窗口内 */
  function applyLayout() {
    const scale = manifest.baseScale ?? 1;
    const width = Math.round(currentSize * scale);
    const ratio = currentCanvas ? currentCanvas.height / currentCanvas.width : 1;
    const height = Math.round(width * ratio);

    element.style.width = `${width}px`;
    element.style.height = `${height}px`;

    const left = Math.round((container.clientWidth - width) / 2);
    const top =
      manifest.anchor === 'center'
        ? Math.round((container.clientHeight - height) / 2)
        : Math.round(container.clientHeight - height - FEET_MARGIN_PX);

    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }

  function stopTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * 播放指定状态。
   * @param {string} stateId manifest.states 中的键
   */
  async function playState(stateId) {
    const state = manifest.states?.[stateId];
    if (!state) {
      console.warn('[animation] 未知状态：', stateId);
      return;
    }
    // 畸形 manifest 防御（审查 L6）：assets 缺失/为空时 .map 会抛错、
    // sources[0] 是 undefined → element.src=undefined。状态块写错不该炸掉整个动画循环
    if (!Array.isArray(state.assets) || state.assets.length === 0) {
      console.warn('[animation] 状态没有可用素材：', stateId);
      if (stateId !== defaultStateId) {
        playState(defaultStateId); // 非默认状态坏了就回落待机，别让宠物定格在旧帧
      }
      return;
    }

    const myToken = ++token;
    stopTimer();
    currentStateId = stateId;

    // 画布比例可能随状态变（大动作更高），先更新布局再换帧
    const canvas = state.canvas;
    const next = canvas && canvas.width > 0 && canvas.height > 0 ? canvas : null;
    if (next?.width !== currentCanvas?.width || next?.height !== currentCanvas?.height) {
      currentCanvas = next;
      applyLayout();
    }

    // 预加载全部帧，之后逐帧切换不再等待磁盘/网络
    const sources = await Promise.all(state.assets.map((asset) => activeResolver.load(asset)));
    if (myToken !== token) {
      return; // 等待期间已被新状态取代
    }

    const frameDuration = state.frameDurationMs ?? DEFAULT_FRAME_MS;
    let index = 0;

    const step = () => {
      if (myToken !== token) {
        return;
      }
      element.src = sources[index];
      // 逐帧时长：单帧可覆盖状态的默认帧间隔（起跳要快、腾空要慢时才做得出手感）
      const hold = state.assets[index].durationMs ?? frameDuration;
      index += 1;

      if (index >= sources.length) {
        if (state.loop === false) {
          playState(defaultStateId); // 非循环动作播完回落到默认状态
          return;
        }
        index = 0;
      }
      timer = setTimeout(step, hold);
    };

    step();
  }

  /** 播放默认状态（待机） */
  const startIdle = () => playState(defaultStateId);

  element.addEventListener('error', () => {
    console.error('[animation] 图片加载失败：', {
      src: element.src,
      complete: element.complete,
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
    });
  });

  return {
    applyLayout,
    startIdle,
    playState,
    stopTimer,
    /** 切换精灵尺寸档位（大中小）后调用：更新显示尺寸并重新摆放 */
    setSpriteSize(size) {
      currentSize = size;
      applyLayout();
    },
    /** 替换素材解析器（切尺寸时换一套素材目录） */
    setResolver(nextResolver) {
      activeResolver = nextResolver;
    },
    get currentState() {
      return currentStateId;
    },
    get spriteSize() {
      return currentSize;
    },
  };
}
