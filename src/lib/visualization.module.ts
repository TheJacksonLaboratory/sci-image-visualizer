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
import { TooltipModule } from 'primeng/tooltip';
import { RippleModule } from 'primeng/ripple';
import { TableModule } from 'primeng/table';
import { PaginatorModule } from 'primeng/paginator';
import { OverlayPanelModule } from 'primeng/overlaypanel';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { InputTextModule } from 'primeng/inputtext';

import { VisualizationComponent } from './visualization.component';
import { ToolbarComponent } from './toolbar/toolbar.component';
import { RegionEditorComponent } from './region-editor/region-editor.component';
import { HexColorPickerComponent } from './shared/hex-color-picker/hex-color-picker.component';

/**
 * Self-contained plotting UI: the {@link VisualizationComponent} (plot surface
 * + render orchestration), its {@link ToolbarComponent}, and the
 * {@link RegionEditorComponent} (the Regions tab table/editor). Consumers embed
 * `<visualization>` / `<region-editor>` and need know nothing about the toolbar,
 * the rendering backends, or region file I/O (supplied via the REGION_IO_PORT).
 */
@NgModule({
  declarations: [
    VisualizationComponent,
    ToolbarComponent,
    RegionEditorComponent,
    HexColorPickerComponent,
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
    TooltipModule,
    RippleModule,
    TableModule,
    PaginatorModule,
    OverlayPanelModule,
    ConfirmDialogModule,
    InputTextModule,
  ],
  exports: [VisualizationComponent, RegionEditorComponent],
})
export class VisualizationModule {}
