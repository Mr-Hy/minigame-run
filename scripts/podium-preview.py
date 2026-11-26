# 预览新版领奖台设计（近似效果，供审阅）
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Circle, Polygon
from matplotlib import font_manager
import matplotlib.colors as mcolors
import numpy as np

# 中文字体
for f in ['/Users/pg/Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/python/fonts/NotoSansSC-Regular.ttf',
          '/Users/pg/Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/python/fonts/NotoSansSC-Bold.ttf',
          '/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc']:
    try:
        font_manager.fontManager.addfont(f)
    except Exception:
        pass
plt.rcParams['font.family'] = ['Noto Sans SC', 'PingFang SC', 'STHeiti']

fig, ax = plt.subplots(figsize=(7.5, 5.6), dpi=200)
ax.set_xlim(0, 750); ax.set_ylim(0, 560); ax.axis('off')
fig.patch.set_facecolor('#f7f6ef')

def vgrad(ax, x, y, w, h, c1, c2, radius=0.0, z=1):
    """垂直渐变矩形（用 imshow 裁剪近似）"""
    grad = np.linspace(0, 1, 256).reshape(-1, 1)
    c1, c2 = np.array(mcolors.to_rgb(c1)), np.array(mcolors.to_rgb(c2))
    img = (c1 * (1 - grad[:, :, None]) + c2 * grad[:, :, None]).reshape(256, 1, 3)
    im = ax.imshow(img, extent=[x, x + w, y, y + h], aspect='auto', zorder=z, origin='upper')
    if radius > 0:
        patch = FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={radius}",
                               transform=ax.transData, fc='none', ec='none')
        ax.add_patch(patch)
        im.set_clip_path(patch)
    return im

# 卡片
card = FancyBboxPatch((30, 30), 690, 500, boxstyle="round,pad=0,rounding_size=26",
                      fc='#fffdf4', ec='#e7e2cd', lw=1.2, zorder=0)
ax.add_patch(card)
# 顶部金色光晕
glow = Circle((375, 530), 200, fc='#e7b24a', alpha=0.16, zorder=1)
ax.add_patch(glow)
glow2 = Circle((375, 530), 130, fc='#e7b24a', alpha=0.14, zorder=1)
ax.add_patch(glow2)
# 卡片上边缘裁掉光晕溢出（简单起见叠加标题即可）

ax.text(60, 500, '本 期 前 三', fontsize=15, fontweight='bold', color='#1f4437', va='center')
ax.text(690, 502, '本期净增面积', fontsize=9.5, color='#97a288', va='center', ha='right')

ranks = {
    1: dict(metal='#e2ab3e', deep='#9e7015', sfrom='#f7df9f', sto='#eec863',
            portrait='#f6e8c1', frame=66, step=150, medal='冠军'),
    2: dict(metal='#9fbdc9', deep='#5f8496', sfrom='#e4eef4', sto='#ccdfe8',
            portrait='#e2edf2', frame=54, step=118, medal='亚军'),
    3: dict(metal='#d2956a', deep='#96603a', sfrom='#f3ddc8', sto='#eac9a5',
            portrait='#f3e2d0', frame=54, step=98, medal='季军'),
}
people = [  # 2-1-3 站位
    (2, 195, '跑者乙', '8,942 m²'),
    (1, 375, '跑者甲', '21,600 m²'),
    (3, 555, '跑者丙', '6,279 m²'),
]
col_w = 160
for rank, cx, name, score in people:
    r = ranks[rank]
    step_h = r['step']
    # 台阶
    vgrad(ax, cx - col_w/2, 50, col_w, step_h, r['sfrom'], r['sto'], radius=14, z=2)
    ax.plot([cx - col_w/2 + 4, cx + col_w/2 - 4], [50 + step_h - 2, 50 + step_h - 2],
            color='white', lw=2, alpha=0.55, zorder=3)
    # 水印名次
    ax.text(cx + col_w/2 - 16, 50 + step_h - 8, str(rank), fontsize=30, fontweight='bold',
            color='white', alpha=0.7, ha='right', va='top', zorder=3)
    # 姓名、成绩
    ax.text(cx, 50 + step_h - 34, name, fontsize=11.5, fontweight='bold',
            color='#413a26', ha='center', zorder=4)
    ax.text(cx, 50 + step_h - 58, score, fontsize=9.5, fontweight='bold',
            color=r['deep'], ha='center', zorder=4)
    # 头像框
    fy = 50 + step_h + 12 + r['frame']
    ring = Circle((cx, fy), r['frame'] + 4, fc='white', ec=r['metal'], lw=3, zorder=5)
    ax.add_patch(ring)
    face = Circle((cx, fy), r['frame'] - 3, fc=r['portrait'], ec='none', zorder=6)
    ax.add_patch(face)
    ax.text(cx, fy, name[0], fontsize=22 if rank == 1 else 17, fontweight='bold',
            color=r['deep'], ha='center', va='center', zorder=7)
    # 奖牌胶囊
    pill = FancyBboxPatch((cx - 26, fy - r['frame'] - 18), 52, 20,
                          boxstyle="round,pad=0,rounding_size=10",
                          fc='#fffdf6', ec=r['metal'], lw=1.4, zorder=8)
    ax.add_patch(pill)
    ax.text(cx, fy - r['frame'] - 8, r['medal'], fontsize=7.5, fontweight='bold',
            color=r['deep'], ha='center', va='center', zorder=9)
    # 冠军皇冠
    if rank == 1:
        cw, ch = 30, 22
        x0, y0 = cx - cw / 2, fy + r['frame'] + 2
        crown = Polygon([(x0, y0), (x0, y0 + ch*0.55), (x0 + cw*0.24, y0 + ch*0.68),
                         (x0 + cw*0.5, y0 + ch), (x0 + cw*0.76, y0 + ch*0.68),
                         (x0 + cw, y0 + ch*0.55), (x0 + cw, y0)],
                        closed=True, fc='#f0b93f', ec='#d99a22', lw=1, zorder=9)
        ax.add_patch(crown)

plt.savefig('/Users/pg/Desktop/Hy/miniGame/demo2/podium-preview.png',
            bbox_inches='tight', facecolor=fig.get_facecolor())
print('ok')
