#!/usr/bin/env python3
"""
精灵图（sprite sheet）切片入库工具。

用途：把 AI 生成的一整张动作序列图，切成桌宠皮肤包可用的单帧 PNG。

为什么用"整张图"生成：同一次生成内的画风/比例天然一致，
比逐帧生成再拼凑稳定得多（逐帧生成的角色会飘）。

处理流程：
  1. 按 cols×rows 等分切格
  2. 抠掉纯色底（chroma key），得到透明背景
  3. 取"整组内容的并集包围盒"统一裁剪 —— 关键：逐帧裁剪会破坏相对大小
  4. 裁成正方形并缩放到目标尺寸（NEAREST，保持像素硬边）
  5. 颜色量化到指定色数，锁定像素风观感
  6. 输出 000.png 001.png ...

用法示例：
  # 注意 --out 必须补到 <动作>/<显示尺寸>/<dpr> 这一层！
  # manifest 里的素材路径是 sprites/<动作>/{size}/{dpr}/NNN.png，
  # 直接输出到 sprites/<动作>/ 会生成一堆没人引用的死文件（历史上踩过这个坑）。
  python tools/sprite_pipeline.py raw/idle_sheet.png \
      --cols 4 --out assets/skins/default/sprites/idle/192/1.5 --prefix 000 --size 288

  # 换肤 / 换动作同理，同样要落到 <动作>/<尺寸>/<dpr>
  python tools/sprite_pipeline.py raw/run_sheet.png \
      --cols 6 --out assets/skins/cr7/sprites/run/256/1.5 --size 384 --pixel-size 2

  # 一次生成动作图后，各尺寸各 dpr 各跑一遍（同一底图保证跨尺寸形象一致）
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# 底色识别：与目标色距离小于容差的像素视为背景
DEFAULT_CHROMA = "ff00ff"          # 品红，与球衣/肤色都不冲突
DEFAULT_TOLERANCE = 110
ALPHA_CUTOFF = 40                  # 低于该 alpha 视为全透明，避免抠底色残留毛边
CHROMA_FILLER = (255, 0, 255)      # 限色时填充透明区的离群色，不污染调色板


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.strip().lstrip("#")
    if len(value) != 6:
        raise ValueError(f"颜色格式应为 RRGGBB，收到：{value}")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def color_distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    """
    标准 RGB 欧氏距离。
    不要改成带感知权重的距离：给绿色通道加权会让黑色 (0,0,0) 到品红 (255,0,255)
    的距离降到 81，落在容差内被误判为背景，结果把描边和黑短裤一起抠掉。
    """
    dr, dg, db = a[0] - b[0], a[1] - b[1], a[2] - b[2]
    return (dr * dr + dg * dg + db * db) ** 0.5


def remove_background(image: Image.Image, chroma: tuple[int, int, int], tolerance: int) -> Image.Image:
    """把接近底色的像素设为透明。"""
    image = image.convert("RGBA")
    pixels = image.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            if color_distance((r, g, b), chroma) <= tolerance:
                pixels[x, y] = (0, 0, 0, 0)
    return image


def defringe_chroma(image: Image.Image, rounds: int = 2) -> Image.Image:
    """
    去掉紧贴透明区的底色残边。

    为什么需要它：底色与角色黑色描边之间的抗锯齿过渡像素是"底色 + 黑"的混合色，
    与底色的色距很远（纯黑到品红的距离约 360），无论怎么调 --tolerance 都抠不掉，
    表现为角色外围一圈粉色描边。

    判据用的是**通道关系**而不是色距：品红系的特点是蓝、红都明显高于绿。
    角色身上没有这种配色的部件（球衣红是 R 高但 B 低），所以不会误伤。
    只处理四邻已有透明像素的点，不会啃进角色内部。
    """
    image = image.convert("RGBA")
    for _ in range(max(0, rounds)):
        width, height = image.size
        pixels = image.load()
        # 先收集本轮要清掉的点再统一处理，避免边判断边改导致连锁吞噬
        victims = []
        for y in range(height):
            for x in range(width):
                r, g, b, a = pixels[x, y]
                if a == 0 or not (r > g + 30 and b > g + 30):
                    continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < width and 0 <= ny < height and pixels[nx, ny][3] == 0:
                        victims.append((x, y))
                        break
        if not victims:
            break
        for x, y in victims:
            r, g, b, _ = pixels[x, y]
            pixels[x, y] = (r, g, b, 0)
    return image


def content_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    """返回不透明内容的包围盒；全透明返回 None。"""
    alpha = image.getchannel("A")
    return alpha.getbbox()


def crop_union(frames: list[Image.Image]) -> list[Image.Image]:
    """
    用"整组并集包围盒"统一裁剪：保持各帧角色的相对大小与位置关系，
    否则逐帧自动裁剪会把做出下蹲动作的帧放大到和其他帧一样大。
    """
    boxes = [b for b in (content_bbox(f) for f in frames) if b]
    if not boxes:
        raise SystemExit("抠底色后没有任何不透明内容，检查 --chroma / --tolerance 参数")

    left = min(b[0] for b in boxes)
    top = min(b[1] for b in boxes)
    right = max(b[2] for b in boxes)
    bottom = max(b[3] for b in boxes)

    # 扩成正方形并留出 6% 边距，避免缩放时裁到手脚
    width, height = right - left, bottom - top
    side = int(max(width, height) * 1.06) + 2
    center_x, center_y = (left + right) // 2, (top + bottom) // 2
    box = (
        center_x - side // 2,
        center_y - side // 2,
        center_x + side // 2,
        center_y + side // 2,
    )
    return [crop_with_padding(frame, box) for frame in frames]


def crop_with_padding(image: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    """裁剪到目标区域，超出画布的部分用透明填充。"""
    left, top, right, bottom = box
    canvas = Image.new("RGBA", (right - left, bottom - top), (0, 0, 0, 0))
    source_box = (
        max(0, left),
        max(0, top),
        min(image.width, right),
        min(image.height, bottom),
    )
    if source_box[2] > source_box[0] and source_box[3] > source_box[1]:
        chunk = image.crop(source_box)
        canvas.paste(chunk, (source_box[0] - left, source_box[1] - top))
    return canvas


def align_frames(frames: list[Image.Image], mode: str) -> list[Image.Image]:
    """
    帧间对齐。AI 生成的同一张图里，各帧角色的落点往往不齐，
    直接播放会"抖"。这里把每帧按统一锚点平移到中位位置。

    mode:
      none   → 不对齐（跳跃/腾空类动作保持原始高低差时用）
      feet   → 按脚底对齐 + 水平按内容中心对齐（站立/行走/待机用）
      center → 按内容几何中心对齐
    """
    if mode == "none" or len(frames) < 2:
        return frames

    anchors = []
    for frame in frames:
        box = content_bbox(frame)
        if box is None:
            anchors.append(None)
            continue
        left, top, right, bottom = box
        anchors.append(
            {
                "x": (left + right) / 2,
                "y": bottom if mode == "feet" else (top + bottom) / 2,
            }
        )

    valid = [a for a in anchors if a]
    if not valid:
        return frames
    target_x = median([a["x"] for a in valid])
    target_y = median([a["y"] for a in valid])

    aligned = []
    for frame, anchor in zip(frames, anchors):
        if anchor is None:
            aligned.append(frame)
            continue
        dx = round(target_x - anchor["x"])
        dy = round(target_y - anchor["y"])
        if dx == 0 and dy == 0:
            aligned.append(frame)
            continue
        canvas = Image.new("RGBA", frame.size, (0, 0, 0, 0))
        canvas.paste(frame, (dx, dy))
        aligned.append(canvas)
    return aligned


def median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def normalize(
    frame: Image.Image, size: int, pixel_size: int, colors: int, downscale: str = "box"
) -> Image.Image:
    """
    缩放到目标尺寸并做像素化 + 限色。
    两个关键点：
    - 降采样必须用区域平均类算法（BOX/LANCZOS）：NEAREST 是"每隔 N 像素抽一个样"，
      大幅缩小时细线（眼睛、嘴线、描边）时有时无，产生麻点脸
    - 限色前必须把透明区填成离群底色：直接 convert("RGB") 会把透明区变成黑色
      参与调色板统计，把整个色板往暗色带偏（整体发脏）
    """
    resample = Image.LANCZOS if downscale == "lanczos" else Image.BOX
    if pixel_size > 1:
        small = frame.resize(
            (max(1, size // pixel_size), max(1, size // pixel_size)), resample
        )
    else:
        small = frame.resize((size, size), resample)

    opaque = clean_alpha(small.getchannel("A"))

    if colors > 0:
        filler = Image.new("RGBA", small.size, CHROMA_FILLER + (255,))
        filler.paste(small, (0, 0), opaque)  # 透明区填底色，不参与调色板统计
        quantized = (
            filler.convert("RGB").quantize(colors=colors, method=Image.MEDIANCUT).convert("RGBA")
        )
        quantized.putalpha(opaque)
        return quantized

    result = small.copy()
    result.putalpha(opaque)
    return result


def clean_alpha(alpha: Image.Image) -> Image.Image:
    """alpha 二值化：像素风不需要半透明边缘。"""
    return alpha.point(lambda value: 0 if value < ALPHA_CUTOFF else 255)


def apply_masks(image: Image.Image, rects: list[str], chroma: tuple[int, int, int]) -> Image.Image:
    """
    把指定矩形区域涂成底色，使其在抠底阶段被一并去掉。
    用于清除生成图自带的水印/角标等干扰元素。
    rect 格式："x,y,w,h"（相对图片左上角）
    """
    painter = ImageDraw.Draw(image)
    for rect in rects:
        try:
            x, y, w, h = (int(part) for part in rect.split(","))
        except ValueError:
            raise SystemExit(f"--mask 格式应为 x,y,w,h，收到：{rect}")
        painter.rectangle([x, y, x + w, y + h], fill=(*chroma, 255))
    return image


def slice_sheet(image: Image.Image, cols: int, rows: int) -> list[Image.Image]:
    cell_w = image.width // cols
    cell_h = image.height // rows
    frames = []
    for row in range(rows):
        for col in range(cols):
            frames.append(image.crop((col * cell_w, row * cell_h, (col + 1) * cell_w, (row + 1) * cell_h)))
    return frames


def pre_quantize(image: Image.Image, colors: int) -> Image.Image:
    """
    切片前在原始分辨率上限色。
    AI 生成的"像素画"往往带柔和渐变阴影（几十种近似色），
    直接降采样会平均出斑驳的中间色；先压平成有限色块再缩，画面才干净。
    透明区同样要填离群色，否则 convert("RGB") 产生的黑色会挤占调色板。
    """
    if colors <= 0:
        return image
    opaque = clean_alpha(image.getchannel("A"))
    filler = Image.new("RGBA", image.size, CHROMA_FILLER + (255,))
    filler.paste(image, (0, 0), opaque)
    flat = filler.convert("RGB").quantize(colors=colors, method=Image.MEDIANCUT).convert("RGBA")
    flat.putalpha(opaque)
    return flat


def main() -> int:
    parser = argparse.ArgumentParser(description="精灵图切片入库")
    parser.add_argument("sheet", type=Path, help="原始精灵图路径")
    parser.add_argument("--out", type=Path, required=True, help="输出目录（如 assets/skins/default/sprites/idle）")
    parser.add_argument("--cols", type=int, default=4, help="列数（默认 4）")
    parser.add_argument("--rows", type=int, default=1, help="行数（默认 1）")
    parser.add_argument("--prefix", default="000", help="起始文件名（默认 000）")
    parser.add_argument("--size", type=int, default=64, help="输出单帧边长 px（默认 64）")
    parser.add_argument("--pixel-size", type=int, default=2, help="像素块大小，1=不虚化（默认 2）")
    parser.add_argument("--colors", type=int, default=16, help="限色数量，0=不限（默认 16）")
    parser.add_argument(
        "--pre-colors", type=int, default=16, help="切片前在原图分辨率上限色，0=关闭（默认 16）"
    )
    parser.add_argument("--chroma", default=DEFAULT_CHROMA, help=f"底色 RRGGBB（默认 {DEFAULT_CHROMA}）")
    parser.add_argument("--tolerance", type=int, default=DEFAULT_TOLERANCE, help="底色容差（默认 110）")
    parser.add_argument(
        "--defringe",
        type=int,
        default=0,
        help="抠底后额外清理几轮底色残留边（默认 0=关闭；AI 生成的图建议 2）",
    )
    parser.add_argument("--start-index", type=int, default=0, help="输出文件名起始序号")
    parser.add_argument(
        "--mask",
        nargs="*",
        default=[],
        metavar="x,y,w,h",
        help="先涂掉指定矩形（如生成图的水印），可传多个",
    )
    parser.add_argument(
        "--downscale",
        choices=["box", "lanczos"],
        default="box",
        help="降采样算法：box=区域平均（稳），lanczos=保边更锐（可能带光晕）",
    )
    parser.add_argument("--montage", action="store_true", help="额外输出一张四帧拼图便于肉眼检查")
    parser.add_argument("--montage-scale", type=int, default=3, help="拼图放大倍率（便于看清细节，默认 3）")
    parser.add_argument(
        "--align",
        choices=["none", "feet", "center"],
        default="feet",
        help="帧间对齐方式：feet=按脚底（站立/待机/行走），none=保留原始高低差（跳跃/腾空），center=按中心",
    )
    args = parser.parse_args()

    if not args.sheet.is_file():
        print(f"找不到精灵图：{args.sheet}", file=sys.stderr)
        return 1

    sheet = Image.open(args.sheet).convert("RGBA")
    chroma = hex_to_rgb(args.chroma)

    # 顺序不能变：先涂水印 → 再抠底 → 最后限色。
    # 若先限色，底色与角色之间的抗锯齿过渡像素会被"烘焙"成固定的红色调和色，
    # 之后抠不掉了；且大面积底色会挤占调色板名额，白色/浅色被牺牲。
    if args.mask:
        sheet = apply_masks(sheet, args.mask, chroma)
    sheet = remove_background(sheet, chroma, args.tolerance)
    if args.defringe > 0:
        sheet = defringe_chroma(sheet, args.defringe)
    if args.pre_colors > 0:
        sheet = pre_quantize(sheet, args.pre_colors)

    raw_frames = slice_sheet(sheet, args.cols, args.rows)
    cropped = crop_union(raw_frames)
    aligned = align_frames(cropped, args.align)
    frames = [normalize(f, args.size, args.pixel_size, args.colors, args.downscale) for f in aligned]

    args.out.mkdir(parents=True, exist_ok=True)
    start = int(args.prefix)
    for offset, frame in enumerate(frames):
        target = args.out / f"{start + offset + args.start_index:03d}.png"
        frame.save(target)

    if args.montage:
        sheet_out = build_montage(frames, args.size, args.montage_scale)
        montage_path = args.out / "_montage.png"
        sheet_out.save(montage_path)
        print(f"  检查用拼图：{montage_path}")

    print(f"已输出 {len(frames)} 帧 → {args.out}")
    print(f"  尺寸 {args.size}x{args.size} · 像素块 {args.pixel_size} · 限色 {args.colors} · 底色 #{args.chroma}")
    return 0


def build_montage(frames: list[Image.Image], size: int, scale: int = 3) -> Image.Image:
    """把各帧横向拼成一张检查图（棋盘底，便于看透明区域），按 scale 放大。"""
    cols = len(frames)
    cell = size * scale
    canvas = Image.new("RGBA", (cols * cell, cell), (0, 0, 0, 0))
    checker = Image.new("RGBA", canvas.size, (230, 230, 230, 255))
    draw = ImageDraw.Draw(checker)
    step = 16
    for y in range(0, canvas.height, step):
        for x in range(0, canvas.width, step):
            if (x // step + y // step) % 2 == 0:
                draw.rectangle([x, y, x + step - 1, y + step - 1], fill=(200, 200, 200, 255))
    checker.alpha_composite(canvas)
    for index, frame in enumerate(frames):
        enlarged = frame.resize((cell, cell), Image.NEAREST)
        checker.alpha_composite(enlarged, (index * cell, 0))
    return checker


if __name__ == "__main__":
    raise SystemExit(main())
