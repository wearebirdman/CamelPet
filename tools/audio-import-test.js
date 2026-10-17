/**
 * 音频导入处理的效果实测。
 * 用法：npm run audio-import-test [文件...]
 *
 * 处理必须在渲染层跑（依赖 Web Audio 的 decodeAudioData），所以这里开一个隐藏窗口，
 * 真实 import 生产模块 src/renderer/audio-import.js，而不是另写一份逻辑。
 * 处理结果落到 temp/audio-import-out/，可以直接播来听。
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { app, BrowserWindow } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'temp', 'audio-import-out');
const MODULE_URL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'audio-import.js')).href;

const targets = process.argv
  .filter((arg) => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(arg))
  .map((arg) => (path.isAbsolute(arg) ? arg : path.join(ROOT, arg)));
if (targets.length === 0) {
  targets.push(path.join(ROOT, 'siuuu.mp3'), path.join(ROOT, 'siuuu2.mp3'));
}

app.disableHardwareAcceleration();

const watchdog = setTimeout(() => {
  console.log('看门狗超时：60s 未完成，强制退出');
  app.exit(2);
}, 60000);

const round = (value) => (value === null || value === undefined || !Number.isFinite(value) ? '-∞' : Math.round(value * 10) / 10);
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

/** 噪声门未启用时，把"为什么不开"翻译成人话 —— 这个原因正是排查杂音的关键线索 */
const GATE_REASON_TEXT = {
  gated: '已开门',
  'snr-low': '信噪比不足',
  'no-silence': '没有足够长的静音段',
  'too-few-silence': '长静音段数量太少',
  'silence-share-low': '长静音段占比过低',
};

/** 在隐藏窗口里跑真实模块：读文件 → 处理 → 回传报告 + 成品字节(base64) */
const RUN = (fileUrl) => `(async () => {
  const mod = await import(${JSON.stringify(MODULE_URL)});
  const response = await fetch(${JSON.stringify(fileUrl)});
  const buffer = await response.arrayBuffer();
  const result = await mod.prepareAudioImport(buffer);
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([result.bytes], { type: 'audio/wav' }));
  });
  return JSON.stringify({ report: result.report, base64 });
})()`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    webPreferences: { webSecurity: false, contextIsolation: true, nodeIntegration: false },
  });
  const page = path.join(ROOT, 'temp', 'audio-import-test.html');
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>audio import test</title>', 'utf8');
  await win.loadFile(page);

  const rows = [];
  for (const file of targets) {
    if (!fs.existsSync(file)) {
      console.log(`跳过（文件不存在）：${file}`);
      continue;
    }
    const raw = await win.webContents.executeJavaScript(RUN(pathToFileURL(file).href));
    const { report, base64 } = JSON.parse(raw);
    const outFile = path.join(OUT_DIR, `${path.basename(file, path.extname(file))}-processed.wav`);
    fs.writeFileSync(outFile, Buffer.from(base64, 'base64'));
    rows.push({ name: path.basename(file), sourceBytes: fs.statSync(file).size, report, outFile });
  }

  console.log('\n=== 处理前 → 处理后（dBFS）===');
  console.log(['文件', '峰值', '有效值', '底噪', '主体', '信噪比'].join('\t'));
  for (const row of rows) {
    const b = row.report.before;
    const a = row.report.after;
    console.log(
      [
        `${row.name}`,
        `${round(b.peakDb)} → ${round(a.peakDb)}`,
        `${round(b.rmsDb)} → ${round(a.rmsDb)}`,
        `${round(b.noiseFloorDb)} → ${round(a.noiseFloorDb)}`,
        `${round(b.bodyDb)} → ${round(a.bodyDb)}`,
        `${round(b.snrDb)} → ${round(a.snrDb)}`,
      ].join('\t')
    );
  }

  console.log('\n=== 处理动作 ===');
  console.log(['文件', '增益', '噪声门', '解码→输出', '体积'].join('\t'));
  for (const row of rows) {
    const r = row.report;
    console.log(
      [
        row.name,
        `${round(r.gainDb)} dB`,
        r.gateApplied
          ? '已启用（压间隙底噪）'
          : `未启用（${GATE_REASON_TEXT[r.gateReason] ?? r.gateReason ?? '—'}）`,
        `${r.sourceSampleRate}Hz/${r.sourceChannels}ch → ${r.outputSampleRate}Hz/${r.outputChannels}ch（${r.decodeNative ? '一步到位' : '经 48k 中转'}）`,
        `${kb(row.sourceBytes)} → ${kb(r.outputBytes)}`,
      ].join('\t')
    );
  }

  console.log('\n=== 质检 ===');
  console.log(['文件', '解码', '静音段', '最长/中位', '长段占比', '过冲修正', '成品峰值'].join('\t'));
  for (const row of rows) {
    const r = row.report;
    const s = r.silence ?? {};
    console.log(
      [
        row.name,
        r.decodeNative ? '一步到 32k' : '经 48k 中转',
        `${s.count ?? 0} 段`,
        `${Math.round(s.longestMs ?? 0)}/${Math.round(s.medianMs ?? 0)} ms`,
        `${Math.round((s.longShare ?? 0) * 100)}%（长段 ${s.longCount ?? 0}）`,
        r.peakLimit?.applied ? `缩 ${round(20 * Math.log10(r.peakLimit.scale))} dB` : '未触发',
        `${round(r.after?.peakDb)} dBFS`,
      ].join('\t')
    );
  }

  console.log('\n成品已写入 temp/audio-import-out/，可直接播放对比：');
  for (const row of rows) {
    console.log(`  ${path.relative(ROOT, row.outFile)}`);
  }

  win.destroy();
  clearTimeout(watchdog);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error('处理实测失败：', error);
    clearTimeout(watchdog);
    app.exit(1);
  })
);
