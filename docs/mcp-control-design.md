# Image-visualization MCP server — control-bridge design

Design for a **Model Context Protocol (MCP) server** that lets a Claude (or any
MCP client) session drive the `jax-image-visualization` viewer, per
[jit-ui#97](https://github.com/TheJacksonLaboratory/jit-ui/issues/97): "open an
image, switch plot type, pan/zoom to a region, toggle channels/colormap, create
and edit regions, run browser-side SAM/Cellpose, and read back the current view
or region geometry." The full SOW is in
[`JIT_image_visualization_MCP_server_SOW.docx`](JIT_image_visualization_MCP_server_SOW.docx);
this doc is the technical design behind it.

> **Why not a stateless plot generator?** The two servers cited in the issue
> ([mcpmarket visualization](https://mcpmarket.com/server/visualization),
> [xlisp/visualization-mcp-server](https://github.com/xlisp/visualization-mcp-server))
> are **stateless**: data in → PNG/HTML out. This library is a **stateful,
> browser-resident, interactive viewer** (OpenSeadragon + Plotly behind one
> `IVisualizer` contract). "Control the plotting" here means driving a **live UI
> in a browser**, not rendering a file — a remote-control bridge, not a renderer.
> Re-porting the rendering to Node would throw away tiling, regions, and
> browser-side segmentation. Declined; see SOW §3.3.

---

## 1. The control surface already exists

The whole UI is already driven through **one backend-neutral command interface**,
so the MCP server does not invent a control API — it exposes the existing one.

- **`IVisualizer`** (`contracts/visualizer.contract.ts`) — ~80 methods composed
  from role interfaces:
  - `IDataRenderer` — `load`/`plot`, `zoomIn`/`zoomOut`, `setDragMode`,
    `setShowStack`/`setZIndex`, `getTrueImageSize`, `getDisplayedPixelData`,
    `getCurrentImage`, `downloadImage`, `setPlotType`.
  - `IRegionStore` — `setRegions`/`getRegions`, `selectRegion`,
    `deleteActiveShape`, `undo`/`redo`, `importRegions`/`getGeoJsonString`.
  - `IToolController` — `setWandMode`/`setBrushMode`, `segmentRectangles`,
    `segmentRectanglesCellpose`, `setSamModel`, `setSamPointMode`/`commitSamPoints`.
  - `IDisplayOptions` — `setColormap`/`getColormap`, `setReverseScale`,
    `getImageMeta`.
  - capability-gated extras — `getSurface3dControls()`, `getIsosurfaceControls()`,
    `getIntensityControls()` (each returns `null` when the active backend can't
    serve it, so the adapter advertises only live tools).
- **`RoutingVisualizerService`** — the concrete impl bound to the `VISUALIZER` DI
  token; the composition-root facade the host (and the library's own toolbar)
  already call. Every command the MCP server exposes is already a typed method
  here.
- **`PlotType`** — `IMAGE` (OpenSeadragon), `HEATMAP`, `CONTOUR`, `SCATTER`,
  `SURFACE`, `SCATTER3D`, `ISOSURFACE` (Plotly). Plot switching is one
  `setPlotType()` call; the router swaps backends underneath.
- **Read-back** — `getGeoJsonString(getRegions())` for geometry,
  `getDisplayedPixelData()`/`getCurrentImage()` for pixels, and
  `downloadImage()`/`exportComposite()` for a rendered PNG → MCP image content.

**The gap is transport, not API.** An MCP server is a Node process; the viewer
lives in a browser tab. The whole design question is what bridges them:

```
Claude session ──(MCP stdio/SSE)──► MCP server (Node) ──( WebSocket )──► control adapter ──► RoutingVisualizerService
                                                                          (in the live browser tab)
```

---

## 2. Architecture

Three layers, only the first lives inside the library:

```
┌─ Claude / MCP client ───────────────────────────────────────────────┐
│  calls MCP tools: viz.loadImage, viz.setPlotType, viz.getScreenshot…  │
└───────────────┬──────────────────────────────────────────────────────┘
                │ MCP (stdio or SSE)
┌───────────────▼─────────────── tools/jit-viz-mcp/ (new Node pkg) ─────┐
│  @modelcontextprotocol/sdk server                                      │
│   • one MCP tool per adapter command (generated from the catalogue)    │
│   • relays the call over a WebSocket, awaits the result                │
│   • wraps screenshots as MCP image content, geometry as JSON           │
└───────────────┬──────────────────────────────────────────────────────┘
                │ WebSocket (JSON-RPC-ish: {id, command, args} / {id, ok, result})
┌───────────────▼──────────── apps/jit-ui (host, dev/flagged) ──────────┐
│  VizControlSocket — opens the channel, performs the session handshake  │
│  registers ↓                                                           │
├───────────────────────────── src/lib/mcp/ (NEW, opt-in entry point) ──┤
│  VisualizerControlAdapter (Angular injectable)                         │
│   • injects VISUALIZER (RoutingVisualizerService)                      │
│   • flat, serializable command map → IVisualizer method calls          │
│   • validates args; returns JSON / base64 PNG                          │
└───────────────┬──────────────────────────────────────────────────────┘
                │ in-process method calls
        RoutingVisualizerService ──► OpenSeadragon / Plotly backends
```

- **Library** owns only `VisualizerControlAdapter` + its DTOs, behind a
  **secondary entry point** (`@jax-image/visualization/mcp`) so the core library
  carries **no transport dependency** — consumers that don't want remote control
  never pull in the socket/MCP code.
- **Host** owns the WebSocket client and the feature flag. The library never
  opens a socket itself (keeps it host-agnostic, mirrors the DI-port pattern).
- **MCP server** is a separate Node package; the only thing that imports
  `@modelcontextprotocol/sdk`.

### 2.1 `VisualizerControlAdapter` (library, Angular)

```ts
// src/lib/mcp/visualizer-control.adapter.ts  (secondary entry point)
@Injectable()
export class VisualizerControlAdapter {
  constructor(@Inject(VISUALIZER) private viz: IVisualizer) {}

  /** Stable, serializable command catalogue. Names are the MCP tool ids. */
  async exec(command: string, args: Record<string, unknown>): Promise<CommandResult> {
    switch (command) {
      case 'setPlotType':   this.viz.setPlotType(args.plotType as PlotType); return ok();
      case 'setColormap':   this.viz.setColormap(args.colormap as ColormapNode); return ok();
      case 'setReverseScale': this.viz.setReverseScale(!!args.reverse); return ok();
      case 'zoomIn':        this.viz.zoomIn(); return ok();
      case 'zoomOut':       this.viz.zoomOut(); return ok();
      case 'setZIndex':     this.viz.setZIndex(args.z as number); return ok();
      case 'setRegionsGeoJson':
        this.viz.setRegions(this.viz.importRegions(args.geojson as string), true, false, undefined, !!args.append);
        return ok();
      case 'getRegionsGeoJson':
        return json({ geojson: this.viz.getGeoJsonString(this.viz.getRegions()) });
      case 'segmentRectangles':
        return json({ added: await this.viz.segmentRectangles() });
      case 'getScreenshotPng':
        return image(await this.snapshotPng());   // base64 PNG via canvas readback
      case 'getState':
        return json(this.snapshotState());         // plotType, zIndex, region count, image size
      default:
        throw new UnknownCommandError(command);
    }
  }

  /** Drives the MCP tool list AND the tool-schema generation in the server. */
  static readonly CATALOGUE: CommandSpec[] = [ /* name, argsSchema, returns, capability? */ ];
}
```

Key choices:

- **`exec(command, args)` dispatch**, not one public method per command — keeps a
  single audited entry point and lets the MCP server enumerate tools from
  `CATALOGUE` instead of hand-maintaining a parallel list.
- **Serializable boundary.** Regions cross the wire as **GeoJSON strings** (the
  library already round-trips QuPath GeoJSON), never as live `Region` objects.
  Screenshots cross as **base64 PNG**. No DOM/observable leaks through the socket.
- **Capability gating.** A command tagged with a capability (e.g. 3D camera) is
  only advertised when `viz.getSurface3dControls()` / `getIsosurfaceControls()`
  is non-null for the current backend, so Claude is never offered a no-op tool.
- **`any` discipline.** `IVisualizer` is intentionally permissive (`any` on
  several Plotly methods, see the contract header). The adapter is the forcing
  function to pin a **tight, validated subset** — args are schema-checked here,
  not passed through raw.

### 2.2 Transport + handshake (host)

A small JSON message protocol over WebSocket:

```jsonc
// client → adapter
{ "id": "c1", "command": "setPlotType", "args": { "plotType": "contour" } }
// adapter → client
{ "id": "c1", "ok": true, "result": { "kind": "ok" } }
{ "id": "c2", "ok": true, "result": { "kind": "image", "mime": "image/png", "data": "<base64>" } }
{ "id": "c3", "ok": false, "error": { "code": "UNKNOWN_COMMAND", "message": "…" } }
```

- **Handshake / session.** On connect the host sends `{hello, viewerId, title}`;
  the MCP server binds to that `viewerId`. Commands target a `viewerId`; if more
  than one viewer is registered and none is named, the adapter **rejects** rather
  than guessing (SOW risk: single-tab ambiguity).
- **Direction.** Host **dials out** to the MCP server's socket (or a relay), so
  the browser needs no inbound port and the existing oauth2-proxy ingress is
  untouched.

### 2.3 MCP server (`tools/jit-viz-mcp/`)

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// 1. connect/relay to the host's VizControlSocket
// 2. for each spec in CATALOGUE: server.tool(spec.name, spec.argsSchema, handler)
// 3. handler = relay over WS, await {ok,result}; map result.kind →
//      'ok'    → text "done"
//      'json'  → text (stringified) or structured content
//      'image' → { type: 'image', mimeType, data }   (Claude can "see" the view)
```

The tool list is **generated from `CATALOGUE`**, so adding a library command is a
one-line catalogue entry + the `exec` case — no parallel edits in the server.

---

## 3. Command catalogue (target)

| MCP tool | IVisualizer call(s) | Returns | Capability |
|---|---|---|---|
| `viz.getState` | several getters | json (plotType, zIndex, regionCount, imageSize) | — |
| `viz.loadImage` | `load` + `plot` | ok | — |
| `viz.setPlotType` | `setPlotType` | ok | — |
| `viz.setColormap` | `setColormap` | ok | — |
| `viz.setReverseScale` | `setReverseScale` | ok | — |
| `viz.zoomIn` / `viz.zoomOut` | `zoomIn`/`zoomOut` | ok | — |
| `viz.setZIndex` / `viz.setShowStack` | `setZIndex`/`setShowStack` | ok | stack |
| `viz.getRegionsGeoJson` | `getGeoJsonString(getRegions())` | json | — |
| `viz.setRegionsGeoJson` | `importRegions` → `setRegions` | ok | — |
| `viz.selectRegion` / `viz.deleteActiveShape` | `selectRegion`/`deleteActiveShape` | ok | — |
| `viz.undo` / `viz.redo` | `undo`/`redo` | ok | — |
| `viz.segmentRectangles` | `segmentRectangles` | json (added) | — |
| `viz.segmentRectanglesCellpose` | `segmentRectanglesCellpose` | json (added) | — |
| `viz.setSamModel` | `setSamModel` | ok | — |
| `viz.setSurfaceDragMode` / `viz.resetSurfaceCamera` | `getSurface3dControls()…` | ok | surface3d |
| `viz.setIsoRange` | `getIsosurfaceControls().setIsoRange` | ok | isosurface |
| `viz.getScreenshotPng` | canvas readback / `exportComposite` | image | — |
| `viz.exportComposite` / `viz.exportData` | `exportComposite`/`exportData` | ok | — |

---

## 4. MVP

Read state + **five** commands proves the whole bridge before building the rest:

1. `viz.loadImage`
2. `viz.setPlotType`
3. `viz.setColormap`
4. `viz.setRegionsGeoJson`
5. `viz.getScreenshotPng` (+ `viz.getState`)

That demonstrates *"Claude drives the viewer and sees the result"* and validates
the transport, handshake, and serializable boundary. Expand the catalogue
(segmentation, tools, 3D) only once the MVP is green.

---

## 5. Approach B — headless mode (optional)

Same `VisualizerControlAdapter` and MCP server; the difference is **who owns the
browser**. Instead of attaching to a human's tab, the MCP server launches the
library in a **Playwright-driven headless browser** it controls, against the
**planned example server** (visualization SOW D7) that stands in for jit-service
(preview/tiles/histogram/zoom-region). Best for automation/CI with no human tab.

A and B share ~90% of the code (adapter + MCP tool layer). Ship A first; B is
mostly browser orchestration + example-server data stubs on top. B depends on the
example server existing.

---

## 6. Security

Both deployments sit behind **oauth2-proxy + Auth0**. A channel that can run
segmentation and export data is a real remote-control surface.

- **Phase 1:** gate the channel to **dev/local behind a feature flag**; never
  enabled in prod builds.
- **Phase 3 (hardening):** authenticate the channel via the same oauth2-proxy +
  Auth0 path (or a documented equivalent), enforce the `viewerId` handshake, and
  drop the dev-only flag for a controlled deployment.
- Keep the adapter the **single audited entry point**; validate every arg at the
  boundary; advertise only capability-live tools.

---

## 7. Phasing

| Phase | Scope |
|---|---|
| **P1 — MVP bridge** | `VisualizerControlAdapter` (5 commands + `getState`), host WebSocket + handshake (dev/flagged), MCP server generating those tools. Acceptance: from a Claude session, load → setPlotType → setColormap → setRegionsGeoJson → getScreenshot drives a real jit-ui tab. |
| **P2 — Full catalogue** | Remaining `IVisualizer` commands as MCP tools with validated schemas, capability gating, region/pixel read-back. |
| **P3 — Security hardening** | oauth2-proxy + Auth0 on the channel; enforced handshake; remove the dev-only flag for a controlled deployment. |
| **P4 — Headless (optional)** | Playwright-driven headless browser against the example server; CI-runnable; no human tab. Depends on SOW D7. |

---

## 8. Reuse map (already in the repo)

- **`IVisualizer` / `RoutingVisualizerService`** — the entire command surface;
  the adapter is a thin translation layer (`contracts/visualizer.contract.ts`,
  `routing-visualizer.service.ts`).
- **GeoJSON round-trip** — `importRegions` / `getGeoJsonString` already do QuPath
  GeoJSON, so regions serialize for free (`region-store.service.ts`).
- **Screenshot/export** — `downloadImage` / `exportComposite` / `exportData`
  already composite the current view.
- **Secondary entry point pattern** — same `ng-package.json` mechanism used to
  keep optional surfaces out of the core bundle.
- **DI-port / host-agnostic pattern** — the library exposes the adapter; the host
  owns the transport and flag, exactly as it owns `TILE_ACCESS_PORT` et al.
- **Example server** — the planned standalone server (SOW D7) is the natural host
  for headless mode (Approach B).

---

## References

- Issue: <https://github.com/TheJacksonLaboratory/jit-ui/issues/97>
- SOW: [`JIT_image_visualization_MCP_server_SOW.docx`](JIT_image_visualization_MCP_server_SOW.docx)
- Model Context Protocol: <https://modelcontextprotocol.io> · SDK registry: <https://registry.modelcontextprotocol.io>
- Reference servers (stateless generators, contrasted in §0): <https://mcpmarket.com/server/visualization>, <https://github.com/xlisp/visualization-mcp-server>
- OpenSeadragon: <https://openseadragon.github.io/> · Plotly.js: <https://plotly.com/javascript/>
