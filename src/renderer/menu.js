/**
 * 菜单动作分发（渲染层）。
 * 主进程把右键菜单里"非内置动作"的项转发到这里，按 id 映射为桌宠行为。
 * 扩展方式：新增动作时优先在皮肤 manifest 里加状态，这里无需改动。
 */
export function createMenuController({ animation, manifest, interaction }) {
  /**
   * @param {{id?: string, label?: string}} item 菜单配置项
   */
  async function handleMenuAction(item) {
    const stateId = item?.id;
    if (!stateId) {
      return;
    }

    if (manifest.states?.[stateId]) {
      await animation.playState(stateId);
      return;
    }

    switch (stateId) {
      case 'pause':
        interaction?.setEnabled(false);
        break;
      case 'resume':
        interaction?.setEnabled(true);
        break;
      default:
        console.info('[menu] 尚未处理的菜单动作：', stateId);
    }
  }

  return { handleMenuAction };
}
