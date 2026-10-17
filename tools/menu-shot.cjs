/**
 * 右键菜单的视觉验证。
 * 用途：菜单是原生弹窗，普通截图工具拍不到；这里把**真实的**菜单内容单独弹出来拍一张。
 * 用法：npm run menu-shot
 *
 * 拍三张：
 *   menu-voice.png        「语音」子菜单内容
 *   menu-voice-empty.png  停用全部语音包后的「语音」子菜单（结束前一定还原）
 *   menu-top.png          顶层整段（确认动作收进「动作」子菜单、顶层保持四项）
 *   menu-actions.png      「动作」子菜单展开后的四个动作
 *
 * 说明：
 * - 用**真实的** config/menu.json、真实语音包服务、真实动态段构造器，
 *   所以拍到的就是实际会出现在右键菜单里的内容（只是省掉了用户去悬浮展开子菜单这一步）。
 * - 会临时停用语音包来拍"没有可用语音包"的状态，**结束前一定还原**。
 * - 拍完即退，不留后台进程。
 */
const { app, BrowserWindow, Menu, screen } = require('electron');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'temp', 'capture');
const MENU_X = 240;
const MENU_Y = 200;
const GRAB_W = 420;
const GRAB_H = 420;

app.disableHardwareAcceleration();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`[menu-shot] ${msg}`);

function grabScreen(x, y, width, height, outFile) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing;',
    `$b = New-Object System.Drawing.Bitmap(${width}, ${height});`,
    '$g = [System.Drawing.Graphics]::FromImage($b);',
    `$g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size);`,
    `$b.Save('${outFile.replace(/\\/g, '\\\\')}');`,
    '$g.Dispose(); $b.Dispose();',
  ].join(' ');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
}

const watchdog = setTimeout(() => {
  log('看门狗超时：40s 未完成，强制退出');
  app.exit(2);
}, 40000);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sectionModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'menu-dynamic.js')).href
  );
  const voicepacksModule = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src', 'main', 'voicepacks.js')).href
  );
  const voicePackService = voicepacksModule.createVoicePackService();

  /**
   * 当前皮肤 manifest（顶层「动作」动态段要读它才能列出四个动作）。
   * 直接按 config/skin.json 的 activeSkin 找文件，与主进程 loadSkinManifest 同一份数据。
   */
  const skinManifest = () => {
    const skinConfig = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'skin.json'), 'utf8')
    );
    const skinId = skinConfig.activeSkin || 'default';
    return JSON.parse(
      fs.readFileSync(
        path.join(PROJECT_ROOT, 'assets', 'skins', skinId, 'manifest.json'),
        'utf8'
      )
    );
  };

  const originalPacks = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'voicepacks.json'), 'utf8')
  );

  // 这个 Electron 版本不允许"没有 BaseWindow 就弹 Menu"，所以给菜单挂一个宿主窗口。
  // 做成全透明无边框且与菜单同位置，截图里不会留下痕迹。
  const host = new BrowserWindow({
    x: MENU_X,
    y: MENU_Y,
    width: 120,
    height: 80,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
  });
  host.setIgnoreMouseEvents(true);
  host.showInactive();
  await wait(700);

  const voiceSubmenu = () => {
    const sections = sectionModule.createMenuDynamicSections({
      voicePackService,
      onPlayVoicePack: () => {},
    });    // 只取「语音」子菜单里的内容，前面几项（静音/音量）从 menu.json 原样抄过来
    const menuConfig = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'menu.json'), 'utf8')
    );
    const voice = menuConfig.items.find((item) => item.label === '语音');
    const items = voice.items.filter((item) => !item.dynamic);
    const dynamic = sections.voicePacks();
    return [...items, ...dynamic].map((item) => {
      if (item.type === 'separator') return { type: 'separator' };
      if (item.type === 'checkbox' || item.type === 'radio') {
        return { type: item.type, label: item.label, checked: false, enabled: false };
      }
      // 含 { label: '音量', items: [...] } 这种子菜单；同样灰显，只为了拍出层级
      return {
        label: item.label,
        enabled: false,
        submenu: Array.isArray(item.items)
          ? item.items.map((child) =>
              child.type === 'separator'
                ? { type: 'separator' }
                : { type: child.type ?? 'normal', label: child.label, enabled: false }
            )
          : undefined,
      };
    });
  };

  /**
   * 「动作」子菜单内容：真实 manifest 动态段，拍出四个动作的实际排布。
   * actions() 返回 [分隔线, { label:'动作', items:[四个动作] }]，子项嵌在 items 里。
   */
  const actionSubmenu = () => {
    const sections = sectionModule.createMenuDynamicSections({
      getManifest: () => skinManifest(),
    });
    const node = sections.actions().find((item) => item.label === '动作');
    return (node?.items ?? []).map((item) => ({ label: item.label, enabled: false }));
  };

  const shoot = async (template, file) => {
    // 坐标写成 (0,0)：相对宿主窗口左上角，而宿主窗口就在 MENU_X/MENU_Y，位置可控
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: host, x: 0, y: 0 });
    await wait(1200);
    const scale = screen.getPrimaryDisplay().scaleFactor || 1;
    grabScreen(
      Math.round((MENU_X - 12) * scale),
      Math.round((MENU_Y - 12) * scale),
      Math.round(GRAB_W * scale),
      Math.round(GRAB_H * scale),
      path.join(OUT_DIR, file)
    );
    menu.closePopup();
    await wait(500);
    log(`已截图 ${file}`);
  };

  /**
   * 顶层菜单整段（真实的 menu.json + 真实的动态段），
   * 用来确认动作收进了「动作」子菜单、顶层保持四项。
   * 动态段里的项一律灰显：目的是拍结构，不是点它。
   */
  const topLevelMenu = () => {
    const sections = sectionModule.createMenuDynamicSections({
      voicePackService,
      onPlayVoicePack: () => {},
      getManifest: () => skinManifest(),
    });
    const menuConfig = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'menu.json'), 'utf8')
    );
    const expand = (items) =>
      items.flatMap((item) => (item.dynamic ? (sections[item.dynamic]?.() ?? []) : [item]));

    return expand(menuConfig.items).map((item) => {
      if (item.type === 'separator') return { type: 'separator' };
      const submenu = Array.isArray(item.items)
        ? expand(item.items).map((child) =>
            child.type === 'separator'
              ? { type: 'separator' }
              : { type: child.type ?? 'normal', label: child.label, enabled: false }
          )
        : undefined;
      return {
        label: item.label,
        enabled: false,
        submenu: submenu && submenu.length > 0 ? submenu : undefined,
      };
    });
  };

  try {
    await shoot(voiceSubmenu(), 'menu-voice.png');

    // 停用全部语音包，拍"只剩静音与音量"的状态
    for (const pack of originalPacks.packs ?? []) {
      voicePackService.setEnabled(pack.id, false);
    }
    await shoot(voiceSubmenu(), 'menu-voice-empty.png');

    // 顶层整段：确认动作收进「动作」子菜单、顶层保持四项
    await shoot(topLevelMenu(), 'menu-top.png');

    // 「动作」子菜单展开后的内容
    await shoot(actionSubmenu(), 'menu-actions.png');
  } finally {
    // 无论成败都要还原
    for (const pack of originalPacks.packs ?? []) {
      voicePackService.setEnabled(pack.id, pack.enabled !== false);
    }
    const restored = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'voicepacks.json'), 'utf8')
    );
    log(
      `语音包已还原：${(restored.packs ?? [])
        .map((pack) => `${pack.id}${pack.enabled === false ? '(停用)' : ''}`)
        .join(', ')}`
    );
  }

  clearTimeout(watchdog);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error('菜单截图失败：', error);
    app.exit(1);
  })
);
