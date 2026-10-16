# 生成「缪斯」项目的结果图表（朴素白底，16:9，2 倍图 1440x810）。
# 数据来源：GET http://127.0.0.1:3080/api/dsh-serendipity/summary（跨项目累计）
# 用法：py -3.14 tools/gen-metrics-chart.py
# 说明：不用 matplotlib 自带的中文字体回退会出方块字，所以显式挑一个已装的中文字体。
import json
import os
import urllib.request

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

RED = "#C00000"
INK = "#111111"
MUTED = "#6B6B6B"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "演示", "assets", "muse", "metrics-funnel.png")

for name in ["Microsoft YaHei", "Noto Sans SC", "SimHei"]:
    if any(name.lower() in f.name.lower() for f in font_manager.fontManager.ttflist):
        plt.rcParams["font.sans-serif"] = [name]
        break
plt.rcParams["axes.unicode_minus"] = False


def load_counts():
    """优先读插件实时接口；读不到就退回最近一次记录的值（并打印警告）。"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:3080/api/dsh-serendipity/summary", timeout=5) as resp:
            usage = json.load(resp)["usage"]
        return ([usage["itemsServed"], usage["noted"], usage["landed"], usage["transformations"]],
                "GET /api/dsh-serendipity/summary（跨项目累计）")
    except Exception as exc:  # noqa: BLE001 — 离线也要能出图
        print("WARN: 读不到插件接口（%s），使用上次记录的值" % exc)
        return [387, 52, 21, 4], "上次记录值（跨项目累计）"


values, source = load_counts()
labels = ["发出素材", "记录笔记", "写明落点", "转化式"]

fig, ax = plt.subplots(figsize=(8, 4.5), dpi=180)
fig.patch.set_facecolor("white")
ax.set_facecolor("white")

bars = ax.barh(labels[::-1], values[::-1], color=RED, height=0.55)
for bar, v in zip(bars, values[::-1]):
    ax.text(bar.get_width() + max(values) * 0.02, bar.get_y() + bar.get_height() / 2,
            str(v), va="center", ha="left", color=INK, fontsize=13, fontweight="bold")

ax.set_xlim(0, max(values) * 1.18)
ax.tick_params(axis="y", labelsize=14, colors=INK, length=0)
ax.tick_params(axis="x", labelsize=11, colors=MUTED, length=0)
for side in ["top", "right", "left"]:
    ax.spines[side].set_visible(False)
ax.spines["bottom"].set_color("#DDDDDD")
ax.grid(axis="x", color="#EEEEEE", linewidth=1)
ax.set_axisbelow(True)

# 标题交给 slide，图内不重复标题，只留数据源脚注
ax.set_title("")
fig.text(0.012, 0.015, "数据源：" + source, fontsize=9, color=MUTED)

fig.tight_layout(rect=[0, 0.03, 1, 0.99])
fig.savefig(OUT, facecolor="white")
print("wrote " + OUT + "  values=" + str(values))
