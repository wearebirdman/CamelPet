#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 v2 视频抽帧产物打包成可入库的动作精灵包（多档尺寸 × 多 dpr）。

与 `make_idle_pack.py` 的关系：那个生成"待机 + 眨眼"，本脚本生成"大动作"。
两者共用同一套落盘约定（`sprites/<state>/<size>/<dpr>/NNN.png`、非整数倍用 LANCZOS），
但**画布规则不同** —— 大动作有垂直位移（起跳、下蹲），方形画布装不下，见下。

画布为什么不是正方形（本文件的核心取舍）：
- 渲染层把精灵盒设成 `宽=高=spriteSize`，所以素材**必须**是方形 —— 除非扩展渲染层。
  窗口在角色上方留了 `BUBBLE_SPACE_PX=64` 的气泡空间，**画布加高是免费的**：
  元素宽 = size、高 = size × H/W，多出来的高度全在头顶方向，脚底线不动。
- 于是：**宽度基准固定 256，高度按该动作的垂直跨度加高**，脚底固定落在离底 8 行
  （与待机帧一致：待机 256 画布内脚底 y=248）。动作用 1:1 像素输出，**不做任何缩放**，
  像素画不会因非整数倍缩放发软；128/192 档位才走与待机包相同的 LANCZOS。

位移处理（为什么不是逐帧底部对齐）：
- `feet_align`（逐帧把内容底贴到固定行）会把**起跳整个抹平** —— 脚永远踩在地上，
  跳跃只剩身体变形。改为**全局固定垂直偏移**（以尾段落地帧的底行为基准），
  起跳帧自然升高，跳得起来。
- 水平方向相反：源视频里角色会横向移动（最大跨 72 格），桌宠不该满屏乱跑，
  所以**逐帧按脚底中心对齐**到画布中线，把横向位移吃掉（跑动变成原地跑）。

用法：
  python tools/make_action_pack.py 庆祝.mp4 cheer --label 庆祝 --write-manifest
  python tools/make_action_pack.py 跳水2.mp4 dive2 --label 跳水2 --write-manifest
"""
import argparse
import io
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
import imageio_ffmpeg

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))
import video_extract as ve          # noqa: E402  底层抠底/去影/连通域清洗
import video_extract_v2 as v2       # noqa: E402  v2 像素化管线

SPRITES_ROOT = ROOT / "assets" / "skins" / "default" / "sprites"
MANIFEST = ROOT / "assets" / "skins" / "default" / "manifest.json"
PREVIEW_DIR = ROOT / "temp" / "action_pack_preview"

IDLE_SRC = ROOT / "raw" / "final_B1_256" / "000.png"   # 待机基准帧（256×256，脚底 y=248）
IDLE_FOOT_Y = 248
BASE_W = 256        # 宽度基准（脚底 y=248 的待机画布同宽）
FOOT_GAP = 8        # 脚底离画布底边的行数（待机：256 行画布、脚底 y=248 → 8）
SIZES = (128, 192, 256)
DPRS = (1, 1.5)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

# 源视频的"豆包AI生成"水印（四个视频同位置，2026-10-03 实测 bbox x565~695 y895~935）。
# 白底视频里水印贴白底会被 v2 抠底顺手去掉；**粉底/灰底视频（cheer2/dive/dive2）会保留**，
# AI 抠图也会把它当主体。抽帧时统一用 delogo 修掉（矩形略放宽盖住描边）。
WM_X, WM_Y, WM_W, WM_H = 556, 886, 148, 56


def grab(src: Path, t: float):
    """抽单帧（管道读取，不落临时文件 —— 写盘再删会触发安全策略的批量删除拦截）。

    片尾附近的时刻可能落在最后一帧之后，ffmpeg 会输出空管道 → 返回 None（调用方跳过）。
    抽帧时同步做 delogo 去水印（见 WM_* 常量注释）。
    """
    proc = subprocess.run(
        [FFMPEG, "-y", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1",
         "-vf", f"delogo=x={WM_X}:y={WM_Y}:w={WM_W}:h={WM_H}",
         "-f", "image2pipe", "-vcodec", "png", "-"],
        capture_output=True,
    )
    if not proc.stdout:
        return None
    try:
        return Image.open(io.BytesIO(proc.stdout)).convert("RGBA")
    except Exception:
        return None


def clean_frames(src: Path, step: float, cutout_mode: str = "v2"):
    """按 v2 管线（process() 的同一条路）产出**未裁剪**的像素化帧。

    不裁剪是关键：裁掉包围盒就丢了帧间位移，起跳/跑动会被抹平。

    cutout_mode：
      "v2" —— 旧抠底（色距+泛洪，keyed_frame_img）。白底视频上成熟，
              但**灰底/粉底场景会把与背景同色的水面/石池整片吃掉**
              （dive 系列的"显示缺失"：1947 个内部空洞的根因）。
      "ai" —— BiRefNet AI 抠图（本地模型，local-watermark-remover 技能）。
              主体（人物+水池+水花）整体保留，逐帧会话复用。
              输出软边 alpha，后续 finalize 的 alpha 硬化会收掉。
    """
    probe = subprocess.run([FFMPEG, "-i", str(src)], capture_output=True, text=True,
                           encoding="utf-8", errors="ignore").stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", probe)
    dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    times = [i * step for i in range(int(dur / step) + 1) if i * step < dur]

    ai_cutout = None
    if cutout_mode == "ai":
        skill_scripts = Path.home() / ".workbuddy" / "skills" / "local-watermark-remover" / "scripts"
        if not (skill_scripts / "bg_remove.py").is_file():
            raise SystemExit(f"找不到 AI 抠图脚本：{skill_scripts / 'bg_remove.py'}")
        if str(skill_scripts) not in sys.path:
            sys.path.insert(0, str(skill_scripts))
        from bg_remove import cutout as ai_cutout_fn   # session 内部有缓存，逐帧复用
        ai_cutout = ai_cutout_fn
        print("  抠底路线：BiRefNet AI（首次调用会加载本地模型）")

    out = []
    for t in times:
        raw = grab(src, t)
        if raw is None:
            continue
        if ai_cutout is not None:
            rgb = np.asarray(raw.convert("RGB"))
            bgr = rgb[:, :, ::-1].copy()                 # cutout 入参是 BGR
            bgra = ai_cutout(bgr, feather=0)             # feather=0：硬边，像素画不要羽化
            rgba = bgra[:, :, [2, 1, 0, 3]]              # BGR(A) → RGB(A)
            img = Image.fromarray(rgba, "RGBA")
            px = v2.pixelate(img, v2.K)
            # AI 掩膜已把主体整体保留，不再跑 keyed/kill_bg_pockets（那是灰白底特化步骤，
            # 需要 bg_rows 参数且正是"吃水面"的元凶）；孤立碎片靠 keep_main_component 清。
            ve.keep_main_component(px)
        else:
            img, bg_rows, is_light = v2.keyed_frame_img(raw)
            px = v2.pixelate(img, v2.K)
            px = v2.kill_bg_pockets(px, bg_rows, v2.K)
            if not is_light:
                px = v2.clean_shadow_blocks(px, bg_rows, v2.K)
            ve.keep_main_component(px)
        out.append((t, px))
    return out


def metrics(img: Image.Image):
    """返回 (top, bottom, foot_cx, xs_min, xs_max)。"""
    ys, xs = np.where(np.asarray(img)[:, :, 3] > 10)
    if len(ys) == 0:
        return None
    bottom = int(ys.max())
    foot = xs[ys >= bottom - 2]
    return {
        "top": int(ys.min()), "bottom": bottom,
        "foot_cx": float(np.median(foot)),
        "xs_min": int(xs.min()), "xs_max": int(xs.max()),
    }


def signature(img: Image.Image) -> np.ndarray:
    """32×32 缩略签名，用于帧间差分（找动作起止，剪掉首尾静止段）。"""
    return np.asarray(img.resize((32, 32), Image.BILINEAR), dtype=np.float32)


def motion_span(frames, threshold=2.0, pad=2):
    """剪掉首尾"和静止基准帧一样"的帧，返回 [start, end] 闭区间索引。

    首段只和**第一帧**比、尾段只和**最后一帧**比 —— 两头的站立姿势并不相同
    （一个正面站立、一个回位站立），要求同时像两边会导致一帧都剪不掉。
    """
    sigs = [signature(f) for _, f in frames]
    first, last = sigs[0], sigs[-1]
    n = len(sigs)
    d_head = [float(np.abs(s - first).mean()) for s in sigs]
    d_tail = [float(np.abs(s - last).mean()) for s in sigs]

    start = 0
    for i in range(n):
        if d_head[i] >= threshold:
            start = i
            break
    end = n - 1
    for i in range(n - 1, -1, -1):
        if d_tail[i] >= threshold:
            end = i
            break
    if start >= end:                      # 整段都静止（异常素材）→ 原样返回
        return 0, n - 1
    return max(0, start - pad), min(n - 1, end + pad)


def build_canvas_frames(frames, base_w=BASE_W, foot_gap=FOOT_GAP):
    """统一放到 (base_w × H) 画布：**水平和垂直都用整段固定偏移**。

    为什么不再逐帧居中（这是"抖动"的根因）：
    - 逐帧居中要把每帧的脚底中心对齐到中线，偏移量逐帧取整 →
      脚底中心估计值在帧间有 ±1~3 格的噪声，整段看起来就是人物左右小幅抖动。
    - 固定偏移 = 全段共用一个 dx/dy，帧间相对位置完全来自源视频本身，零抖动。
      代价是保留源视频里的横向跑动（最大跨 72 格），对桌宠来说是"原地助跑"变"跑几步"，
      更自然；并集宽度最大 237 ≤ 256，装得下。
    垂直固定偏移锚定**尾段落地帧**的底行：起跳帧因此会真的升高（不会被压回地面）。
    """
    ms = [metrics(f) for _, f in frames]
    for i, m in enumerate(ms):
        if m is None:
            raise SystemExit(f"第 {i} 帧没有内容，抠底结果异常")
    tail = ms[-10:]
    ref_bot = int(np.median([m["bottom"] for m in tail]))     # 落地参考行

    extra = max(ref_bot - m["top"] for m in ms)               # 内容最高伸出多少
    h = foot_gap + extra + 1
    h = max(h, BASE_W)          # 至少 256 高：首尾要放整张待机帧（否则溶解帧被削头）
    h += h % 2                                                # 取偶，方便 0.5 倍缩放
    dy = (h - foot_gap) - ref_bot

    xs_lo = min(m["xs_min"] for m in ms)
    xs_hi = max(m["xs_max"] for m in ms)
    if xs_hi - xs_lo + 1 > base_w:
        raise SystemExit(f"内容并集宽 {xs_hi - xs_lo + 1} > 画布 {base_w}，需要加宽画布")
    dx = int(round((base_w - (xs_hi - xs_lo + 1)) / 2)) - xs_lo   # 并集水平居中

    out = [(t, _compose(img, dx, dy, base_w, h)) for t, img in frames]
    return out, {"ref_bottom": ref_bot, "height": h, "dy": dy, "dx": dx,
                 "union_w": xs_hi - xs_lo + 1}


def _compose(img, dx, dy, base_w, h):
    canvas = Image.new("RGBA", (base_w, h), (0, 0, 0, 0))
    canvas.alpha_composite(img, (dx, dy))
    return canvas


def idle_on_canvas(base_w: int, h: int):
    """待机基准帧摆到动作画布上（脚底对齐同一个高度）。"""
    im = Image.open(IDLE_SRC).convert("RGBA")
    if im.width != base_w:
        im = im.resize((base_w, round(im.height * base_w / im.width)), Image.LANCZOS)
    ys, xs = np.where(np.asarray(im)[:, :, 3] > 0)
    cx = (int(xs.min()) + int(xs.max())) / 2
    scale = im.height / 256.0
    canvas = Image.new("RGBA", (base_w, h), (0, 0, 0, 0))
    canvas.alpha_composite(im, (int(round(base_w / 2 - cx)),
                                int(round((h - FOOT_GAP) - IDLE_FOOT_Y * scale))))
    return canvas


def add_transitions(frames, base_w: int, h: int, blends=(0.35, 0.7)):
    """首尾各插一组"与待机帧的交叉溶解"，抹掉状态切换时的跳变。

    为什么必须做：动作来自视频、待机来自精修像素画，两者是**两张不同的画**
    （姿势、比例、笔触都不同），硬切过去必然是一下明显的跳变。
    做法是让动作**从待机帧开始、以待机帧结束**：首尾各 1 帧真待机帧 + 2 帧溶解过渡，
    于是"切到待机状态"那一刻画面完全没变化，过渡也在 150ms 内平滑完成。
    """
    idle = idle_on_canvas(base_w, h)
    head = [(0.0, idle)]
    for k in blends:
        head.append((0.0, Image.blend(idle, frames[0][1], k)))
    tail = []
    for k in blends:
        tail.append((0.0, Image.blend(frames[-1][1], idle, k)))
    tail.append((0.0, idle))
    return head + frames + tail


def write_tiers(frames, state: str, base_w: int, canvas_h: int, stamp: str = ""):
    """按 128/192/256 × dpr 1/1.5 落盘（与待机包同一套缩放约定）。

    旧目录**不能 rmtree** —— 一次删 96 个文件会被安全策略
    （SAFE_DELETE_BULK_CONFIRM_REQUIRED，阈值 50）拦下，整个打包中断。
    按项目约定改为移入 `temp/_trash_<日期>/`（可逆、可追溯）。
    """
    written = []
    for size in SIZES:
        for dpr in DPRS:
            w = round(size * dpr)
            h = round(w * canvas_h / base_w)
            out_dir = SPRITES_ROOT / state / str(size) / f"{dpr:g}"
            if out_dir.exists():
                base = ROOT / "temp" / f"_trash_{stamp or 'actionpack'}" / state / str(size)
                trash = base / f"{dpr:g}"
                n = 2
                while trash.exists():                      # 同日重复打包 → 加序号，不覆盖
                    trash = base / f"{dpr:g}_{n}"
                    n += 1
                trash.mkdir(parents=True, exist_ok=True)
                for f in out_dir.glob("*.png"):
                    shutil.move(str(f), str(trash / f.name))
                out_dir.rmdir()
            out_dir.mkdir(parents=True)
            for index, (_, img) in enumerate(frames):
                frame = img if img.size == (w, h) else img.resize((w, h), Image.LANCZOS)
                frame.save(out_dir / f"{index:03d}.png")
            written.append((size, f"{dpr:g}", w, h))
    return written


def write_preview(frames, state: str, canvas_h: int):
    """预览 GIF + 接触表，供人工确认（不入库）。"""
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    frames[0][1].save(PREVIEW_DIR / f"{state}.gif", save_all=True,
                      append_images=[f for _, f in frames[1:]],
                      duration=[50] * len(frames), loop=0, disposal=2)
    cols, cell = 6, 140
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 16)), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    for y in range(0, sheet.height, 12):
        for x in range(0, sheet.width, 12):
            if (x // 12 + y // 12) % 2:
                d.rectangle((x, y, x + 11, y + 11), fill=(232, 232, 232))
    for i, (t, img) in enumerate(frames):
        cx, cy = i % cols, i // cols
        thumb = img.copy()
        thumb.thumbnail((cell - 8, cell - 8), Image.NEAREST)
        sheet.paste(thumb, (cx * cell + (cell - thumb.width) // 2,
                            cy * (cell + 16) + 16 + (cell - thumb.height) // 2), thumb)
        d.text((cx * cell + 4, cy * (cell + 16) + 3), f"#{i} t={t:.1f}", fill=(30, 30, 30))
    sheet.save(PREVIEW_DIR / f"{state}_sheet.png")


def update_manifest(state: str, label: str, count: int, base_w: int, canvas_h: int,
                    frame_ms: int = 50):
    """把状态写进 manifest（保留原有键序，新状态追加在末尾）。"""
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    data["states"][state] = {
        "label": label,
        "loop": False,
        "frameDurationMs": frame_ms,
        # 画布宽高（256 基准）：渲染层据此算元素高度（宽=size、高=size×H/W）
        "canvas": {"width": base_w, "height": canvas_h},
        "assets": [
            {"type": "png", "path": f"sprites/{state}/{{size}}/{{dpr}}/{i:03d}.png"}
            for i in range(count)
        ],
    }
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="把视频抽帧打包成动作精灵包")
    ap.add_argument("video", help="视频文件名（相对项目根，如 庆祝.mp4）")
    ap.add_argument("state", help="状态 id（英文小写，如 cheer）")
    ap.add_argument("--label", default=None, help="菜单/设置里显示的中文名（缺省用 id）")
    ap.add_argument("--step", type=float, default=0.05,
                    help="抽帧间隔秒（默认 0.05 = 20fps；源视频 24fps，"
                         "用 0.1 会丢掉一半以上的帧 → 回放明显发顿）")
    ap.add_argument("--no-trim", action="store_true", help="不剪首尾静止段")
    ap.add_argument("--cutout", choices=("v2", "ai"), default="v2",
                    help="抠底路线：v2=旧色距+泛洪（白底视频）；ai=BiRefNet 本地 AI 抠图"
                         "（灰底/粉底视频必选，否则水面/石池被整片吃掉）")
    ap.add_argument("--write-manifest", action="store_true", help="同时写入 manifest.json")
    args = ap.parse_args()

    src = ROOT / args.video
    if not src.is_file():
        print(f"找不到视频：{src}", file=sys.stderr)
        return 1

    frames = clean_frames(src, args.step, cutout_mode=args.cutout)
    print(f"{args.video}: 抽帧 {len(frames)} 帧")
    if not args.no_trim:
        a, b = motion_span(frames)
        print(f"  运动分段：剪掉首尾静止段 → #{a}~#{b}（{b - a + 1} 帧）")
        frames = frames[a:b + 1]

    frames, info = build_canvas_frames(frames)
    frames = add_transitions(frames, BASE_W, info["height"])
    print(f"  画布 {BASE_W}×{info['height']}（脚底参考行 {info['ref_bottom']} → 偏移 {info['dy']}）"
          f"｜首尾各 3 帧待机过渡")

    import datetime
    written = write_tiers(frames, args.state, BASE_W, info["height"],
                          stamp=datetime.date.today().strftime("%Y%m%d"))
    for size, dpr, w, h in written:
        print(f"    {size}/{dpr:<3} → {w}×{h}")

    write_preview(frames, args.state, info["height"])

    if args.write_manifest:
        update_manifest(args.state, args.label or args.state, len(frames),
                        BASE_W, info["height"], frame_ms=max(1, round(args.step * 1000)))
        print(f"  manifest 已更新：states.{args.state}（{len(frames)} 帧）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
