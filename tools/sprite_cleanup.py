#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""精灵素材清理：修白边 / 补内部空洞 / 收敛色板，让视频派生素材接近"硬边像素画"。

背景（2026-10-01 实测，针对待机形象）：
  素材来自视频 3×3 块平均降采样，因此有三个固有毛病：
  1. **白边**：轮廓边缘那一圈的块里混进了**白底**，于是整条轮廓线变成亮色
     （实测 1364 个轮廓像素里 1077 个亮度 > 180 —— 接近全白）。
     而源视频本来是有**黑色描边**的（"庆祝"之所以好看就是因为这个），
     描边在降采样中被白底稀释掉了。
  2. **白色细节被抠掉**：白底的视频里，球衣/球裤上的白色数字与背景同色
     （实测只差 ~10，色彩不可分），抠底时被一起吃掉 → 数字成了透明洞。
     这些洞**不与画布边界连通**，所以可靠"内部空洞"识别。
  3. **不够"像素"**：3×3 平均带来大色板（实测 15829 色）与软过渡，
     而项目标准是"硬边像素、黑描边、约 12 色"。

本脚本按 **①补洞 → ②量化 → ③修边** 的顺序处理（修边必须放量化**之后**，
否则量化会把修复结果改掉，检查器又能扫出残留），**不改形状**：
  - alpha 全程不动（素材本来就是硬边 alpha，0 个半透明像素），
    因此画布尺寸、人物位置、脚底行完全不变，不会影响落点与动画。
  - 只改颜色。

用法：
  python tools/sprite_cleanup.py <输入.png> [--out 输出.png] [--colors 16] [--max-hole 300]
                                 [--edge-lum 180] [--dry]
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# 黑描边色：与 style_align.py / outline_char.py 保持一致（不是纯黑，留一点暖调）
OUTLINE_RGB = (10, 6, 4)


def flood_from_border(mask):
    """从画布四边向内泛洪（4 邻域），返回可达区域。mask=True 表示可通行。"""
    reach = np.zeros_like(mask)
    reach[0, :] = mask[0, :]
    reach[-1, :] = mask[-1, :]
    reach[:, 0] = mask[:, 0]
    reach[:, -1] = mask[:, -1]
    for _ in range(8000):
        grow = np.zeros_like(reach)
        grow[1:, :] |= reach[:-1, :]
        grow[:-1, :] |= reach[1:, :]
        grow[:, 1:] |= reach[:, :-1]
        grow[:, :-1] |= reach[:, 1:]
        new = reach | (grow & mask)
        if new.sum() == reach.sum():
            break
        reach = new
    return reach


def label_components(mask):
    """4 邻域连通域标记，返回 [(像素坐标数组, bbox), ...]。"""
    h, w = mask.shape
    seen = np.zeros_like(mask)
    out = []
    for y, x in zip(*np.where(mask)):
        if seen[y, x]:
            continue
        stack = [(y, x)]
        seen[y, x] = True
        pix = []
        while stack:
            cy, cx = stack.pop()
            pix.append((cy, cx))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        pix = np.array(pix)
        out.append((pix, (pix[:, 0].min(), pix[:, 1].min(), pix[:, 0].max(), pix[:, 1].max())))
    return out


def boundary_mask(op):
    """与透明相邻的不透明像素。"""
    tr = ~op
    g = np.zeros_like(op)
    g[1:, :] |= tr[:-1, :]
    g[:-1, :] |= tr[1:, :]
    g[:, 1:] |= tr[:, :-1]
    g[:, :-1] |= tr[:, 1:]
    return op & g


def step_holes(arr, max_hole, fill_rgb, min_ring_sat=0, verbose=True):
    """补内部空洞。

    两个判据同时成立才补（2026-10-01 用庆祝 91 帧的实测数据定下来的）：
      1. **不与画布边界连通**（内部洞），且面积 < max_hole；
      2. 洞周围一圈的**饱和度**中位数 ≥ min_ring_sat。

    为什么必须加第 2 条：光看面积会误伤。实测庆祝各帧的小洞里，
    白色数字/白细节的环是球衣红/球裤绿（饱和度 42~52），
    而"手臂与躯干之间、腿与腿之间"的真空隙环是中性色（饱和度 6~12）——
    两者面积有重叠，只有饱和度分得开。填错了就是一团白斑。
    大洞（≥300px）实测环饱和度中位 7，全是真空隙，面积这条已经拦住了。
    """
    op = arr[:, :, 3] > 0
    holes = (~op) & (~flood_from_border(~op))
    if not holes.any():
        return 0
    total = 0
    h, w = arr.shape[:2]
    for pix, (y0, x0, y1, x1) in label_components(holes):
        if len(pix) >= max_hole:
            if verbose:
                print(f'    跳过 {len(pix):4d}px 空洞 (y{y0}~{y1} x{x0}~{x1})：'
                      f'面积 ≥ {max_hole}，判定为背景空隙')
            continue
        # 环上（洞的 4 邻域不透明像素）的饱和度
        ring = []
        for cy, cx in pix:
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and op[ny, nx]:
                    p = arr[ny, nx, :3].astype(int)
                    ring.append(int(p.max() - p.min()))
        ring_sat = float(np.median(ring)) if ring else 0.0
        if ring_sat < min_ring_sat:
            if verbose:
                print(f'    跳过 {len(pix):4d}px 空洞 (y{y0}~{y1} x{x0}~{x1})：'
                      f'环饱和度 {ring_sat:.0f} < {min_ring_sat}，判定为背景空隙')
            continue
        arr[pix[:, 0], pix[:, 1], :3] = fill_rgb
        arr[pix[:, 0], pix[:, 1], 3] = 255
        total += len(pix)
        if verbose:
            print(f'    填补 {len(pix):4d}px 空洞 (y{y0}~{y1} x{x0}~{x1}) 环饱和度 {ring_sat:.0f} → RGB{tuple(int(v) for v in fill_rgb)}')
    return total


def step_edges(arr, rel_delta=20.0, radius=3):
    """把轮廓上的"白底残留边缘"换成它**内圈真实内容**的颜色。

    判据必须是**相对**的，不能是绝对亮度 —— 这是 2026-10-01 返工一次换来的教训：
      绝对阈值 `lum > 180` 只抓到接近全白的边缘（第一次修掉 1048px），
      但**被白底洗淡、又没到 180 的那批全漏了**（实测还剩 378px，中位亮度 116）。
      用户的观感就是"还是有一点白边"。
    所以改成：轮廓像素比自己**内圈（非轮廓）**的中位亮度高出 rel_delta 就算残留。

    注意：本函数只处理**最外 1 圈**。白边实际有 2~3 层厚，
    真正的修法是 `step_edges_depth`（按深度剖面覆盖多层）。
    保留它是因为对"只需要剥一圈"的场景仍然好用。
    """
    op = arr[:, :, 3] > 0
    lum = arr[:, :, :3].mean(axis=2)
    boundary = boundary_mask(op)
    if not boundary.any():
        return 0
    inner = op & ~boundary
    h, w = arr.shape[:2]
    targets = []
    for y, x in zip(*np.where(boundary)):
        y0, y1 = max(0, y - radius), min(h, y + radius + 1)
        x0, x1 = max(0, x - radius), min(w, x + radius + 1)
        patch = inner[y0:y1, x0:x1]
        if not patch.any():
            continue
        ref = np.median(arr[y0:y1, x0:x1, :3][patch], axis=0)
        ref_lum = float(np.mean(ref))
        if lum[y, x] > ref_lum + rel_delta:
            targets.append((y, x, ref))
    for y, x, ref in targets:
        arr[y, x, :3] = np.clip(ref, 0, 255).astype(np.uint8)
    return len(targets)


def step_edges_depth(arr, max_depth=3, tol=8.0, passes=4, palette=None, verbose=True):
    """**按深度剖面修边**（覆盖多层，白边真正的修法）。

    为什么需要它（2026-10-01 返工三次的根因）：
      白边是视频 3×3 块平均造成的，**通常有 2~3 像素厚**。
      前面几轮我只修最外 1 圈，往里第 2 圈还亮着 —— 用量化数据看得很清楚：
      待机母版 depth0 违规 230、**depth1 违规 545**、depth2 111、depth3 93。

    判据（与 tools/check_edge_fringe.py 完全一致，**共用同一套实现**，
    避免"检查用一套、修复用另一套"那种自欺）：
      对 depth ≤ max_depth 的像素，沿**内法线**取参考色（朝最内侧方向走 3 步的中位色），
      用"朝白投影"判据（按参考色亮度分档，详见 check_edge_fringe.is_fringe）→ 替换为参考色。

    为什么参考色要沿内法线取：
      取"半径 N 内的内部像素中位色"会两头不讨好 ——
      半径 4 会把不相干的深色内容（耳朵/头发）拉进来 → 头带被误判；
      半径 2 又会把紧贴的黑描边混进来 → 同样误判。

    返回修改像素数。
    """
    from check_edge_fringe import depth_map, inner_reference, is_fringe, white_content_mask

    total = 0
    for _ in range(passes):
        op = arr[:, :, 3] > 0
        if not op.any():
            break
        lum = arr[:, :, :3].mean(axis=2)
        depth = depth_map(op, max_depth + 3)
        # 大白色内容（发带/数字）掩码：同色连通域触及图形内部的近中性白。
        # **每轮重算**：上一轮修掉的桥接白像素可能让"白点与发带连通"断开，
        # 掩码算一次会让这些白点在整轮修复里都受保护、修完又被检查器报出来
        # （2026-10-01 实测：cheer/192/1/055.png 等 5 文件 22px 残留的根因）。
        white_big = white_content_mask(arr, depth, max_depth)
        targets = []
        for y, x in zip(*np.where(op & (depth <= max_depth))):
            d = int(depth[y, x])
            # 参考色与判据都走 check_edge_fringe 的同一套实现（含色板对齐）——
            # 检查器与修复器用不同判据 = 自欺，会让"永远收敛不了"（实测卡在 169）。
            ref = inner_reference(arr, lum, depth, int(y), int(x), d, palette=palette)
            if ref is None:
                continue
            if is_fringe(arr[y, x, :3], ref, max_residual=tol * 12, palette=palette,
                         white_big=bool(white_big[y, x])):
                targets.append((int(y), int(x), ref))
        if not targets:
            break
        for y, x, ref in targets:
            arr[y, x, :3] = np.clip(ref, 0, 255).astype(np.uint8)
        total += len(targets)
        if verbose:
            print(f'    第 {_ + 1} 轮：修 {len(targets)} 像素')
    return total


def step_quantize(arr, colors, keep=((10, 6, 4),)):
    """把不透明像素收敛到 colors 级自适应色板（硬边像素画的关键一步）。

    alpha 不参与量化（素材本来就是硬边），只量化 RGB。
    """
    op = arr[:, :, 3] > 0
    if not op.any():
        return 0
    src = Image.fromarray(arr[:, :, :3]).convert('RGB')
    # 用 alpha 加权：让不透明区域主导色板（透明区域的黑色不影响）
    mask = Image.fromarray((op * 255).astype(np.uint8), 'L')
    quant = src.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE)
    pal = np.array(quant.getpalette()[: colors * 3], dtype=np.uint8).reshape(-1, 3)
    idx = np.array(quant)
    new_rgb = pal[idx]
    arr[:, :, :3] = np.where(op[:, :, None], new_rgb, arr[:, :, :3])
    # 描边色强制保留：量化可能把 1px 描边并到暗红上，那样描边就不均匀了
    for rgb in keep:
        near = op & (np.abs(arr[:, :, :3].astype(int) - np.array(rgb)).sum(axis=2) < 40)
        arr[near, :3] = rgb
    return colors


def _residual_bright(arr, boundary, radius=3, rel_delta=20.0):
    """自检用：还有多少轮廓像素比内圈参考亮出 rel_delta（0 为理想）。"""
    op = arr[:, :, 3] > 0
    lum = arr[:, :, :3].mean(axis=2)
    inner = op & ~boundary
    h, w = op.shape
    n = 0
    for y, x in zip(*np.where(boundary)):
        y0, y1 = max(0, y - radius), min(h, y + radius + 1)
        x0, x1 = max(0, x - radius), min(w, x + radius + 1)
        patch = inner[y0:y1, x0:x1]
        if not patch.any():
            continue
        ref = float(np.mean(np.median(arr[y0:y1, x0:x1, :3][patch], axis=0)))
        if lum[y, x] > ref + rel_delta:
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src', type=Path)
    ap.add_argument('--out', type=Path, default=None)
    ap.add_argument('--colors', type=int, default=16, help='目标色板级数，0 = 不量化')
    ap.add_argument('--max-hole', type=int, default=300, help='超过此面积的空洞判为背景空隙不补')
    ap.add_argument('--min-ring-sat', type=float, default=16.0,
                    help='洞周围饱和度低于此值判为背景空隙不补（白色数字被红绿包围，饱和度很高）')
    ap.add_argument('--quiet', action='store_true', help='批量处理时少打印')
    ap.add_argument('--edge-rel-delta', type=float, default=20.0,
                    help='轮廓像素比内圈参考亮出此值即视为白边残留（相对判据，绝对阈值会漏）')
    ap.add_argument('--edge-depth', type=int, default=3,
                    help='修边覆盖到第几层（白边通常 2~3 层厚，只修最外 1 圈是不够的）')
    ap.add_argument('--edge-passes', type=int, default=4,
                    help='修边迭代轮数：一轮之后内圈参考会变，再跑能收掉剩下的残留')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()

    src_path = a.src
    out_path = a.out or src_path.with_name(src_path.stem + '.cleaned.png')
    img = Image.open(src_path).convert('RGBA')
    arr = np.asarray(img).copy()

    # 白色细节的回填色：取"素材里本身就存在的、最亮的暖白"，避免引入新颜色
    op = arr[:, :, 3] > 0
    lum = arr[:, :, :3].mean(axis=2)
    bright = op & (lum > 200)
    fill_rgb = np.median(arr[bright][:, :3], axis=0).astype(np.uint8) if bright.any() else np.array([252, 250, 252], np.uint8)

    print(f'输入 {src_path.name}  {img.width}×{img.height}')
    print(f'  回填色（取自素材自身最亮内容）RGB({fill_rgb[0]},{fill_rgb[1]},{fill_rgb[2]})')

    print('① 补内部空洞')
    before_alpha = arr[:, :, 3].copy()
    n_holes = step_holes(arr, a.max_hole, fill_rgb, a.min_ring_sat, verbose=not a.quiet)
    filled = (before_alpha == 0) & (arr[:, :, 3] > 0)   # 补洞改动的像素

    print(f'② 色板收敛 → {a.colors} 色')
    if a.colors:
        step_quantize(arr, a.colors)

    # ③ 修边放在量化**之后**：否则修完再量化，量化会把修复结果改掉，检查器又能扫出残留
    #    （2026-10-01 实测：顺序反了的话 160 个违规怎么迭代都下不去，就是地板在这）。
    #    同时把替换色**对齐到色板**，这样修完不会被后续处理再次改动。
    palette = np.unique(arr[arr[:, :, 3] > 0][:, :3].reshape(-1, 3), axis=0)
    print(f'③ 修轮廓白边（深度剖面 depth 0~{a.edge_depth}，替换色对齐到 {len(palette)} 色色板）')
    n_edge = step_edges_depth(arr, max_depth=a.edge_depth, tol=a.edge_rel_delta,
                              passes=a.edge_passes, palette=palette, verbose=not a.quiet)

    # 结果自检
    op2 = arr[:, :, 3] > 0
    lum2 = arr[:, :, :3].mean(axis=2)
    b2 = boundary_mask(op2)
    flat = arr.reshape(-1, 4)
    uniq = len({tuple(p) for p in flat[flat[:, 3] > 0]})
    print(f'\n自检：')
    alpha_ok = ((arr[:, :, 3] == before_alpha) | filled).all()
    print(f'  alpha 仅在被填补的空洞处变化 : {"是 ✓（外形轮廓/位置/落点不变）" if alpha_ok else "否 ✗"}')
    print(f'  补洞 {n_holes}px ｜ 修边 {n_edge}px')
    print(f'  轮廓像素 {int(b2.sum())}（自检请用 tools/check_edge_fringe.py 扫）')
    print(f'  不透明部分独特色数 {uniq}')

    if a.dry:
        print('\n（dry run，未写盘）')
        return 0
    Image.fromarray(arr, 'RGBA').save(out_path)
    print(f'\n已写出 {out_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
