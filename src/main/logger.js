/**
 * 主进程日志。
 * 桌宠无控制台窗口，异常统一落盘到用户数据目录，便于事后排查。
 *
 * 用命名空间导入而不是 `import { app } from 'electron'`：
 * 后者在纯 Node 环境（跑服务单测 / 一次性脚本）下会因为解析不到命名导出而**直接抛错**，
 * 导致任何间接依赖本文件的模块都没法脱离 Electron 运行。
 * 命名空间导入拿不到 app 时降级为只打控制台，主流程不受影响。
 */
import fs from 'fs';
import path from 'path';
import * as electron from 'electron';

const LOG_FILE = 'main.log';

/** 用户数据目录；非 Electron 环境返回 null */
function resolveLogDir() {
  try {
    return electron.app?.getPath?.('userData') ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * 追加一条日志（异步、失败静默，绝不影响主流程）。
 * @param {string} stage 阶段标识，如 'create-window'
 * @param {Error|string} [detail]
 */
export function logError(stage, detail) {
  const entry = `${new Date().toISOString()} [${stage}] ${formatDetail(detail)}\n`;
  console.error(entry.trim());
  const dir = resolveLogDir();
  if (!dir) {
    return; // 非 Electron 环境（脚本 / 单测）只打控制台
  }
  fs.promises
    .appendFile(path.join(dir, LOG_FILE), entry)
    .catch((error) => console.error('logError failed', error));
}

function formatDetail(detail) {
  if (detail instanceof Error) {
    return `${detail.message}${detail.stack ? `\n${detail.stack}` : ''}`;
  }
  if (detail === undefined) {
    return '';
  }
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}
