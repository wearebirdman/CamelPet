/**
 * 菜单「语音」项的派发检查。
 * 用法：npm run menu-volume
 *
 * 为什么单独做这个：音量档位写在 config/menu.json，处理函数登记在 src/main/index.js，
 * 两处靠一个字符串（'voice:volume:25'）对接。一旦哪边改了名字，症状是**静默失效** ——
 * 点下去没报错、没效果，只是被兜底转发给了渲染层。这个脚本专门盯这条缝。
 *
 * 做法：用**真实的** config/menu.json 和**真实的** createMenuManager 生成菜单模板，
 * 直接调用模板项上的 click（就是线上菜单点击时执行的那个函数），
 * 看它是否按预期去查主进程动作表。跑完即退，不留后台进程。
 */
const { app } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

app.disableHardwareAcceleration();

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
}

/** 深度优先找 label 对应的模板项 */
function findByLabel(items, label) {
  for (const item of items) {
    if (item.label === label) return item;
    if (Array.isArray(item.submenu)) {
      const found = findByLabel(item.submenu, label);
      if (found) return found;
    }
  }
  return null;
}

/** 收集菜单配置里声明的全部 action 名 */
function collectActions(items, out = []) {
  for (const item of items) {
    if (typeof item.action === 'string') out.push(item.action);
    if (Array.isArray(item.items)) collectActions(item.items, out);
  }
  return out;
}

const watchdog = setTimeout(() => {
  console.log('看门狗超时：30s 未完成，强制退出');
  app.exit(2);
}, 30000);

async function main() {
  const { createMenuManager } = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'menu.js')).href
  );

  const menuConfig = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'menu.json'), 'utf8')
  );
  const indexSource = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'index.js'), 'utf8');

  // 真实档位从 index.js 源码解析，不在这里另写一份 —— 否则脚本自己也会跟实现脱节
  const levelsMatch = indexSource.match(/const VOLUME_LEVELS = (\[[^\]]*\]);/);
  const levels = levelsMatch ? JSON.parse(levelsMatch[1]) : null;
  check('能从 index.js 解析出 VOLUME_LEVELS', Array.isArray(levels), JSON.stringify(levels));

  // 主进程真正登记的动作名（生成的音量档位 + 手写的固定项）
  const registered = new Set((levels ?? []).map((level) => `voice:volume:${level}`));
  for (const key of ['quit', 'hide', 'show', 'settings:open', 'voice:toggle-mute']) {
    // 动作表里的 key 有的带引号（'voice:toggle-mute'）有的不带（quit），按"对象键"整体匹配
    const asKey = new RegExp(`(^|[\\s,{])['"]?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*:`, 'm');
    if (asKey.test(indexSource)) registered.add(key);
  }
  check('解析出主进程动作表', registered.size >= 6, `${registered.size} 个：${[...registered].join(', ')}`);

  // 用桩动作表记录"点击时查了哪个 key"；桩里只放真实登记过的名字，
  // 所以菜单若查了一个不存在的名字，calls 里就不会出现它 —— 正好暴露脱节
  const calls = [];
  const actions = Object.fromEntries(
    [...registered].map((key) => [key, () => { calls.push(key); }])
  );

  const manager = createMenuManager({
    menuConfig,
    actions,
    getWindow: () => null,
    forwardToRenderer: (item) => calls.push(`forward:${item.label ?? item.id ?? '?'}`),
    resolveDynamic: () => [],
  });

  const template = manager.build();

  /* ---------- 1. 每个音量档位点下去都命中主进程动作 ---------- */
  for (const level of levels ?? []) {
    const label = level === 0 ? '静音（0%）' : `${level}%`;
    const item = findByLabel(template, label);
    if (!item) {
      check(`菜单项「${label}」存在`, false);
      continue;
    }
    calls.length = 0;
    item.click();
    check(
      `点击「${label}」派发到 voice:volume:${level}`,
      calls.length === 1 && calls[0] === `voice:volume:${level}`,
      calls.join(', ') || '(无派发)'
    );
  }

  /* ---------- 2. 静音开关 ---------- */
  const muteItem = findByLabel(template, '静音');
  if (!muteItem) {
    check('菜单项「静音」存在', false);
  } else {
    calls.length = 0;
    muteItem.click();
    check('点击「静音」派发到 voice:toggle-mute', calls[0] === 'voice:toggle-mute', calls.join(', ') || '(无派发)');
  }

  /* ---------- 3. 菜单声明的 action 全都登记过（防"改了配置忘了登记"） ---------- */
  const declared = [...new Set(collectActions(menuConfig.items))];
  const missing = declared.filter((action) => !registered.has(action));
  check(
    'menu.json 里的 action 全都在主进程登记过',
    missing.length === 0,
    missing.length ? `缺失：${missing.join(', ')}` : `${declared.length} 个全部命中`
  );

  /* ---------- 4. 档位覆盖：菜单里有的档位就是全部档位，不多不少 ---------- */
  const menuVolumeLevels = declared
    .filter((action) => action.startsWith('voice:volume:'))
    .map((action) => Number(action.split(':').pop()))
    .sort((a, b) => a - b);
  const expected = [...(levels ?? [])].sort((a, b) => a - b);
  check(
    '菜单音量档位与主进程档位一一对应',
    JSON.stringify(menuVolumeLevels) === JSON.stringify(expected),
    `菜单=${JSON.stringify(menuVolumeLevels)} 主进程=${JSON.stringify(expected)}`
  );

  /* ---------- 5. 语音包动态段之外，「语音」子菜单不该再有占位项 ---------- */
  const voiceSubmenu = menuConfig.items.find((item) => item.label === '语音');
  const placeholders = (voiceSubmenu?.items ?? []).filter(
    (item) => item.enabled === false
  );
  check(
    '「语音」子菜单没有残留的灰显占位项',
    placeholders.length === 0,
    placeholders.map((item) => item.label).join(', ') || '无'
  );
}

app.whenReady().then(() =>
  main()
    .then(() => {
      clearTimeout(watchdog);
      const failed = results.filter((item) => !item.pass).length;
      console.log(`\n共 ${results.length} 项，失败 ${failed} 项`);
      app.exit(failed === 0 ? 0 : 1);
    })
    .catch((error) => {
      console.error('菜单音量检查失败：', error);
      clearTimeout(watchdog);
      app.exit(1);
    })
);
