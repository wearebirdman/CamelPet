/**
 * 编译「自检启动器」：launcher/CamelPetLauncher.cs -> 仓库根目录的 CamelPet.exe
 *
 * 用系统自带的 .NET Framework csc，不依赖额外 SDK：
 *   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
 *
 * 产物是 GUI 子系统（winexe），双击不会闪黑框。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'launcher', 'CamelPetLauncher.cs');
const OUTPUT = path.join(ROOT, 'CamelPet.exe');
const ICON = path.join(ROOT, 'assets', 'icons', 'app-icon.ico');

/** 找一个可用的 csc.exe（64 位优先） */
function findCompiler() {
  const candidates = [
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) {
    throw new Error('找不到 csc.exe（.NET Framework 4.0 编译器），无法生成启动器');
  }
  return found;
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`缺少启动器源码：${SOURCE}`);
  }

  const args = [
    '/nologo',
    '/target:winexe', // GUI 子系统：双击不弹控制台
    '/optimize+',
    '/codepage:65001',
    `/out:${OUTPUT}`,
    '/r:System.Windows.Forms.dll',
  ];
  if (fs.existsSync(ICON)) {
    args.push(`/win32icon:${ICON}`);
  }
  args.push(SOURCE);

  // 源码必须以 UTF-8 BOM 保存，否则 csc 会按 ANSI 读中文注释而报错
  const raw = fs.readFileSync(SOURCE);
  const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  if (!hasBom) {
    fs.writeFileSync(SOURCE, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]));
  }

  execFileSync(findCompiler(), args, { stdio: 'inherit' });
  const size = fs.statSync(OUTPUT).size;
  console.log(`启动器已生成：${path.basename(OUTPUT)}（${(size / 1024).toFixed(1)} KB）`);
}

try {
  main();
} catch (error) {
  console.error('[build-launcher] 失败：', error.message);
  process.exit(1);
}
