/**
 * 音频响度与噪声底诊断（一次性，跑完即退，不留后台进程）。
 * 用法：npm run audio-loudness
 *
 * 为什么要量这个：把很轻的音频"放大"并不能凭空造出信息 —— 噪声底会跟着一起抬上去。
 * 能不能放大、能放大多少，取决于底噪离信号有多远，所以先把底噪量出来再决定方案。
 *
 * 用 Web Audio 的 decodeAudioData 拿**未经任何增益的原始 PCM**（这正是要的：真实电平），
 * 不依赖 ffmpeg。
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { app, BrowserWindow } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 想归一化到的目标峰值（-1 dBFS 留一点余量，避免削顶） */
const TARGET_PEAK_DB = -1;

const TARGETS = process.argv
  .filter((arg) => arg.toLowerCase().endsWith('.mp3') || arg.toLowerCase().endsWith('.wav'))
  .map((arg) => (path.isAbsolute(arg) ? arg : path.join(ROOT, arg)));

if (TARGETS.length === 0) {
  TARGETS.push(path.join(ROOT, 'siuuu.mp3'), path.join(ROOT, 'siuuu_2.mp3'));
}

app.disableHardwareAcceleration();

const watchdog = setTimeout(() => {
  console.log('看门狗超时：30s 未完成，强制退出');
  app.exit(2);
}, 30000);

/** 在渲染层跑：解码 + 统计。返回结构化数据 */
const ANALYZE = (url) => `(async () => {
  const response = await fetch(${JSON.stringify(url)});
  const buffer = await response.arrayBuffer();
  const context = new AudioContext();
  const audio = await context.decodeAudioData(buffer);
  await context.close();

  // 混成单声道，后续统计都基于它
  const channels = audio.numberOfChannels;
  const length = audio.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c += 1) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < length; i += 1) mono[i] += data[i] / channels;
  }

  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < length; i += 1) {
    const value = Math.abs(mono[i]);
    if (value > peak) peak = value;
    sumSquares += mono[i] * mono[i];
  }
  const rms = Math.sqrt(sumSquares / length);

  // 逐 20ms 帧求 RMS：拿分位数来判断"底噪"和"主体"各在哪
  const frame = Math.max(1, Math.round(audio.sampleRate * 0.02));
  const frames = [];
  for (let start = 0; start + frame <= length; start += frame) {
    let acc = 0;
    for (let i = start; i < start + frame; i += 1) acc += mono[i] * mono[i];
    frames.push(Math.sqrt(acc / frame));
  }
  frames.sort((a, b) => a - b);

  const db = (value) => (value > 0 ? 20 * Math.log10(value) : -Infinity);
  const pick = (ratio) => frames[Math.min(frames.length - 1, Math.floor(frames.length * ratio))] ?? 0;
  const head = mono.slice(0, Math.round(audio.sampleRate * 0.1));
  const headSquares = head.reduce((acc, value) => acc + value * value, 0);

  return {
    duration: audio.duration,
    sampleRate: audio.sampleRate,
    channels,
    peak, rms,
    peakDb: db(peak), rmsDb: db(rms),
    crestDb: db(peak) - db(rms),
    minFrameDb: db(frames[0] ?? 0),
    noiseFloorDb: db(pick(0.05)),
    bodyDb: db(pick(0.95)),
    headDb: db(Math.sqrt(headSquares / Math.max(1, head.length))),
  };
})()`;

const round = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : '-Infinity');

async function main() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { webSecurity: false, contextIsolation: true, nodeIntegration: false },
  });
  const blank = path.join(ROOT, 'temp', 'audio-probe.html');
  fs.mkdirSync(path.dirname(blank), { recursive: true });
  fs.writeFileSync(blank, '<!doctype html><meta charset="utf-8">', 'utf8');
  await win.loadFile(blank);

  const rows = [];
  for (const file of TARGETS) {
    if (!fs.existsSync(file)) {
      console.log(`跳过（文件不存在）：${file}`);
      continue;
    }
    const data = await win.webContents.executeJavaScript(ANALYZE(pathToFileURL(file).href));
    const gainDb = TARGET_PEAK_DB - data.peakDb;
    rows.push({
      name: path.basename(file),
      bytes: fs.statSync(file).size,
      ...data,
      gainDb,
      peakAfterDb: data.peakDb + gainDb,
      noiseAfterDb: data.noiseFloorDb + gainDb,
      bodyAfterDb: data.bodyDb + gainDb,
    });
  }

  console.log('\n=== 原始电平（dBFS，越接近 0 越响）===');
  console.log(
    ['文件', '时长', '峰值', '有效值', '波峰因数', '底噪(5%)', '主体(95%)'].join('\t')
  );
  for (const row of rows) {
    console.log(
      [
        row.name,
        `${row.duration.toFixed(2)}s`,
        round(row.peakDb),
        round(row.rmsDb),
        round(row.crestDb),
        round(row.noiseFloorDb),
        round(row.bodyDb),
      ].join('\t')
    );
  }

  console.log(`\n=== 若归一化到峰值 ${TARGET_PEAK_DB} dBFS ===`);
  console.log(['文件', '需增益', '放大后峰值', '放大后底噪 (底噪+增益)', '放大后主体'].join('\t'));
  for (const row of rows) {
    console.log(
      [
        row.name,
        `${round(row.gainDb)} dB`,
        round(row.peakAfterDb),
        round(row.noiseAfterDb),
        round(row.bodyAfterDb),
      ].join('\t')
    );
  }

  console.log('\n判读：底噪放大后若仍在 -45 dBFS 以下，听感上基本察觉不到；');
  console.log('      若超过 -35 dBFS，放大后会有明显"嘶声/沙沙"被一起抬起来。');

  win.destroy();
  clearTimeout(watchdog);
  app.exit(0);
}

app.whenReady().then(() => main().catch((error) => {
  console.error('诊断失败：', error);
  clearTimeout(watchdog);
  app.exit(1);
}));
