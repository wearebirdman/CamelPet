#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把"清理后的母版"效果同步到各档位输出帧。

为什么必须单独一步（2026-10-01 实测）：
  `make_idle_pack.py` 用 LANCZOS 从 256 母版派生其余档位，**插值会重新引入大量颜色**：
  母版 21 色 → 派生档位 4551 / 7723 / 12716 / 19803 色，白边也会回来。
  只清理母版等于白干。

本脚本对每个输出帧做三件事（顺序固定）：
  1. **alpha 硬化**：LANCZOS 会造出半透明边缘像素 → 按 128 阈值二值化，恢复硬边像素画。
  2. **白边修复**：与检查器 tools/check_edge_fringe.py **同一套判据**（朝白投影 +
     色板成员资格 + 大白色内容保护），替换色对齐到母版色板。
     （旧版用绝对亮度 lum>180，会漏"被洗淡但没到 180"的白边 —— 已废弃。）
  3. **色板锁定**：所有不透明像素映射到**母版色板**里最近的颜色。
     锁定而不是各自量化：跨档位切换时颜色集合一致，不会闪（自己量化各档会得到不同色板）。

用法：
  python tools/finalize_sprite_tiers.py idle --palette-from raw/idle_new/000.png
  python tools/finalize_sprite_tiers.py cheer --palette-from <清理好的母版>
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SPRITES = ROOT / 'assets' / 'skins' / 'default' / 'sprites'
SIZES = (128, 192, 256)
DPRS = ('1', '1.5')


def palette_of(path: Path) -> np.ndarray:
    """取参考图不透明部分的色板（去重）。"""
    a = np.asarray(Image.open(path).convert('RGBA')).astype(np.int16)
    op = a[:, :, 3] > 0
    return np.unique(a[op][:, :3].reshape(-1, 3), axis=0)


def map_to_palette(rgb: np.ndarray, mask: np.ndarray, pal: np.ndarray) -> np.ndarray:
    """把 mask 内的像素映射到 pal 里最近的颜色（分块做，避免大数组爆内存）。"""
    out = rgb.copy()
    ys, xs = np.where(mask)
    if not len(ys):
        return out
    vals = rgb[ys, xs].astype(np.int16)                     # N×3
    best = np.zeros(len(vals), dtype=np.int32)
    best_d = np.full(len(vals), 1 << 30, dtype=np.int64)
    for i, c in enumerate(pal):                              # 21~24 色，逐个比很快
        d = np.abs(vals - c.astype(np.int16)).sum(axis=1)
        upd = d < best_d
        best_d[upd] = d[upd]
        best[upd] = i
    out[ys, xs] = pal[best]
    return out


def boundary_mask(op: np.ndarray) -> np.ndarray:
    tr = ~op
    g = np.zeros_like(op)
    g[1:, :] |= tr[:-1, :]
    g[:-1, :] |= tr[1:, :]
    g[:, 1:] |= tr[:, :-1]
    g[:, :-1] |= tr[:, 1:]
    return op & g


def fix_edges(rgb: np.ndarray, op: np.ndarray, edge_lum=180, radius=2) -> int:
    lum = rgb.mean(axis=2)
    bad = boundary_mask(op) & (lum > edge_lum)
    n = int(bad.sum())
    if not n:
        return 0
    good = op & ~bad
    h, w = op.shape
    for y, x in zip(*np.where(bad)):
        y0, y1 = max(0, y - radius), min(h, y + radius + 1)
        x0, x1 = max(0, x - radius), min(w, x + radius + 1)
        patch = good[y0:y1, x0:x1]
        if patch.any():
            rgb[y, x] = np.median(rgb[y0:y1, x0:x1][patch], axis=0)
        else:
            rgb[y, x] = (10, 6, 4)
    return n


def rederive_tiers(state: str, master_dir_name='256', master_dpr='1'):
    """从 256/1 母版按 make_action_pack.write_tiers 同款公式重派生其余 5 档。

    为什么需要重派生而不是就地清理旧档位：**母版改了，档位必须跟着重算** ——
    否则档位还是旧母版的内容，改完等于白改（同理，档位里先前被 LANCZOS 引入的
    上万种颜色也只能靠重派生 + 色板锁定来收干净）。
    """
    master_dir = SPRITES / state / master_dir_name / master_dpr
    files = sorted(master_dir.glob('*.png'))
    if not files:
        return 0
    n = 0
    for f in files:
        img = Image.open(f).convert('RGBA')
        base_w, canvas_h = img.size
        index = f.name
        for size in SIZES:
            for dpr in DPRS:
                if size == 256 and dpr == '1':
                    continue
                w = round(size * float(dpr))
                h = round(w * canvas_h / base_w)
                out = SPRITES / state / str(size) / dpr / index
                frame = img if img.size == (w, h) else img.resize((w, h), Image.LANCZOS)
                frame.save(out)
                n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('state')
    ap.add_argument('--palette-from', type=Path, required=True)
    ap.add_argument('--alpha-threshold', type=int, default=128)
    ap.add_argument('--rederive', action='store_true',
                    help='先从 256/1 母版重派生其余档位，再做收尾（母版刚改过时必须加）')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()

    if a.rederive and not a.dry:
        k = rederive_tiers(a.state)
        print(f'已从 256/1 母版重派生 {k} 个档位帧\n')

    pal = palette_of(a.palette_from)
    print(f'母版色板 {len(pal)} 色（来自 {a.palette_from.name}）\n')

    rows = []
    for size in SIZES:
        for dpr in DPRS:
            d = SPRITES / a.state / str(size) / dpr
            if not d.exists():
                continue
            files = sorted(d.glob('*.png'))
            before_union, after_union = set(), set()
            e_fixed = semi = 0
            for f in files:
                img = Image.open(f).convert('RGBA')
                arr = np.asarray(img).astype(np.int16)
                rgb, alpha = arr[:, :, :3], arr[:, :, 3]
                op0 = alpha > 0

                # 1. alpha 硬化（先落回 arr，后面的修边/深度剖面都依赖硬化后的 alpha）
                semi += int(((alpha > 0) & (alpha < 255)).sum())
                op = alpha >= a.alpha_threshold
                arr[:, :, 3] = np.where(op, 255, 0).astype(np.uint8)

                # 2. 色板锁定（**必须排在修边之前**：锁定会把非色板色改掉，
                #    若放在修边之后，修好的判据前提就变了 → 检查器仍报残留，
                #    与 sprite_cleanup 的"①补洞 ②量化 ③修边"同序）。
                before_union |= {tuple(x) for x in rgb[op0]}
                rgb = map_to_palette(rgb, op, pal)
                arr[:, :, :3] = rgb.astype(np.int16)

                # 3. 白边修复（与检查器同一判据；替换色取自母版色板本身，
                #    因为上一步已锁定，修完不会再被后续处理改动）
                from sprite_cleanup import step_edges_depth
                e_fixed += step_edges_depth(arr, max_depth=3, tol=8.0, passes=6,
                                            palette=pal, verbose=False)
                rgb = arr[:, :, :3]
                after_union |= {tuple(x) for x in rgb[op]}

                out = np.dstack([rgb.astype(np.uint8), arr[:, :, 3].astype(np.uint8)])
                if not a.dry:
                    Image.fromarray(out, 'RGBA').save(f)
            rows.append((size, dpr, len(files), len(before_union), len(after_union), e_fixed, semi))

    print(f'{"档位":10s} {"帧数":4s} {"整档色数(原)":12s} {"锁定后":8s} {"修边":6s} {"半透明硬化":10s}')
    for size, dpr, n, cb, ca, ef, sm in rows:
        print(f'{size}/{dpr:4s} {n:4d} {cb:12d} {ca:8d} {ef:6d} {sm:10d}')
    print('\n' + ('（dry run，未写盘）' if a.dry else '已写盘'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
