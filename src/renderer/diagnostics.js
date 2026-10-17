/**
 * 渲染层诊断日志（可选能力）。
 * 桌宠没有控制台，出问题时靠这份日志定位（写入用户数据目录 diagnostics.log）。
 * petAPI 不可用时自动降级为只打 console，不影响功能。
 */
export function createDiagnostics(petAPI = globalThis.petAPI) {
  let logPath = null;

  async function resolveLogPath() {
    if (!logPath && petAPI?.getAppPath) {
      logPath = `${await petAPI.getAppPath()}/diagnostics.log`;
    }
    return logPath;
  }

  return {
    /**
     * @param {object} payload 任意可序列化对象
     */
    async write(payload) {
      const entry = `${new Date().toISOString()} ${JSON.stringify(payload)}\n`;
      if (!petAPI?.writeDiagnostics) {
        return;
      }
      try {
        const target = await resolveLogPath();
        if (!target) {
          return;
        }
        const bytes = new TextEncoder().encode(entry);
        await petAPI.writeDiagnostics(target, Array.from(bytes));
      } catch (error) {
        console.error('[diagnostics] 写入失败', error);
      }
    },
  };
}
