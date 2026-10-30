import type { SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../../contracts/display-types';
import {
  NO_CATEGORY,
  SpatialColumn,
  SpatialDataset,
  isCategoricalColumn,
} from '../../../contracts/spatial-dataset.contract';
import { cellTypeColumnFor } from '../../../spatial/lod';
import { hasGeneFilter, observationGeneMask } from '../../../spatial/spatial-gene-filter';

/** A categorical column's per-observation codes and its metadata (categories, colours). */
export interface CategoricalCodes {
  codes: Uint16Array;
  meta: SpatialColumn['meta'];
}

/** Per-observation group codes, and which codes are switched off (1) in the group list. */
export interface HiddenCodes {
  codes: Uint16Array;
  hidden: Uint8Array;
}

/**
 * The categorical columns the cells, the transcripts and the hover all read: the cell-type
 * column's codes, and which of its groups the user switched off. A failed request rejects;
 * the caller decides whether that fails its group of the plan or degrades to "no types".
 */
export class CategoricalLookup {
  constructor(private readonly port: SpatialDataPort) {}

  /** Codes of the column `name`, or null when it is not categorical. */
  async codes(name: string): Promise<CategoricalCodes | null> {
    const column = await this.port.getColumn(name);
    return isCategoricalColumn(column) ? { codes: column.codes, meta: column.meta } : null;
  }

  /**
   * The observations not drawn: those of the groups switched off, and those the gene filter
   * leaves out. Null when nothing is hidden.
   */
  async hiddenCodes(dataset: SpatialDataset, view: SpatialViewState): Promise<HiddenCodes | null> {
    if (!hasGeneFilter(view)) return this.hiddenGroupCodes(dataset, view);
    const count = dataset.observations.count;
    const [groups, shown] = await Promise.all([
      this.hiddenGroupCodes(dataset, view),
      observationGeneMask(view, count, (g) => this.port.getFeatureVector(g)),
    ]);
    if (!shown) return groups;
    // One code per observation: 1 for hidden, by its group or by the gene filter.
    const codes = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      const c = groups ? groups.codes[i] : NO_CATEGORY;
      codes[i] = !shown[i] || (c !== NO_CATEGORY && groups!.hidden[c]) ? 1 : 0;
    }
    return { codes, hidden: Uint8Array.of(0, 1) };
  }

  /** Codes of the group column that are switched off, or null when none are. */
  private async hiddenGroupCodes(dataset: SpatialDataset, view: SpatialViewState): Promise<HiddenCodes | null> {
    if (!view.hiddenGroups.length) return null;
    const name = cellTypeColumnFor(dataset, view);
    const col = name ? await this.codes(name) : null;
    if (!col || col.meta.kind !== 'categorical') return null;
    const off = new Set(view.hiddenGroups);
    const hidden = Uint8Array.from(col.meta.categories, (c) => (off.has(c) ? 1 : 0));
    return { codes: col.codes, hidden };
  }
}
