/**
 * 语音包导入时的音频处理。
 *
 * 为什么放在渲染层：解码和重采样都依赖 Web Audio，主进程没有这些 API。
 *
 * 为什么在「导入时」处理，而不是「播放时」处理：
 *   1. `<audio>` 元素的 volume 上限是 1.0 —— 只能衰减、不能放大。播放时想变响就只能引入
 *      GainNode，而那只是把同一件事挪到另一个地方做，还多出一条要维护的音频图；
 *   2. 处理结果落进 assets/audio/，用户之后挪动或删掉原始文件都不影响；
 *   3. 播放链路保持简单，不必每次播放都重算。
 *
 * 处理策略（为什么不是无脑放大）：
 *   放大是乘法，信号和底噪同乘一个数，**信噪比一点不改善**。所以增益取两个上限里的较小值：
 *   「峰值提到 -1dBFS 需要多少」与「底噪不许超过 -35dBFS 还能放多少」。
 *   同时先把语音间隙的底噪压下去（噪声门），否则那点嘶声会被一起抬起来。
 */

import { MAX_AUDIO_SECONDS } from '../shared/constants.js';

/** 目标峰值：留 1dB 余量，避免归一化或重采样后的过冲削顶 */
const TARGET_PEAK_DB = -1;
/** 底噪上限：放大后底噪不得高于它，否则安静处会听见明显嘶声 */
const NOISE_CEILING_DB = -35;
/** 输出统一成单声道 32kHz —— 语音不需要立体声，32kHz 的 16kHz 带宽远超人声所需 */
const OUTPUT_SAMPLE_RATE = 32000;
/** 噪声门的衰减量：不用全静音，留一点自然感 */
const GATE_ATTENUATION_DB = -18;
/** 噪声门阈值比底噪高多少 */
const GATE_HEADROOM_DB = 6;
/** 信噪比低于这个值就不开噪声门 —— 放大后本底噪声会明显 */
const GATE_MIN_SNR_DB = 12;

/**
 * 「有没有真正的静音间歇」的判据 —— 噪声门能不能开，取决于这个。
 *
 * 踩坑记录（2026-09-29）：原先只看信噪比（≥12dB 就开门），结果一首信噪比 16.6dB 的
 * **连续音乐**被判为"可以开门"。实测该音频 28.9 秒里门开/关切换 **790 次**、
 * 平均每 37ms 翻转一次、最短开门段只有 5ms —— 增益被高频调制，
 * 听感就是用户报的"突突/沙沙"杂音。
 *
 * 根因：信噪比高 ≠ 有静音段。音乐也有高信噪比（主体 -7.8dBFS / 底噪 -24.3dBFS），
 * 但它**从头到尾都在响**，帧级 RMS 天然在门限附近起伏，二值判定必然抖动。
 *
 * 正确判据是"关门段里有多少是真正的停顿"：语音换气停顿通常 ≥200ms 且规律出现，
 * 而音乐/持续噪声的"低于门限"绝大多数只有一两帧（实测中位 10ms、396 段里仅 7 段 ≥150ms）。
 * 三个判据同时满足才开门，任一条不满足都说明这是连续信号。
 */
const MIN_SILENCE_MS = 150;
/** 长静音段（≥MIN_SILENCE_MS）至少这么多段，才认为存在真正的停顿 */
const MIN_SILENCE_COUNT = 2;
/** 长静音段占全部关门段的比例下限（音乐实测 1.8%，语音远高于此） */
const MIN_SILENCE_SHARE = 0.3;
/** 开门后至少保持这么久再允许关闭，避免极短抖动 */
const GATE_HOLD_MS = 120;
/** 软膝宽度：阈值下方这段区间按比例衰减，避免二值硬切造成的"切感" */
const GATE_KNEE_DB = 12;

const dbToLinear = (db) => 10 ** (db / 20);
const linearToDb = (value) => (value > 0 ? 20 * Math.log10(value) : -Infinity);

/**
 * 电平分析。
 * 用「逐帧 RMS 的分位数」区分底噪与主体：最安静的 5% 帧当成底噪，最响的 95% 帧当成主体。
 * 比"取全段最小值/最大值"稳 —— 单点毛刺不会带偏结论。
 */
export function analyze(samples, sampleRate, frameMs = 20) {
  const length = samples.length;
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
    sumSquares += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, length));

  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames = [];
  for (let start = 0; start + frameSize <= length; start += frameSize) {
    let acc = 0;
    for (let i = start; i < start + frameSize; i += 1) acc += samples[i] * samples[i];
    frames.push(Math.sqrt(acc / frameSize));
  }
  frames.sort((a, b) => a - b);
  const pick = (ratio) =>
    frames.length ? frames[Math.min(frames.length - 1, Math.floor(frames.length * ratio))] : 0;

  const peakDb = linearToDb(peak);
  const rmsDb = linearToDb(rms);
  const noiseFloorDb = linearToDb(pick(0.05));
  const bodyDb = linearToDb(pick(0.95));

  return {
    duration: length / sampleRate,
    peakDb,
    rmsDb,
    noiseFloorDb,
    bodyDb,
    /** 波峰因数：峰值比有效值高多少。数值小说明被重度压缩过 */
    crestDb: peakDb - rmsDb,
    /** 信噪比：主体比底噪高多少。这才是"放大能不能听"的决定性指标 */
    snrDb: bodyDb - noiseFloorDb,
  };
}

/**
 * 关门段统计：按门限找出所有"低于门限"的连续段，给出长度分布。
 *
 * 为什么不用"最长段"当判据：连续音乐里偶然也会出现一段较长的安静
 * （实测 396 段里 7 段 ≥150ms，最长 355ms），只看最长段会被这种偶然骗过去。
 * 看**中位数与长段占比**才分得开"规律停顿的语音"和"一直在响的音乐"。
 */
export function summarizeSilence(samples, sampleRate, thresholdDb, frameMs = 5) {
  const threshold = dbToLinear(thresholdDb);
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frameCount = Math.floor(samples.length / frameSize);
  const runs = [];
  let current = 0;
  for (let f = 0; f < frameCount; f += 1) {
    const start = f * frameSize;
    let acc = 0;
    for (let i = start; i < start + frameSize; i += 1) acc += samples[i] * samples[i];
    const frameRms = Math.sqrt(acc / frameSize);
    if (frameRms < threshold) {
      current += 1;
    } else if (current > 0) {
      runs.push(current * frameMs);
      current = 0;
    }
  }
  if (current > 0) {
    runs.push(current * frameMs);
  }
  runs.sort((a, b) => a - b);
  const longRuns = runs.filter((ms) => ms >= MIN_SILENCE_MS);
  return {
    /** 关门段总数 */
    count: runs.length,
    /** 最长的一段（ms） */
    longestMs: runs.length ? runs[runs.length - 1] : 0,
    /** 段长中位数（ms）—— 音乐实测 10ms，语音应为数百 ms */
    medianMs: runs.length ? runs[Math.floor(runs.length / 2)] : 0,
    /** 达到 MIN_SILENCE_MS 的段数与占比 */
    longCount: longRuns.length,
    longShare: runs.length ? longRuns.length / runs.length : 0,
  };
}

/**
 * 决定要不要开噪声门。四条判据全满足才开 —— 任一条不满足都说明这是连续信号，
 * 硬开门只会得到被高频调制的增益（听感即"杂音"）。
 * @returns {{apply: boolean, reason: string, silence: object, thresholdDb: number}}
 */
export function decideGate(analysis, silence, { minSnrDb = GATE_MIN_SNR_DB } = {}) {
  if (analysis.snrDb < minSnrDb) {
    return { apply: false, reason: 'snr-low', silence, thresholdDb: null };
  }
  if (silence.longestMs < MIN_SILENCE_MS) {
    return { apply: false, reason: 'no-silence', silence, thresholdDb: null };
  }
  if (silence.longCount < MIN_SILENCE_COUNT) {
    return { apply: false, reason: 'too-few-silence', silence, thresholdDb: null };
  }
  if (silence.longShare < MIN_SILENCE_SHARE) {
    return { apply: false, reason: 'silence-share-low', silence, thresholdDb: null };
  }
  return {
    apply: true,
    reason: 'gated',
    silence,
    thresholdDb: analysis.noiseFloorDb + GATE_HEADROOM_DB,
  };
}

/**
 * 简易噪声门：按帧判定"这一段算不算有声音"，不算就衰减。
 * 只压间隙，不动语音段 —— 所以放大后不会把整段的嘶声一起抬起来。
 *
 * 两处针对"抖动"的设计（都源于 2026-09-29 的实测）：
 * - **软膝**：阈值下方 GATE_KNEE_DB 区间内按比例衰减，而不是二值切换。
 * - **保持**：开门后至少 GATE_HOLD_MS 内不再关门。实测音乐的门在门限附近
 *   平均每 37ms 翻转一次，最短开门段只有 5ms —— 保持窗口把这类抖动直接吃掉。
 *
 * @param {Float32Array} samples 就地修改
 */
export function applyNoiseGate(
  samples,
  sampleRate,
  {
    thresholdDb,
    attenuationDb = GATE_ATTENUATION_DB,
    frameMs = 5,
    smoothMs = 15,
    holdMs = GATE_HOLD_MS,
    kneeDb = GATE_KNEE_DB,
  } = {}
) {
  const threshold = dbToLinear(thresholdDb);
  const kneeFloor = dbToLinear(thresholdDb - kneeDb);
  const attenuation = dbToLinear(attenuationDb);
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frameCount = Math.ceil(samples.length / frameSize);

  const target = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    const start = f * frameSize;
    const end = Math.min(start + frameSize, samples.length);
    let acc = 0;
    for (let i = start; i < end; i += 1) acc += samples[i] * samples[i];
    const frameRms = Math.sqrt(acc / Math.max(1, end - start));
    if (frameRms >= threshold) {
      target[f] = 1;
    } else if (frameRms <= kneeFloor) {
      target[f] = attenuation;
    } else {
      // 软膝：在对数域线性插值，听感上比线性域更均匀
      const ratio =
        (linearToDb(frameRms) - (thresholdDb - kneeDb)) / Math.max(1e-6, kneeDb);
      target[f] = attenuation + (1 - attenuation) * Math.max(0, Math.min(1, ratio));
    }
  }

  // 保持：判定"开门"（增益高于半程）之后的 holdFrames 内不允许关门
  const holdFrames = Math.max(1, Math.round(holdMs / frameMs));
  let lastOpen = -Infinity;
  for (let f = 0; f < frameCount; f += 1) {
    if (target[f] >= 0.5) {
      lastOpen = f;
    } else if (f - lastOpen <= holdFrames) {
      target[f] = 1;
    }
  }

  // 帧间做一阶平滑，避免增益突变产生"咔哒"声
  const alpha = Math.min(1, frameMs / Math.max(smoothMs, frameMs));
  let current = target[0] ?? 1;
  for (let f = 0; f < frameCount; f += 1) {
    current += (target[f] - current) * alpha;
    const start = f * frameSize;
    const end = Math.min(start + frameSize, samples.length);
    for (let i = start; i < end; i += 1) samples[i] *= current;
  }
}

/**
 * 决定放大多少。
 * @returns {number} 增益（dB）。负值会被夹到 0 —— 本来就够响的音频不该被悄悄调小。
 */
export function computeGainDb(
  analysis,
  { targetPeakDb = TARGET_PEAK_DB, noiseCeilingDb = NOISE_CEILING_DB } = {}
) {
  const byPeak = targetPeakDb - analysis.peakDb;
  const byNoise = noiseCeilingDb - analysis.noiseFloorDb;
  return Math.max(0, Math.min(byPeak, byNoise));
}

/**
 * 峰值上限保护。
 *
 * 增益计算只会"放大"（负增益被夹到 0，见 computeGainDb 注释），这是有意的：
 * 本来就够响的音频不该被悄悄调小。但**重采样（带抗混叠滤波的插值）会让峰值过冲**，
 * 满刻度信号过冲后就会在 16bit 编码时被 clamp 硬削顶 —— 波形顶部被切平，
 * 听感是破音/沙沙（实测 We Are Electric 源峰值 -0.11dBFS，已贴着满刻度）。
 *
 * 所以这里只做"超过上限才缩"的兜底：整体乘一个 ≤1 的系数，不动动态、不引入失真，
 * 代价只是一点点响度（dB 量级）。
 *
 * @returns {{applied: boolean, scale: number, peakDbBefore: number, peakDbAfter: number}}
 */
export function limitPeak(samples, targetPeakDb = TARGET_PEAK_DB) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  const peakDbBefore = linearToDb(peak);
  const target = dbToLinear(targetPeakDb);
  if (!(peak > target)) {
    return { applied: false, scale: 1, peakDbBefore, peakDbAfter: peakDbBefore };
  }
  const scale = target / peak;
  for (let i = 0; i < samples.length; i += 1) samples[i] *= scale;
  return { applied: true, scale, peakDbBefore, peakDbAfter: targetPeakDb };
}

/** 混合成单声道 */
export function toMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const out = new Float32Array(audioBuffer.length);
  for (let c = 0; c < channels; c += 1) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < out.length; i += 1) out[i] += data[i] / channels;
  }
  return out;
}

/** 重采样（用 OfflineAudioContext，它自带抗混叠滤波） */
export async function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) {
    return samples;
  }
  const length = Math.max(1, Math.round((samples.length / fromRate) * toRate));
  const context = new OfflineAudioContext(1, length, toRate);
  const buffer = context.createBuffer(1, samples.length, fromRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

/** 编码成 16bit PCM 单声道 WAV */
export function encodeWav(samples, sampleRate) {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeText(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** 把可能来自 IPC 的二进制统一成 ArrayBuffer */
function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  }
  throw new TypeError('音频数据必须是 ArrayBuffer 或其视图');
}

/**
 * 导入处理总入口。
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes 源音频文件字节
 * @returns {Promise<{bytes: ArrayBuffer, report: object}>} 处理后的 WAV 与处理报告
 * @throws {Error & {code: string, duration?: number}} 时长超限时抛 `code='too-long'`
 *   —— 用 code 而不是文案来判断：界面层必须把它与"解码失败"区分开，
 *   否则会走进"原样导入"的降级路径，把超长音频放进来（那样校验等于没有）。
 */
export async function prepareAudioImport(bytes, options = {}) {
  const {
    targetPeakDb = TARGET_PEAK_DB,
    noiseCeilingDb = NOISE_CEILING_DB,
    outputSampleRate = OUTPUT_SAMPLE_RATE,
    gate: gateEnabled = true,
    maxSeconds = MAX_AUDIO_SECONDS,
  } = options;

  const source = toArrayBuffer(bytes);

  /**
   * 让解码器直接输出目标采样率。
   *
   * 默认 AudioContext 用的是设备采样率（桌面常见 48000），于是 44.1kHz 的源会
   * 先被解码器转到 48k、再被我们转到 32k —— 两次滤波、两次插值，全无必要。
   * 指定 sampleRate 后解码即得 32k，第二段重采样直接变成空操作。
   *
   * 注意：部分环境不支持指定采样率时**不抛错而是静默忽略**，
   * 所以不靠 try/catch 判断，而是回读 context.sampleRate 比对。
   */
  let context;
  try {
    context = new AudioContext({ sampleRate: outputSampleRate });
  } catch (_) {
    context = new AudioContext();
  }
  const decodeNative = context.sampleRate === outputSampleRate;

  let decoded;
  try {
    // decodeAudioData 会转移传入 ArrayBuffer 的所有权（用完就空了），
    // 所以复制一份再解，调用方手里的数据仍然可用
    decoded = await context.decodeAudioData(source.slice(0));
  } finally {
    await context.close();
  }

  const sourceSampleRate = decoded.sampleRate;
  const sourceChannels = decoded.numberOfChannels;

  /**
   * 时长校验。
   *
   * 位置选在解码之后：只有解码完才知道真实时长（文件头里的时长字段不可信，
   * mp3 的 VBR 时长还常是估算值）。同时也足够早 —— 后面的噪声门、增益、重采样
   * 都是逐样本循环，超长音频在这里拦下可以省掉全部计算。
   */
  const decodedDuration = decoded.length / decoded.sampleRate;
  if (decodedDuration > maxSeconds) {
    const error = new Error(`音频时长 ${decodedDuration.toFixed(1)} 秒，超过 ${maxSeconds} 秒上限`);
    error.code = 'too-long';
    error.duration = decodedDuration;
    error.limit = maxSeconds;
    throw error;
  }

  // 先混单声道再处理：噪声门判的是"整段有没有声音"，分左右两路各判各的会不一致
  const working = toMono(decoded);
  const before = analyze(working, sourceSampleRate);

  /**
   * 噪声门：先判断"这段音频有没有真正的静音停顿"，再决定开不开（见 decideGate）。
   * 不看信噪比一项 —— 连续音乐的信噪比也不低，开了门就等着听增益抖动。
   */
  const silence = summarizeSilence(
    working,
    sourceSampleRate,
    before.noiseFloorDb + GATE_HEADROOM_DB
  );
  const gateDecision = decideGate(before, silence);
  const gateApplied = Boolean(gateEnabled && gateDecision.apply);
  if (gateApplied) {
    applyNoiseGate(working, sourceSampleRate, { thresholdDb: gateDecision.thresholdDb });
  }

  /**
   * 增益仍按**开门前**的底噪计算，这是刻意保守的一侧：开门后底噪实际已降
   * GATE_ATTENUATION_DB，按新底噪算可以放得更大，但"少放大"不会带来任何听感缺陷，
   * 而"多放大"会让本底噪声浮出来。
   */
  const gainDb = computeGainDb(before, { targetPeakDb, noiseCeilingDb });
  const gain = dbToLinear(gainDb);
  if (gain !== 1) {
    for (let i = 0; i < working.length; i += 1) working[i] *= gain;
  }

  const resampled = await resample(working, sourceSampleRate, outputSampleRate);
  // 重采样会让峰值过冲，编码前兜一次（只在超过目标峰值时才缩）
  const peakLimit = limitPeak(resampled, targetPeakDb);
  const wav = encodeWav(resampled, outputSampleRate);

  return {
    bytes: wav,
    report: {
      duration: before.duration,
      /** 解码上下文采样率。decodeNative 为 true 时它等于文件真实采样率 */
      sourceSampleRate,
      /** 是否成功让解码器直接输出目标采样率（false 表示多了一次重采样） */
      decodeNative,
      sourceChannels,
      outputSampleRate,
      outputChannels: 1,
      outputBytes: wav.byteLength,
      gateApplied,
      /** 未开门的原因：snr-low / no-silence / too-few-silence / silence-share-low */
      gateReason: gateApplied ? 'gated' : gateDecision.reason,
      silence,
      gainDb,
      peakLimit,
      before,
      after: analyze(resampled, outputSampleRate),
    },
  };
}

export {
  TARGET_PEAK_DB,
  NOISE_CEILING_DB,
  OUTPUT_SAMPLE_RATE,
  GATE_MIN_SNR_DB,
  MIN_SILENCE_MS,
  MIN_SILENCE_COUNT,
  MIN_SILENCE_SHARE,
  GATE_HOLD_MS,
};
