/**
 * 语音音量端到端探针（一次性，跑完即退，不留后台进程）。
 *
 * 目的：把「调了音量没作用」拆成两个互斥的结论 ——
 *   A. 链路没生效（广播没到 / setVolume 没被调 / 元素 volume 没变）
 *   B. 链路生效了，但听感差异小（音频本身录得轻、或系统音量已到顶）
 *
 * 与其它验证脚本的区别：这里不满足于读播放器自己算出来的 gain，
 * 而是读 <audio> 元素上的真实 volume，并解码音频算峰值/有效值，
 * 否则无法排除"记的值变了、元素没变"这种情况。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { app, BrowserWindow } from 'electron';

// 必须用静态 import 引入真实主进程入口，不能等 ready 之后再动态 import：
// index.js 顶层的 app.disableHardwareAcceleration() 只允许在 ready 之前调用，
// 而动态 import 的求值时机已经晚于 ready（实测报 "can only be called before app is ready"）。
import '../src/main/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VOICE_CONFIG = path.join(ROOT, 'config', 'voice.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}\n`);
}

function findWindow(fragment) {
  return BrowserWindow.getAllWindows().find(
    (win) => !win.isDestroyed() && win.webContents.getURL().includes(fragment)
  );
}

/** 备份原配置：探针会真的落盘，跑完必须还原，否则用户的音量设置被脚本改掉 */
const originalVoiceConfig = fs.readFileSync(VOICE_CONFIG, 'utf8');

let finished = false;
let watchdog = null;

async function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  try {
    fs.writeFileSync(VOICE_CONFIG, originalVoiceConfig);
    process.stdout.write(`\n已还原 config/voice.json：${originalVoiceConfig.replace(/\s+/g, ' ')}\n`);
  } catch (error) {
    process.stdout.write(`\n还原 config/voice.json 失败：${error.message}\n`);
  }
  const failed = results.filter((item) => !item.pass).length;
  process.stdout.write(`\n共 ${results.length} 项，失败 ${failed} 项\n`);
  app.exit(code ?? (failed === 0 ? 0 : 1));
}

// 设置窗口需要开着，才能验证"界面改音量 → 桌宠生效"这条真实链路。
// index.js 的 whenReady 回调读这个变量，晚于本行执行，所以顺序没问题。
process.env.CAMEL_PET_OPEN_SETTINGS = '1';

async function probe() {
  const petWin = findWindow('renderer/index.html');
  const setWin = findWindow('settings.html');

  if (!petWin || !setWin) {
    check('两个窗口都就绪', false, `pet=${Boolean(petWin)} settings=${Boolean(setWin)}`);
    return finish(3);
  }

  // 等渲染层 bootstrap 完成（__pet 挂上才算）
  for (let i = 0; i < 30; i += 1) {
    const ready = await petWin.webContents.executeJavaScript('Boolean(window.__pet?.player)');
    if (ready) break;
    await sleep(200);
  }
  const rendererReady = await petWin.webContents.executeJavaScript('Boolean(window.__pet?.player)');
  if (!rendererReady) {
    check('桌宠渲染层就绪（window.__pet.player 存在）', false);
    return finish(3);
  }
  check('桌宠渲染层就绪（window.__pet.player 存在）', true);

  const readStatus = () => petWin.webContents.executeJavaScript('window.__pet.player.status');
  const writeVolume = (value) =>
    setWin.webContents.executeJavaScript(`window.petAPI.setSetting('voiceVolume', ${value})`);

  /* ---------- 1. 初始状态 ---------- */
  const initial = await readStatus();
  check(
    '初始 volume 来自 config/voice.json',
    initial.volume === 100 && initial.elementVolume === 1,
    `volume=${initial.volume} elementVolume=${initial.elementVolume}`
  );

  /* ---------- 2. 设置界面写音量 → 桌宠即时生效 ---------- */
  const writeResult = await writeVolume(25);
  check('设置界面写入 voiceVolume=25 被接受', writeResult?.ok === true, JSON.stringify(writeResult));

  await sleep(400);
  const after25 = await readStatus();
  check('广播后桌宠 player.volume 变为 25', after25.volume === 25, `volume=${after25.volume}`);
  check(
    '音频元素实际 volume 变为 0.25（不是只改了内部记录值）',
    after25.elementVolume === 0.25,
    `elementVolume=${after25.elementVolume}`
  );

  const onDisk = JSON.parse(fs.readFileSync(VOICE_CONFIG, 'utf8'));
  check('配置已落盘 volume=25', onDisk.volume === 25, `disk volume=${onDisk.volume}`);

  /* ---------- 3. 边界：0 与 100 ---------- */
  await writeVolume(0);
  await sleep(300);
  const atZero = await readStatus();
  check('音量 0 时元素 volume 为 0', atZero.elementVolume === 0, `elementVolume=${atZero.elementVolume}`);

  await writeVolume(100);
  await sleep(300);
  const atHundred = await readStatus();
  check(
    '音量 100 时元素 volume 为 1',
    atHundred.elementVolume === 1,
    `elementVolume=${atHundred.elementVolume}`
  );

  /* ---------- 4. 播放中改音量是否即时生效 ---------- */
  await writeVolume(100);
  await sleep(200);
  const duringPlay = await petWin.webContents.executeJavaScript(`(async () => {
    const player = window.__pet.player;
    const packs = await player.refresh();
    const pack = packs.find((candidate) => candidate.url) ?? null;
    if (!pack) return { error: 'no-playable-pack' };
    player.play(pack);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const playingAtFull = player.status;
    player.setVolume(25);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const playingAtQuarter = player.status;
    return {
      packName: pack.name,
      elementAtFull: playingAtFull.elementVolume,
      elementAtQuarter: playingAtQuarter.elementVolume,
      stillPlaying: playingAtQuarter.playing,
    };
  })()`);

  if (duringPlay.error) {
    check('存在可播放语音包', false, duringPlay.error);
  } else {
    check(
      '播放中把音量调到 25 立即反映到元素上',
      duringPlay.elementAtFull === 1 && duringPlay.elementAtQuarter === 0.25,
      `${duringPlay.packName}: ${duringPlay.elementAtFull} → ${duringPlay.elementAtQuarter}`
    );
    check('改音量不会打断正在播放的音频', duringPlay.stillPlaying === true);
  }

  /* ---------- 5. 音频本身的响度（决定"听感差异是否明显"） ---------- */
  const loudness = await petWin.webContents.executeJavaScript(`(async () => {
    const packs = await window.__pet.player.refresh();
    const pack = packs.find((candidate) => candidate.url) ?? null;
    if (!pack) return { error: 'no-pack' };
    const response = await fetch(pack.url);
    const buffer = await response.arrayBuffer();
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(buffer);
    const data = decoded.getChannelData(0);
    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
      sumSquares += data[i] * data[i];
    }
    const rms = Math.sqrt(sumSquares / data.length);
    await context.close();
    return {
      name: pack.name,
      bytes: pack.bytes,
      duration: decoded.duration,
      channels: decoded.numberOfChannels,
      sampleRate: decoded.sampleRate,
      peak,
      rms,
      peakDb: 20 * Math.log10(peak),
      rmsDb: 20 * Math.log10(rms),
    };
  })()`);

  if (loudness.error) {
    check('解码音频算响度', false, loudness.error);
  } else {
    const round = (value) => Math.round(value * 1000) / 1000;
    check(
      '音频信息',
      true,
      `${loudness.name}  ${round(loudness.duration)}s  ${loudness.channels}ch  ${loudness.sampleRate}Hz  ${loudness.bytes}B`
    );
    check(
      '音频峰值电平（决定音量拉小后是否听得出来）',
      true,
      `peak=${round(loudness.peak)} (${round(loudness.peakDb)} dBFS)  rms=${round(loudness.rms)} (${round(loudness.rmsDb)} dBFS)`
    );
  }

  /* ---------- 6. 拖动期间的实时预览：即时可听，但不写配置 ---------- */
  await writeVolume(60);
  await sleep(300);
  const diskBefore = JSON.parse(fs.readFileSync(VOICE_CONFIG, 'utf8')).volume;

  const previewAccepted = await setWin.webContents.executeJavaScript(
    "window.petAPI.previewSetting('voiceVolume', 35)"
  );
  await sleep(300);
  const afterPreview = await readStatus();
  check('拖动预览被接受', previewAccepted?.ok === true, JSON.stringify(previewAccepted));
  check(
    '拖动预览立刻改变元素音量（不用等松手）',
    afterPreview.elementVolume === 0.35,
    `elementVolume=${afterPreview.elementVolume}`
  );

  const diskAfter = JSON.parse(fs.readFileSync(VOICE_CONFIG, 'utf8')).volume;
  check('拖动预览不写配置（松手才落盘）', diskAfter === diskBefore, `disk=${diskBefore} → ${diskAfter}`);

  const previewRejected = await setWin.webContents.executeJavaScript(
    "window.petAPI.previewSetting('bubbleDurationMs', 3000)"
  );
  check(
    '未标 preview 的项拒绝预览（防止界面广播任意键影响桌宠）',
    previewRejected?.ok === false && previewRejected.reason === 'no-preview',
    JSON.stringify(previewRejected)
  );

  const previewUnknown = await setWin.webContents.executeJavaScript(
    "window.petAPI.previewSetting('not-a-real-key', 1)"
  );
  check('未知设置项拒绝预览', previewUnknown?.ok === false && previewUnknown.reason === 'unknown-key', JSON.stringify(previewUnknown));

  /* ---------- 7. 音量旁的「试听」按钮 ---------- */
  await writeVolume(80);
  await sleep(200);
  const sampleClick = await setWin.webContents.executeJavaScript(`(async () => {
    window.__settings.selectCategory('behavior');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const row = document.querySelector('[data-item-id="voiceVolume"]');
    if (!row) return { error: 'no-volume-row' };
    const button = row.querySelector('[data-action="sample"]');
    if (!button) return { error: 'no-sample-button' };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { clicked: true, label: button.textContent };
  })()`);

  if (sampleClick.error) {
    check('音量设置旁有「试听」按钮', false, sampleClick.error);
  } else {
    check('音量设置旁有「试听」按钮', sampleClick.label === '试听', `label=${sampleClick.label}`);
    const afterSample = await readStatus();
    check(
      '点「试听」后桌宠窗口确实在播放',
      afterSample.readyState >= 2 && afterSample.errorCode === null,
      `readyState=${afterSample.readyState} playing=${afterSample.playing} error=${afterSample.errorCode}`
    );
  }

  /* ---------- 8. 桌宠窗口隐藏时是否仍同步 ---------- */
  petWin.hide();
  await sleep(200);
  await writeVolume(40);
  await sleep(400);
  const hiddenStatus = await readStatus();
  check(
    '桌宠窗口隐藏时音量仍会同步',
    hiddenStatus.elementVolume === 0.4,
    `elementVolume=${hiddenStatus.elementVolume}`
  );
  petWin.show();
}

/**
 * 注意：这里刻意不用顶层 await。
 * Electron 要等主进程脚本**求值结束**才发 ready，而顶层 await 会挂住求值，
 * 若在顶层 await 里又去等 app.whenReady()，两边互相等 → 永远卡住（实测踩过）。
 */
async function main() {
  // 保险丝：任何一步卡住都强制退出，绝不把 Electron 挂在后台占住用户
  watchdog = setTimeout(() => {
    process.stdout.write('\n超时，强制退出\n');
    finish(2);
  }, 60000);

  await app.whenReady();
  await sleep(2500);

  await probe();
  await finish(0);
}

main().catch(async (error) => {
  process.stdout.write(`\n探针异常：${error?.stack ?? error}\n`);
  await finish(1);
});
