#!/usr/bin/env python3
"""
生成"分层待机"帧包：
  1. idle  循环帧 —— 重心左右摇摆 + 呼吸下沉
  2. blink 三帧   —— 半闭 / 全闭 / 半闭，供渲染层随机插播（非循环，播完回落 idle）

母版与画布（2026-10-01 换画后重定）：
- 母版 = 视频派生那套站立画的 256 基准图（由 cheer 动作首帧裁剪而来），**非方形**。
- 画布 256×262：头顶留 0 行、脚底离画布底 7 行。
  这两个数不是随便取的 ——
    * "脚底离画布底 7 行"决定宠物**在屏幕上的落点**（渲染层按画布底对齐），
      必须与各动作一致（实测 idle/cheer2/dive/dive2 都在屏幕 y≈312），否则切动作会上下跳。
    * 画布高度决定**头顶还剩多少气泡空间**（窗口高 = 尺寸 256 + 气泡 64 + 脚底留白 4 = 324）。
      单行气泡实测约 43px，262 的画布能让气泡正好落在头顶（324−262−4−43−8 = 7px 余量）。
      再高就会把气泡挤到脚下去。

多档位怎么来：
- 只维护**一份 256 母版**，128/192 × dpr 1/1.5 全部按 `write_tiers` 同一套约定派生：
      w = round(size × dpr)，h = round(w × 画布高 / 256)，LANCZOS 缩放。
  已实测：现有动作素材与这套公式**逐像素一致**（差异 0.00%）。

形变为什么这么设计（沿用原方案，段边界按新画重标）：
- 不做"连续剪切"。连续剪切的偏移量逐行取整后，会得到"每 N 行硬错开 1px"的阶梯，
  看起来像身体被切成几块砖。
- 改成"分段刚性平移"：按身体部位切段，段内整体平移（段内零错位），
  错位只发生在段与段之间。错位次数 = 最大偏移像素数，这是像素画的物理下限。
- 于是把段边界**刻意对齐衣服的天然颜色分界线**（新画：鞋口、球袜顶）。
  人眼会把那 1px 错位读成衣褶/布料层叠，而不是"身体裂开了"。这是本方案的关键。
- 幅度取写实值：真人重心切换的头部横移约身高的 1~1.5%，256 基准即 3~4px。

时间轴：30 帧 @ 90ms = 2.7s 一个循环，正弦缓动（极值处速度自然趋零 = 换向时的天然停顿）。

用法：
  python tools/make_idle_pack.py raw/idle_new/000.png \
      --sprites-root assets/skins/default/sprites --foot-y 254 \
      --eyes "92,27,110,39" "134,27,152,39"
"""
import argparse
import math
import shutil
import sys
from pathlib import Path

from PIL import Image

# 256 基准下的默认参数（按 2026-10-01 新画实测标定）
BASE = 256
# 眼睛外框 (x0,y0,x1,y1)：新画眼睛在裁剪后母版的 y27~38、左 x92~110 / 右 x134~152
EYES_DEFAULT = ["92,27,111,39", "134,27,153,39"]

FRAME_COUNT = 30  # idle 循环帧数
FRAME_MS = 90  # 每帧时长 → 循环 2.7s
SWING_PX = 3  # 256 基准：身体最大水平位移
BOB_PX = 1  # 256 基准：呼吸下沉

SIZES = [128, 192, 256]
DPRS = [1.0, 1.5]

# 形变模型：绕脚踝摆动（脚钉住，脚以上整体侧移，球袜段做柔性过渡）
#
# 段边界按**新画**重标（新画腿部结构与旧画不同：绿裤→裸露小腿(肤色)→红球袜→黑球鞋）：
#   0 ~ 21 行  球鞋        → 0.00（脚钉住不动）
#   21 ~ 33 行 红色球袜    → 线性 0→1（唯一的形变区，表现为小腿微倾）
#   ≥33 行     肤色/球裤以上 → 1.00（整体刚性平移，内部零错位）
# 渐变上界刻意取 33 而非球袜顶（离脚底 39 行）：给"球袜顶=肤色"那条水平线留缓冲带，
# 保证它上下两侧位移取值相同（否则 1px 跳变会正压在那条线上形成撕裂）。
# 单位是"离脚底的行数"，与画布高度解耦 —— 换画布不用重算比例。
SWING_PROFILE_ROWS = [
    (0, 0.00),
    (21, 0.00),  # 鞋口：两侧同为 0，水平线不被切断
    (33, 1.00),  # 球袜上段（球袜顶之下留缓冲）
    (10 ** 6, 1.00),
]


def parse_args():
    parser = argparse.ArgumentParser(description="生成分层待机帧包（摇摆循环 + 眨眼）")
    parser.add_argument("frame", type=Path, help="基准单帧静图（已抠底、已裁到目标画布的 256 母版）")
    parser.add_argument("--sprites-root", type=Path, required=True,
                        help="精灵根目录，如 assets/skins/default/sprites")
    parser.add_argument("--foot-y", type=int, required=True,
                        help="母版里脚底所在行（256 基准像素行），形变段以它为原点")
    parser.add_argument("--eyes", nargs="*", default=EYES_DEFAULT,
                        help="眼睛外框（母版坐标）'x0,y0,x1,y1'，左眼右眼各一项")
    parser.add_argument("--swing", type=int, default=SWING_PX, help="256 基准最大水平位移")
    parser.add_argument("--bob", type=int, default=BOB_PX, help="256 基准呼吸下沉")
    parser.add_argument("--stamp", default="", help="回收目录日期戳，如 20261001")
    return parser.parse_args()


def profile_factor(rows_above_sole: float) -> float:
    """按 SWING_PROFILE_ROWS 控制点线性插值。入参：离脚底的行数（向上为正）。"""
    points = SWING_PROFILE_ROWS
    if rows_above_sole <= points[0][0]:
        return points[0][1]
    for (r0, f0), (r1, f1) in zip(points, points[1:]):
        if rows_above_sole <= r1:
            if r1 == r0:
                return f1
            return f0 + (f1 - f0) * (rows_above_sole - r0) / (r1 - r0)
    return points[-1][1]


def shift_rows(frame: Image.Image, swing_px: float, foot_y: int) -> Image.Image:
    """
    逐行水平平移，每行位移由 profile_factor 决定 —— 行内零错位（不会撕开任何一条线），
    位移只在行与行之间变化，且变化刻意限制在球袜段（纯色区），表现为小腿倾斜。
    按"位移相同的连续行"分块批量粘贴，避免逐行 crop 的开销。
    """
    width, height = frame.size
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    def dx_at(y):
        rows = foot_y - y  # 离脚底的行数（向上为正）
        return math.floor(swing_px * profile_factor(rows) + 0.5)

    y = 0
    while y < height:
        dx = dx_at(y)
        y_end = y + 1
        while y_end < height and dx_at(y_end) == dx:
            y_end += 1
        block = frame.crop((0, y, width, y_end))
        h = y_end - y
        if dx == 0:
            out.paste(block, (0, y))
        elif dx > 0:
            out.paste(block.crop((0, 0, width - dx, h)), (dx, y))
        else:
            out.paste(block.crop((-dx, 0, width, h)), (0, y))
        y = y_end
    return out


def compose_frame(frame: Image.Image, swing_px: float, sink_px: int, foot_y: int) -> Image.Image:
    """一帧 idle = 绕脚踝的行级位移 + 整体下沉（底部溢出截断）。"""
    width, height = frame.size
    shifted = shift_rows(frame, swing_px, foot_y)
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    out.paste(shifted, (0, sink_px))
    return out


def build_idle(frame: Image.Image, swing: int, bob: int, foot_y: int) -> list:
    amplitude = float(swing)
    sink_max = max(1, bob)

    frames = []
    for index in range(FRAME_COUNT):
        t = index / FRAME_COUNT
        # 水平：正弦缓动，极值处速度自然趋零 = 换向时的天然停顿
        swing_px = amplitude * math.sin(2 * math.pi * t)
        # 垂直：2 倍频，去程/回程各沉一次，与水平合成"8 字/椭圆"式的柔和浮动
        sink = math.floor(sink_max * (1 - math.cos(4 * math.pi * t)) / 2 + 0.5)
        frames.append((compose_frame(frame, swing_px, sink, foot_y), FRAME_MS))
    return frames


def darkest_pixel(pixels) -> tuple | None:
    """一组 RGBA 里最深的（亮度最低且不透明）像素，用作睫毛/眼线色。"""
    best = None
    best_score = 1e9
    for r, g, b, a in pixels:
        if a < 128:
            continue
        score = r + g + b
        if score < best_score:
            best_score = score
            best = (r, g, b, 255)
    return best


def make_closed_eye(frame: Image.Image, box: tuple, mode: str) -> Image.Image:
    """
    把一只眼睛改成半闭 / 全闭。
    逐列处理：填充色取眼框正下方一行的肤色（保留脸的垂直渐变）；
    全闭时在原上眼线下方一点画一条原色的闭眼线，弧度自然跟随原眼型。
    """
    image = frame.copy()
    pixels = image.load()
    x0, y0, x1, y1 = box
    width, height = image.size

    # 闭眼线：逐列取上眼线（框顶部若干行）里最深色像素的位置与颜色
    lash_probe_rows = max(2, round(3 * (width / BASE)))

    for x in range(max(0, x0), min(width, x1)):
        probe = [pixels[x, y] for y in range(y0, min(y0 + lash_probe_rows + 1, y1))]
        lash = darkest_pixel(probe)
        fill = pixels[x, min(y1 + 1, height - 1)]  # 眼框下方的肤色（逐列采样保渐变）

        if mode == "half":
            for y in range(y0 + (y1 - y0) // 2, y1):
                pixels[x, y] = fill
        else:  # full
            for y in range(y0, y1):
                pixels[x, y] = fill
            if lash is not None:
                line_y = min(y0 + lash_probe_rows + 2, y1 - 1)
                pixels[x, line_y] = lash
    return image


def build_blink(frame: Image.Image, eyes: list) -> list:
    half = frame.copy()
    full = frame.copy()
    for box_str in eyes:
        box = tuple(int(v) for v in box_str.split(","))
        half = make_closed_eye(half, box, "half")
        full = make_closed_eye(full, box, "full")
    # 播放序列：半闭 → 全闭(停一拍) → 半闭，播完由渲染层回落 idle
    return [(half, 70), (full, 130), (half, 70)]


def write_tier(frames: list, sprites_root: Path, state: str, size: int, dpr: float,
               base_w: int, canvas_h: int, stamp: str) -> tuple:
    """按 128/192/256 × dpr 1/1.5 落盘（与动作包的 write_tiers 同一套缩放约定）。"""
    width = round(size * dpr)
    height = round(width * canvas_h / base_w)
    out_dir = sprites_root / state / str(size) / f"{dpr:g}"

    if out_dir.exists():
        # 旧目录不能 rmtree（一次删 30+ 文件会撞安全策略），按项目约定移入回收区。
        # sprites_root = <项目根>/assets/skins/default/sprites → 上溯 4 级才是项目根。
        project_root = sprites_root.parents[3]
        trash = project_root / "temp" / f"_trash_{stamp or 'idlepack'}" / state / str(size) / f"{dpr:g}"
        n = 2
        while trash.exists():
            trash = trash.parent / f"{dpr:g}_{n}"
            n += 1
        trash.mkdir(parents=True, exist_ok=True)
        for f in out_dir.glob("*.png"):
            shutil.move(str(f), str(trash / f.name))
        out_dir.rmdir()
    out_dir.mkdir(parents=True)

    for index, (image, _hold) in enumerate(frames):
        frame = image if image.size == (width, height) else image.resize((width, height), Image.LANCZOS)
        frame.save(out_dir / f"{index:03d}.png")
    return size, f"{dpr:g}", width, height


def main() -> int:
    args = parse_args()
    if not args.frame.is_file():
        print(f"找不到文件：{args.frame}", file=sys.stderr)
        return 1

    with Image.open(args.frame) as image:
        master = image.convert("RGBA")

    base_w, canvas_h = master.size
    if base_w != BASE:
        print(f"母版宽度必须是 {BASE}（256 基准），当前 {base_w}", file=sys.stderr)
        return 1
    if not (0 < args.foot_y < canvas_h):
        print(f"--foot-y 越界：{args.foot_y}（画布高 {canvas_h}）", file=sys.stderr)
        return 1

    print(f"母版 {base_w}×{canvas_h}｜脚底行 {args.foot_y}（离画布底 {canvas_h - 1 - args.foot_y} 行）"
          f"｜bbox={master.getbbox()}")

    idle_frames = build_idle(master, args.swing, args.bob, args.foot_y)
    blink_frames = build_blink(master, args.eyes)

    rows = []
    for size in SIZES:
        for dpr in DPRS:
            rows.append(write_tier(idle_frames, args.sprites_root, "idle", size, dpr, base_w, canvas_h, args.stamp))
    for size in SIZES:
        for dpr in DPRS:
            rows.append(write_tier(blink_frames, args.sprites_root, "blink", size, dpr, base_w, canvas_h, args.stamp))

    print(f"  idle  循环 {len(idle_frames)} 帧 × {FRAME_MS}ms = {len(idle_frames) * FRAME_MS}ms")
    print(f"  blink 序列 {len(blink_frames)} 帧")
    for size, dpr, w, h in rows:
        print(f"    {size}/{dpr}: {w}×{h}")
    print("提醒：manifest 的 idle / blink 需要写 canvas = "
          f"{{width: {base_w}, height: {canvas_h}}}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
