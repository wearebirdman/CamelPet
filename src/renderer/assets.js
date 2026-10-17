/**
 * 素材解析器。
 * 职责单一：把皮肤 manifest 里的相对路径解析成可用的图片 URL，并做缓存。
 * 路径约定：<项目根>/assets/skins/<skinId>/<asset.path>
 * 路径占位符：
 *   {size} → 显示尺寸档位（128/192/256，CSS px）
 *   {dpr}  → 设备像素比（如 1 / 1.5），素材按物理像素出图实现 1:1 渲染；
 *            对应目录缺失时自动回退到 dpr=1 的素材。
 *
 * 之所以要转成 data:/blob: URL 而不是直接用 file:// 地址：
 * - 便于后续支持远程/压缩包皮肤
 * - 避免 file:// 下的解码与应用缓存行为差异
 */
import { SIZE_PLACEHOLDER, DPR_PLACEHOLDER } from '../shared/constants.js';

/** 把 dpr 数值格式化成目录名：1 → '1'，1.5 → '1.5' */
function formatDpr(dpr) {
  return Number(dpr).toString();
}

/**
 * @param {URL} rootUrl 项目根目录 URL
 * @param {string} skinId 皮肤 id
 * @param {number} spriteSize 显示尺寸档位（CSS px）
 * @param {number} dpr 设备像素比
 */
export function createAssetResolver(rootUrl, skinId, spriteSize, dpr = 1) {
  const skinRoot = new URL(`assets/skins/${skinId}/`, rootUrl);
  const dprName = formatDpr(dpr);
  /** @type {Map<string, Promise<string>>} 展开后的路径 → URL（含失败项，避免重复请求） */
  const cache = new Map();

  /** 把 manifest 里的路径补全成资源路径（处理 {size} 与 {dpr} 占位符） */
  const expandPath = (assetPath) =>
    assetPath.split(SIZE_PLACEHOLDER).join(String(spriteSize)).split(DPR_PLACEHOLDER).join(dprName);

  /** dpr 变体缺失时的兜底路径（回退到 1x 素材） */
  const fallbackPath = (expanded) =>
    dprName === '1' ? null : expanded.replace(`/${dprName}/`, '/1/');

  /** 仅做路径解析，不读取内容 */
  const resolveUrl = (expanded) => new URL(expanded, skinRoot).href;

  /** SVG 内联成 data URL；位图转 blob URL，两者都能被 <img> 直接使用 */
  async function fetchDisplayUrl(url) {
    if (url.endsWith('.svg')) {
      const text = await (await fetch(url)).text();
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
    }
    const blob = await (await fetch(url)).blob();
    return URL.createObjectURL(blob);
  }

  /**
   * 加载展开后的路径。dpr 变体缺失时回退到 1x 素材，但**只回退一次**——
   * 否则回退目标再次失败时会自我递归，Promise 洪水会把渲染进程拖死。
   */
  async function loadExpanded(expanded, allowFallback = true) {
    const url = resolveUrl(expanded);
    try {
      return await fetchDisplayUrl(url);
    } catch (error) {
      const fallback = allowFallback ? fallbackPath(expanded) : null;
      if (!fallback) {
        console.error('[assets] 素材加载失败：', url, '→', error?.message ?? error);
        return url; // 兜底：交给浏览器自己尝试
      }
      console.warn('[assets] dpr 变体缺失，回退 1x：', expanded);
      return loadExpanded(fallback, false);
    }
  }

  /**
   * 加载素材并返回可直接赋给 <img>.src 的 URL（带缓存）。
   * @param {{type?: string, path: string}} asset
   * @returns {Promise<string>}
   */
  function load(asset) {
    const expanded = expandPath(asset.path);
    if (!cache.has(expanded)) {
      cache.set(expanded, loadExpanded(expanded));
    }
    return cache.get(expanded);
  }

  /** 释放 blob 缓存（换肤或换尺寸时调用，避免内存泄漏） */
  async function dispose() {
    for (const pending of cache.values()) {
      try {
        const url = await pending;
        if (url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      } catch (_) {
        /* 失败项无需释放 */
      }
    }
    cache.clear();
  }

  return { load, resolveUrl: (assetPath) => resolveUrl(expandPath(assetPath)), dispose };
}
