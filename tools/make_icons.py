#!/usr/bin/env python3
"""
从截图生成应用图标：抠掉棋盘格背景 → 裁剪 → 导出多尺寸 PNG 与 Windows .ico。

为什么用「从四边泛洪」而不是简单的颜色阈值：
截图里的透明区被渲染成了**棋盘格**（两种浅灰交替）。角色的白色发带颜色和棋盘格的
白色方块几乎一致（都是低饱和、高明度），单纯按颜色扣会把发带一起抠掉。
发带被黑色描边完整包住，所以从画面四边做连通域泛洪，颜色阈值只作为"候选背景"，
连通性才是真正的判定 —— 发带不在连通域里，自然保得住。

用法：
  python tools/make_icons.py <源图> --out assets/icons
"""
import argparse
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

# 背景候选判定：低饱和 + 高明度（棋盘格的两种灰都落在这个区间）
MAX_SATURATION = 20
MIN_BRIGHTNESS = 170


def parse_args():
    parser = argparse.ArgumentParser(description="生成应用图标（抠底 + 多尺寸 + ico）")
    parser.add_argument("source", type=Path, help="源图（角色头像截图）")
    parser.add_argument("--out", type=Path, required=True, help="输出目录，如 assets/icons")
    parser.add_argument("--padding", type=float, default=0.06,
                        help="四周留白比例（相对成品边长），默认 0.06")
    return parser.parse_args()


def remove_checkerboard(image: Image.Image) -> Image.Image:
    """从四边泛洪，抠掉与边界连通的浅灰棋盘格。"""
    rgb = np.array(image.convert("RGB")).astype(int)
    height, width = rgb.shape[:2]

    spread = rgb.max(axis=2) - rgb.min(axis=2)
    brightness = rgb.min(axis=2)
    candidate = (spread <= MAX_SATURATION) & (brightness >= MIN_BRIGHTNESS)

    reachable = np.zeros((height, width), dtype=bool)
    queue = deque()

    def seed(y, x):
        if candidate[y, x] and not reachable[y, x]:
            reachable[y, x] = True
            queue.append((y, x))

    for x in range(width):
        seed(0, x)
        seed(height - 1, x)
    for y in range(height):
        seed(y, 0)
        seed(y, width - 1)

    while queue:
        y, x = queue.pop()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < height and 0 <= nx < width and candidate[ny, nx] and not reachable[ny, nx]:
                reachable[ny, nx] = True
                queue.append((ny, nx))

    out = np.array(image.convert("RGBA"))
    out[..., 3] = np.where(reachable, 0, 255)
    return Image.fromarray(out, "RGBA"), int(reachable.sum())


def defringe(image: Image.Image, rounds: int = 1) -> Image.Image:
    """
    去掉紧贴透明区的一圈浅色残边（截图抗锯齿留下的灰晕）。
    只处理"本身是浅灰、且相邻已有透明像素"的点，不会啃到角色内部。
    """
    data = np.array(image).astype(int)
    for _ in range(rounds):
        alpha = data[..., 3]
        transparent = alpha == 0
        spread = data[..., :3].max(axis=2) - data[..., :3].min(axis=2)
        brightness = data[..., :3].min(axis=2)
        near_transparent = np.zeros_like(transparent)
        near_transparent[1:, :] |= transparent[:-1, :]
        near_transparent[:-1, :] |= transparent[1:, :]
        near_transparent[:, 1:] |= transparent[:, :-1]
        near_transparent[:, :-1] |= transparent[:, 1:]
        kill = (alpha > 0) & near_transparent & (spread <= 26) & (brightness >= 150)
        data[kill, 3] = 0
    return Image.fromarray(data.astype(np.uint8), "RGBA")


def square_with_padding(image: Image.Image, padding_ratio: float) -> Image.Image:
    """把内容居中放到正方形画布上，四周留白（图标视觉重心更稳）。"""
    box = image.getbbox()
    cropped = image.crop(box)
    side = max(cropped.width, cropped.height)
    canvas_side = max(1, round(side * (1 + padding_ratio * 2)))
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    canvas.paste(cropped, ((canvas_side - cropped.width) // 2, (canvas_side - cropped.height) // 2))
    return canvas


def scaled(image: Image.Image, size: int) -> Image.Image:
    """
    缩放策略按目标尺寸分两类：
    - 小尺寸（≤64）：直接 LANCZOS 平滑缩小。像素画的硬边在这么小的画布上本来就不可辨，
      平滑缩小的结果反而更干净、不出现杂乱噪点。
    - 大尺寸：先整数倍 NEAREST 放大，再 LANCZOS 收到目标。这样像素块大小均匀（避免非整数倍
      缩放导致的"有的块 1px 有的 2px"），同时边缘锐度也保住了。
    """
    if image.width == size:
        return image
    if size <= 64:
        return image.resize((size, size), Image.LANCZOS)
    factor = max(2, -(-size // image.width))  # 向上取整
    upscaled = image.resize((image.width * factor, image.height * factor), Image.NEAREST)
    return upscaled.resize((size, size), Image.LANCZOS)


TARGETS = [
    # 文件名, 尺寸, 留白比例（托盘图标要占满一些才看得清，留白小一点）
    ("tray-icon.png", 32, 0.03),
    ("app-icon.png", 256, 0.06),
]


def main() -> int:
    args = parse_args()
    if not args.source.is_file():
        print(f"找不到文件：{args.source}", file=sys.stderr)
        return 1

    args.out.mkdir(parents=True, exist_ok=True)

    with Image.open(args.source) as source:
        print(f"源图 {source.size} {source.mode}")
        cleaned, removed = remove_checkerboard(source)
    print(f"抠掉背景像素 {removed}")

    cleaned = defringe(cleaned, rounds=2)
    box = cleaned.getbbox()
    print(f"角色包围盒 {box}（{box[2] - box[0]}×{box[3] - box[1]}）")

    # 净版原图（留白取中间值）：供后续重新导出其他尺寸
    square = square_with_padding(cleaned, args.padding)
    print(f"净版画布 {square.size}")
    square.save(args.out / "avatar-source.png")

    for name, size, padding in TARGETS:
        canvas = square if padding == args.padding else square_with_padding(cleaned, padding)
        scaled(canvas, size).save(args.out / name)
        print(f"  {name}  {size}×{size}")

    # Windows 的 .ico 需要多尺寸，系统会按 DPI 自行挑选。
    # 逐尺寸自己算好再交给 Pillow 打包（用最大尺寸那张做载体，其余尺寸作为帧附加）。
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_canvas = square_with_padding(cleaned, 0.05)
    ico_canvas.save(args.out / "app-icon.ico", sizes=[(s, s) for s in ico_sizes])
    print(f"  app-icon.ico  {ico_sizes}")

    # 检查用拼图：三种底色上看是否有残留边框或误抠
    preview = Image.new("RGBA", (256 * 3 + 40, 256 + 130), (0, 0, 0, 0))
    for index, background in enumerate([(255, 255, 255, 255), (40, 40, 46, 255), (0, 160, 220, 255)]):
        tile = Image.new("RGBA", (256, 256), background)
        tile.alpha_composite(scaled(square, 256))
        preview.alpha_composite(tile, (10 + index * (256 + 10), 20))
    tray = Image.open(args.out / "tray-icon.png").convert("RGBA")
    for index, background in enumerate([(255, 255, 255, 255), (40, 40, 46, 255)]):
        tile = Image.new("RGBA", (128, 128), background)
        tile.alpha_composite(tray.resize((96, 96), Image.NEAREST), (16, 16))
        preview.alpha_composite(tile, (10 + index * 138, 290))
    preview.save(Path(args.out).parent.parent / "temp" / "icon-preview.png")
    print("预览拼图：temp/icon-preview.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
