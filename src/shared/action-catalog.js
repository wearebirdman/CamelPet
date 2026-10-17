/**
 * 动作目录：从皮肤 manifest 里区分「待机动作」与「大动作」。
 *
 * 为什么单独一个模块：动作的分类判定要被三处用到，判定规则必须只有一份 ——
 *   1. 设置界面的「动作管理」选项列表（渲染层，通过 IPC 拿）
 *   2. 右键菜单的「动作」子菜单（主进程）
 *   3. 单击可触发的动作池（渲染层 interaction.js 的 resolveStatePool）
 * 三处各写一遍 `state.ambient` 判断，迟早有一处忘记改。
 *
 * 分类约定（这是本文件的核心，修改 manifest 或分类规则时请同步检查下方说明）：
 *
 *   - **基线状态**（manifest 的 defaultState，即 `idle`）
 *     状态机唯一的落点：所有 `loop: false` 的动作播完都回它。
 *     **不可关闭**，也不该出现在任何"动作列表"里 —— 它是收口，不是选项。
 *     （注意它是 30 帧的呼吸循环"重心左右摇摆 + 下沉"，不是一张静止贴图。）
 *
 *   - **待机动作**（`ambient: true`，目前只有 `blink`）
 *     待机状态自身的组成部分：待机时每隔一段随机时间插播一次，播完自动回落 idle。
 *     在用户眼里它属于"待机时的表现"，不是"一个动作"，所以同样不进动作列表。
 *     它的节奏由设置里的「待机动作频率」控制（见 idle-scheduler.js）。
 *
 *   - **大动作**（既非 defaultState 又非 ambient，如将来的"庆祝""撅嘴 siuuu"）
 *     用户主动触发的一次性动作，才是"动作"这个词的真正指代。
 *     只有这一类会出现在菜单与「动作管理」里，可开关。
 *
 * 纯函数、零依赖，主进程与渲染层都能用，也能脱离 Electron 单测。
 */

/**
 * 该状态是不是"待机动作"（待机状态的一部分）。
 * 字段名沿用 manifest 的 `ambient`，语义上就是"待机动作"。
 * @param {object} state manifest.states 里的一项
 */
export function isIdleAction(state) {
  return Boolean(state?.ambient);
}

/**
 * 列出"大动作"—— 能上动作菜单、能被「动作管理」开关的那些。
 *
 * 顺序跟随 manifest 里 states 的书写顺序（对象键序），不额外排序：
 * 想调菜单顺序就去调 manifest，不要在代码里再定义一遍顺序。
 *
 * @param {object} manifest 皮肤 manifest
 * @returns {Array<{value: string, label: string}>} 可直接当 schema 的 options / 菜单项用
 */
export function listBigActions(manifest) {
  const defaultStateId = manifest?.defaultState || 'idle';
  return Object.entries(manifest?.states ?? {})
    .filter(([id, state]) => id !== defaultStateId && !isIdleAction(state))
    .map(([id, state]) => ({
      value: id,
      // 菜单与设置界面都要显示中文名。manifest 里给 state 加 `label` 即可；
      // 没写就退回 id —— 宁可显示英文 id，也不要显示空白。
      label: typeof state?.label === 'string' && state.label ? state.label : id,
    }));
}

/**
 * 列出"待机动作"的 id（idle-scheduler 的插播池）。
 * @param {object} manifest
 * @returns {string[]}
 */
export function listIdleActions(manifest) {
  return Object.entries(manifest?.states ?? {})
    .filter(([, state]) => isIdleAction(state))
    .map(([id]) => id);
}
