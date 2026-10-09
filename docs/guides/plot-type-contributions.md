# Contributed plot types

Another package can add a mode to the plot-type selector at runtime, through
Angular DI — the same way `TOOLBAR_TOOLS` contributes toolbar tools. Nothing
registers at import time: a mode appears only when the host provides it on the
`PLOT_TYPE_CONTRIBUTIONS` multi-provider token, and with no provider the
library behaves exactly as before. A contribution is a plain object, so the
contributing package needs no Angular compiler and no decorators.

```ts
import {
  PLOT_TYPE_CONTRIBUTIONS, PlotType, PlotTypeContribution,
} from '@jax-data-science/sci-image-visualizer';

const myMode: PlotTypeContribution = {
  descriptor: {
    type: 'my-mode',                  // namespaced; must not clash with a PlotType
    label: 'Image + my overlay',      // test-mode label
    productionLabel: 'My overlay',    // omit to make the mode test-only
    icon: 'pi pi-pencil',
    dimensions: '2d',
    baseType: PlotType.IMAGE,         // v1: only the OpenSeadragon Image view
  },
  activate(ctx) {
    // ctx.visualizer — the public IVisualizer (regions, region overlay, undo…)
    // ctx.viewport  — overlay container, dataToClient / clientToData, frame$ / settled$
    // ctx.imageInfo$ — the current image
    // ctx.tools     — arm the toolbar brush for a class (0.6.0+):
    //                 ctx.tools?.armBrush({ label: 'tumour', color: '#1E88E5' })
    const sub = ctx.viewport.frame$.subscribe((visible) => redraw(visible));
    return { deactivate: () => sub.unsubscribe() };
  },
  // Optional side panel, in the right-hand panel area while the mode is active.
  // Either an Angular component (it can inject PLOT_MODE_CONTEXT / PLOT_MODE_SESSION)…
  //   panel: { title: 'My overlay', component: MyPanelComponent },
  // …or plain DOM, for a package built without the Angular compiler:
  panel: {
    title: 'My overlay',
    mount(host, ctx, session) {
      host.textContent = 'Hello';
      return () => { host.textContent = ''; };   // teardown
    },
  },
};

// Host composition root:
providers: [{ provide: PLOT_TYPE_CONTRIBUTIONS, useValue: myMode, multi: true }]
```

Selecting the mode plots exactly as its `baseType` would (same backend, toolbar,
region tools and wheel handling), then calls `activate(ctx)` once the viewport
is ready. `session.deactivate()` runs exactly once when the user leaves the
mode, when the image changes (a fresh session starts for the new image), or
when the visualizer is destroyed. Anything a contribution throws or rejects is
caught and logged. Failing to start falls back to `baseType`, and so does failing
to clean up when the same mode is about to be re-activated (re-render, image
switch). Contributed descriptors take the same `requiresGrayscale`,
`requiresStack`, `requiresSpatialData` and `requiresSpatial3d` gates as the
built-ins. The full contract
and its guarantees are documented in
[`plot-type-contribution.contract.ts`](../../src/lib/contracts/plot-type-contribution.contract.ts).
