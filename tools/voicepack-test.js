/**
 * 语音包服务逻辑测试（纯 Node，不启动 Electron）。
 * 用法：npm run voicepack-test
 *
 * 全程在系统临时目录里跑，不碰项目里真实的 assets/audio 与 config/voicepacks.json。
 *
 * 重点盯的是「文件名由 id 派生 + 文件系统不区分大小写」这个组合：
 * 曾经 { name: 'siuuu' } 和 { name: 'SIUUU' } 会派生出同一个文件名，
 * 后添加的包静默覆盖前一个包的音频，两个包从此播同一个声音；
 * 更糟的是删掉其中一个会把另一个正在用的文件一并删掉。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
}

/** 造一段 WAV 字节（频率不同 → 字节不同，覆盖与否一眼能看出） */
function makeWavBuffer(seconds, frequency, sampleRate = 8000) {
  const samples = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12000);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 同上，直接落盘 */
function makeWav(file, seconds, frequency) {
  fs.writeFileSync(file, makeWavBuffer(seconds, frequency));
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-voicepack-'));
const audioDir = path.join(tmpRoot, 'audio');
const packsPath = path.join(tmpRoot, 'voicepacks.json');
const fixtures = path.join(tmpRoot, 'fixtures');
fs.mkdirSync(fixtures, { recursive: true });

const srcA = path.join(fixtures, 'a.wav');
const srcB = path.join(fixtures, 'b.wav');
makeWav(srcA, 0.3, 440);
makeWav(srcB, 0.5, 880);

const { createVoicePackService, readWavInfo } = await import(
  pathToFileURL(path.join(ROOT, 'src', 'main', 'voicepacks.js')).href
);

const service = createVoicePackService({ audioDir, packsPath });

/**
 * 删除失败分支用独立实例：注入一个必然抛错的 unlink。
 * 真实磁盘上制造"删不掉"要依赖平台与权限（Windows 只读常失败、POSIX 未必），
 * 注入才是稳定的验证方式。
 */
const failingService = createVoicePackService({
  audioDir,
  packsPath,
  unlink: () => {
    const error = new Error('EBUSY: 文件被占用（注入的测试故障）');
    error.code = 'EBUSY';
    throw error;
  },
});
const readPacks = () => JSON.parse(fs.readFileSync(packsPath, 'utf8')).packs ?? [];
const audioFile = (name) => path.join(audioDir, name);

try {
  /* ---------- 1. 基本入库 ---------- */
  const first = service.add({ name: 'siuuu', src: srcA });
  check('添加语音包成功', first.ok === true, JSON.stringify(first.pack?.file ?? first.reason));
  check('文件名为派生 id 的小写形式', first.pack?.file === 'siuuu.wav', `file=${first.pack?.file}`);
  check('音频已复制入库且内容与源一致', fs.readFileSync(audioFile('siuuu.wav')).equals(fs.readFileSync(srcA)));

  /* ---------- 2. 处理后入库：写的是渲染层回传的成品，不是源文件 ---------- */
  const processedBytes = Buffer.from('RIFF____processed-by-renderer____WAVE');
  const second = service.add({
    name: '优化过的',
    src: srcB,
    bytes: processedBytes,
    ext: '.wav',
  });
  check('带处理后字节时能入库', second.ok === true, JSON.stringify(second.pack?.file ?? second.reason));
  check(
    '写入的是处理后字节，而不是原样复制源文件',
    fs.readFileSync(audioFile('优化过的.wav')).equals(processedBytes),
    `file=${second.pack?.file}`
  );
  check('清单标记为已优化', second.pack?.optimized === true);
  check('原样复制的包不带优化标记', first.pack?.optimized === false, `optimized=${first.pack?.optimized}`);
  check('文件名跟随处理后的扩展名', second.pack?.file === '优化过的.wav', `file=${second.pack?.file}`);

  const both = service.list();
  check('两条记录都在清单里', both.length === 2, `${both.length} 条`);
  check('两个包的文件都存在', both.every((pack) => pack.exists), both.map((p) => `${p.id}:${p.exists}`).join(', '));
  check(
    '两个包指向不同文件',
    both[0].file.toLowerCase() !== both[1].file.toLowerCase(),
    `${both[0].file} vs ${both[1].file}`
  );
  check(
    '两个包的可播 URL 不同',
    both[0].url !== both[1].url,
    both.map((p) => path.basename(p.url)).join(' vs ')
  );

  /* ---------- 3. 名称必须唯一（同名会被拒绝，而不是静默加序号） ---------- */
  const duplicate = service.add({ name: 'siuuu', src: srcA });
  check(
    '完全同名被拒绝',
    duplicate.ok === false && duplicate.reason === 'duplicate-name',
    duplicate.ok ? `竟然通过了：${duplicate.pack.file}` : duplicate.message
  );
  check('拒绝时给出可读的原因', /已存在同名/.test(duplicate.message ?? ''), duplicate.message);

  const caseDuplicate = service.add({ name: 'SiUuU', src: srcA });
  check(
    '仅大小写不同也算同名（用户视角就是同一个名字）',
    caseDuplicate.ok === false && caseDuplicate.reason === 'duplicate-name',
    caseDuplicate.ok ? `竟然通过了：${caseDuplicate.pack.file}` : caseDuplicate.message
  );

  const spacedDuplicate = service.add({ name: '  siuuu  ', src: srcA });
  check(
    '首尾空白不影响判重',
    spacedDuplicate.ok === false && spacedDuplicate.reason === 'duplicate-name',
    spacedDuplicate.ok ? `竟然通过了：${spacedDuplicate.pack.file}` : spacedDuplicate.message
  );

  const fresh = service.add({ name: '另一个名字', src: srcA });
  check('换个名字就能添加', fresh.ok === true, fresh.ok ? fresh.pack.file : fresh.reason);
  service.remove(fresh.pack.id);

  /* ---------- 4. 删除不会动别的包正在用的文件 ---------- */
  const removed = service.remove(second.pack.id);
  check('删除第二个包成功', removed.ok === true, JSON.stringify(removed));
  check('删掉了它自己的音频副本', !fs.existsSync(audioFile('优化过的.wav')));
  check('第一个包的音频仍在', fs.existsSync(audioFile('siuuu.wav')));
  const afterRemove = service.list().find((pack) => pack.id === first.pack.id);
  check('剩下的包依然可播', afterRemove?.exists === true && Boolean(afterRemove.url));

  /* ---------- 5. 老数据：两条记录共用一份文件时，删除不能连带删掉文件 ---------- */
  // 模拟修复前已经产生的坏清单
  const sharedPath = path.join(audioDir, 'shared.wav');
  fs.copyFileSync(srcA, sharedPath);
  fs.writeFileSync(
    packsPath,
    `${JSON.stringify(
      {
        packs: [
          { id: 'alpha', name: 'alpha', file: 'shared.wav', enabled: true },
          { id: 'BETA', name: 'BETA', file: 'SHARED.WAV', enabled: true },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  check('坏清单能被读出两条', service.list().length === 2);

  const brokenRemove = service.remove('alpha');
  check('删除共用文件中的一个包成功', brokenRemove.ok === true);
  check(
    '共用文件被保留（另一个包还在用它）',
    fs.existsSync(sharedPath),
    `fileKept=${brokenRemove.fileKept}`
  );
  const survivor = service.list()[0];
  check('另一个包没有变成"文件已丢失"', survivor?.exists === true, `id=${survivor?.id} exists=${survivor?.exists}`);

  /* ---------- 6. 输入校验 ---------- */
  check('空名称被拒绝', service.add({ name: '  ', src: srcA }).reason === 'empty-name');
  check('空路径被拒绝', service.add({ name: 'x', src: '' }).reason === 'empty-src');
  check(
    '源文件不存在被拒绝',
    service.add({ name: 'x', src: path.join(fixtures, 'nope.wav') }).reason === 'src-missing'
  );

  const badExt = path.join(fixtures, 'note.txt');
  fs.writeFileSync(badExt, 'not audio');
  check('不支持的格式被拒绝', service.add({ name: 'x', src: badExt }).reason === 'bad-format');

  /* ---------- 7. 启停 ---------- */
  const target = service.list().find((pack) => pack.exists);
  service.setEnabled(target.id, false);
  check(
    '停用后不参与播放但仍在列表里',
    service.list().some((pack) => pack.id === target.id && pack.enabled === false) &&
      !service.playable().some((pack) => pack.id === target.id)
  );
  check('不存在的 id 启停被拒绝', service.setEnabled('nope', true).reason === 'not-found');

  /* ---------- 8. 时长上限（30 秒） ---------- */
  const longSource = path.join(fixtures, 'long-31s.wav');
  makeWav(longSource, 31, 220);
  const tooLong = service.add({ name: '超长样音', src: longSource });
  check(
    '源 WAV 超过 30 秒被拒绝',
    tooLong.ok === false && tooLong.reason === 'too-long',
    tooLong.message ?? JSON.stringify(tooLong)
  );
  check(
    '拒绝信息里带上实测时长与上限',
    /3[01]\.\d 秒.*30 秒/.test(tooLong.message ?? ''),
    tooLong.message
  );

  const okSource = path.join(fixtures, 'ok-29s.wav');
  makeWav(okSource, 29, 330);
  const underLimit = service.add({ name: '二十九秒样音', src: okSource, duration: 29 });
  check('29 秒（未越界）可以正常导入', underLimit.ok === true, underLimit.message ?? '');
  if (underLimit.ok) {
    service.remove(underLimit.pack.id);
  }

  const longProcessed = service.add({
    name: '超长成品',
    src: okSource,
    bytes: makeWavBuffer(31, 440),
    ext: '.wav',
  });
  check(
    '成品 WAV 超过 30 秒同样被拒绝（不信任调用方回传）',
    longProcessed.ok === false && longProcessed.reason === 'too-long',
    longProcessed.message ?? JSON.stringify(longProcessed)
  );

  // 降级路径：源不是 WAV、也没有成品字节，只剩渲染层回传的时长可用
  const fakeMp3 = path.join(fixtures, 'long-45s.mp3');
  fs.writeFileSync(fakeMp3, 'ID3 fake mp3 payload');
  const byDuration = service.add({ name: '回传时长超限', src: fakeMp3, duration: 45 });
  check(
    '降级路径下按回传时长判超限',
    byDuration.ok === false && byDuration.reason === 'too-long',
    byDuration.message ?? JSON.stringify(byDuration)
  );

  /* ---------- 9. WAV 头解析 ---------- */
  const wavInfo = readWavInfo(makeWavBuffer(2.5, 700));
  check(
    'WAV 头能解析出正确的时长',
    Math.abs((wavInfo?.duration ?? 0) - 2.5) < 0.02,
    `${wavInfo?.duration?.toFixed(3)}s @ ${wavInfo?.sampleRate}Hz`
  );
  check('非 WAV 字节返回 null 而不是误判', readWavInfo(Buffer.from('RIFF____not-a-real-wav')) === null);

  /* ---------- 10. 删除回报与孤儿扫描 ---------- */
  const orphanName = 'orphan-probe.wav';
  fs.writeFileSync(path.join(audioDir, orphanName), makeWavBuffer(1, 550));
  check(
    '未登记的文件会被扫成孤儿',
    service.listOrphans().some((item) => item.file === orphanName),
    JSON.stringify(service.listOrphans().map((item) => item.file))
  );

  const delSrc = path.join(fixtures, 'del.wav');
  makeWav(delSrc, 0.4, 990);
  const delPack = service.add({ name: '待删除样音', src: delSrc });
  const delResult = service.remove(delPack.pack.id);
  check(
    '删除回报里如实带上文件删除结果',
    delResult.fileRemoved === true && delResult.warning === undefined,
    JSON.stringify(delResult)
  );
  check('删除后音频文件确实不在目录里', !fs.existsSync(audioFile(delPack.pack.file)));

  const failPack = failingService.add({ name: '删不掉样音', src: delSrc });
  const failResult = failingService.remove(failPack.pack.id);
  check(
    '文件删不掉时不静默：ok=true 但 warning 有值、fileRemoved=false',
    failResult.ok === true && failResult.fileRemoved === false && typeof failResult.warning === 'string',
    failResult.warning ?? JSON.stringify(failResult)
  );
  check(
    '删不掉的文件仍能被孤儿扫描发现（可事后清理）',
    service.listOrphans().some((item) => item.file === failPack.pack.file),
    JSON.stringify(service.listOrphans().map((item) => item.file))
  );
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.pass).length;
console.log(`\n共 ${results.length} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
