import type { SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../../contracts/display-types';
import { SpatialColumn, SpatialDataset, isCategoricalColumn } from '../../../contracts/spatial-dataset.contract';
import { cellTypeColumnFor } from '../../../spatial/lod';

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

  /** Codes of the group column that are switched off, or null when none are. */
  async hiddenCodes(dataset: SpatialDataset, view: SpatialViewState): Promise<HiddenCodes | null> {
    if (!view.hiddenGroups.length) return null;
    const name = cellTypeColumnFor(dataset, view);
    const col = name ? await this.codes(name) : null;
    if (!col || col.meta.kind !== 'categorical') return null;
    const off = new Set(view.hiddenGroups);
    const hidden = Uint8Array.from(col.meta.categories, (c) => (off.has(c) ? 1 : 0));
    return { codes: col.codes, hidden };
  }
}
