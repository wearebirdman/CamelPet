# -*- coding: utf-8 -*-
"""视频抽帧管线 v3：把"外部视频"变成待机同密度的像素画动作帧。

## 与 v2 的关系（本轮为什么改）

v2 有三个结构性缺陷，真机播放时表现为"发带/头巾时隐时现""水池被吃掉""两腿之间留灰脏"：

1. **背景判据是"感知式"的，不是"结构式"的**
   - 浅底分支用「亮度 > 0.62 且饱和 < 0.16」判背景 —— 白色发带完全符合这个描述，
     泛洪从发带外缘渗进去把整条吃掉；发带描边有没有缺口决定这一帧吃不吃 → **逐帧闪烁**。
   - 实测：庆祝的发带白 (248,248,252) 与背景白 (244,244,244) **只差 10**，色彩不可分。
   - 跳水.mp4 是灰底 (172,180,187)，水池石块是中性灰 (178,174,171)，**色距仅 18** ——
     任何"放宽的浅底判据"都会把石池一起吞掉。
   → 正解：判据保持"色距 + 泛洪"，但泛洪**必须被前景屏障挡住**：
     与所在行背景色距超过 `fg_tol` 的像素（角色描边、饱和色、深色石块缝）膨胀 `barrier_k`
     圈作为屏障，泛洪不许穿过。发带/水池被轮廓包住 → 泛洪进不去 → 保住。

2. **行背景建模被场景物污染**
   - v2 取"左右边缘中值"，水池贴到画面右边缘时右中值=池水色 → 整池水被当成背景吃掉
     （跳水2 只剩一圈蓝描边）。
   → 正解：先取**顶部 15% 行的中值**作为全局背景参考（角色/道具一定在下方），
     每行只在「与全局参考色距 < loose」的像素里取中值；样本太少的行沿用上一行。

3. **全局色彩清洗会误杀白色**
   - `remove_bg_color(bg, 60)` 是一次全图色距扫描（不管连通性），白色（距白底仅 14）
     被整片抹掉。→ 删掉这一步，改为**结构守卫**的清理（见 kill_bg_pockets 的三档规则）。

## 最终流程

    抽帧 → row_bg(稳健) → 泛洪抠底（前景屏障保护）
         → kill_shadow_reachable（彩底：墙投影，全分辨率可达性判据）
         → remove_gray_shadow（浅底：邻接透明的灰影）
         → fill_internal_holes（描边缺口造成的内部洞回填）
         → pixelate（3×3 整分降采样，solid_thr=3/9）
         → kill_bg_pockets（背景口袋三档规则）
         → clean_shadow_blocks（彩底：贴地底部带影子）
         → keep_main_component

用法：python tools/video_extract_v2.py <视频名> [帧间隔秒]
输出：temp/video_frames_v2/<名>/
"""
import io
import os
import re
import subprocess
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageDraw
import imageio_ffmpeg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "temp", "video_frames_v2")
K = 3                      # 视频像素块边长（diag_blocksize.py 实测 k=3 最优）
CANVAS = (256, 256)
FOOT_Y = 248

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import video_extract as ve  # noqa: E402  复用连通域清洗等底层函数


# ---------------------------------------------------------------- 基础工具

def _rgb(img):
    return np.asarray(img.convert("RGB"), dtype=np.float32)


def _hsv(rgb):
    """rgb float(0~1) 任意形状[...,3] → (h,s,v)，h 归一到 0~1。"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(axis=-1)
    mn = rgb.min(axis=-1)
    d = mx - mn
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0.0)
    safe_d = np.maximum(d, 1e-6)
    hr = ((g - b) / safe_d) % 6
    hg = (b - r) / safe_d + 2
    hb = (r - g) / safe_d + 4
    hh = np.where(mx == r, hr, np.where(mx == g, hg, hb)) / 6
    hh = np.where(d == 0, 0.0, hh)
    return hh, s, mx


def flood_from_border(mask, max_iter=2000):
    """从画面边界向内扩散（numpy 迭代膨胀），返回可达区域。"""
    reach = np.zeros_like(mask)
    reach[0, :] = mask[0, :]
    reach[-1, :] = mask[-1, :]
    reach[:, 0] = mask[:, 0]
    reach[:, -1] = mask[:, -1]
    for _ in range(max_iter):
        grow = reach.copy()
        np.logical_or(grow[1:, :], reach[:-1, :], out=grow[1:, :])
        np.logical_or(grow[:-1, :], reach[1:, :], out=grow[:-1, :])
        np.logical_or(grow[:, 1:], reach[:, :-1], out=grow[:, 1:])
        np.logical_or(grow[:, :-1], reach[:, 1:], out=grow[:, :-1])
        grow &= mask
        if grow.sum() == reach.sum():
            break
        reach = grow
    return reach


def dilate(mask, k=1):
    """4 邻域膨胀 k 圈（k 很小，直接循环）。"""
    out = mask.copy()
    for _ in range(k):
        grow = out.copy()
        grow[1:, :] |= out[:-1, :]
        grow[:-1, :] |= out[1:, :]
        grow[:, 1:] |= out[:, :-1]
        grow[:, :-1] |= out[:, 1:]
        out = grow
    return out


def adj_to_transparent(alpha):
    """每个不透明像素是否与透明像素 4 邻接。"""
    tr = alpha == 0
    adj = np.zeros_like(tr)
    adj[1:, :] |= tr[:-1, :]
    adj[:-1, :] |= tr[1:, :]
    adj[:, 1:] |= tr[:, :-1]
    adj[:, :-1] |= tr[:, 1:]
    return adj


def _components(like):
    """4 邻域连通域标记（BFS）。像素化图很小，够快。返回 (labels, sizes)。"""
    h, w = like.shape
    labels = np.zeros((h, w), np.int32)
    sizes = {}
    cur = 0
    ys, xs = np.where(like)
    for y0, x0 in zip(ys.tolist(), xs.tolist()):
        if labels[y0, x0]:
            continue
        cur += 1
        q = deque([(y0, x0)])
        labels[y0, x0] = cur
        n = 0
        while q:
            y, x = q.popleft()
            n += 1
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < h and 0 <= nx < w and like[ny, nx] and not labels[ny, nx]:
                    labels[ny, nx] = cur
                    q.append((ny, nx))
        sizes[cur] = n
    return labels, sizes


# ---------------------------------------------------------------- 背景建模

def row_bg(img, loose=70.0, top_frac=0.15, min_frac=0.04):
    """逐行背景色，**不被场景物污染**。

    先取顶部 `top_frac` 行的中值当全局参考（角色/道具一定在下方，顶部必是背景），
    每行只在「与全局参考色距 < loose」的像素里取中值；候选太少的行沿用上一行
    （背景有垂直渐变时，相邻行的背景色本就接近）。
    """
    arr = _rgb(img)
    h, w, _ = arr.shape
    top = max(1, int(h * top_frac))
    global_bg = np.median(arr[:top].reshape(-1, 3), axis=0)
    d = np.abs(arr - global_bg).max(axis=2)
    cand = d < loose
    masked = np.where(cand[:, :, None], arr, np.nan)
    rows = np.nanmedian(masked, axis=1)
    need = max(2, int(w * min_frac))
    good = cand.sum(axis=1) >= need
    if not good.any():
        return np.broadcast_to(global_bg, (h, 3)).astype(np.float32).copy()
    idx = np.where(good)[0]
    for y in range(h):
        if not good[y]:
            prev = idx[idx < y]
            rows[y] = rows[prev[-1]] if len(prev) else rows[idx[0]]
    return rows.astype(np.float32)


def bg_distance(rgb, bg_rows):
    return np.sqrt(((rgb - bg_rows[:, None, :]) ** 2).sum(axis=2))


def fg_barrier(rgb, bg_rows, fg_tol=70.0, k=3):
    """前景屏障：与所在行背景色距 > fg_tol 的像素膨胀 k 圈。

    泛洪不许穿过屏障 —— 这是"发带被轮廓包住就吃不掉""石池被轮廓包住就吞不掉"的实现。
    膨胀补上抗锯齿/压缩造成的描边缺口（缺口宽 ≤ 2k 就被封住）。

    k 为什么取 3（实测）：跳水.mp4 的石砌泳池与灰底**同色**（冷灰对冷灰，色距仅 10），
    池壁只靠砖缝的深色线挡泛洪；砖缝有 ≤6px 的小缺口，k=2 只保住 72% 池壁、
    k=3 保住 100%。屏障加宽不会误删任何东西（它只拦泛洪），
    轮廓外多留下的背景色环由 kill_bg_pockets 的紧容差+邻接透明规则剥掉。
    """
    return dilate(bg_distance(rgb, bg_rows) > fg_tol, k)


# ---------------------------------------------------------------- 抠底

def fill_internal_holes(img, max_iter=700):
    """回填内部洞：alpha=0 且不接触边界的连通域（泛洪从描边缺口渗进去造成的洞）。"""
    arr = np.asarray(img).copy()
    h, w, _ = arr.shape
    a = arr[:, :, 3] == 0
    if not a.any():
        return img
    reach = np.zeros((h, w), bool)
    reach[0, :] = a[0, :]
    reach[-1, :] = a[-1, :]
    reach[:, 0] = a[:, 0]
    reach[:, -1] = a[:, -1]
    for _ in range(max_iter):
        grow = reach.copy()
        np.logical_or(grow[1:, :], reach[:-1, :], out=grow[1:, :])
        np.logical_or(grow[:-1, :], reach[1:, :], out=grow[:-1, :])
        np.logical_or(grow[:, 1:], reach[:, :-1], out=grow[:, 1:])
        np.logical_or(grow[:, :-1], reach[:, 1:], out=grow[:, :-1])
        grow &= a
        if grow.sum() == reach.sum():
            break
        reach = grow
    holes = a & ~reach
    if not holes.any():
        return img
    rgb = arr[:, :, :3].astype(np.float32)
    known = arr[:, :, 3] > 0
    for _ in range(max_iter):
        unknown = holes & ~known
        if not unknown.any():
            break
        acc = np.zeros((h, w, 3), np.float32)
        cnt = np.zeros((h, w), np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            kk = np.roll(known, (dy, dx), axis=(0, 1))
            v = np.roll(rgb, (dy, dx), axis=(0, 1))
            acc += v * kk[:, :, None]
            cnt += kk
        fillable = unknown & (cnt > 0)
        if not fillable.any():
            break
        rgb[fillable] = acc[fillable] / cnt[fillable][:, None]
        known |= fillable
    arr[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    arr[holes, 3] = 255
    return Image.fromarray(arr, "RGBA").copy()


def kill_shadow_reachable(img, bg_rows, tol=40.0):
    """彩底：删「从画面边界经影子色可达」的区域（背景墙上的投影带）。

    必须在全分辨率层做 —— 像素化后嘴腔、深色球衣与影子颜色几乎相同，
    只有"唇线封闭结构"能区分。
    影子判据用**蓝比值 ≥ 绿比值**（玫粉背景 b>g 的色度签名）；手臂/皮毛/球衣全部 b<g。
    """
    arr = np.asarray(img).copy()
    rgb = arr[:, :, :3].astype(np.float32)
    opaque = arr[:, :, 3] > 0
    near = bg_distance(rgb, bg_rows) < tol
    rl = rgb / np.maximum(bg_rows[:, None, :], 1.0)
    dark = ((rl > 0.30) & (rl < 0.97)).all(axis=2)
    span = rl.max(axis=2) - rl.min(axis=2)
    bge = rl[:, :, 2] >= rl[:, :, 1]
    shadow = dark & bge & (span < 0.28)
    hh, ss, vv = _hsv(rgb / 255.0)
    hl = _hsv(bg_rows / 255.0)[0]                  # (h,)
    dh = np.abs(hh - hl[:, None])
    dh = np.minimum(dh, 1.0 - dh)
    # 饱和度上限是必须的：球衣红 (160,48,40) 的色相只比玫粉背景远 0.04（0.99 vs 0.955）、
    # 饱和度却是 0.75 —— 只加下限会把整件球衣当"影子色相"吃掉（跳水2 衣服闪烁的真凶）。
    # 真影子/粉斑的饱和度都在 0.35~0.55（实测 深影 0.50、影缘 0.38、亮粉斑 0.38）。
    hue = (dh < 0.05) & (ss > 0.30) & (ss < 0.62) & (vv > 0.35) & (vv < 0.90)
    reach = flood_from_border(opaque & (near | shadow | hue))
    arr[reach, 3] = 0
    return Image.fromarray(arr, "RGBA").copy()


def remove_gray_shadow(img, min_v=70, max_v=175, max_s=0.13, rounds=64):
    """浅底：删低饱和灰影（柔和投影），**只删邻接透明的**并迭代扩散。

    浅底视频的投影是灰色（实测 庆祝 (136,136,144)，V≈144、S≈0.06），
    与 v2 的"亮度 > 0.62 即背景"判据擦肩而过 → 留在两腿之间成灰脏。
    限定"邻接透明 + 迭代扩散"保证不碰角色内部的深灰；
    白发暗面 V≈184 > max_v 保留，球鞋/描边 V < min_v 保留。
    """
    arr = np.asarray(img).copy()
    rgb = arr[:, :, :3].astype(np.float32)
    _, s, v = _hsv(rgb / 255.0)
    cand = (arr[:, :, 3] > 0) & (s < max_s) & (v * 255 > min_v) & (v * 255 < max_v)
    for _ in range(rounds):
        kill = cand & adj_to_transparent(arr[:, :, 3])
        if not kill.any():
            break
        arr[kill, 3] = 0
    return Image.fromarray(arr, "RGBA").copy()


def decontaminate_edges(img, band=3, rounds=8):
    """把轮廓外圈的"背景混合色"换成内侧内容色（全分辨率，抠底的最后一步）。

    泛洪被前景屏障挡下后，轮廓外会留 band 像素宽的混合带（背景色×内容色的过渡），
    量化时正好压成外圈一格 —— 粉底视频里就是一圈**粉色描边**
    （用户看到的"没扣干净的粉块"、水花上的粉边都是它）。原始视频里这些边是干净的。

    做法：取"距透明 ≥ band"的像素当**纯内容种子**，把它们的颜色向外扩散覆盖混合带。
    在块级做不了这件事 —— 小结构（水花碎点、手指）整块都是外圈，没有内侧邻居可参考。
    """
    arr = np.asarray(img).copy()
    op = arr[:, :, 3] > 0
    if not op.any():
        return img
    tr = ~op
    cur = tr
    for _ in range(band):
        grow = cur.copy()
        grow[1:, :] |= cur[:-1, :]
        grow[:-1, :] |= cur[1:, :]
        grow[:, 1:] |= cur[:, :-1]
        grow[:, :-1] |= cur[:, 1:]
        cur = grow
    inner = op & ~cur                     # 距透明 ≥ band 的纯内容
    edge = op & ~inner
    if not inner.any() or not edge.any():
        return img
    rgb = arr[:, :, :3].astype(np.float32)
    known = inner.copy()
    for _ in range(rounds):
        unknown = edge & ~known
        if not unknown.any():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(op.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            kk = np.roll(known, (dy, dx), axis=(0, 1))
            v = np.roll(rgb, (dy, dx), axis=(0, 1))
            acc += v * kk[:, :, None]
            cnt += kk
        fill = unknown & (cnt > 0)
        if not fill.any():
            break
        rgb[fill] = acc[fill] / cnt[fill][:, None]
        known |= fill
    arr[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA").copy()


def keyed_frame_img(img):
    """抠底（屏障保护 + 稳健行背景）。返回 (img, bg_rows, is_light_bg)。"""
    bg_rows = row_bg(img)
    rgb = _rgb(img)
    global_bg = np.median(bg_rows, axis=0)
    s_bg, v_bg = ve.rgb_to_hsv(*global_bg)
    is_light_bg = bool(v_bg > 0.65 and s_bg < 0.18)

    barrier = fg_barrier(rgb, bg_rows, fg_tol=70.0, k=3)
    like = (bg_distance(rgb, bg_rows) < (45.0 if is_light_bg else 40.0)) & ~barrier
    reach = flood_from_border(like)
    arr = np.asarray(img).copy()
    arr[reach, 3] = 0
    img = Image.fromarray(arr, "RGBA")

    if not is_light_bg:
        img = kill_shadow_reachable(img, bg_rows)
    # 洞回填必须在灰影清除**之前**：两腿之间的接触影被腿包住，清掉后会变成"内部洞"，
    # 回填步骤会把它插值复原成灰块（庆祝脚底灰脏的真实成因）。
    img = fill_internal_holes(img)
    if is_light_bg:
        img = remove_gray_shadow(img)
    img = decontaminate_edges(img)      # 抹掉轮廓外的背景混合带（粉边来源）
    return img, bg_rows, is_light_bg


# ---------------------------------------------------------------- 像素化与清残

def pixelate(img, k=K, solid_thr=0.34):
    """k×k 块整分降采样：块内不透明像素均值色，alpha 二值化。

    solid_thr = 3/9（v2 是 5/9）：v2 会把"只被覆盖 4/9 的边缘块"整块丢掉 ——
    快速挥臂/跳跃帧的手臂因此断成几截（用户报的"撕裂"）。降到 3/9 保住这些块。
    """
    arr = np.asarray(img, dtype=np.float32)
    h, w, _ = arr.shape
    oh, ow = h // k, w // k
    arr = arr[: oh * k, : ow * k]
    rgb = arr[:, :, :3].reshape(oh, k, ow, k, 3)
    alpha = (arr[:, :, 3] > 128).astype(np.float32).reshape(oh, k, ow, k)
    solid = alpha.sum(axis=(1, 3))
    mask = alpha[:, :, :, :, None]
    cnt = np.maximum(mask.sum(axis=(1, 3)), 1.0)
    mean_rgb = (rgb * mask).sum(axis=(1, 3)) / cnt
    out = np.zeros((oh, ow, 4), dtype=np.uint8)
    filled = solid >= max(1, round(k * k * solid_thr))
    out[filled, :3] = np.clip(mean_rgb[filled], 0, 255).astype(np.uint8)
    out[filled, 3] = 255
    return Image.fromarray(out, "RGBA").copy()


def _neighbor_count(a):
    """每个像素的 4 邻域里"与自身同为 True"的个数（a 为布尔掩码，按"是前景"算）。"""
    n = np.zeros(a.shape, np.int16)
    n[1:, :] += a[:-1, :]
    n[:-1, :] += a[1:, :]
    n[:, 1:] += a[:, :-1]
    n[:, :-1] += a[:, 1:]
    return n


def _rings(op):
    """返回 [ring1, ring2, ring3]：轮廓内侧第 1/2/3 格（按"到透明的距离"）。"""
    tr = ~op
    cur = tr
    out = []
    for _ in range(3):
        grow = cur.copy()
        grow[1:, :] |= cur[:-1, :]
        grow[:-1, :] |= cur[1:, :]
        grow[:, 1:] |= cur[:, :-1]
        grow[:, :-1] |= cur[:, 1:]
        out.append(grow & ~cur & op)
        cur = grow
    return out


def clean_edges(img, ring1_gain=0.34, ring2_gain=0.24, thick_need=2, main_only=False):
    """像素化后的边缘修缮 —— 把轮廓做成待机形象那种"两格深色描边"。

    为什么：实测待机基准帧的轮廓内侧两圈亮度是 **26 与 47**（很暗、很连续），
    而视频来源的动作帧只有 **58~79** 且时断时续 —— 用户看到的"锯齿边/不够精细"
    就是描边又细又浅造成的（阶梯被裸露出来）。这里按待机的规格补齐：

      1. 去掉孤立凸块（4 邻域前景邻居 ≤1）—— 消掉轮廓上的单块毛刺；
      2. 补上孤立凹口（透明块但有 ≥3 个前景邻居）—— 补掉轮廓上的单块缺口；
      3. **第 1 格轮廓一律压暗**（×ring1_gain）；
      4. **第 2 格只在结构够厚时压暗**（第 3 格存在且邻接 ≥thick_need 个）——
         否则细结构（手指、发带白边、"自律"笔画）会被描边吃掉。
    """
    arr = np.asarray(img).copy()
    op = arr[:, :, 3] > 0
    if not op.any():
        return img
    lone = op & (_neighbor_count(op) <= 1)
    arr[lone, 3] = 0
    op = arr[:, :, 3] > 0
    notch = (~op) & (_neighbor_count(op) >= 3)
    if notch.any():
        rgb = arr[:, :, :3].astype(np.float32)
        acc = np.zeros(rgb.shape, np.float32)
        cnt = np.zeros(op.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            kk = np.roll(op, (dy, dx), axis=(0, 1))
            v = np.roll(rgb, (dy, dx), axis=(0, 1))
            acc += v * kk[:, :, None]
            cnt += kk
        fill = notch & (cnt > 0)
        rgb[fill] = acc[fill] / cnt[fill][:, None]
        arr[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        arr[fill, 3] = 255
        op = arr[:, :, 3] > 0

    r1, r2, r3 = _rings(op)
    if main_only:
        # 描边只给角色主体（最大连通域）—— 场景物（水池、水花、球）的边界
        # 一旦被压暗就会看着像"被啃掉/有脏边"（跳水2 池沿实测被压到 (50,53,57)，
        # 源色其实是 (217,222,240) 的白色池沿）。默认 False 保持其他动作现状。
        # 角色 ≠ 最大连通域（跳水2 里水池比角色还大：11641 vs 10092 像素）！
        # 按"暖色像素最多"来找角色：驼色皮毛/红衣是暖色（r>=b），池水是冷色（b>r）。
        lab, sizes = _components(op)
        warm = (arr[:, :, 0].astype(np.int16) >= arr[:, :, 2].astype(np.int16)) & op
        score = {}
        for k in sizes:
            m = lab == k
            score[k] = int((warm & m).sum())
        main_id = max(score, key=lambda k: score[k])
        keep = lab == main_id
        r1 = r1 & keep
        r2 = r2 & keep
        r3 = r3 & keep
    rgb = arr[:, :, :3].astype(np.float32)

    # 去污（关键）：轮廓第 1 格的颜色多半是"背景 + 内容"的混合 ——
    # 泛洪被屏障挡下时会在轮廓外留 3px，量化正好压成一格，
    # 于是描边带上背景色（粉底视频里就是一圈粉边，用户眼里的"没扣干净的粉块"）。
    # 用内侧邻居的均色替换掉，再压暗，得到的就是干净的深色描边。
    inner = op & ~r1
    if inner.any():
        acc = np.zeros_like(rgb)
        cnt = np.zeros(op.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            kk = np.roll(inner, (dy, dx), axis=(0, 1))
            v = np.roll(rgb, (dy, dx), axis=(0, 1))
            acc += v * kk[:, :, None]
            cnt += kk
        take = r1 & (cnt > 0)
        rgb[take] = acc[take] / cnt[take][:, None]

    n3 = np.zeros(op.shape, np.int16)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        n3 += np.roll(r3, (dy, dx), axis=(0, 1))
    dark2 = r2 & (n3 >= thick_need)          # 厚结构才补第二格
    rgb[r1] *= ring1_gain
    rgb[dark2] *= ring2_gain
    arr[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA").copy()


def kill_bg_pockets(img, bg_rows, k=K, tol=25.0, tight=8.0, min_area=30,
                    head_frac=0.35, wall_tol=30.0):
    """清除背景残留（泛洪够不到 / 被屏障挡下留下的背景色块），**三档规则**：

    1. **紧容差 + 邻接透明**（色距 < tight=8）：屏障在轮廓外留下的背景色环，逐层剥掉。
       真背景色距 ≈ 0~3；道具（跳水石池色距 18）不受影响。
    2. **松容差 + 面积**（色距 < tol=40 且面积 ≥ min_area）：被轮廓完全封闭的口袋。
    3. **头部区域豁免**：内容上沿往下 head_frac 范围内的块不走面积规则 ——
       浅底视频里"发带白"与"背景白"色距只有 10，色彩不可分，只能靠结构：
       发带被头部轮廓包住（不邻接透明），绝不能被面积规则误杀。

    背景参考取两种：所在行背景 + 全局墙面色（顶部 20% 行中值）——
    后者的意义是兜住"行模型被地面/水面污染"的行（v2 的腰际粉带就是这么漏掉的）。
    """
    arr = np.asarray(img).copy()
    h, w, _ = arr.shape
    rgb = arr[:, :, :3].astype(np.float32)
    idx = np.clip(np.arange(h) * k + k // 2, 0, len(bg_rows) - 1)
    refs = [bg_rows[idx]]
    top = max(1, int(len(bg_rows) * 0.2))
    wall = np.median(bg_rows[:top], axis=0)
    refs.append(np.broadcast_to(wall, (h, 3)).astype(np.float32))

    # tol 从 40 收到 25：驼色皮毛的暗部 (169,99,81) 与粉底 (187,77,107) 色距只有 38.5，
    # 用 40 会把它的块当"背景口袋"删掉（跳水2 #31 脸部被啃出洞的真凶）。
    # 该规则本意只是清"纯背景色口袋"（色距 ~5~15），25 足够。
    acc_loose = np.zeros((h, w), bool)
    acc_tight = np.zeros((h, w), bool)
    for ref in refs:
        d2 = ((rgb - ref[:, None, :]) ** 2).sum(axis=2)
        acc_loose |= d2 < tol * tol
        acc_tight |= d2 < tight * tight
    opaque = arr[:, :, 3] > 0

    ys, _ = np.where(opaque)
    if len(ys) == 0:
        return img
    head_end = int(ys.min() + (ys.max() - ys.min()) * head_frac)

    for mask, is_tight in ((opaque & acc_tight, True), (opaque & acc_loose, False)):
        if not mask.any():
            continue
        labels, sizes = _components(mask)
        kill = np.zeros((h, w), bool)
        for lab, n in sizes.items():
            if n < min_area:
                continue
            sel = labels == lab
            if is_tight:
                # 邻接透明 → 屏障留下的背景环，剥掉
                if (sel & adj_to_transparent(arr[:, :, 3])).any():
                    kill |= sel
            else:
                rows = np.where(sel)[0]
                if rows.min() < head_end:
                    # 头部区域只保护"白色系"（发带/头巾与白底同色、色彩不可分）。
                    # 粉/彩色的封闭口袋照删 —— 头与举起的双臂之间就有一块，
                    # 泛洪被屏障封在通道外，漏删后就是脸旁一大块粉斑。
                    sel_rgb = rgb[sel].mean(axis=0)
                    mx, mn = sel_rgb.max(), sel_rgb.min()
                    sat = 0.0 if mx <= 0 else (mx - mn) / mx
                    if mx / 255.0 > 0.88 and sat < 0.12:
                        continue
                kill |= sel
        arr[kill, 3] = 0
    return Image.fromarray(arr, "RGBA").copy()


def clean_shadow_blocks(img, bg_rows, k=K, band=0.18, lo=0.30, hi_dark=0.97,
                        hi_light=1.20, ratio_span=0.28,
                        hue_tol=0.10, s_lo=0.30, v_lo=0.35):
    """彩底：贴地底部带的影子（比值 ∪ 色相 + 邻接透明 + 迭代扩散到收敛）。

    全帧投影带由 kill_shadow_reachable 在全分辨率层处理。
    """
    arr = np.asarray(img).copy()
    h, w, _ = arr.shape
    a = arr[:, :, 3]
    rgb = arr[:, :, :3].astype(np.float32)
    ys, _ = np.where(a > 0)
    if len(ys) == 0:
        return img
    bottom = int(ys.max() - (ys.max() - ys.min()) * band)
    band_mask = np.arange(h)[:, None] >= bottom
    idx = np.clip(np.arange(h) * k + k // 2, 0, len(bg_rows) - 1)
    bl = bg_rows[idx][:, None, :]
    rl = rgb / np.maximum(bl, 1.0)
    dark = ((rl > lo) & (rl < hi_dark)).all(axis=2)
    bright = ((rl > 1.02) & (rl < hi_light)).all(axis=2)
    span = rl.max(axis=2) - rl.min(axis=2)
    by_ratio = (dark | bright) & (span < ratio_span)
    hh, ss, vv = _hsv(rgb / 255.0)
    hl = _hsv(bl[:, 0, :] / 255.0)[0]              # (h,)
    dh = np.abs(hh - hl[:, None])
    dh = np.minimum(dh, 1.0 - dh)
    by_hue = (dh < hue_tol) & (ss > s_lo) & (ss < 0.62) & (vv > v_lo) & (vv < 0.97)
    # 比值判据全帧生效：屏障在轮廓外留了一圈接触影（泛洪被挡住），
    # 它不在底部带内但必须清掉。安全性靠"邻接透明 + 迭代扩散"——
    # 嘴腔/球衣暗部虽然也符合比值判据，但被唇线/轮廓包住，不邻接透明。
    # 色相判据仍只作用于底部带（它对白衣暗部只有 0.03 的余量，是全帧时最危险的一条）。
    # 分两趟，**轮数不同**：
    # · 底部带（贴地影子）：可以多轮迭代，影子可能成片；
    # · 全帧的"等比变暗"块：**最多剥 3 轮** —— 它本意只是剥掉屏障在轮廓外留下的
    #   那圈 1~3 格厚的接触影。放宽到 48 轮会顺着轮廓缺口啃进身体：
    #   球衣的暗红 (100,36,50) 相对粉底 (187,77,107) 恰好是"等比变暗"（比值 0.53/0.47/0.47、
    #   跨度 0.06），于是深色球衣被当影子吃掉（跳水2 #31 身上一条横向缺口就是这么来的）。
    band_like = (a > 0) & band_mask & (by_ratio | by_hue)
    all_like = (a > 0) & by_ratio
    for rounds, like in ((3, all_like), (48, band_like)):
        for _ in range(rounds):
            kill = like & adj_to_transparent(arr[:, :, 3])
            if not kill.any():
                break
            arr[kill, 3] = 0
    return Image.fromarray(arr, "RGBA").copy()


# ---------------------------------------------------------------- 组装与输出

def clean_frame(img):
    """单帧的完整清洗链（供 make_action_pack / 审计脚本复用）。"""
    img, bg_rows, is_light = keyed_frame_img(img)
    px = pixelate(img, K)
    px = kill_bg_pockets(px, bg_rows, K)
    if not is_light:
        px = clean_shadow_blocks(px, bg_rows, K)
    px = clean_edges(px)                 # 边缘修缮（去毛刺 / 补凹口 / 补描边）
    ve.keep_main_component(px)
    return px, bg_rows, is_light


def feet_align(img, canvas_size=None):
    """脚底对齐：底行中心 x + 内容底 y 贴到 FOOT_Y（逐帧版，仅旧脚本用）。"""
    cw, ch = canvas_size or CANVAS
    px = img.load()
    foot_xs = None
    for y in range(img.height - 1, -1, -1):
        xs = [x for x in range(img.width) if px[x, y][3] > 10]
        if xs:
            foot_xs = xs
            break
    cx = (foot_xs[0] + foot_xs[-1]) // 2 if foot_xs else img.width // 2
    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    canvas.alpha_composite(img, (cw // 2 - cx, FOOT_Y - img.height))
    return canvas


def process(video, step=0.1):
    name = os.path.splitext(video)[0]
    vdir = os.path.join(OUT, name)
    os.makedirs(vdir, exist_ok=True)
    src = os.path.join(ROOT, video)

    probe = subprocess.run([FFMPEG, "-i", src], capture_output=True, text=True,
                           encoding="utf-8", errors="ignore").stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", probe)
    dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    times = [t for t in [i * step for i in range(int(dur / step) + 1)] if t < dur]

    frames = []
    for i, t in enumerate(times):
        proc = subprocess.run(
            [FFMPEG, "-y", "-ss", f"{t:.3f}", "-i", src, "-frames:v", "1",
             "-f", "image2pipe", "-vcodec", "png", "-"],
            capture_output=True,
        )
        if not proc.stdout:
            continue
        img = Image.open(io.BytesIO(proc.stdout)).convert("RGBA")
        px, _, _ = clean_frame(img)
        b = px.getbbox()
        if b:
            px = px.crop(b)
        px.save(os.path.join(vdir, f"f{i:03d}_t{t:.2f}.png"))
        frames.append((px, t))

    cols, cell = 6, 140
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 16)), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for y in range(0, sheet.height, 12):
        for x in range(0, sheet.width, 12):
            if (x // 12 + y // 12) % 2:
                draw.rectangle((x, y, x + 11, y + 11), fill=(232, 232, 232))
    for idx, (im, t) in enumerate(frames):
        cx, cy = idx % cols, idx // cols
        thumb = im.copy()
        thumb.thumbnail((cell - 8, cell - 8), Image.NEAREST)
        sheet.paste(thumb, (cx * cell + (cell - thumb.width) // 2,
                            cy * (cell + 16) + 16 + (cell - thumb.height) // 2), thumb)
        draw.text((cx * cell + 4, cy * (cell + 16) + 3), f"#{idx} t={t:.2f}", fill=(30, 30, 30))
    sheet.save(os.path.join(vdir, "_contact.png"))
    print(f"{video}: {len(frames)} 帧 → _contact.png")


if __name__ == "__main__":
    step = float(sys.argv[2]) if len(sys.argv) > 2 else 0.1
    process(sys.argv[1], step)
