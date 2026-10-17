/**
 * 菜单「动作」子菜单的结构与派发检查。
 * 用法：node tools/run-electron.cjs temp/menu-actions-check.cjs
 *
 * 盯两件事：
 *   1. 动作是收在可展开的「动作」子菜单里（不是平铺在顶层）
 *   2. 子项点下去走 menu.js 的兜底分发（转发渲染层按 id 播 manifest 状态）
 * 跑完即退。
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

const watchdog = setTimeout(() => { console.log('看门狗超时'); app.exit(2); }, 30000);

async function main() {
  const { createMenuManager } = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'menu.js')).href
  );
  const sectionsModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'menu-dynamic.js')).href
  );
  const { listBigActions } = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'shared', 'action-catalog.js')).href
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'assets', 'skins', 'default', 'manifest.json'), 'utf8')
  );
  const actions = listBigActions(manifest);
  check('manifest 里有 4 个大动作', actions.length === 4, actions.map((a) => a.label).join(', '));

  const menuConfig = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'menu.json'), 'utf8')
  );

  const forwarded = [];
  const manager = createMenuManager({
    menuConfig,
    actions: {},
    getWindow: () => null,
    forwardToRenderer: (item) => forwarded.push(item.label ?? item.id ?? '?'),
    resolveDynamic: (name) =>
      sectionsModule.createMenuDynamicSections({
        getManifest: () => manifest,
      })[name]?.(),
  });

  const template = manager.build();
  const labels = template.filter((i) => i.label).map((i) => i.label);

  // 1. 顶层不再平铺动作名
  const flat = actions.filter((a) => labels.includes(a.label));
  check('顶层不再平铺动作名', flat.length === 0, flat.map((a) => a.label).join(', ') || '无');

  // 2. 顶层有一个可展开的「动作」
  const actionNode = template.find((i) => i.label === '动作');
  check('顶层出现「动作」子菜单', Boolean(actionNode), labels.join(' / '));
  check('「动作」是可展开的（有 submenu）', Array.isArray(actionNode?.submenu), String(actionNode?.submenu?.length));

  // 3. 子菜单里就是那四个动作，顺序与 manifest 一致
  const subLabels = (actionNode?.submenu ?? []).map((i) => i.label);
  check(
    '子菜单含 4 个动作且顺序与 manifest 一致',
    JSON.stringify(subLabels) === JSON.stringify(actions.map((a) => a.label)),
    subLabels.join(', ')
  );

  // 4. 子项 id 与状态 id 一致 —— id 不进 Electron 模板（buildTemplate 只映射 label），
  //    要断言就断言动态段构造器的**原始输出**，那才是转发渲染层的真实载荷
  const rawActionItems = sectionsModule.buildActionMenuItems({ actions }).find((i) => i.label === '动作');
  const subIds = (rawActionItems?.items ?? []).map((i) => i.id);
  check(
    '子项 id 与状态 id 一致',
    JSON.stringify(subIds) === JSON.stringify(actions.map((a) => a.value)),
    subIds.join(', ')
  );
  for (const item of actionNode?.submenu ?? []) {
    forwarded.length = 0;
    item.click();
    check(
      `点击「${item.label}」转发渲染层`,
      forwarded.length === 1 && forwarded[0] === item.label,
      forwarded.join(', ') || '(无派发)'
    );
  }

  // 5. 顶层结构
  check(
    '顶层结构 = 设置 / 动作 / 语音 / 退出',
    JSON.stringify(labels) === JSON.stringify(['设置', '动作', '语音', '退出']),
    labels.join(' / ')
  );
}

app.whenReady().then(() =>
  main()
    .then(() => {
      clearTimeout(watchdog);
      const failed = results.filter((r) => !r.pass).length;
      console.log(`\n共 ${results.length} 项，失败 ${failed} 项`);
      app.exit(failed === 0 ? 0 : 1);
    })
    .catch((error) => { console.error('检查失败：', error); clearTimeout(watchdog); app.exit(1); })
);
