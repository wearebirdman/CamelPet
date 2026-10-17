#!/usr/bin/env python3
"""
往 .ico 里补一个尺寸档（默认 256x256），**已有的条目一个字节都不动**。

为什么需要：electron-builder / NSIS 硬性要求安装包图标最大档 ≥ 256
（app-builder-lib 的 iconConverter：ERR_ICON_TOO_SMALL），而项目里的 app-icon.ico
最大只有 128。重画整份图标会动到已认可的形象，所以这里只做"追加"：
  - 已存在目标档 → 什么都不做（幂等，可重复跑）；
  - 不存在 → 从指定 PNG（默认同目录同名 .png）取该尺寸，PNG 压缩格式追加进去。

用法：
    python tools/append-ico-entry.py assets/icons/app-icon.ico [256] [源图.png]

跑完可用 Pillow 验证：Image.open(ico) 应能列出 16..256 各档。
"""
import io
import shutil
import struct
import sys
from pathlib import Path

from PIL import Image

ICO_HEADER = struct.Struct('<HHH')
DIR_ENTRY = struct.Struct('<BBBBHHII')


def parse_entries(buf):
    """按 ICO 目录逐条解析出（尺寸标记 + 原始图像数据），数据原样保留。"""
    reserved, ico_type, count = ICO_HEADER.unpack_from(buf, 0)
    if reserved != 0 or ico_type != 1:
        raise SystemExit(f'不是有效的 ICO 文件（type={ico_type}）')
    entries = []
    for index in range(count):
        off = 6 + index * 16
        width, height, colors, reserved_b, planes, bitcount, size, offset = \
            DIR_ENTRY.unpack_from(buf, off)
        entries.append({
            'w': width, 'h': height, 'colors': colors, 'reserved': reserved_b,
            'planes': planes, 'bitcount': bitcount,
            'data': buf[offset:offset + size],
        })
    return entries


def serialize(entries):
    """重新拼 ICO：目录重排（偏移会变），图像数据逐字节原样写回。"""
    out = io.BytesIO()
    out.write(ICO_HEADER.pack(0, 1, len(entries)))
    offset = 6 + 16 * len(entries)
    for entry in entries:
        out.write(DIR_ENTRY.pack(
            entry['w'], entry['h'], entry['colors'], entry['reserved'],
            entry['planes'], entry['bitcount'], len(entry['data']), offset))
        offset += len(entry['data'])
    for entry in entries:
        out.write(entry['data'])
    return out.getvalue()


def declared_size(entry):
    """目录条目里的边长；256 按规范记成 0。"""
    return entry['w'] or 256


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    ico_path = Path(sys.argv[1])
    wanted = int(sys.argv[2]) if len(sys.argv) > 2 else 256
    source = Path(sys.argv[3]) if len(sys.argv) > 3 else ico_path.with_suffix('.png')

    buf = ico_path.read_bytes()
    entries = parse_entries(buf)
    existing = sorted(declared_size(entry) for entry in entries)
    print(f'现有档位：{existing}')

    if any(declared_size(entry) == wanted for entry in entries):
        print(f'{wanted}x{wanted} 已存在，无需处理。')
        return

    if not source.exists():
        raise SystemExit(f'找不到源图：{source}')
    image = Image.open(source).convert('RGBA')
    if image.size != (wanted, wanted):
        image = image.resize((wanted, wanted), Image.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    # PNG 压缩条目：bWidth/bHeight 记 0 表示 256；planes/bitcount 用常规值
    entries.append({
        'w': 0 if wanted >= 256 else wanted,
        'h': 0 if wanted >= 256 else wanted,
        'colors': 0, 'reserved': 0, 'planes': 1, 'bitcount': 32,
        'data': buffer.getvalue(),
    })

    backup = Path('temp') / '_trash_2026-10-11' / ico_path.name
    backup.parent.mkdir(parents=True, exist_ok=True)
    if not backup.exists():
        shutil.copy2(ico_path, backup)
        print(f'旧版已备份：{backup}')

    ico_path.write_bytes(serialize(entries))
    print(f'已追加 {wanted}x{wanted}（PNG 压缩，{len(buffer.getvalue())} 字节），共 {len(entries)} 档。')

    check = Image.open(ico_path)
    sizes = []
    try:
        while True:
            sizes.append(check.size)
            check.seek(check.tell() + 1)
    except EOFError:
        pass
    print('验证可读档位：', sorted(set(sizes)))


if __name__ == '__main__':
    main()
