/**
 * 设置服务。
 * 职责：把 config/settings.json 这份「设置界面 schema」加载进来，按 schema 读出各项当前值，
 * 并把写入请求路由到对应的 applier（真正落盘 + 广播由调用方在 applier 里决定）。
 *
 * 设计要点：
 * - 界面完全由 schema 驱动 —— 新增设置项只改 settings.json，渲染层代码不用动。
 * - 「读」是通用的（按 source.file + source.key 取，缺失回退 default）；
 *   「写」必须显式登记 applier，避免界面上一改就把配置写坏。
 * - 不 import electron，保持纯 Node 可测。
 */
import { loadConfigOrDefault, loadSettingsSourceFile } from './config.js';

const SCHEMA_FILE = 'settings.json';

/** 加载设置 schema */
export function loadSettingsSchema() {
  return loadConfigOrDefault({ categories: [] }, SCHEMA_FILE);
}

/**
 * 展平所有可配置项。
 * 分类有两种写法：直接给 items，或用 groups 分组（行为分类就是"对话/动作/语音"三组，
 * 界面上渲染成小标题），两种都要能取到。
 */
function flattenItems(schema) {
  return schema.categories.flatMap((category) => {
    if (category.kind === 'about') {
      return [];
    }
    if (Array.isArray(category.groups)) {
      return category.groups.flatMap((group) => group.items ?? []);
    }
    return category.items ?? [];
  });
}

/**
 * 按点号路径取值：'click.lines' → obj.click.lines。
 * 任一层缺失返回 undefined（调用方回退 default）。
 */
function getByPath(source, path) {
  return String(path)
    .split('.')
    .reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), source);
}

/**
 * 读出全部设置项的当前值。
 * @param {object} [schema]
 * @returns {Record<string, unknown>} { [itemId]: value }
 */
export function readSettingsValues(schema = loadSettingsSchema()) {
  /** 同一份配置文件在一次读取里只读一次 */
  const fileCache = new Map();
  const values = {};

  for (const item of flattenItems(schema)) {
    const file = item.source?.file;
    const key = item.source?.key;
    if (!file || !key) {
      values[item.id] = item.default;
      continue;
    }
    if (!fileCache.has(file)) {
      // 台词（dialogue.json）随皮肤走：读侧与写侧必须同一套解析，
      // 否则换到自带台词的皮肤后，设置页显示的是上一套的值（见 config.js 的说明）
      fileCache.set(file, loadSettingsSourceFile(file));
    }
    const raw = getByPath(fileCache.get(file), key);
    values[item.id] = raw === undefined ? item.default : raw;
  }
  return values;
}

/** 导出给测试与 applier 复用 */
export { flattenItems, getByPath };

/**
 * 创建设置服务。
 * @param {object} options
 * @param {Record<string, (value: any) => (boolean|{value: any}|{ok: false, message: string}|{value: any, warning: string})>} options.applySetting
 *        设置项 id → 应用函数。返回值约定：
 *          - `false`                    → 拒绝写入（reason: 'rejected'）
 *          - `true` / undefined         → 接受，值原样
 *          - `{ value }`                → 接受，但值被规范化过（界面会同步成这个值，
 *                                         例如台词池会去掉空行、做长度限制）
 *          - `{ ok: false, message }`   → 拒绝，并把原因透到界面（例如系统拒绝了开机项写入）。
 *                                         这类原因只有 applier 知道，界面瞎猜只会给出误导性提示。
 *          - `{ value, warning }`       → 接受，但有隐患要提醒用户（界面弹提示，不当失败）
 *        未登记 applier 的项一律拒绝（reason: 'no-applier'），保证不会有"界面改了但没人管"的静默失效。
 */
export function createSettingsService({ applySetting = {} } = {}) {
  const schema = loadSettingsSchema();
  const items = flattenItems(schema);

  return {
    /** 供 GET_SETTINGS 使用 */
    readAll() {
      return { schema, values: readSettingsValues(schema) };
    },

    /**
     * 校验某项设置是否允许"拖动期间临时预览"。
     *
     * 与 write 的区别：不落盘、不执行 applier，只判断这个键是否被授权预览。
     * 仍然要过白名单 —— 否则设置窗口就能广播任意 key 去影响桌宠状态。
     * 只有 schema 里显式标了 `preview: true` 的项才放行（这类项的共同点是
     * "拖的时候必须能立刻感知"，比如音量）。
     *
     * @returns {{ok: true, value: any} | {ok: false, reason: string}}
     */
    preview(key, value) {
      const item = items.find((candidate) => candidate.id === key);
      if (!item) {
        return { ok: false, reason: 'unknown-key' };
      }
      if (item.preview !== true) {
        return { ok: false, reason: 'no-preview' };
      }
      return { ok: true, value };
    },

    /**
     * 写入一项设置。
     * @returns {{ok: true, value: any, warning?: string} | {ok: false, reason: string, message?: string}}
     *          reason: unknown-key | no-applier | rejected
     */
    write(key, value) {
      const item = items.find((candidate) => candidate.id === key);
      if (!item) {
        return { ok: false, reason: 'unknown-key' };
      }
      const apply = applySetting[key];
      if (typeof apply !== 'function') {
        return { ok: false, reason: 'no-applier' };
      }
      try {
        const outcome = apply(value);
        if (outcome === false) {
          return { ok: false, reason: 'rejected' };
        }
        if (outcome && typeof outcome === 'object' && outcome.ok === false) {
          // applier 自己说明的失败原因，原样透给界面
          return { ok: false, reason: 'rejected', message: outcome.message };
        }
        const normalized =
          outcome && typeof outcome === 'object' && 'value' in outcome ? outcome.value : value;

        // 互斥组：把某项打开时，同组的其他项一并关闭。
        // 放在主进程而不是界面里做，是为了「一次 IPC 内同步写完」——
        // 否则界面要发 N 次请求，中间会出现"两个同时开着"的瞬间状态。
        const siblingFailures = [];
        const siblingWarnings = [];
        if (item.exclusiveGroup && normalized === true) {
          for (const sibling of items) {
            if (
              sibling.id !== key &&
              sibling.exclusiveGroup === item.exclusiveGroup
            ) {
              const siblingLabel = sibling.label ?? sibling.id;
              try {
                const siblingOutcome = applySetting[sibling.id]?.(false);
                // 兄弟项的结果不能吞掉（审查 L2）：关不掉=还开着、有告警=有隐患，
                // 主项虽然成功了，这些也必须让界面知道
                if (siblingOutcome && typeof siblingOutcome === 'object') {
                  if (siblingOutcome.ok === false) {
                    siblingFailures.push(`${siblingLabel}（${siblingOutcome.message ?? '未知原因'}）`);
                  } else if (siblingOutcome.warning) {
                    siblingWarnings.push(`${siblingLabel}：${siblingOutcome.warning}`);
                  }
                }
              } catch (error) {
                console.error('[settings] 关闭互斥项失败：', sibling.id, error);
                siblingFailures.push(siblingLabel);
              }
            }
          }
        }

        const result = { ok: true, value: normalized };
        const warnings = [];
        if (outcome && typeof outcome === 'object' && outcome.warning) {
          // 写成功了但有隐患：界面要弹出来，不能当成静默成功
          warnings.push(String(outcome.warning));
        }
        warnings.push(...siblingWarnings);
        if (siblingFailures.length > 0) {
          warnings.push(`互斥项未能自动关闭：${siblingFailures.join('、')}`);
        }
        if (warnings.length > 0) {
          result.warning = warnings.join('；');
        }
        return result;
      } catch (error) {
        console.error('[settings] 应用设置失败：', key, error);
        return { ok: false, reason: 'rejected' };
      }
    },
  };
}
