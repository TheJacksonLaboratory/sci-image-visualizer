import type { SpatialViewState } from '../contracts/display-types';
import type { SpatialDataPort } from '../contracts/ports/spatial-data.port';
import {
  type CategoricalColumnMeta,
  type ContinuousColumnMeta,
  type SpatialDataset,
  isCategoricalColumn,
} from '../contracts/spatial-dataset.contract';
import { cellTypeColumnFor } from './lod';
import { categoryColorsFor } from './spatial-encoding';

/**
 * The observations of a selection (a mask), described: how many, by the grouping they are coloured
 * by (else the cell types), the mean of a few measurements — or, for one cell, its id, its groups
 * and its values. Pure but for the port's columns (cached by it).
 */

/** At most this many measurements (continuous columns) are given. */
export const OBSERVATION_DETAIL_COLUMNS = 6;

/** One group's observations in the selection. */
export interface GroupCount {
  name: string;
  count: number;
  /** The group's colour, as the legend shows it. */
  color: string;
}

/** What {@link describeObservations} finds. */
export interface ObservationsDescription {
  total: number;
  /** The grouping the observations are counted by, or null when the dataset has none. */
  groupColumn: string | null;
  /** Groups by count, most first (empty groups left out). */
  groups: GroupCount[];
  /**
   * A few measurements: the mean over the selection (`mean` true), or one cell's own values. With
   * one cell, its other groupings come first, as text.
   */
  measures: { name: string; value: string | number; unit?: string; mean: boolean }[];
  /** The one cell's id, when the selection is one cell. */
  cellId?: string;
}

/**
 * Describe the observations `mask` selects (see {@link ObservationsDescription}): counted by the
 * categorical column the view colours by, else the cell-type column; at most `maxMeasures`
 * continuous columns averaged (or read, for one cell).
 */
export async function describeObservations(
  port: Pick<SpatialDataPort, 'getColumn'>,
  dataset: SpatialDataset,
  view: Pick<SpatialViewState, 'colorBy' | 'cellTypeColumn' | 'groupColors'>,
  mask: Uint8Array,
  maxMeasures = OBSERVATION_DETAIL_COLUMNS,
): Promise<ObservationsDescription> {
  const indices: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) indices.push(i);
  const total = indices.length;
  const one = total === 1 ? indices[0] : -1;

  const categorical = dataset.columns.filter((c): c is CategoricalColumnMeta => c.kind === 'categorical');
  const colored = view.colorBy?.kind === 'column' ? view.colorBy.name : null;
  const groupColumn =
    (colored && categorical.some((c) => c.name === colored) ? colored : null) ?? cellTypeColumnFor(dataset, view);

  let groups: GroupCount[] = [];
  const measures: ObservationsDescription['measures'] = [];
  if (groupColumn && total) {
    const column = await port.getColumn(groupColumn);
    if (isCategoricalColumn(column)) {
      const categories = column.meta.categories;
      const colors = categoryColorsFor(groupColumn, column.meta, view.groupColors);
      const counts = new Map<number, number>();
      for (const i of indices) counts.set(column.codes[i], (counts.get(column.codes[i]) ?? 0) + 1);
      groups = [...counts.entries()]
        .map(([code, count]) => ({
          name: categories[code] ?? '(none)',
          count,
          color: colors[code] ?? '#9e9e9e',
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }
  }

  if (total) {
    // One cell: its other groupings first (its type, its cluster…), as text.
    if (one >= 0) {
      for (const meta of categorical.filter((c) => c.name !== groupColumn).slice(0, maxMeasures)) {
        const column = await port.getColumn(meta.name);
        if (!isCategoricalColumn(column)) continue;
        const name = column.meta.categories[column.codes[one]];
        if (name !== undefined) measures.push({ name: meta.name, value: name, mean: false });
      }
    }
    const continuous = dataset.columns.filter((c): c is ContinuousColumnMeta => c.kind === 'continuous');
    for (const meta of continuous.slice(0, maxMeasures)) {
      const column = await port.getColumn(meta.name);
      if (isCategoricalColumn(column)) continue;
      let sum = 0;
      let n = 0;
      for (const i of indices) {
        const v = column.values[i];
        if (Number.isFinite(v)) {
          sum += v;
          n++;
        }
      }
      if (n) measures.push({ name: meta.name, value: sum / n, unit: meta.unit, mean: one < 0 });
    }
  }

  return {
    total,
    groupColumn: groups.length ? groupColumn : null,
    groups,
    measures,
    ...(one >= 0 ? { cellId: dataset.observations.ids?.[one] ?? String(one) } : {}),
  };
}
