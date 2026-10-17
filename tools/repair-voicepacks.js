/**
 * 语音包音频修复：让每条记录都对应自己的、不冲突的音频文件。
 * 用法：npm run voicepack-repair
 *
 * 修什么：早期版本 id 去重是大小写敏感的，而文件名由 id 派生、文件系统又不区分大小写，
 * 于是 `siuuu` 与 `SIUUU` 落到同一个文件上 —— 两个包共用一个音频，甚至互相覆盖。
 * 代码已经修了（见 voicepacks.js 的 uniqueId），但**已经被覆盖的文件不会自己恢复**，
 * 这个脚本按每条记录的 source 重新把音频取回来，并重新分配不冲突的文件名。
 *
 * 安全约定：
 * - 动手前先把 config/voicepacks.json 与 assets/audio/ 整份备份到 temp/，并打印备份路径；
 * - 只往 assets/audio/ 里写，绝不碰用户原始音频文件；
 * - source 已经找不到的记录原样保留（不猜、不臆造），只报告出来让人工决定。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PACKS_PATH = path.join(ROOT, 'config', 'voicepacks.json');
const AUDIO_DIR = path.join(ROOT, 'assets', 'audio');

const log = (msg) => console.log(msg);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BACKUP_DIR = path.join(ROOT, 'temp', `voicepacks-backup-${stamp}`);

function main() {
  if (!fs.existsSync(PACKS_PATH)) {
    log('没有 config/voicepacks.json，无需修复');
    return;
  }
  const config = JSON.parse(fs.readFileSync(PACKS_PATH, 'utf8'));
  const packs = Array.isArray(config.packs) ? config.packs : [];
  if (packs.length === 0) {
    log('语音包清单为空，无需修复');
    return;
  }

  // ---- 备份 ----
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(PACKS_PATH, path.join(BACKUP_DIR, 'voicepacks.json'));
  if (fs.existsSync(AUDIO_DIR)) {
    fs.cpSync(AUDIO_DIR, path.join(BACKUP_DIR, 'audio'), { recursive: true });
  }
  log(`已备份到 ${path.relative(ROOT, BACKUP_DIR)}`);

  const used = new Set();
  const nextPacks = [];
  const report = [];

  for (const pack of packs) {
    const id = String(pack.id ?? '');
    const source = String(pack.source ?? '');
    const ext = path.extname(String(pack.file ?? '') || source).toLowerCase() || '.mp3';

    // 重新分配文件名：小写 id 打底，冲突就加序号
    const base = (id.toLowerCase() || 'voice').replace(/[\\/:*?"<>|]/g, '') || 'voice';
    let fileName = `${base}${ext}`;
    for (let suffix = 2; used.has(fileName); suffix += 1) {
      fileName = `${base}-${suffix}${ext}`;
    }
    used.add(fileName);

    const target = path.join(AUDIO_DIR, fileName);
    const before = String(pack.file ?? '');
    const beforeExists = before ? fs.existsSync(path.join(AUDIO_DIR, before)) : false;

    let action = '保留原样';
    if (source && fs.existsSync(source)) {
      const sourceBuffer = fs.readFileSync(source);
      const targetBuffer = fs.existsSync(target) ? fs.readFileSync(target) : null;
      if (!targetBuffer || !targetBuffer.equals(sourceBuffer)) {
        fs.mkdirSync(AUDIO_DIR, { recursive: true });
        fs.writeFileSync(target, sourceBuffer);
        action = targetBuffer ? '按来源重新取回（内容不一致）' : '按来源补齐';
      } else {
        action = '内容已正确';
      }
    } else {
      action = fs.existsSync(target) ? '来源缺失，沿用现有文件' : '来源与文件都缺失';
    }

    nextPacks.push({ ...pack, file: fileName });
    report.push({ id, before, after: fileName, beforeExists, action });
  }

  // 清理不再被任何记录引用的旧文件（只删 assets/audio 内的）
  const keep = new Set(nextPacks.map((pack) => path.join(AUDIO_DIR, pack.file)));
  const orphans = fs.existsSync(AUDIO_DIR)
    ? fs.readdirSync(AUDIO_DIR).filter((name) => !keep.has(path.join(AUDIO_DIR, name)))
    : [];

  log('\n计划：');
  for (const row of report) {
    log(`  ${row.id.padEnd(12)} ${String(row.before).padEnd(18)} → ${row.after.padEnd(18)} ${row.action}`);
  }
  if (orphans.length) {
    log(`\n无人引用的旧文件（将删除）：${orphans.join(', ')}`);
  }

  fs.writeFileSync(
    PACKS_PATH,
    `${JSON.stringify({ ...config, packs: nextPacks }, null, 2)}\n`,
    'utf8'
  );
  for (const name of orphans) {
    fs.unlinkSync(path.join(AUDIO_DIR, name));
  }

  log('\n修复完成。当前语音包：');
  for (const pack of nextPacks) {
    const file = path.join(AUDIO_DIR, pack.file);
    const exists = fs.existsSync(file);
    const size = exists ? fs.statSync(file).size : 0;
    log(`  ${pack.id}  file=${pack.file}  ${exists ? `${size} B` : '文件缺失'}  source=${pack.source}`);
  }
}

main();
