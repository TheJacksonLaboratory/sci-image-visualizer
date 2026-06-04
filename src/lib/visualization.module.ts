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

import { VisualizationComponent } from './visualization.component';
import { ToolbarComponent } from './toolbar/toolbar.component';

/**
 * Self-contained plotting UI: the {@link VisualizationComponent} (plot surface
 * + render orchestration) and its {@link ToolbarComponent}. Consumers embed
 * `<visualization>` and need know nothing about the toolbar or the rendering
 * backends. The diagram host imports this module and renders `<visualization>`.
 */
@NgModule({
  declarations: [VisualizationComponent, ToolbarComponent],
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
  ],
  exports: [VisualizationComponent],
})
export class VisualizationModule {}
