/**
 * electron-builder 打包后钩子：把桌面入口换成「自检启动器」。
 *
 * 做两件事：
 *   1. 把 electron-builder 生成的 CamelPet.exe 改名成 CamelPetCore.exe
 *   2. 把仓库根的 CamelPet.exe（csc 编译出的启动器）复制成新的 CamelPet.exe
 *
 * 为什么要这样：
 *   某些受限 Windows 环境里 Chromium 沙箱初始化会被拒，进程在 main.js 之前就以
 *   0x80000003 崩溃 —— 双击表现为"完全没反应"。这个参数只能从命令行传，所以在 JS 里设无效。
 *   换成启动器后：
 *     - 正常电脑：启动器先按标准方式启动，行为与不换完全一致
 *     - 受限电脑：检测到 0x80000003 后自动加 --no-sandbox 重试
 *   安装包快捷方式、便携版、资源管理器里双击，走的都是同一个入口，不用各自记参数。
 */
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const dir = context.appOutDir;
  const coreName = 'CamelPetCore.exe';
  const entryName = 'CamelPet.exe';
  const sourceExe = path.join(dir, entryName);
  const coreExe = path.join(dir, coreName);
  const launcher = path.join(__dirname, '..', entryName);

  if (!fs.existsSync(sourceExe)) {
    throw new Error(`[after-pack] 没找到打包出的 ${entryName}：${sourceExe}`);
  }
  if (!fs.existsSync(launcher)) {
    throw new Error(`[after-pack] 没找到启动器 ${launcher}，请先运行 node tools/build-launcher.cjs`);
  }

  if (fs.existsSync(coreExe)) {
    fs.unlinkSync(coreExe);
  }
  fs.renameSync(sourceExe, coreExe);
  fs.copyFileSync(launcher, sourceExe);

  console.log(`[after-pack] 入口已换成启动器：${entryName} -> ${coreName}`);
};
