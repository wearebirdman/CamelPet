/**
 * 右键菜单。
 * 菜单结构完全由 config/menu.json 生成，约定：
 * - { type: 'separator' }        → 分隔线
 * - { action: '<key>', ... }     → 命中主进程动作表，由主进程处理（退出、切换尺寸等）
 *                                  action 也可以**直接是个函数**（运行期才存在的项，如语音包，
 *                                  没法预登记进动作表）
 * - { type: 'radio', ... }       → 单选组；checked 可为函数，每次弹菜单实时求值
 * - { type: 'checkbox', ... }    → 勾选项；checked 同上
 * - { dynamic: '<名字>' }        → 动态段占位，弹菜单时向 resolveDynamic 求值后就地展开；
 *                                  返回空数组则整段（含分隔线）消失
 * - 其余带 id 的项               → 转发渲染层，id 对应皮肤 manifest 中的状态
 *
 * 新增主进程动作：在 index.js 传入的 actions 表里登记即可，本文件不用改。
 */
import { Menu } from 'electron';
import { logError } from './logger.js';

/**
 * @param {object} options
 * @param {{items: Array}} options.menuConfig config/menu.json
 * @param {Record<string, Function>} options.actions 主进程动作表
 * @param {() => import('electron').BrowserWindow|null} options.getWindow
 * @param {(item: object) => void} options.forwardToRenderer 未命中内置动作时的兜底分发
 * @param {(name: string) => Array} [options.resolveDynamic] 动态段求值：名字 → 菜单项数组
 */
export function createMenuManager({
  menuConfig,
  actions,
  getWindow,
  forwardToRenderer,
  resolveDynamic,
}) {
  /**
   * 把动态段占位项就地展开。
   * 每次 buildTemplate 都重新求值 —— 语音包在设置界面增删后，不用重启菜单就能反映出来。
   */
  function expand(items) {
    const out = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || !item.dynamic) {
        out.push(item);
        continue;
      }
      let produced = [];
      try {
        produced = resolveDynamic?.(item.dynamic) ?? [];
      } catch (error) {
        logError('menu-dynamic', error);
      }
      out.push(...(Array.isArray(produced) ? produced : []));
    }
    return out;
  }

  function buildTemplate(items) {
    return expand(items).map((item) => {
      if (item.type === 'separator') {
        return { type: 'separator' };
      }

      const template = {
        label: item.label,
        click: () => handleClick(item),
      };

      // 未上线的功能在菜单里灰显，避免点下去只留一行"尚未处理"的日志
      if (item.enabled === false) {
        template.enabled = false;
      }

      if (item.type === 'radio' || item.type === 'checkbox') {
        template.type = item.type;
        template.checked = typeof item.checked === 'function' ? item.checked() : Boolean(item.checked);
      }

      if (Array.isArray(item.items) && item.items.length > 0) {
        template.submenu = buildTemplate(item.items);
      }

      return template;
    });
  }

  function handleClick(item) {
    const handler =
      typeof item.action === 'function' ? item.action : item.action && actions[item.action];
    if (handler) {
      try {
        handler(item);
      } catch (error) {
        logError('menu-action', error);
      }
      return;
    }
    forwardToRenderer(item);
  }

  return {
    /** 弹出右键菜单（每次重建，保证 radio 勾选状态与动态段都是最新的） */
    popup(window) {
      Menu.buildFromTemplate(buildTemplate(menuConfig.items)).popup({ window });
    },
    /**
     * 只生成模板、不弹出来。
     * 供验证脚本检查菜单结构（真的 popup() 会阻塞在模态菜单上，无人值守跑不了）。
     */
    build() {
      return buildTemplate(menuConfig.items);
    },
  };
}
