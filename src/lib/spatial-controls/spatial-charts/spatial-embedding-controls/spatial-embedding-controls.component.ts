import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

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
  templateUrl: './spatial-embedding-controls.component.html',
  styleUrls: ['./spatial-embedding-controls.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialEmbeddingControlsComponent {
  /** Whether the Embedding tab is the one on screen. */
  @Input() isEmbedding = false;
  @Input() embeddings: SpatialEmbeddingMeta[] = [];
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
  @Output() readonly embeddingChange = new EventEmitter<string>();
  @Output() readonly compute = new EventEmitter<void>();
  @Output() readonly cancel = new EventEmitter<void>();
  @Output() readonly detachedToggle = new EventEmitter<void>();
}
