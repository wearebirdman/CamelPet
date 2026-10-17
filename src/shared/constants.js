/**
 * 渲染层与主进程共用的常量（ESM）。
 * 可调的默认值集中在此，避免散落在各个控制器里。
 */

/** 默认皮肤 id，config/skin.json 未指定时使用 */
export const DEFAULT_SKIN_ID = 'default';

/** 精灵素材路径里的尺寸占位符，如 sprites/idle/{size}/000.png */
export const SIZE_PLACEHOLDER = '{size}';

/** 素材路径里的设备像素比占位符，如 sprites/idle/{size}/{dpr}/000.png。
 *  素材像素 = 显示尺寸 × dpr，保证 1:1 渲染；非整数缩放（如 150% 显示缩放下 1.5 倍）
 *  会让像素宽度在 1/2 物理像素间交替，产生肉眼可见的撕裂。 */
export const DPR_PLACEHOLDER = '{dpr}';

/** 精灵尺寸档位（小 / 中 / 大），设置界面与菜单共用 */
export const SPRITE_SIZES = [128, 192, 256];

/** 默认精灵尺寸（config/skin.json 未指定时使用） */
export const DEFAULT_SPRITE_SIZE = 192;

/** 判定"拖拽"的最小位移（px）：小于该值松开视为单击 */
export const DRAG_THRESHOLD_PX = 4;

/**
 * 「待机动作频率」档位 → 插播间隔区间（毫秒，闭区间内随机取）。
 *
 * 为什么档位表放在共享常量里：主进程要用它校验写入的值（非法值夹回默认档），
 * 渲染层的 idle-scheduler 要用它换算成定时器延迟 —— 两边各写一份迟早会对不上。
 *
 * `off` 用 `null` 表示"不插播"，而不是 [Infinity, Infinity]：
 * 前者可以直接判空停掉调度器，后者会得到一个永远不会触发的定时器（还在占着内存和时间线）。
 *
 * 注意这几个区间的语义是**间隔**（多久眨一次），不是单次动作的时长。
 */
export const IDLE_ACTION_FREQUENCIES = {
  off: null,
  low: [8000, 15000],
  medium: [3000, 7000],
  high: [1000, 3000],
};

/** 默认待机动作频率档位（config/behavior.json 缺键时用它，也与原写死的 3~7 秒一致） */
export const DEFAULT_IDLE_FREQUENCY = 'medium';

/** 气泡默认显示时长（ms） */
export const DEFAULT_BUBBLE_MS = 1800;

/**
 * 语音包音频时长上限（秒）。
 *
 * 语音包是"喊一句"的量级，30 秒已远超正常用法（现网最长的一个 28.9 秒）；
 * 超限多半是选错了文件（整个专辑、整段录音）。
 *
 * 为什么放在共享常量里：渲染层在解码后立刻判、主进程落盘前再按 WAV 字节数判一遍 ——
 * 两道关用同一个数字，改的时候不会只改到一边。
 * 界面校验只是提前反馈，真正的守门人必须是不受界面影响的那一层。
 */
export const MAX_AUDIO_SECONDS = 30;

/** 帧动画默认帧间隔（ms） */
export const DEFAULT_FRAME_MS = 120;

/** 角色底边与窗口底部的最小留白（px），anchor 为 feet 时生效 */
export const FEET_MARGIN_PX = 4;
