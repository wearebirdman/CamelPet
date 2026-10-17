/**
 * 定时随机调度器验证（跑完即退，不留进程）。
 * 用途：审查 M2 修复后，验证 idleDialogue / idleAction 两个调度器真的接上了 ——
 *       配置读取、triggerNow 触发、让路规则、SETTINGS_CHANGED 广播消费链路。
 * 用法：node tools/run-electron.cjs tools/scheduler-check.cjs
 *
 * 复用 capture-actions.cjs 的引导方式：隐藏窗口 + 生产 preload + __pet 调试入口。
 * 定时器路径（真实分钟级延迟）不在本脚本验证范围 —— 用 triggerNow 同步触发，
 * 隐藏窗口的定时器节流不影响结论。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BIG_ACTIONS = ['cheer', 'cheer2', 'dive', 'dive2'];

app.disableHardwareAcceleration();

ipcMain.handle('get-app-path', () => app.getPath('userData'));
ipcMain.handle('write-diagnostics', () => true);
ipcMain.handle('get-voice-packs', () => []);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.log('看门狗超时：60s 未完成，强制退出');
  app.exit(2);
}, 60000);

/** 断言计数 */
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` ｜ ${detail}` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
}

async function main() {
  const window = new BrowserWindow({
    width: 208,
    height: 260,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(PROJECT_ROOT, 'src', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  window.webContents.on('console-message', (_e, _level, message) => {
    if (/error|失败/i.test(message)) console.log(`  [renderer] ${message}`);
  });

  await window.loadFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'index.html'));
  await wait(2700); // bootstrap + idle 首帧

  const ask = (code, timeoutMs = 5000) =>
    Promise.race([
      window.webContents.executeJavaScript(code),
      wait(timeoutMs).then(() => '<<renderer-timeout>>'),
    ]);

  /* ---------- 1. 初始状态：跟着配置走（断言与配置比对，不写死配置值） ---------- */
  /**
   * 这里的判据必须**自含**：不能假设"配置里就是开的/关的" ——
   * 用户随时可能在设置界面改这两项，写死初值的断言会立刻变成假失败
   * （2026-10-01 实测踩过：用户把 idleDialogueEnabled 改成 false，测试就红了）。
   */
  const fs = require('fs');
  const readCfg = (f) => JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', f), 'utf8'));
  const dialogueCfg = readCfg('dialogue.json');
  const behaviorCfg = readCfg('behavior.json');

  const dialogueStatus = JSON.parse(
    await ask(`JSON.stringify(window.__pet?.idleDialogueScheduler?.status ?? null)`)
  );
  check(
    `对话调度器存在，启用状态与配置一致（配置=${dialogueCfg.idleDialogueEnabled === true ? '开' : '关'}，档位 ${dialogueCfg.idleDialogueInterval}）`,
    dialogueStatus?.enabled === (dialogueCfg.idleDialogueEnabled === true) &&
      dialogueStatus?.interval === dialogueCfg.idleDialogueInterval &&
      dialogueStatus?.scheduled === dialogueStatus?.enabled,
    JSON.stringify(dialogueStatus)
  );

  const actionStatus = JSON.parse(
    await ask(`JSON.stringify(window.__pet?.idleActionScheduler?.status ?? null)`)
  );
  check(
    `动作调度器存在，启用状态与配置一致（配置=${behaviorCfg.idleActionEnabled === true ? '开' : '关'}）`,
    actionStatus?.enabled === (behaviorCfg.idleActionEnabled === true) &&
      actionStatus?.scheduled === actionStatus?.enabled,
    JSON.stringify(actionStatus)
  );

  // 后面的"触发类"断言需要一个开着的对话调度器 —— 用广播开启（自含，不改用户配置）
  await window.webContents.send('settings-changed', { key: 'idleDialogueEnabled', value: true });
  await wait(250);
  const dialogueReady = JSON.parse(
    await ask(`JSON.stringify(window.__pet?.idleDialogueScheduler?.status ?? null)`)
  );
  check('广播开启后对话调度器就绪（后续触发断言的前提）', dialogueReady?.enabled === true, JSON.stringify(dialogueReady));

  /* ---------- 2. 对话调度器 triggerNow：真的冒气泡 ---------- */
  const bubbleBefore = await ask(`document.querySelectorAll('.bubble').length`);
  const fired = await ask(`window.__pet.idleDialogueScheduler.triggerNow()`);
  await wait(100); // dialogue.show 同步建 DOM，但保险起见等一拍
  const bubbleAfter = await ask(`document.querySelectorAll('.bubble').length`);
  const bubbleText = await ask(`document.querySelector('.bubble')?.textContent ?? ''`);
  check(
    '对话 triggerNow 返回 true 且页面出现气泡',
    fired === true && Number(bubbleAfter) === Number(bubbleBefore) + 1,
    `bubbles ${bubbleBefore}→${bubbleAfter}, text="${String(bubbleText).slice(0, 20)}"`
  );

  /* ---------- 3. 台词池同步：广播 clickLines 后新池生效 ---------- */
  await window.webContents.send('settings-changed', { key: 'clickLines', value: ['调度器验证台词'] });
  await wait(200);
  await ask(`window.__pet.idleDialogueScheduler.triggerNow()`);
  await wait(100);
  const newText = await ask(`document.querySelector('.bubble')?.textContent ?? ''`);
  check('广播 clickLines 后台词池即时更新', newText === '调度器验证台词', `text="${newText}"`);

  /* ---------- 4. 动作调度器：disabled 时 triggerNow 不动作 ---------- */
  const stateBefore = await ask(`window.__pet.animation.currentState`);
  const disabledFire = await ask(`window.__pet.idleActionScheduler.triggerNow()`);
  const stateAfterDisabled = await ask(`window.__pet.animation.currentState`);
  check(
    '动作调度器停用时 triggerNow 返回 false 且不动画面',
    disabledFire === false && stateAfterDisabled === stateBefore,
    `state=${stateAfterDisabled}`
  );

  /* ---------- 5. SETTINGS_CHANGED 广播消费链路：开动作调度器 ---------- */
  await window.webContents.send('settings-changed', { key: 'idleActionEnabled', value: true });
  await wait(200);
  const afterEnable = JSON.parse(
    await ask(`JSON.stringify(window.__pet.idleActionScheduler.status)`)
  );
  check(
    '广播 idleActionEnabled=true 后调度器启用并排时',
    afterEnable?.enabled === true && afterEnable?.scheduled === true,
    JSON.stringify(afterEnable)
  );

  /* ---------- 6. 动作 triggerNow：真的播大动作 ---------- */
  const actionFire = await ask(`window.__pet.idleActionScheduler.triggerNow()`);
  await wait(150);
  const stateAfterFire = await ask(`window.__pet.animation.currentState`);
  check(
    '动作 triggerNow 返回 true 且播的是大动作',
    actionFire === true && BIG_ACTIONS.includes(String(stateAfterFire)),
    `state=${stateAfterFire}`
  );

  /* ---------- 7. 让路规则：正在播大动作时再次触发要跳过 ---------- */
  const yieldFire = await ask(`window.__pet.idleActionScheduler.triggerNow()`);
  check('正在播大动作时再次 triggerNow 让路（返回 false）', yieldFire === false);

  /* ---------- 8. 换档：广播 interval 后档位即时生效 ---------- */
  await window.webContents.send('settings-changed', { key: 'idleActionInterval', value: '6-10' });
  await wait(200);
  const afterInterval = JSON.parse(
    await ask(`JSON.stringify(window.__pet.idleActionScheduler.status)`)
  );
  check('广播 idleActionInterval=6-10 后档位即时切换', afterInterval?.interval === '6-10', JSON.stringify(afterInterval));

  const bogusInterval = await ask(
    `window.__pet.idleActionScheduler.setInterval('不存在的档位'); JSON.stringify(window.__pet.idleActionScheduler.status)`
  );
  check(
    '非法档位回退默认 3-6（不炸不静默）',
    JSON.parse(bogusInterval)?.interval === '3-6',
    bogusInterval
  );

  /* ---------- 9. 关闭：广播 false 后停排时 ---------- */
  await window.webContents.send('settings-changed', { key: 'idleActionEnabled', value: false });
  await window.webContents.send('settings-changed', { key: 'idleDialogueEnabled', value: false });
  await wait(200);
  const finalAction = JSON.parse(await ask(`JSON.stringify(window.__pet.idleActionScheduler.status)`));
  const finalDialogue = JSON.parse(await ask(`JSON.stringify(window.__pet.idleDialogueScheduler.status)`));
  check(
    '广播关闭后两个调度器都停止排时（不留后台定时器）',
    finalAction?.enabled === false && finalAction?.scheduled === false &&
      finalDialogue?.enabled === false && finalDialogue?.scheduled === false,
    `action=${JSON.stringify(finalAction)} dialogue=${JSON.stringify(finalDialogue)}`
  );

  /* ---------- 10. 台词池为空时：不出气泡但节奏继续 ---------- */
  await window.webContents.send('settings-changed', { key: 'clickLines', value: [] });
  await window.webContents.send('settings-changed', { key: 'idleDialogueEnabled', value: true });
  await wait(200);
  const emptyFire = await ask(`window.__pet.idleDialogueScheduler.triggerNow()`);
  check('台词池为空时 triggerNow 返回 false（不报错、节奏由 schedule 维持）', emptyFire === false);

  console.log(`\n=== 调度器验证：${passed} 项通过，${failed} 项失败 ===`);
  window.destroy();
  clearTimeout(watchdog);
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(main);
