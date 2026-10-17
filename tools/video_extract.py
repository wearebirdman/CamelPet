# -*- coding: utf-8 -*-
"""
视频 → 透明帧序列（探索版）：抽帧 → 抠底 → 去影子/水印 → 裁剪 → contact sheet。

抠底策略（按背景类型自动分派）：
- 浅色低饱和背景（白灰）：泛洪，判据 = V>170 且 S<0.14（头带白被描边包住不与边缘连通，安全）
- 彩色背景（粉）：泛洪，判据 = 与四角中值色的 RGB 距离 < 容差
- 影子清理：抠底后 S<0.15 且 60<V<205 的像素清透明（角色棕/红/绿饱和度高，不受影响）
- 水印/残片：keep_main_component 只留最大连通域（水印不与角色相连时自动消失）

用法：python temp/video_extract.py <视频名> [帧间隔秒]
"""
import math
import os
import subprocess
import sys
from collections import deque

from PIL import Image, ImageDraw
import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "temp", "video_frames")


def rgb_to_hsv(r, g, b):
    r, g, b = r / 255, g / 255, b / 255
    mx, mn = max(r, g, b), min(r, g, b)
    v = mx
    s = 0 if mx == 0 else (mx - mn) / mx
    return s, v


def chroma_key(img, tolerance=45.0):
    """泛洪抠底。自动判断背景类型：四角中值色浅且低饱和 → 亮度判据；否则色距判据。"""
    w, h = img.size
    px = img.load()
    corners = [px[x, y][:3] for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    corners.sort()
    bg = corners[1]  # 中值
    s, v = rgb_to_hsv(*bg)
    light_bg = v > 0.65 and s < 0.18
    if light_bg:
        def is_bg(p):
            _, vv = rgb_to_hsv(*p[:3])
            return vv > 0.62 and rgb_to_hsv(*p[:3])[0] < 0.16
    else:
        def is_bg(p):
            dr, dg, db = p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]
            return (dr * dr + dg * dg + db * db) < tolerance * tolerance * 3

    visited = bytearray(w * h)
    queue = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_bg(px[x, y]) and not visited[y * w + x]:
                visited[y * w + x] = 1
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(px[x, y]) and not visited[y * w + x]:
                visited[y * w + x] = 1
                queue.append((x, y))
    while queue:
        x, y = queue.popleft()
        px[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx] and is_bg(px[nx, ny]):
                visited[ny * w + nx] = 1
                queue.append((nx, ny))
    return img


def remove_shadow(img):
    """清低饱和灰影子：S<0.15 且 60<V<205 → 透明。描边（V 很暗）与白头带（V 很亮）不受影响。"""
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if p[3] == 0:
                continue
            s, v = rgb_to_hsv(p[0], p[1], p[2])
            if s < 0.15 and 60 < v * 255 < 205:
                px[x, y] = (0, 0, 0, 0)
    return img


def keep_main_component(img):
    """清浮动水印/残片：保留面积 ≥ 最大连通域 8% 的所有连通域。

    不能只留最大 —— 场景道具（浴缸）可能比角色大，坐姿时头与身体也可能是
    分离连通域（跳水视频实测：只留最大会把角色整个清掉，只剩浴缸）。
    水印面积通常 < 最大连通域的 8%，角色/道具远大于该阈值。
    """
    w, h = img.size
    px = img.load()
    labels = [[0] * w for _ in range(h)]
    sizes = {}
    current = 0
    for sy in range(h):
        for sx in range(w):
            if labels[sy][sx] or px[sx, sy][3] <= 10:
                continue
            current += 1
            stack = [(sx, sy)]
            labels[sy][sx] = current
            count = 0
            while stack:
                x, y = stack.pop()
                count += 1
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not labels[ny][nx] and px[nx, ny][3] > 10:
                        labels[ny][nx] = current
                        stack.append((nx, ny))
            sizes[current] = count
    if not sizes:
        return img
    biggest = max(sizes.values())
    threshold = biggest * 0.08
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 10 and sizes[labels[y][x]] < threshold:
                px[x, y] = (0, 0, 0, 0)
    return img


def remove_bg_color(img, bg, tolerance=60.0):
    """二次清理：与背景色距离近的残留（粉背景的影子）。限非连通泛洪可达的残留。"""
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if p[3] == 0:
                continue
            dr, dg, db = p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]
            if (dr * dr + dg * dg + db * db) < tolerance * tolerance:
                px[x, y] = (0, 0, 0, 0)
    return img


def process(video, step=0.1):
    name = os.path.splitext(video)[0]
    vdir = os.path.join(OUT, name)
    os.makedirs(vdir, exist_ok=True)
    # 注意：不做目录清理 —— 批量删除会被安全策略拦（阈值 50 个/次），
    # 换全新输出目录重跑才是干净的做法。
    src = os.path.join(ROOT, video)

    # 均匀抽帧（0.1s 一步）
    probe = subprocess.run(
        [FFMPEG, "-i", src], capture_output=True, text=True, encoding="utf-8", errors="ignore"
    ).stderr
    import re
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", probe)
    dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    times = [t for t in [i * step for i in range(int(dur / step) + 1)] if t < dur]

    frames = []
    for i, t in enumerate(times):
        raw = os.path.join(vdir, f"_raw{i:03d}.png")
        if not os.path.exists(raw):
            subprocess.run(
                [FFMPEG, "-y", "-ss", f"{t:.3f}", "-i", src, "-frames:v", "1", raw],
                capture_output=True, text=True,
            )
        if not os.path.exists(raw):
            continue
        img = Image.open(raw).convert("RGBA")
        corners = []
        w, h = img.size
        p0 = img.load()
        for cx, cy in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)):
            corners.append(p0[cx, cy][:3])
        corners.sort()
        bg = corners[1]
        chroma_key(img)
        remove_bg_color(img, bg, 60.0 if not (rgb_to_hsv(*bg)[1] > 0.65) else 0.0)
        remove_shadow(img)
        keep_main_component(img)
        bbox = img.getbbox()
        if bbox:
            img = img.crop(bbox)
        img.save(os.path.join(vdir, f"f{i:03d}_t{t:.2f}.png"))
        frames.append((img, t))
        os.remove(raw)

    # contact sheet：棋盘底显透明
    cols = 6
    cell = 170
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 16)), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for y in range(0, sheet.height, 12):
        for x in range(0, sheet.width, 12):
            if (x // 12 + y // 12) % 2:
                draw.rectangle((x, y, x + 11, y + 11), fill=(230, 230, 230))
    draw = ImageDraw.Draw(sheet)
    for idx, (img, t) in enumerate(frames):
        cx, cy = idx % cols, idx // cols
        thumb = img.copy()
        thumb.thumbnail((cell - 8, cell - 8), Image.NEAREST)
        ox = cx * cell + (cell - thumb.width) // 2
        oy = cy * (cell + 16) + 16 + (cell - thumb.height) // 2
        sheet.paste(thumb, (ox, oy), thumb)
        draw.text((cx * cell + 4, cy * (cell + 16) + 3), f"#{idx} t={t:.2f}", fill=(30, 30, 30))
    sheet.save(os.path.join(vdir, "_contact.png"))
    print(f"{video}: {len(frames)} 帧 → {vdir}\\_contact.png")

    # —— 对齐 + 合成 GIF（feet 对齐：底行中心 x + 包围盒底 y；同镜头连续拍摄不做尺寸归一化）——
    W = max(f.width for f, _ in frames) + 24
    H = max(f.height for f, _ in frames) + 24
    aligned = []
    for f, t in frames:
        px = f.load()
        foot_xs = None
        for y in range(f.height - 1, -1, -1):
            xs = [x for x in range(f.width) if px[x, y][3] > 10]
            if xs:
                foot_xs = xs
                break
        cx = (foot_xs[0] + foot_xs[-1]) // 2 if foot_xs else f.width // 2
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(f, (W // 2 - cx, H - 12 - f.height))
        aligned.append((canvas, t))

    scale = 384 / H
    gif_size = (round(W * scale), 384)
    big = [(c.resize(gif_size, Image.NEAREST), t) for c, t in aligned]
    gif_path = os.path.join(vdir, "_preview.gif")
    big[0][0].save(
        gif_path,
        save_all=True,
        append_images=[c for c, _ in big[1:]],
        duration=[100 for _ in big],
        loop=0,
        disposal=2,
    )
    # 面积统计：看帧间大小漂移幅度
    areas = [f.width * f.height for f, _ in frames]
    print(f"  内容面积 min={min(areas)} max={max(areas)} 漂移 {max(areas)/min(areas):.2f}x → {gif_path}")


if __name__ == "__main__":
    step = float(sys.argv[2]) if len(sys.argv) > 2 else 0.1
    process(sys.argv[1], step)
