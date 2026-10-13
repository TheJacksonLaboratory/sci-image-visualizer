import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DropdownModule } from 'primeng/dropdown';
import { ProgressBarModule } from 'primeng/progressbar';
import { TooltipModule } from 'primeng/tooltip';

import type { SpatialEmbeddingMeta } from '../../../contracts/spatial-dataset.contract';
import type { EmbeddingComputeState } from '../../../spatial/embedding-compute-coordinator';

const IDLE: EmbeddingComputeState = { running: false, fraction: null, backend: null, message: null, error: null };

/**
 * The row under the chart tabs: which embedding to draw, computing a t-SNE the dataset
 * does not publish (with its estimate, progress, Cancel and errors), and detaching the
 * chart into its own window — which applies to every kind.
 *
 * Presentational: the charts panel owns the embeddings, the computation and the window.
 */
@Component({
  selector: 'spatial-embedding-controls',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, DropdownModule, ProgressBarModule, TooltipModule],
  templateUrl: './spatial-embedding-controls.component.html',
  styleUrls: ['./spatial-embedding-controls.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialEmbeddingControlsComponent {
  /** Whether the Embedding tab is the one on screen. */
  @Input() isEmbedding = false;
  /** The embeddings the dataset offers (plus one to compute, when offered). */
  @Input() embeddings: SpatialEmbeddingMeta[] = [];
  /** The embedding drawn, or null. */
  @Input() embedding: SpatialEmbeddingMeta | null = null;
  /** The selected embedding is one this browser would have to compute… */
  @Input() computable = false;
  /** …and it has been, this session. */
  @Input() computed = false;
  /** A computation is running. */
  @Input() running = false;
  /** Where a computation stands: its progress, backend, message and error. */
  @Input() state: EmbeddingComputeState = IDLE;
  /** The run's estimated duration, for the Compute button. */
  @Input() estimateLabel = '';
  /** Why a t-SNE is not offered, when the dataset is too big to embed here; else null. */
  @Input() tooLargeNote: string | null = null;
  /** Whether the chart is in its own window. */
  @Input() detached = false;
  /** Another embedding was picked (its name). */
  @Output() readonly embeddingChange = new EventEmitter<string>();
  /** Compute the selected embedding in this browser. */
  @Output() readonly compute = new EventEmitter<void>();
  /** Stop the running computation. */
  @Output() readonly cancel = new EventEmitter<void>();
  /** Move the chart into its own window, or back into the panel. */
  @Output() readonly detachedToggle = new EventEmitter<void>();
}
