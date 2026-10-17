/**
 * 可写数据根验证（打包态链路）。
 *
 * ## 为什么需要它
 * 打包后 config/ 与语音包数据都落在 userData（app.asar 只读），可 9 套回归脚本跑的全是
 * 开发态（数据根 == 包根），**覆盖不到这条链路**。等到打完包在实机上才发现设置存不进去，
 * 代价太大。所以这里用纯 Node（不启 Electron）复现打包态：
 *
 *     setupDataRoot({ packaged: true, userDataDir: <临时目录> })
 *
 * 跑完即退，不启窗口、不留后台进程、不动仓库里的任何文件。
 *
 * ## 覆盖的契约
 *   A. 播种：首次运行把出厂默认数据补进数据根（含"清单 + 音频"成对数据）
 *   B. 不播种只读 schema：settings.json / menu.json 永远只从包内读（升级后新增项才能生效）
 *   C. 不播种素材：sprites / manifest 留在包里（60 MB 级，不该被拷一份）
 *   D. 写只落数据根；读"数据根优先、包内兜底"
 *   E. 皮肤级写入跟着皮肤走：default 落全局 config/，自带台词/语音的皮肤落自己目录
 *   F. 语音包的 exists/url 在打包态仍然成立（播种把清单与音频对齐到一个根）
 *   G. 出厂默认文件一个字节都没被改（跑前跑后的物理快照比对）
 *
 * 两条纪律（沿用本项目的验证要求）：
 *   ① 断言自含 —— 不依赖用户当前配置的初值；对照值全部现场从包内读出来用。
 *   ② 收尾基于物理快照 —— 用快照证明"没动过仓库文件"，而不是靠"我记得没写"。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ROOT_DIR,
  loadConfig,
  loadConfigOrDefault,
  loadSkinConfig,
  resolveSkinAsset,
  resolveVoicePaths,
  saveConfig,
  saveSkinDialogue,
  seedUserData,
  getDataRoot,
  hasSeparateDataRoot,
  setupDataRoot,
} from '../src/main/config.js';
import { createVoicePackService } from '../src/main/voicepacks.js';

/** 临时 userData（脚本自己的草稿区，跑完删掉；在项目 temp/ 下便于观察） */
const SCRATCH = path.join(ROOT_DIR, 'temp', '_userdata-check');
const SCRATCH_USER_DATA = path.join(SCRATCH, 'userData');
const SCRATCH_DATA_ROOT = path.join(SCRATCH_USER_DATA, 'data');

/** 只读 schema：不播种、也不参与"数据根优先" */
const READONLY_SCHEMA = ['settings.json', 'menu.json'];

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 跑前/跑后的物理快照：包内"可能被误写"的区域（config 全部 + 素材元数据 + 语音素材） */
function snapshotPackage() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // sprites 是只读素材（几十万张 png），只记目录存在性，不逐个进快照
        if (entry.name === 'sprites') {
          files.push(`${path.relative(ROOT_DIR, full)}/ [目录]`);
          continue;
        }
        walk(full);
      } else {
        const stat = fs.statSync(full);
        files.push(`${path.relative(ROOT_DIR, full)}|${stat.size}|${stat.mtimeMs}`);
      }
    }
  };
  walk(path.join(ROOT_DIR, 'config'));
  walk(path.join(ROOT_DIR, 'assets', 'audio'));
  walk(path.join(ROOT_DIR, 'assets', 'icons'));
  for (const skin of ['default', 'sample-camel']) {
    for (const name of ['manifest.json', 'dialogue.json', 'voicepacks.json']) {
      const file = path.join(ROOT_DIR, 'assets', 'skins', skin, name);
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        files.push(`${path.relative(ROOT_DIR, file)}|${stat.size}|${stat.mtimeMs}`);
      }
    }
    const audioDir = path.join(ROOT_DIR, 'assets', 'skins', skin, 'audio');
    if (fs.existsSync(audioDir)) {
      walk(audioDir);
    }
  }
  return files.sort();
}

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(path.relative(dir, full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** 绕过"数据根优先"直接读**包内**那份 config 文件 —— 断言"出货文件没被改"必须走这条 */
function readPackageConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config', name), 'utf8'));
}

function main() {
  console.log('可写数据根验证（打包态链路）\n');

  // ---- 0. 干净的草稿区 + 包内物理快照 ----
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH_USER_DATA, { recursive: true });
  const packageBefore = snapshotPackage();
  check('0. 包内快照已采集（对照基线）', packageBefore.length > 0, `${packageBefore.length} 项`);

  // 对照值全部现场从包内读出来，不写死
  const packageSkin = loadConfig('skin.json');
  const packageDialogue = loadConfig('dialogue.json');
  const packageVoicePacks = loadConfig('voicepacks.json');
  const packageAudioFiles = fs.readdirSync(path.join(ROOT_DIR, 'assets', 'audio'));

  // ---- 1. 切到打包态数据根 + 播种 ----
  console.log('\n[1] setupDataRoot(packaged) 与播种');
  const setup = setupDataRoot({ packaged: true, userDataDir: SCRATCH_USER_DATA });
  check('数据根指向 userData 下的 data 目录', setup.dataRoot === SCRATCH_DATA_ROOT, setup.dataRoot);
  check('判定为"数据与包已分离"', setup.separate === true && hasSeparateDataRoot() === true);
  check('播种了出厂默认文件', setup.copied > 0, `copied=${setup.copied}`);
  check('getDataRoot() 与 setup 返回一致', getDataRoot() === setup.dataRoot);

  const seeded = listFiles(SCRATCH_DATA_ROOT);
  const has = (rel) => seeded.includes(rel);

  // A. 播种内容
  check('A1 config 下的可改配置已播种（skin.json）', has('config/skin.json'));
  check('A2 台词/语音清单已播种（dialogue.json / voicepacks.json）',
    has('config/dialogue.json') && has('config/voicepacks.json'));
  check('A3 全局语音素材已播种', packageAudioFiles.every((name) => has(`assets/audio/${name}`)),
    packageAudioFiles.join(','));
  check('A4 皮肤自带台词已播种（sample-camel）',
    has('assets/skins/sample-camel/dialogue.json'));
  check('A5 皮肤自带语音清单与音频已播种（清单与音频同处一个根）',
    has('assets/skins/sample-camel/voicepacks.json')
    && has('assets/skins/sample-camel/audio/siuuu.wav'));

  // B. 只读 schema 不播种
  check('B1 只读 schema 不播种（settings.json / menu.json 不在数据根）',
    READONLY_SCHEMA.every((name) => !has(`config/${name}`)));

  // C. 素材不播种
  check('C1 sprites 不播种（留在包里）',
    !seeded.some((rel) => rel.includes('/sprites/')));
  check('C2 manifest 不播种（留在包里）',
    !seeded.some((rel) => rel.endsWith('manifest.json')));

  // ---- 2. 读：数据根优先、包内兜底 ----
  console.log('\n[2] 读路径');
  check('2.1 读到的 skin.json 与包内出厂值一致', loadSkinConfig().activeSkin === packageSkin.activeSkin,
    JSON.stringify(loadSkinConfig()));
  // 反例注入：把数据根那份改成"另一个皮肤"，读必须跟着数据根走（证明优先的是数据根，不是包内）
  saveConfig(['skin.json'], { activeSkin: '__probe__' });
  check('2.2 反例注入：数据根那份改了就以数据根为准（证明"数据根优先"真的生效）',
    loadSkinConfig().activeSkin === '__probe__',
    `实际 ${loadSkinConfig().activeSkin}`);
  check('2.3 包内那份没被这次写入碰到（直接读包内文件，绕过数据根优先）',
    readPackageConfig('skin.json').activeSkin === packageSkin.activeSkin,
    readPackageConfig('skin.json').activeSkin);
  fs.writeFileSync(path.join(SCRATCH_DATA_ROOT, 'config', 'skin.json'),
    `${JSON.stringify(packageSkin, null, 2)}\n`, 'utf8'); // 还原草稿

  // 兜底：把数据根那份临时挪走，读必须回落到包内（打包后首次运行就是这条路径）。
  // 先往数据根那份写一个标记，这样"读到的是包内那份"才区分得出来（两份内容否则一模一样）。
  const behaviorInData = path.join(SCRATCH_DATA_ROOT, 'config', 'behavior.json');
  const behaviorBackup = `${behaviorInData}.probe-bak`;
  saveConfig(['behavior.json'], { __marker__: 1 });
  fs.renameSync(behaviorInData, behaviorBackup);
  const fallback = loadConfigOrDefault(null, 'behavior.json');
  check('2.4 数据根缺失时回落到包内出厂值（打包后首次运行的路径）',
    fallback !== null && fallback.__marker__ === undefined,
    JSON.stringify(fallback));
  fs.renameSync(behaviorBackup, behaviorInData); // 原样还原：下面 [6] 幂等性要基于"数据根完整"
  check('2.5 只读 schema 只认包内那份（数据根里不存在，也读得到）',
    !fs.existsSync(path.join(SCRATCH_DATA_ROOT, 'config', 'settings.json'))
    && Array.isArray(loadConfig('settings.json').categories));

  // ---- 3. 写：只落数据根 ----
  console.log('\n[3] 写路径');
  saveConfig(['window.json'], { __probe__: 1 });
  check('3.1 saveConfig 写在数据根',
    JSON.parse(fs.readFileSync(path.join(SCRATCH_DATA_ROOT, 'config', 'window.json'), 'utf8'))
      .__probe__ === 1);
  check('3.2 包内 window.json 未出现该键', readPackageConfig('window.json').__probe__ === undefined);

  // ---- 4. 皮肤级写入跟着皮肤走 ----
  console.log('\n[4] 皮肤级写入');
  saveSkinDialogue({ bubbleDurationMs: 4321 });                       // 当前皮肤 default
  saveSkinDialogue({ bubbleDurationMs: 4321 }, 'sample-camel');       // 自带台词的皮肤
  const defaultDialogueInData = path.join(SCRATCH_DATA_ROOT, 'config', 'dialogue.json');
  const skinDialogueInData = path.join(SCRATCH_DATA_ROOT, 'assets', 'skins', 'sample-camel', 'dialogue.json');
  check('4.1 default 皮肤（不自带台词）→ 写全局 config/dialogue.json',
    JSON.parse(fs.readFileSync(defaultDialogueInData, 'utf8')).bubbleDurationMs === 4321);
  check('4.2 自带台词的皮肤 → 写自己目录下的 dialogue.json',
    JSON.parse(fs.readFileSync(skinDialogueInData, 'utf8')).bubbleDurationMs === 4321);
  check('4.3 包内台词都没被改（两份都直接读包内文件核对）',
    readPackageConfig('dialogue.json').bubbleDurationMs === packageDialogue.bubbleDurationMs
    && JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'assets', 'skins', 'sample-camel', 'dialogue.json'), 'utf8'))
      .bubbleDurationMs !== 4321);
  check('4.4 读侧与写侧同一套解析（读回来就是刚写进去的）',
    JSON.parse(fs.readFileSync(resolveSkinAsset(undefined, 'dialogue.json'), 'utf8')).bubbleDurationMs === 4321
    && JSON.parse(fs.readFileSync(resolveSkinAsset('sample-camel', 'dialogue.json'), 'utf8')).bubbleDurationMs === 4321);

  // 反例注入：给 default 皮肤在数据根里放一份自带台词，写必须改去皮肤目录（"自带判定"要连数据根一起看）
  const defaultSkinDialogue = path.join(SCRATCH_DATA_ROOT, 'assets', 'skins', 'default', 'dialogue.json');
  fs.mkdirSync(path.dirname(defaultSkinDialogue), { recursive: true });
  fs.writeFileSync(defaultSkinDialogue, '{}\n', 'utf8');
  saveSkinDialogue({ bubbleDurationMs: 5555 });
  check('4.5 反例注入：数据根里给 default 加了自带台词后，写改落皮肤目录',
    JSON.parse(fs.readFileSync(defaultSkinDialogue, 'utf8')).bubbleDurationMs === 5555);

  // ---- 5. 语音包在打包态仍然可用 ----
  console.log('\n[5] 语音包（清单 + 音频对齐）');
  const service = createVoicePackService({ resolvePaths: () => resolveVoicePaths() });
  const packs = service.list();
  check('5.1 语音包清单读得到', packs.length === packageVoicePacks.packs.length,
    `包内 ${packageVoicePacks.packs.length} 条，读到 ${packs.length} 条`);
  check('5.2 每个包的音频文件都能找到（exists）', packs.every((pack) => pack.exists),
    packs.filter((p) => !p.exists).map((p) => p.file).join(',') || '全部存在');
  check('5.3 可播 URL 指向数据根而不是包内', packs.every((pack) => pack.url.includes('_userdata-check')
    || pack.url === ''), packs.map((p) => p.url).join(' '));

  // ---- 6. 重复播种不覆盖用户数据 ----
  console.log('\n[6] 幂等性');
  const again = seedUserData();
  check('6.1 再次播种不复制任何文件（只补缺、不覆盖）', again === 0, `copied=${again}`);
  check('6.2 用户改过的值仍在', JSON.parse(fs.readFileSync(defaultSkinDialogue, 'utf8')).bubbleDurationMs === 5555);

  // ---- 7. 出厂默认文件一个字节都没动 ----
  console.log('\n[7] 包内文件未被改动（物理快照比对）');
  const packageAfter = snapshotPackage();
  const changed = packageAfter.filter((line, index) => line !== packageBefore[index]);
  check('7.1 config/ 与素材元数据的快照完全一致', changed.length === 0,
    changed.slice(0, 5).join('; '));
  check('7.2 快照条数一致（没有新增/删除）', packageBefore.length === packageAfter.length,
    `${packageBefore.length} → ${packageAfter.length}`);

  // ---- 收尾：清掉草稿区（脚本自己建的，物理删除）----
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch (error) {
    console.log(`\n（草稿区未能自动清除：${SCRATCH} — ${error.message}）`);
  }

  // ---- 汇总 ----
  console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
  if (failures.length) {
    for (const item of failures) {
      console.log(`  ✗ ${item}`);
    }
    process.exitCode = 1;
  } else {
    console.log('全部通过：打包态"可写数据与包分离"链路成立。');
  }
}

main();
