"""SUPERSEDED — the architecture figure is now rendered directly from
jit-ui-visualization-architecture.mmd via mermaid (ELK layout), so its arrows use
clean orthogonal routing matching the region diagram. Render with:

    npx -y @mermaid-js/mermaid-cli -i jit-ui-visualization-architecture.mmd \\
        -o img/jit-ui-visualization-architecture.png   # (and .svg)

This matplotlib generator is kept only for history. Do NOT run it to refresh the
embedded figure — it would overwrite the mermaid PNG/SVG with the older
straight-arrow layout.
"""
import os
import matplotlib
matplotlib.use("Agg")
# Embed text as vector paths in the SVG so labels render everywhere (no reliance
# on the viewer having the DejaVu Sans font).
matplotlib.rcParams["svg.fonttype"] = "path"
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

# Output resolves relative to this script (libs/jax-image-visualization/docs).
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "img", "jit-ui-visualization-architecture.png")

HEADROOM = 3.6   # clear strip at the top of each band for its label (no boxes)
PADB = 1.8       # padding below the boxes, inside the band
GAP = 2.2        # vertical gap between bands
TOP = 116.0
LIB_PAD_TOP = 4.8     # extra space above the first library band for the container title
LIB_PAD_BOTTOM = 3.2  # extra space below the last library band for the container border

A = {}  # anchors by name: dict(cx, top, bottom, left, right)

def draw_box(ax, name, x, y, w, h, text, fc, fs=8, bold=False, ec="#333", lw=1.1):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.22,rounding_size=0.7",
                                lw=lw, edgecolor=ec, facecolor=fc, zorder=2))
    if text:
        ax.text(x + w/2, y + h/2, text, ha="center", va="center", fontsize=fs,
                fontweight="bold" if bold else "normal", color="#111", zorder=3)
    A[name] = dict(cx=x + w/2, top=y + h, bottom=y, left=x, right=x + w, cy=y + h/2)

def arrow(ax, p, q, color="#444", dashed=False, label=None, lw=1.25):
    ax.add_patch(FancyArrowPatch(p, q, arrowstyle="-|>", mutation_scale=12, color=color,
                 lw=lw, linestyle="--" if dashed else "-", shrinkA=2, shrinkB=2, zorder=1.5))
    if label:
        ax.text((p[0]+q[0])/2, (p[1]+q[1])/2, label, fontsize=6.6, style="italic",
                color=color, ha="center", va="center", backgroundcolor="white", zorder=4)

fig, ax = plt.subplots(figsize=(14, 15.2))
ax.set_xlim(-3, 103); ax.axis("off")

# Each band: (label, band color, content_height, draw(ax, box_top))
def host(ax, t):
    # Consumer 1 — the main diagram component (tile-server-backed).
    draw_box(ax, "diag", 3, t-8, 31, 8,
             "Diagram component (host)\nembeds <jaxviz-visualization>\n(main viewer)", "#dcebff", 7.5)
    draw_box(ax, "adapters", 37, t-8, 60, 8,
             "Diagram viz adapters (host-provided)\nTileAccessAdapter · ImageStateAdapter · RegionIoAdapter · VizConfig (tile server)",
             "#dcebff", 7.5, bold=True)
    # Consumer 2 — the image-processing pipeline preview, with its OWN isolated
    # backend chain via provideVisualization() and in-memory (no tile server) ports.
    draw_box(ax, "pipe", 3, t-17.5, 31, 7.5,
             "Image processing pipeline (host)\npipeline-preview embeds\n<jaxviz-visualization>\n(own chain · provideVisualization)", "#dcebff", 7)
    draw_box(ax, "pipeadapters", 37, t-17.5, 60, 7.5,
             "Pipeline viz adapters (host-provided)\nPipelineImageStateAdapter (in-memory) · PipelineTileAccessAdapter\nPipelineRegionIoAdapter · VizConfig (no tile server)",
             "#dcebff", 7, bold=True)

def libui(ax, t):
    # <visualization> wraps the toolbar + visualizer; orchestration extracted (Step 7)
    draw_box(ax, "vis", 3, t-16, 50, 16, "", "#eafaea", ec="#2c7", lw=1.5)
    ax.text(28, t-1.6, "<jaxviz-visualization>  (VisualizationComponent)", ha="center", va="center",
            fontsize=8.3, fontweight="bold", zorder=3)
    draw_box(ax, "tb", 5.5, t-10.4, 21, 7.2, "plotting-toolbar\n(Toolbar)", "#dff5e0", 8)
    draw_box(ax, "vz", 29, t-10.4, 22, 7.2, "Visualizer (#plot)\nactive backend renders here", "#dff5e0", 8)
    draw_box(ax, "orch", 5.5, t-15.2, 45.5, 3.4,
             "RenderOrchestrator (two-pass small→large + retry)  ·  SliceScrubber (z-scrub)",
             "#d3f0d6", 6.5, ec="#2c7")
    draw_box(ax, "chist", 55.5, t-13, 16, 10, "<jaxviz-\nchannel-\nhistogram>\ndialog", "#dff5e0", 7.6)
    draw_box(ax, "redit", 73, t-13, 13.5, 10, "<jaxviz-\nregion-\neditor>", "#dff5e0", 7.6)
    A["vis"]["cx"] = 28  # arrows leave from the toolbar/visualizer area

def seam(ax, t):
    draw_box(ax, "tokens", 3, t-10, 49, 10,
             "API tokens (consumed by the components)\nVISUALIZER · CHANNEL_HISTOGRAM_API ·\nREGION_EDITOR_API", "#fff0cf", 8, bold=True)
    draw_box(ax, "ports", 54, t-10, 43, 10,
             "DI ports (declared by the library, provided by host)\nTILE_ACCESS_PORT · IMAGE_STATE_PORT ·\nREGION_IO_PORT · VIZ_CONFIG", "#fff0cf", 8, bold=True)

def router(ax, t):
    draw_box(ax, "rvs", 18, t-6.5, 62, 6.5,
             "RoutingVisualizerService\nimplements the API tokens (useExisting) · injects the ports · routes by PlotType",
             "#ffe2bd", 8.5, bold=True)

def backends(ax, t):
    draw_box(ax, "osd", 3, t-11, 24, 11, "OpenSeadragon backend\n(Image — tiled)\nthin coordinator", "#ece0ff", 8, bold=True)
    draw_box(ax, "plot", 29, t-11, 24, 11, "Plotly backend\n(heatmap · contour · scatter ·\nsurface · 3D · isosurface)", "#ece0ff", 8, bold=True)
    draw_box(ax, "vstore", 55, t-11, 21, 11, "VisualizerStore\n(channels · window ·\ngamma · colormap)", "#ece0ff", 8)
    draw_box(ax, "rstore", 78, t-11, 19, 11, "RegionStore\n(regions · selection ·\nclass colors)", "#ece0ff", 8)

def internals(ax, t):
    draw_box(ax, "tools", 3, t-9, 44, 9,
             "Region overlay — per backend impl\nOSD: SVG layer · Plotly: native shapes\n"
             "Shared on-canvas tools: wand · brush · vertex-eraser · zoom-to-box · bezier\n"
             "Shared math: contracts/intensity.ts", "#eee", 7)
    mw, gap0, x0 = 10.5, 1.5, 50.0
    draw_box(ax, "tileclient",  x0,             t-9, mw, 9, "TileClient (OSD)\nURL · fetch\n· decode", "#e6e6e6", 7)
    draw_box(ax, "slicecache",  x0+(mw+gap0),   t-9, mw, 9, "SliceCache\nslices · LRU\n· prefetch", "#e6e6e6", 7)
    draw_box(ax, "displaypipe", x0+2*(mw+gap0), t-9, mw, 9, "DisplayPipeline\nrecolor LUT ·\nmulti-channel", "#e6e6e6", 7)
    draw_box(ax, "histsampler", x0+3*(mw+gap0), t-9, mw, 9, "HistogramSampler\nnative + 8-bit\n+ scale bar", "#e6e6e6", 7)

def server(ax, t):
    draw_box(ax, "svc", 16, t-9, 66, 9,
             "jit-service endpoints\n/preview · /previewsize (overview / untiled PNG)\n"
             "/tiles/info · /tile (per-channel tiles)\n/zoom/open-session · /zoom/region (display-res crop)\n"
             "/histogram · /export/tiff", "#ffe2e2", 7.6, bold=True)

BANDS = [
    ("Host app (jit-ui)", "#7fb3ff", 18, host),                                          # 0  (outside library)
    ("UI components", "#86e08a", 16, libui),                                             # 1  ┐
    ("Public API — DI tokens (consumed) & ports (declared here, provided by host)", "#ffd98a", 10, seam),  # 2  │
    ("Router", "#f0b25f", 6.5, router),                                                  # 3  │ library
    ("Backends & shared state", "#c9a6ff", 11, backends),                                # 4  │
    ("Backend internals — shared region overlay + tools (both backends) · OSD-only tiled-image collaborators", "#cfcfcf", 9, internals),   # 5  ┘
    ("Server (jit-service)", "#ff9a9a", 9, server),                                      # 6  (outside library)
]
LIB_FIRST, LIB_LAST = 1, 5  # band indices enclosed by the library container

cursor = TOP
lib_top = lib_bottom = None
for i, (label, color, content_h, drawer) in enumerate(BANDS):
    if i == LIB_FIRST:
        cursor -= LIB_PAD_TOP            # room above the first library band for the container title
    band_h = HEADROOM + content_h + PADB
    band_top = cursor
    band_bottom = band_top - band_h
    ax.add_patch(FancyBboxPatch((1, band_bottom), 98, band_h, boxstyle="round,pad=0.2,rounding_size=0.6",
                                lw=0, facecolor=color, alpha=0.26, zorder=0))
    ax.text(1.8, band_top - 1.5, label, fontsize=8.5, style="italic", color="#3a3a3a",
            ha="left", va="center", zorder=1)
    drawer(ax, band_top - HEADROOM)
    if i == LIB_FIRST: lib_top = band_top
    if i == LIB_LAST:  lib_bottom = band_bottom
    cursor = band_bottom - GAP
    if i == LIB_LAST:
        cursor -= LIB_PAD_BOTTOM         # room below the last library band for the container border

# ---- Library container: one rectangle enclosing UI components → backend internals ----
LX0, LX1 = -1.2, 101.2
rect_top = lib_top + 3.4
rect_bottom = lib_bottom - 2.2
ax.add_patch(FancyBboxPatch((LX0, rect_bottom), LX1-LX0, rect_top-rect_bottom,
             boxstyle="round,pad=0.3,rounding_size=1.4", lw=2.6, edgecolor="#1a9e6f",
             facecolor="#1a9e6f", alpha=0.05, zorder=0.4))
ax.add_patch(FancyBboxPatch((LX0, rect_bottom), LX1-LX0, rect_top-rect_bottom,
             boxstyle="round,pad=0.3,rounding_size=1.4", lw=2.6, edgecolor="#1a9e6f",
             facecolor="none", zorder=1.6))
ax.text(50, rect_top - 1.5, "jax-image-visualization   —   Angular library (npm package)",
        fontsize=11.5, fontweight="bold", color="#127a4f", ha="center", va="center",
        zorder=5, bbox=dict(boxstyle="round,pad=0.35", fc="white", ec="#1a9e6f", lw=1.4))

ax.set_ylim(cursor, TOP + 4)

# ---- arrows (use recorded anchors) ----
# Both host consumers embed <jaxviz-visualization>; the pipeline gets its own
# isolated chain via provideVisualization(). Both sets of host adapters provide
# the DI ports.
arrow(ax, (A["diag"]["cx"], A["diag"]["bottom"]), (26, A["vis"]["top"]), label="embeds")
arrow(ax, (A["pipe"]["cx"], A["pipe"]["bottom"]), (30, A["vis"]["top"]), label="embeds\n(own chain)")
arrow(ax, (90, A["adapters"]["bottom"]), (90, A["ports"]["top"]), dashed=True, color="#666", label="provide\n(useExisting)")
arrow(ax, (94, A["pipeadapters"]["bottom"]), (94, A["ports"]["top"]), dashed=True, color="#666")
arrow(ax, (22, A["vis"]["bottom"]), (20, A["tokens"]["top"]), label="inject")
arrow(ax, (A["chist"]["cx"], A["chist"]["bottom"]), (40, A["tokens"]["top"]))
arrow(ax, (A["redit"]["cx"], A["redit"]["bottom"]), (46, A["tokens"]["top"]))
arrow(ax, (26, A["tokens"]["bottom"]), (33, A["rvs"]["top"]), label="useExisting")
arrow(ax, (75, A["ports"]["bottom"]), (62, A["rvs"]["top"]), label="injected")
arrow(ax, (30, A["rvs"]["bottom"]), (A["osd"]["cx"], A["osd"]["top"]), label="Image")
arrow(ax, (45, A["rvs"]["bottom"]), (A["plot"]["cx"], A["plot"]["top"]), label="other plots")
arrow(ax, (58, A["rvs"]["bottom"]), (A["vstore"]["cx"], A["vstore"]["top"]))
arrow(ax, (66, A["rvs"]["bottom"]), (A["rstore"]["cx"], A["rstore"]["top"]))
arrow(ax, (12, A["osd"]["bottom"]), (15, A["tools"]["top"]))
arrow(ax, (41, A["plot"]["bottom"]), (32, A["tools"]["top"]))
arrow(ax, (24, A["osd"]["bottom"]), (A["slicecache"]["cx"], A["slicecache"]["top"]), label="delegates")
arrow(ax, (A["tileclient"]["cx"], A["tileclient"]["bottom"]), (40, A["svc"]["top"]), label="/tiles/info · /tile\n(per-channel)")
arrow(ax, (A["histsampler"]["cx"], A["histsampler"]["bottom"]), (66, A["svc"]["top"]), label="/histogram")
# Preview / zoom data paths (image URLs arrive via IMAGE_STATE_PORT; the
# backends fetch the pixels). OSD untiled + Plotly overview use /preview; Plotly
# re-fetches hi-res via TILE_ACCESS_PORT.zoomOnRegion → /zoom/region.
arrow(ax, (A["osd"]["left"]+3, A["osd"]["bottom"]), (24, A["svc"]["top"]), color="#b05", dashed=True,
      label="/preview\n(untiled)")
arrow(ax, (A["plot"]["right"]-3, A["plot"]["bottom"]), (52, A["svc"]["top"]), color="#b05", dashed=True,
      label="/preview overview\n→ /zoom/region")

ax.set_title("JAX Image Tools — jit-ui visualization architecture (jax-image-visualization)",
             fontsize=13, fontweight="bold", pad=12)
fig.text(0.5, 0.012,
         "Two host consumers embed <jaxviz-visualization>: the diagram component (tile-server-backed) and the image-processing pipeline "
         "preview, which gets its own isolated backend chain via provideVisualization() with in-memory ports (no tile server). Everything "
         "inside the green container is the jax-image-visualization package: the components, the public API (tokens + ports), the "
         "RoutingVisualizerService, the OpenSeadragon/Plotly backends and the shared stores. The region overlay has a per-backend "
         "implementation (OSD SVG layer · Plotly native shapes) and the on-canvas tools (wand/brush/vertex-eraser/zoom-to-box) are shared "
         "by both backends, while TileClient/SliceCache/DisplayPipeline/HistogramSampler are OSD-only. jit-service feeds the view via "
         "/preview (overview / untiled), /tiles/info + /tile (OSD), /zoom/region (Plotly hi-res re-fetch) and /histogram.",
         ha="center", fontsize=7.0, style="italic", color="#555", wrap=True)

plt.savefig(OUT, dpi=200, bbox_inches="tight", facecolor="white")
print("wrote", OUT)
OUT_SVG = os.path.splitext(OUT)[0] + ".svg"
plt.savefig(OUT_SVG, bbox_inches="tight", facecolor="white")
print("wrote", OUT_SVG)
