import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ToolbarModule } from 'primeng/toolbar';
import { ButtonModule } from 'primeng/button';
import { MenuModule } from 'primeng/menu';
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
import { MultiSelectModule } from 'primeng/multiselect';
import { RadioButtonModule } from 'primeng/radiobutton';
import { SelectButtonModule } from 'primeng/selectbutton';
import { AutoCompleteModule } from 'primeng/autocomplete';

import { VisualizerComponent } from './visualizer.component';
import { ToolbarComponent } from './toolbar/toolbar.component';
import { RegionEditorComponent } from './region-editor/region-editor.component';
import { SaveMaskDialogComponent } from './region-editor/save-mask-dialog/save-mask-dialog.component';
import { SaveRegionsDialogComponent } from './region-editor/save-regions-dialog/save-regions-dialog.component';
import { RegionEditorHelpComponent } from './region-editor/region-editor-help/region-editor-help.component';
import { RegionColorDialogComponent } from './region-editor/region-color-dialog/region-color-dialog.component';
import {
  ManageClassesDialogComponent,
} from './region-editor/manage-classes-dialog/manage-classes-dialog.component';
import { ClassesPanelComponent } from './region-editor/classes-panel/classes-panel.component';
import { RegionTableComponent } from './region-editor/region-table/region-table.component';
import { HexColorPickerComponent } from './hex-color-picker/hex-color-picker.component';
import { ChannelHistogramComponent } from './channel-histogram/channel-histogram.component';
import { SpatialControlsComponent } from './spatial-controls/spatial-controls.component';
import { SpatialChartsComponent } from './spatial-controls/spatial-charts/spatial-charts.component';
import { VISUALIZER_TOKEN_BINDINGS } from './provide-visualization';
import { IntensityInsetComponent } from './intensity-inset/intensity-inset.component';
import { FloatingDragDirective } from './visualizer/floating-drag.directive';

/**
 * Self-contained plotting UI: the {@link VisualizerComponent} (plot surface
 * + render orchestration), its {@link ToolbarComponent}, and the
 * {@link RegionEditorComponent} (the Regions tab table/editor). Consumers embed
 * `<visualizer>` / `<region-editor>` and need know nothing about the toolbar,
 * the rendering backends, or region file I/O (supplied via the REGION_IO_PORT).
 *
 * Also exports {@link HexColorPickerComponent} (`<hex-color-picker>`) as a
 * standalone reusable picker (`[color]` in, `(colorChange)` out) so consuming
 * apps can use it on its own, the same way as the visualizer and region editor.
 */
@NgModule({
  declarations: [
    VisualizerComponent,
    ToolbarComponent,
    RegionEditorComponent,
    SaveMaskDialogComponent,
    SaveRegionsDialogComponent,
    RegionEditorHelpComponent,
    RegionColorDialogComponent,
    ManageClassesDialogComponent,
    ClassesPanelComponent,
    RegionTableComponent,
    HexColorPickerComponent,
    ChannelHistogramComponent,
    SpatialControlsComponent,
    SpatialChartsComponent,
    IntensityInsetComponent,
    FloatingDragDirective,
  ],
  imports: [
    CommonModule,
    FormsModule,
    ToolbarModule,
    ButtonModule,
    MenuModule,
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
    MultiSelectModule,
    RadioButtonModule,
    SelectButtonModule,
    AutoCompleteModule,
  ],
  exports: [
    VisualizerComponent, RegionEditorComponent, HexColorPickerComponent,
    ChannelHistogramComponent, SpatialControlsComponent, SpatialChartsComponent,
  ],
  providers: [
    // Internal backend wiring. All three host-facing contracts are served by the
    // RoutingVisualizerService (the Plotly/OpenSeadragon selector), so consumers
    // depend only on the tokens and never the concrete router. Owned by the
    // library so importing VisualizationModule is enough — the host supplies only
    // the *ports* (IMAGE_STATE_PORT / TILE_ACCESS_PORT / REGION_IO_PORT) and
    // VIZ_CONFIG, which are app-specific. A consumer needing an isolated instance
    // (e.g. a modal that mustn't share region/image state) uses provideVisualization(),
    // which binds the same set at component scope and shadows these for its subtree.
    VISUALIZER_TOKEN_BINDINGS,
  ],
})
export class VisualizationModule {}
