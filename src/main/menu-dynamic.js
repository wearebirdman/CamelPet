/**
 * 菜单里的"动态段"构造器。
 *
 * 为什么单独一个文件：菜单大部分内容是 config/menu.json 写死的，但有两段**不能在启动时定死** ——
 *   1. 语音包是运行期增删的
 *   2. 动作是随**皮肤 manifest** 走的（换皮肤 / 加动作都会变），写进 menu.json 就得两处维护
 * 这段"现算"的逻辑放在这里，与 menu.js（依赖 electron 的 Menu）分开，
 * 好处是可以脱离 Electron 单独验证。
 *
 * 约定：menu.json 里写 { "dynamic": "<名字>" } 占位，menu.js 弹菜单时按名字取结果就地展开。
 * 返回**空数组**表示整段消失（连分隔线一起没有）——
 * 这就是"没有语音包时不显示语音包段""还没有大动作时不显示动作段"的实现方式。
 */
import { listBigActions } from '../shared/action-catalog.js';

/**
 * 右键菜单的「动作」子菜单。
 *
 * 只列**大动作**（庆祝、siuuu 这类用户主动触发的一次性动作）。
 * 待机不是动作、眨眼已并入待机状态 —— 两者都不进这里，
 * 判定统一走 shared/action-catalog.js，别在本文件里另写一套。
 *
 * 结构：一个可展开的「动作」项，四个动作收在里面（而不是平铺在顶层菜单）——
 * 与「语音」子菜单同一套写法，顶层保持「设置 / 动作 / 语音 / 退出」四项。
 *
 * 子项**故意不写 action 字段**：不写就会走 menu.js 的兜底分发
 * （转发给渲染层 → renderer/menu.js 的 handleMenuAction 按 id 播 manifest 状态）。
 * 这条通道本来就有，不需要为动作新增任何代码路径。
 *
 * @param {object} options
 * @param {Array<{value: string, label: string}>} options.actions listBigActions() 的结果
 * @returns {Array<object>} 可直接拼进菜单模板的菜单项数组；无动作时返回空数组（整段消失）
 */
export function buildActionMenuItems({ actions = [] } = {}) {
  if (actions.length === 0) {
    return [];
  }

  return [
    { type: 'separator' },
    {
      label: '动作',
      items: actions.map((action) => ({ id: action.value, label: action.label })),
    },
  ];
}

/**
 * 「语音」子菜单里的语音包段。
 *
 * @param {object} options
 * @param {Array<{id: string, name: string}>} options.packs 只传**启用且文件存在**的包
 *        （停用的包不该出现在菜单里；文件丢失的包点了也没声音，一并挡在外面）
 * @param {(pack: object) => void} options.onPlay 点击某个包时的动作
 * @returns {Array<object>} 可直接拼进菜单模板的菜单项数组
 */
export function buildVoicePackMenuItems({ packs = [], onPlay } = {}) {
  if (packs.length === 0) {
    return [];
  }

  return [
    { type: 'separator' },
    // 不可点的段标题：不加的话，菜单里只是孤零零几个名字，看不出它们是什么
    { label: '语音包', enabled: false },
    ...packs.map((pack) => ({
      id: `voice-pack:${pack.id}`,
      label: pack.name,
      // 直接给函数作为 action：语音包 id 是运行期才知道的，没法预登记进主进程动作表
      action: () => onPlay?.(pack),
    })),
  ];
}

/**
 * 名字 → 构造器。
 * index.js 把它交给 menu.js，弹菜单时按 menu.json 里的 dynamic 值取用。
 *
 * @param {object} options
 * @param {object} [options.voicePackService] 语音包服务
 * @param {(id: string) => void} [options.onPlayVoicePack] 点语音包时的播放动作
 * @param {() => object} [options.getManifest] 取当前皮肤 manifest（每次弹菜单现读，换皮肤不必重启）
 */
export function createMenuDynamicSections({
  voicePackService,
  onPlayVoicePack,
  getManifest,
} = {}) {
  return {
    voicePacks() {
      return buildVoicePackMenuItems({
        packs: voicePackService?.playable?.() ?? [],
        onPlay: (pack) => onPlayVoicePack?.(pack.id),
      });
    },
    actions() {
      // getManifest 抛错时返回 []，菜单少一段总比弹不出来强
      let actions = [];
      try {
        actions = listBigActions(getManifest?.() ?? {});
      } catch (error) {
        console.error('[menu-dynamic] 读取动作目录失败：', error);
      }
      return buildActionMenuItems({ actions });
    },
  };
}
