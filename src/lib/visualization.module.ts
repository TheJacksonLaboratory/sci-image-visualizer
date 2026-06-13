import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ToolbarModule } from 'primeng/toolbar';
import { ButtonModule } from 'primeng/button';
import { DropdownModule } from 'primeng/dropdown';
import { SliderModule } from 'primeng/slider';
import { TreeSelectModule } from 'primeng/treeselect';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { ContextMenuModule } from 'primeng/contextmenu';
import { ProgressBarModule } from 'primeng/progressbar';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { RippleModule } from 'primeng/ripple';
import { TableModule } from 'primeng/table';
import { PaginatorModule } from 'primeng/paginator';
import { OverlayPanelModule } from 'primeng/overlaypanel';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';

import { VisualizationComponent } from './visualization.component';
import { ToolbarComponent } from './toolbar/toolbar.component';
import { RegionEditorComponent } from './region-editor/region-editor.component';
import { HexColorPickerComponent } from './hex-color-picker/hex-color-picker.component';
import { ChannelHistogramComponent } from './channel-histogram/channel-histogram.component';
import { RoutingVisualizerService } from './routing-visualizer.service';
import { VISUALIZER } from './contracts/visualizer.contract';
import { REGION_EDITOR_API } from './contracts/region-editor-api.contract';
import { CHANNEL_HISTOGRAM_API } from './contracts/channel-histogram-api.contract';

/**
 * Self-contained plotting UI: the {@link VisualizationComponent} (plot surface
 * + render orchestration), its {@link ToolbarComponent}, and the
 * {@link RegionEditorComponent} (the Regions tab table/editor). Consumers embed
 * `<visualization>` / `<region-editor>` and need know nothing about the toolbar,
 * the rendering backends, or region file I/O (supplied via the REGION_IO_PORT).
 *
 * Also exports {@link HexColorPickerComponent} (`<hex-color-picker>`) as a
 * standalone reusable picker (`[color]` in, `(colorChange)` out) so consuming
 * apps can use it on its own, the same way as the visualizer and region editor.
 */
@NgModule({
  declarations: [
    VisualizationComponent,
    ToolbarComponent,
    RegionEditorComponent,
    HexColorPickerComponent,
    ChannelHistogramComponent,
  ],
  imports: [
    CommonModule,
    FormsModule,
    ToolbarModule,
    ButtonModule,
    DropdownModule,
    SliderModule,
    TreeSelectModule,
    InputNumberModule,
    DialogModule,
    ContextMenuModule,
    ProgressBarModule,
    ToastModule,
    TooltipModule,
    RippleModule,
    TableModule,
    PaginatorModule,
    OverlayPanelModule,
    ConfirmDialogModule,
    InputTextModule,
    CheckboxModule,
  ],
  exports: [VisualizationComponent, RegionEditorComponent, HexColorPickerComponent, ChannelHistogramComponent],
  providers: [
    // Internal backend wiring. All three host-facing contracts are served by the
    // RoutingVisualizerService (the Plotly/OpenSeadragon selector), so consumers
    // depend only on the tokens and never the concrete router. Owned by the
    // library so importing VisualizationModule is enough — the host supplies only
    // the *ports* (IMAGE_STATE_PORT / TILE_ACCESS_PORT / REGION_IO_PORT) and
    // VIZ_CONFIG, which are app-specific. A consumer needing an isolated instance
    // (e.g. a modal that mustn't share region/image state) re-provides this same
    // set at component scope, which shadows these defaults for its subtree.
    { provide: VISUALIZER, useExisting: RoutingVisualizerService },
    { provide: REGION_EDITOR_API, useExisting: RoutingVisualizerService },
    { provide: CHANNEL_HISTOGRAM_API, useExisting: RoutingVisualizerService },
  ],
})
export class VisualizationModule {}
