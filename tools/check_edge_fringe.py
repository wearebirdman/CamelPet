#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""轮廓白边检查器（按"深度剖面"判，不靠人眼）。

为什么要有这个（2026-10-01 返工三次的教训）：
  前面几轮我都是**只修最外 1 圈**轮廓像素，然后用"我的脚本能达成的指标"宣布干净。
  但白边是 3×3 块平均造成的，完全可能**有 2 像素厚** —— 最外圈修掉了、往里第 2 圈还在。
  没有量过深度剖面就等于没验证。

判据（可自动判失败，v12 按参考色亮度分档）：
  把不透明区域按"离轮廓的层数"分层：depth 0 = 最外圈，depth 1 = 再往里一层 …
  对 depth ≤ max_depth 的每个像素，取它法线深处（depth ≥ max_depth+1）的像素作为
  **内部参考**，把 (p-ref) 投影到"朝白"方向 (255-ref)：
    t = 投影比例，residual = 垂直偏离。
  ref 暗（描边）：t ≥ 0.75 且 residual ≤ tol*12 → 违规；
  ref 浅（内容色）：t ≥ 0.375 且 residual ≤ tol*6 → 违规。
  （一刀切的低门槛会把"阴影灰贴描边"这类正常结构误判成白边 —— v10/v11 实测翻车。）

输出：逐文件违规数 + 违规像素的 depth 分布 + 总清单。
用法：
  python tools/check_edge_fringe.py <文件或目录...> [--depth 3] [--tol 8] [--top 20]
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image


def depth_map(op: np.ndarray, max_depth: int) -> np.ndarray:
    """每个不透明像素离轮廓的层数。0 = 与透明相邻；不在 max_depth 内的填 max_depth+1。"""
    h, w = op.shape
    depth = np.full((h, w), max_depth + 1, dtype=np.int16)
    remaining = op.copy()
    tr = ~op
    for d in range(max_depth + 1):
        if not remaining.any():
            break
        adj = np.zeros_like(remaining)
        adj[1:, :] |= tr[:-1, :] | (op[:-1, :] & (depth[:-1, :] < d))
        adj[:-1, :] |= tr[1:, :] | (op[1:, :] & (depth[1:, :] < d))
        adj[:, 1:] |= tr[:, :-1] | (op[:, :-1] & (depth[:, :-1] < d))
        adj[:, :-1] |= tr[:, 1:] | (op[:, 1:] & (depth[:, 1:] < d))
        shell = remaining & adj
        depth[shell] = d
        remaining = remaining & ~shell
    return depth


def snap(color, palette):
    """把颜色对齐到色板（palette 为 None 时原样返回）。

    为什么必须两边都对齐：素材是"有限色板"的像素画，参考色取中位色时往往不在色板里。
    如果修复时把像素对齐到色板、而检查时拿未对齐的中位色当基准，就会出现
    "修完仍然比基准亮" → **每轮都报同样的 440 个，永远收敛不了**（2026-10-01 实测踩到）。
    两边统一用"色板对齐后的参考色"，修完即为 0。
    """
    if palette is None:
        return np.asarray(color, dtype=float)
    d = np.abs(palette.astype(int) - np.asarray(color, dtype=float)).sum(axis=1)
    return palette[int(np.argmin(d))].astype(float)


def fringe_amount(p_color, c_color):
    """判断"p 是不是 c 被白底冲淡的结果"，返回 (t, residual)。

    做法：把 (p-c) 投影到"朝白"的方向 (255-c) 上。
      t = 投影长度比例（0 = 就是本体色，1 = 完全是白底）
      residual = 垂直方向偏离这条线的量（大 = 不是"被白冲淡"，而是另一种颜色）

    为什么不能只用"亮度差 > 阈值"（2026-10-01 实测踩到）：
      像素画是有限色板的，**相邻两档深色本身就差 10~20**（实测球裤深绿 68 vs 57，
      差 11）。用"亮度差 > 8"会把这种正常的两档色当成白边，怎么迭代都清不掉
      —— 卡在 169 个，全是 RGB(71,79,56) 这种正经色板色。
    投影判据分得很开：正经色板相邻档 t≈0.07；真白边（238 的近白 vs 143 的肤色）t≈0.9。
    """
    p = np.asarray(p_color, dtype=float)
    c = np.asarray(c_color, dtype=float)
    w = 255.0 - c
    denom = float((w * w).sum())
    if denom < 1e-6:
        return 0.0, float(np.abs(p - c).sum())
    v = p - c
    t = float((v * w).sum() / denom)
    proj = c + t * w
    return t, float(np.abs(p - proj).sum())


def white_content_mask(arr, depth, max_depth):
    """找出"大白色内容"（发带白 / 数字白）的像素掩码。

    为什么需要它（2026-10-01 v14）：白边散点的颜色 (239,236,239) 与发带白/数字白
    **完全同色**，且都在色板里 —— 颜色空间内不可分（t：手臂白边 0.92 vs 发带轮廓
    0.86，挨得太近；res 同样分不开）。结构上唯一可靠的区别：
      发带/数字是实心白块，同色连通域**一直延伸到 depth > max_depth 的图形内部**；
      白边散点只贴在轮廓 2~3px 的环上，同色连通域**到不了内部**。
    """
    from sprite_cleanup import label_components

    rgb = arr[:, :, :3].astype(int)
    op = arr[:, :, 3] > 0
    lum = rgb.mean(axis=2)
    chroma = rgb.max(axis=2) - rgb.min(axis=2)
    whiteish = op & (lum >= 200) & (chroma <= 12)
    mask = np.zeros_like(whiteish)
    if not whiteish.any():
        return mask
    for pix, _ in label_components(whiteish):
        if (depth[pix[:, 0], pix[:, 1]] > max_depth).any():
            mask[pix[:, 0], pix[:, 1]] = True
    return mask


def is_fringe(p_color, c_color, min_t=0.75, max_residual=90.0, palette=None, white_big=False):
    """是不是白底残留。判据 v13（2026-10-01 定稿，色板成员资格 + 参考色亮度分档）。

    三代判据的学费，都记在这里：

    · v10/v11（t ≥ 0.15 一刀切）：修了 1622px，把脚下阴影染成暖棕+绿条纹 ——
      "内容色贴深色"是正常画面结构，浅灰阴影(149,141,139)贴描边 t≈0.55、
      深肉(136,109,91)贴描边 t≈0.39，全被误判。
    · v12（按 ref 亮度分档 t=0.75/0.375）：还是误伤 178px ——
      阴影灰(149) 贴靴底暗色(51,45,43) 的 t=0.463/res=6.9，与真白边
      洗淡阴影(198,190,192) vs 阴影灰 的 t=0.449/res=5.5 **在颜色空间完全重叠**。
    · v13 的突破口：**素材已量化收敛到有限色板，任何不在色板里的颜色都是污染**。
      洗淡阴影(198,190,192)距最近色板色 Σ|d|=74 → 必是白边；
      阴影灰(149)本身在色板里 → 是内容色边缘，跳过。

    规则：
      0. p 是近中性白（lum ≥ 200、色差 ≤ 12）→ **先于色板判定**，因为白边散点
         (239,236,239) 与发带白同色且同在色板，色板保护会把它吞掉（v13/v14 实测
         只修 10px 的根因）：
         - white_big（同色连通域触及内部）→ 内容白：仅 ref 暗 + t ≥ min_t 才算白边；
         - 非大域 → 白边散点：按 ref 亮度分档（暗 ref 高门槛 / 浅 ref 低门槛+残差减半）。
      1. p 在色板内（Σ|d| ≤ 20）→ 内容色（阴影灰/球裤绿等）：仅"几乎全白且贴暗描边"
         才算白边。
      2. p 不在色板 → 污染色。ref 暗：t ≥ min_t；ref 浅：t ≥ min_t/2 且残差减半
        （"被白冲淡"必须精确落在本体→白的连线上）。
    """
    t, res = fringe_amount(p_color, c_color)
    ref_lum = float(np.mean(c_color))
    p = np.asarray(p_color, dtype=float)
    is_whiteish = p.mean() >= 200 and (p.max() - p.min()) <= 12
    if is_whiteish:
        if white_big:
            return ref_lum < 40.0 and t >= min_t and res <= max_residual
        if ref_lum < 40.0:
            return t >= min_t and res <= max_residual
        return t >= min_t / 2 and res <= max_residual / 2
    if palette is not None:
        d = np.abs(palette.astype(float) - p).sum(axis=1)
        if int(d.min()) <= 20:
            # 内容色：只有贴着暗描边还几乎全白才算白边
            return ref_lum < 40.0 and t >= min_t and res <= max_residual
    if ref_lum < 40.0:
        return t >= min_t and res <= max_residual
    return t >= min_t / 2 and res <= max_residual / 2


def inward_dir(op, depth, y: int, x: int, d: int):
    """求"朝内"的方向（外法线的反向）。

    找朝外方向：优先取**透明邻居**（深度 0 的边界像素就是靠这个定方向），
    否则取 8 邻域里深度更小、且最小的那个；取反即朝内。

    为什么不用"深度最大的邻居当朝内方向"（上一版就是这么写的，翻车了）：
      那会被**厚的部位**带偏 —— 靴子旁边的腿更厚，于是靴子边缘的参考色取到腿上，
      修完靴子被肤色吃掉（2026-10-01 实测截图可见明显损坏）。
      正确做法是按几何法线走，才不会跨到别的部位。
    """
    h, w = depth.shape
    best = None
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            ny, nx = y + dy, x + dx
            if not (0 <= ny < h and 0 <= nx < w):
                continue
            nd = -1 if not op[ny, nx] else int(depth[ny, nx])   # 透明算最外
            if nd < d:
                if best is None or nd < best[0]:
                    best = (nd, dy, dx)
    if best is None:
        return None
    return (-best[1], -best[2])


def inner_reference(a: np.ndarray, lum: np.ndarray, depth: np.ndarray, y: int, x: int,
                    d: int, steps: int = 3, palette=None, stable_depth: int = 4,
                    op=None):
    """沿**内法线**取参考色，且参考必须来自"**不会被改动的区域**"。

    做法：在 8 邻域里找 depth 最大的方向（= 最朝内），沿它一直走到
    `depth > stable_depth`（默认 4 层以里），再取接着的 steps 个像素的中位色，按 palette 对齐。

    两个坑都踩过，写在这里免得再犯：
      · 取"半径 N 内的内部像素中位色"：半径 4 会把不相干的深色内容（耳朵/头发）拉进来 →
        头带被判成白边；半径 2 又会把紧贴的黑描边混进来 → 同样误判。
      · **参考若取自"正在被修改的 1~3 层"，就会一边改一边变基准** →
        每轮都报同样的几百个，永远收敛不了（实测卡在 440 / 543）。
        所以参考只从 `depth > stable_depth` 取 —— 那部分修边不碰，基准是稳定的。
    """
    h, w = depth.shape
    if op is None:
        op = a[:, :, 3] > 0
    direction = inward_dir(op, depth, y, x, d)
    if direction is None:
        return None
    dy, dx = direction
    # 先走到稳定区（depth > stable_depth）
    k = 1
    while k <= 12:
        ny, nx = y + dy * k, x + dx * k
        if not (0 <= ny < h and 0 <= nx < w):
            return None
        if not op[ny, nx]:
            return None
        if depth[ny, nx] > stable_depth:
            break
        k += 1
    else:
        return None
    vals = []
    for j in range(k, k + steps):
        ny, nx = y + dy * j, x + dx * j
        if not (0 <= ny < h and 0 <= nx < w) or not (a[ny, nx, 3] > 0):
            break
        vals.append(a[ny, nx, :3])
    if not vals:
        return None
    # 返回**颜色**（不是亮度）：投影判据需要颜色向量
    return np.asarray(snap(np.median(np.array(vals), axis=0), palette), dtype=float)


def check_file(path: Path, max_depth: int, tol: float, palette=None) -> tuple:
    """返回 (违规像素列表 [(depth,lum,ref,y,x)], 内容像素数)。

    palette 为 None 时自动取该图自身的独特色板（素材本身量化过，这就是它的色板）。
    """
    a = np.asarray(Image.open(path).convert('RGBA')).astype(np.int16)
    op = a[:, :, 3] > 0
    if not op.any():
        return [], 0
    if palette is None:
        palette = np.unique(a[op][:, :3].reshape(-1, 3), axis=0)
    lum = a[:, :, :3].mean(axis=2)
    depth = depth_map(op, max_depth + 3)
    white_big = white_content_mask(a, depth, max_depth)
    bad = []
    ys, xs = np.where(op & (depth <= max_depth))
    for y, x in zip(ys, xs):
        d = int(depth[y, x])
        ref = inner_reference(a, lum, depth, int(y), int(x), d, palette=palette)
        if ref is None:
            continue
        if is_fringe(a[y, x, :3], ref, max_residual=tol * 12, palette=palette,
                     white_big=bool(white_big[y, x])):
            bad.append((d, int(lum[y, x]), int(np.mean(ref)), int(y), int(x)))
    return bad, int(op.sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--depth', type=int, default=3)
    ap.add_argument('--tol', type=float, default=8.0)
    ap.add_argument('--top', type=int, default=20)
    a = ap.parse_args()

    files = []
    for p in a.paths:
        path = Path(p)
        if not path.is_absolute():
            path = Path.cwd() / path
        if path.is_dir():
            files += sorted(path.rglob('*.png'))
        else:
            files.append(path)
    print(f'扫描 {len(files)} 个文件｜判据：depth ≤ {a.depth} 的像素"被白底冲淡"\n'
          f'（ref 暗：t ≥ 0.75 且残差 ≤ {a.tol * 12:.0f}；ref 浅：t ≥ 0.375 且残差 ≤ {a.tol * 6:.0f}）\n')

    per_file = []
    depth_hist = {}
    for f in files:
        bad, total = check_file(f, a.depth, a.tol)
        for d, *_ in bad:
            depth_hist[d] = depth_hist.get(d, 0) + 1
        if bad:
            per_file.append((len(bad), f, bad))

    per_file.sort(key=lambda t: -t[0])
    total_bad = sum(n for n, _, _ in per_file)
    print(f'违规像素合计 {total_bad}（{len(per_file)}/{len(files)} 个文件不合格）')
    if depth_hist:
        print('违规像素的层数分布：', '  '.join(f'depth{d}: {c}' for d, c in sorted(depth_hist.items())))
    if per_file:
        print(f'\n最严重的 {a.top} 个文件：')
        for n, f, bad in per_file[:a.top]:
            samples = '  '.join(f'(d{d} {lum}>{ref} @y{y}x{x})' for d, lum, ref, y, x in bad[:4])
            print(f'  [{n:5d}] {f.relative_to(Path.cwd()) if str(f).startswith(str(Path.cwd())) else f}')
            print(f'          {samples}')
    return 0 if total_bad == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
