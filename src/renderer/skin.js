/**
 * 皮肤加载。
 * 皮肤包结构：assets/skins/<skinId>/manifest.json + 素材目录
 * 当前皮肤 id 与精灵尺寸档位来自 config/skin.json。
 *
 * ## 可写数据根（打包态）
 * 打包后 config/ 与皮肤级 dialogue.json 都在 userData 下（app.asar 只读），
 * 位置由 preload 通过 additionalArguments 递进来（window.petAPI.dataRootUrl）。
 * 所以"用户可改的配置"一律走 [数据根, 应用包根] 两个候选：数据根优先，读不到回落包内。
 * 开发态没有这个参数 → 只有一条候选，行为与改造前完全一致。
 * **素材（manifest / sprites）始终只从包根读** —— 那是只读内容，不随用户走。
 */
import { DEFAULT_SKIN_ID, DEFAULT_SPRITE_SIZE, SPRITE_SIZES } from '../shared/constants.js';

/** 读取并解析 JSON；失败时抛出带路径的错误信息，便于定位配置问题 */
export async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`读取失败(${response.status})：${url}`);
  }
  return response.json();
}

/**
 * "用户可改配置"的候选 URL：可写数据根优先、应用包根兜底。
 * @param {URL} rootUrl 应用包根 URL（调用方传入，与素材解析保持同一基准）
 * @param {string} relative 相对路径，如 'config/voice.json'
 * @returns {URL[]} 1~2 条候选（开发态/挂具下只有 1 条）
 */
export function configCandidates(rootUrl, relative) {
  const inPackage = new URL(relative, rootUrl);
  const dataRoot = window.petAPI?.dataRootUrl;
  if (!dataRoot) {
    return [inPackage];
  }
  let inData;
  try {
    inData = new URL(relative, dataRoot);
  } catch (_) {
    // 数据根参数不可用（传坏了/形态不认识）→ 直接回落包内，
    // 绝不能让一个 URL 解析异常把整个渲染层启动拖垮
    return [inPackage];
  }
  return inData.href === inPackage.href ? [inPackage] : [inData, inPackage];
}

/**
 * 按候选顺序读一份"用户可改配置"，全部读不到时返回 fallback。
 *
 * `silent: true` 用于**探测型读取**（如"皮肤有没有自带 dialogue.json"）：
 * 读不到是预期的回落路径，打 warn 只会污染控制台（冒烟测试会把未知 console 输出
 * 当成异常）——真正的兜底值由调用方自己给，这里就别出声了。
 */
export async function fetchConfigJson(rootUrl, relative, fallback = {}, { silent = false } = {}) {
  let lastError = null;
  for (const url of configCandidates(rootUrl, relative)) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
    }
  }
  if (!silent) {
    console.warn('[skin] 配置读取失败，使用默认值：', relative, lastError?.message ?? lastError);
  }
  return fallback;
}

/**
 * 加载皮肤与配置。
 *
 * 台词（dialogue.json）是**皮肤级**的：皮肤目录里自带就读皮肤的，
 * 没有则回落到全局 config/dialogue.json —— 与语音包的策略一致，
 * 于是"换皮肤 = 换形象 + 换台词 + 换语音 + 换动作"四件事一起生效。
 *
 * @param {URL} rootUrl 项目根目录 URL
 * @param {string} [skinIdOverride] 强制指定的皮肤 id
 * @returns {Promise<{id: string, manifest: object, spriteSize: number, dialogue: object}>}
 */
export async function loadSkin(rootUrl, skinIdOverride) {
  const skinConfig = await fetchConfigJson(rootUrl, 'config/skin.json');
  const id = skinIdOverride || skinConfig.activeSkin || DEFAULT_SKIN_ID;
  // manifest 是只读素材：只从包根读，不参与数据根回落
  const manifest = await fetchJson(new URL(`assets/skins/${id}/manifest.json`, rootUrl));
  // 先静默探测皮肤自带的台词；没有再用全局的（这次不静默：全局文件是真不该缺的）
  const ownDialogue = await fetchConfigJson(
    rootUrl,
    `assets/skins/${id}/dialogue.json`,
    null,
    { silent: true }
  );
  const dialogue = ownDialogue ?? await fetchConfigJson(rootUrl, 'config/dialogue.json');

  // 档位校验：只认 manifest 声明的可用尺寸，配置写错也不会导致素材 404
  const available = Array.isArray(manifest.availableSizes) ? manifest.availableSizes : SPRITE_SIZES;
  const requested = Number(skinConfig.spriteSize);
  const spriteSize = available.includes(requested)
    ? requested
    : manifest.designSize || DEFAULT_SPRITE_SIZE;

  return { id, manifest, spriteSize, dialogue };
}
