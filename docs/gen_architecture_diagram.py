import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

# Output resolves relative to this script (libs/jax-image-visualization/docs).
# NOTE: superseded by gen_arch_diagram.py (the current banded diagram with the
# library container); kept for history. Both write the same PNG.
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "img", "jit-ui-visualization-architecture.png")

fig, ax = plt.subplots(figsize=(13.5, 9.5))
ax.set_xlim(0, 100)
ax.set_ylim(0, 100)
ax.axis("off")

def band(x, y, w, h, label, color):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.2,rounding_size=0.6",
                                linewidth=0, facecolor=color, alpha=0.28, zorder=0))
    ax.text(x + 0.8, y + h - 1.4, label, fontsize=8.5, style="italic",
            color="#444", ha="left", va="top", zorder=1)

def box(x, y, w, h, text, fc, fontsize=9, bold=False):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.25,rounding_size=0.8",
                                linewidth=1.1, edgecolor="#333", facecolor=fc, zorder=2))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=fontsize,
            fontweight="bold" if bold else "normal", color="#111", zorder=3, wrap=True)
    return (x + w / 2, y + h, x + w / 2, y)  # cx, top_y, (cx), bottom_y

def arrow(p_from, p_to, color="#444", style="-|>", dashed=False, label=None, lw=1.3):
    a = FancyArrowPatch(p_from, p_to, arrowstyle=style, mutation_scale=12,
                        color=color, lw=lw, linestyle="--" if dashed else "-",
                        shrinkA=2, shrinkB=2, zorder=1.5)
    ax.add_patch(a)
    if label:
        mx, my = (p_from[0] + p_to[0]) / 2, (p_from[1] + p_to[1]) / 2
        ax.text(mx, my, label, fontsize=6.8, style="italic", color=color,
                ha="center", va="center", backgroundcolor="white", zorder=4)

# ----- bands -----
band(1, 86, 98, 12, "Host app (jit-ui) — consumers", "#7fb3ff")
band(1, 66, 98, 16, "Public API — library contracts & DI tokens (jax-image-visualization)", "#86e08a")
band(1, 52.5, 98, 11.5, "Router", "#ffcf6b")
band(1, 33, 98, 17, "Backends & shared state", "#c9a6ff")
band(1, 17, 98, 13, "Backend internals", "#cfcfcf")
band(1, 2.5, 98, 11.5, "Server", "#ff9a9a")

C = "#dcebff"; A = "#dff5e0"; R = "#fff0cf"; B = "#ece0ff"; I = "#eeeeee"; S = "#ffe2e2"

# ----- consumers -----
tb   = box(3, 88, 21, 6.5, "Toolbar\n(zoom · drag · plot-type · tools)", C, 8)
chd  = box(26, 88, 24, 6.5, "Channels & Histogram\ndialog", C, 8)
red  = box(52, 88, 21, 6.5, "Region Editor", C, 8.5)
vh   = box(75, 88, 22, 6.5, "Viewer host\n(diagram component)", C, 8)

# ----- public API -----
ivis = box(3, 68, 43, 12,
           "IVisualizer\n(IDataRenderer · IRegionStore ·\nIToolController · IDisplayOptions)\n+ ViewerCapabilities", A, 8.5, bold=True)
chapi= box(48, 68, 24, 12, "IChannelHistogramApi\nCHANNEL_HISTOGRAM_API", A, 8, bold=True)
reapi= box(74, 68, 23, 12, "IRegionEditorApi", A, 8.5, bold=True)

# ----- router -----
rvs  = box(18, 54, 60, 8, "RoutingVisualizerService\n(routes by PlotType; implements the contracts)", R, 9.5, bold=True)
ports= box(80, 54, 17.5, 8, "DI ports\nTILE_ACCESS_PORT · VIZ_CONFIG\nregion-IO port", R, 7)

# ----- backends & stores -----
osd  = box(3, 35, 25, 12, "OpenSeadragon backend\n(Image plot type — tiled)", B, 8.5, bold=True)
plot = box(30, 35, 25, 12, "Plotly backend\n(heatmap · contour · scatter ·\nsurface · 3D · isosurface)", B, 8, bold=True)
vstore = box(57, 35, 21, 12, "VisualizerStore\n(channels · window · gamma ·\ncolormap · invert)", B, 8)
rstore = box(80, 35, 17.5, 12, "RegionStore\n(regions · selection ·\nclass colors)", B, 8)

# ----- internals -----
tools = box(3, 19, 38, 9, "Region overlay + on-canvas tools\n(wand · vertex-eraser · zoom-to-box ·\nrect/freehand/polyline · bezier)", I, 8)
osdpipe = box(44, 19, 33, 9, "OSD tile pipeline\n(recolor LUT · scale bar ·\nslice cache + background loader)", I, 8)

# ----- server -----
svc = box(20, 4, 58, 7.5,
          "jit-service tile endpoints\n/tiles/info · /tile (per-channel) · /histogram · /export/tiff", S, 8.5, bold=True)

# ----- arrows: consumers -> contracts -----
arrow((tb[0], 88), (18, 80))
arrow((chd[0], 88), (chapi[0], 80))
arrow((red[0], 88), (reapi[0], 80))
arrow((vh[0], 88), (40, 80))

# contracts -> router (implemented by)
arrow((20, 68), (33, 62), label="implemented by")
arrow((chapi[0], 68), (50, 62))
arrow((reapi[0], 68), (64, 62))

# router -> backends / stores
arrow((34, 54), (14, 47), label="Image")
arrow((46, 54), (42, 47), label="other plots")
arrow((60, 54), (66, 47))
arrow((68, 54), (88, 47))

# backends -> internals
arrow((13, 35), (16, 28))
arrow((24, 35), (52, 28))
arrow((44, 35), (30, 28))

# osd pipeline -> server
arrow((osdpipe[0], 19), (52, 11.5), label="TILE_ACCESS_PORT / HttpClient")

ax.set_title("JAX Image Tools — jit-ui visualization architecture (jax-image-visualization)",
             fontsize=12.5, fontweight="bold", pad=12)
fig.text(0.5, 0.012,
         "Consumers depend only on the contracts; RoutingVisualizerService implements them and dispatches to the "
         "OpenSeadragon or Plotly backend per plot type. Both backends share VisualizerStore and RegionStore.",
         ha="center", fontsize=7.5, style="italic", color="#555")

plt.savefig(OUT, dpi=200, bbox_inches="tight", facecolor="white")
print("wrote", OUT)
