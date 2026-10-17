/**
 * 皮肤切换验证（跑完即退）。
 *
 * 验证的不是"配置写进去了"，而是**换皮肤整套资源真的跟着换**：
 *   形象素材（manifest） + 台词（dialogue.json） + 语音包（voicepacks.json + audio/）
 *   三者必须同时变 —— 少一样就会出现"换了形象却还说着上一套的台词/声音"。
 *
 * 跑真实链路：静态 import 真 index.js（真 IPC、真 applier、真 setSkin），
 * 断言全部通过渲染层的真 petAPI 与窗口内真状态驱动，不自己复刻逻辑。
 *
 * 用法：node tools/run-electron.cjs tools/skin-check.mjs
 */
import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import '../src/main/index.js';

/** 主进程侧能力直接调（渲染层没有 fs，读不到目录与路径） */
const { listSkins, loadSkinConfig, resolveVoicePaths } = await import('../src/main/config.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.log('看门狗超时'); app.exit(2); }, 120000);

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ｜ ${detail}` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
}

/** 桌宠窗口（加载 index.html 的那个） */
function petWindow() {
  return BrowserWindow.getAllWindows().find((w) => {
    const url = w.webContents?.getURL?.() ?? '';
    return url.includes('index.html');
  });
}

async function waitForPet(timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const win = petWindow();
    if (win) {
      return win;
    }
    await wait(300);
  }
  return null;
}

/**
 * 在桌宠窗口里跑一段 JS（真 petAPI / 真渲染层状态）。
 * 参数以 JSON 字面量内联（这里只需要传字符串 id，够用且不引入额外序列化机制）。
 */
async function inPet(fnSource, ...args) {
  const win = await waitForPet();
  if (!win) {
    return null;
  }
  const argsLiteral = args.length ? JSON.stringify(args).slice(1, -1) : '';
  return win.webContents.executeJavaScript(`(${fnSource})(${argsLiteral})`);
}

async function main() {
  await app.whenReady();
  await wait(2500); // 等 index.js 装配：窗口 + IPC + 托盘

  const skins = listSkins();
  check('皮肤列表非空', skins.length > 0, JSON.stringify(skins.map((s) => s.id)));

  const other = skins.find((s) => s.id !== 'default') ?? null;
  check('存在第二套皮肤（否则切换无从验证）', Boolean(other), other?.id ?? '只有 default');
  if (!other) {
    console.log('\n提示：复制 assets/skins/default 一份、改 manifest.label 即可得到第二套皮肤。');
    clearTimeout(watchdog);
    app.exit(failed ? 1 : 0);
    return;
  }

  // ① 基线
  const before = {
    skin: loadSkinConfig().activeSkin,
    voice: resolveVoicePaths(),
    pet: await inPet(`async () => ({ skinId: window.__pet?.skinId ?? null, lines: window.__pet?.getLines?.() ?? [] })`),
  };

  // ② 走真链路切换：渲染层 petAPI → IPC → 主进程 setSkin
  const switched = await inPet(`async (id) => await window.petAPI.setSkin(id)`, other.id);
  check(`通过 petAPI 切换到 ${other.id}`, switched?.ok === true, JSON.stringify(switched));
  check('activeSkin 已落盘', loadSkinConfig().activeSkin === other.id, loadSkinConfig().activeSkin);

  // ③ 语音包：清单与音频目录随皮肤走
  const afterVoice = resolveVoicePaths();
  check('语音包清单/音频目录已切到新皮肤',
    afterVoice.packsPath !== before.voice.packsPath && afterVoice.packsPath.includes(other.id),
    afterVoice.packsPath.replace(PROJECT_ROOT, '.'));

  // ④ 渲染层重载后：skinId 与台词池都换成新的
  await wait(4000);
  const after = await inPet(`async () => ({ skinId: window.__pet?.skinId ?? null, lines: window.__pet?.getLines?.() ?? [] })`);
  const beforeLines = (before.pet?.lines ?? []).join('|');
  const afterLines = (after?.lines ?? []).join('|');
  check('渲染层 skinId 已更新', after?.skinId === other.id, String(after?.skinId));
  check('台词池已换成新皮肤的（换皮肤 ≠ 只换形象）',
    afterLines.length > 0 && afterLines !== beforeLines,
    `旧: ${beforeLines.slice(0, 24)} → 新: ${afterLines.slice(0, 24)}`);

  // ④.5 设置界面的「读值」也必须随皮肤。
  //     台词是皮肤级的：写侧走 saveSkinDialogue，读侧若还固定读 config/dialogue.json，
  //     会出现"改动能保存、重开设置又弹回旧值"的读写不一致（2026-10-10 修复项）。
  const skinDialogue = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'assets', 'skins', other.id, 'dialogue.json'), 'utf8')
  );
  const settingsRead = await inPet(`async () => {
    const s = await window.petAPI.getSettings();
    return { lines: s.values.clickLines, bubble: s.values.bubbleDurationMs };
  }`);
  check('设置读值随皮肤：台词池读到的是新皮肤自己的',
    JSON.stringify(settingsRead?.lines ?? []) === JSON.stringify(skinDialogue.click?.lines ?? []),
    JSON.stringify(settingsRead?.lines ?? []).slice(0, 60));
  check('设置读值随皮肤：气泡时长读到的是新皮肤的',
    settingsRead?.bubble === skinDialogue.bubbleDurationMs,
    `settings=${settingsRead?.bubble} skin=${skinDialogue.bubbleDurationMs}`);

  // ⑤ 可逆
  const back = await inPet(`async () => await window.petAPI.setSkin('default')`);
  check('切回 default 成功', back?.ok === true, JSON.stringify(back));
  check('activeSkin 已还原', loadSkinConfig().activeSkin === 'default');

  // ⑤.2 default 皮肤没自带台词 → 设置读值应回落到全局 config/dialogue.json（回落路径也要对）
  await wait(4000);
  const globalDialogue = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'dialogue.json'), 'utf8')
  );
  const backRead = await inPet(`async () => {
    const s = await window.petAPI.getSettings();
    return { lines: s.values.clickLines };
  }`);
  check('切回 default 后设置读值回落到全局台词配置',
    JSON.stringify(backRead?.lines ?? []) === JSON.stringify(globalDialogue.click?.lines ?? []),
    JSON.stringify(backRead?.lines ?? []).slice(0, 60));

  // ⑥ 非法皮肤必须被拒，且不能把配置写坏
  const bogus = await inPet(`async () => await window.petAPI.setSkin('__no_such_skin__')`);
  check('未知皮肤被拒绝且配置未写坏',
    bogus?.ok === false && loadSkinConfig().activeSkin === 'default',
    JSON.stringify(bogus));

  console.log(`\n结果: ${failed === 0 ? 'PASS' : 'FAIL'}（共 ${passed + failed} 项断言）`);
  clearTimeout(watchdog);
  app.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('skin-check 异常：', error);
  clearTimeout(watchdog);
  app.exit(1);
});
