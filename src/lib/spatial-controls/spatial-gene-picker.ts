import { BehaviorSubject } from 'rxjs';

import type { ISpatialControls } from '../contracts/visualizer.contract';
import type { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { searchGeneNames } from '../spatial/gene-search';
import { PanelOption, geneOption } from '../spatial/spatial-panel-model';
import { Supersede } from '../util/supersede';

/** What a gene dropdown shows: its options, and what an empty list means. */
export interface GenePickerState {
  /**
   * The options. The full name list when the dataset inlines it (a targeted panel: 8 for
   * the ABC demo, 300–5,000 for Xenium/CosMx) — or rather its best few hundred, see
   * {@link GenePickerModel}. A whole-transcriptome dataset does not ship its ~31k names, so
   * there the list is what the port's last search returned and filtering is server-side —
   * same control either way.
   */
  options: PanelOption<string>[];
  /** True when the options come from the port per keystroke rather than a resident list,
   *  which changes what an empty list means (nothing matched *yet*). */
  remote: boolean;
  /** The last remote lookup failed. */
  failed: boolean;
}

/**
 * The gene list behind every gene dropdown of the spatial-omics panel — "Colour by gene",
 * the cells' gene colouring, and the transcript genes. One model for all three: they share
 * one list and one search, so each opens on the head of the full list rather than on
 * whatever another was last filtered to, and a whole-transcriptome list is fetched once.
 *
 * Every gene the dataset inlined is held as plain strings and searched per keystroke. A
 * whole-transcriptome dataset inlines ~18k names — cheap to keep, ruinous to hand a
 * dropdown all at once — so the options are only ever the best few hundred of them.
 *
 * Plain class, no Angular: the owner passes `run`, which re-enters the zone, and the
 * dropdowns read {@link state$} through the `async` pipe, so an OnPush panel re-renders
 * when a search lands.
 */
export class GenePickerModel {
  /** Most names fetched for the lazy list — well above any panel, whole-transcriptome included. */
  static readonly LIST_MAX = 100_000;
  /** Names asked of the port per keystroke while the list is not resident. */
  static readonly SEARCH_LIMIT = 50;

  readonly state$ = new BehaviorSubject<GenePickerState>({ options: [], remote: false, failed: false });

  private names: string[] = [];
  private listLoading = false;
  /** Guards the typeahead: typing outruns the lookup. */
  private readonly search = new Supersede();
  /** Guards the whole-transcriptome list preload against a dataset switch. */
  private readonly listLoad = new Supersede();

  /**
   * @param controls the port, or null when none is bound.
   * @param chosen the genes already chosen anywhere, kept among the options: a multi-select
   *   shows a chip only for a value it can find among its options.
   * @param run where async results are applied — the owner's `NgZone.run`.
   */
  constructor(
    private readonly controls: () => ISpatialControls | null,
    private readonly chosen: () => readonly string[],
    private readonly run: (fn: () => void) => void = (fn) => fn(),
  ) {}

  get options(): PanelOption<string>[] {
    return this.state$.value.options;
  }

  get remote(): boolean {
    return this.state$.value.remote;
  }

  get failed(): boolean {
    return this.state$.value.failed;
  }

  /** Genes resident in the list (the inlined names, or the fetched list once loaded). */
  get residentCount(): number {
    return this.names.length;
  }

  /** A new dataset: its own names (or none), and nothing in flight for the previous one. */
  setDataset(dataset: SpatialDataset | null): void {
    // A gene search or list preload still in flight answers for the previous dataset.
    this.search.cancel();
    this.listLoad.cancel();
    this.listLoading = false;
    const names = dataset?.features?.names;
    this.names = names ? [...names] : [];
    // The head of the list, not all of it.
    this.set({
      options: searchGeneNames(this.names, '').map(geneOption),
      remote: !!dataset?.features && !names,
      failed: false,
    });
  }

  /**
   * A keystroke in a gene dropdown's filter box.
   *
   * With the names resident, search them here and materialise only the top matches: the
   * dropdown's own filter then runs over those and agrees — they were chosen by the same
   * query — so the control behaves as if it still held the whole list. Without them there
   * is nothing to filter, so the query goes to the port and its answer BECOMES the option
   * list — the same control, filtering one hop further away.
   */
  async onFilter(query: string): Promise<void> {
    if (!this.remote) {
      this.set({ options: this.withChosen(searchGeneNames(this.names, query)), failed: false });
      return;
    }
    this.set({ failed: false });
    const controls = this.controls();
    if (!controls) return;
    // A slow answer for an earlier query would replace the options for the text now in
    // the box — including a failure, which would wrongly mark the current query as failed.
    const current = this.search.next();
    if (!query) {
      this.set({ options: [] });
      return;
    }
    try {
      const names = await controls.searchFeatures(query, GenePickerModel.SEARCH_LIMIT);
      if (!current()) return;
      this.run(() => this.set({ options: this.withChosen(names) }));
    } catch {
      if (!current()) return;
      // A failed lookup must not wedge the control — show none and say so.
      this.run(() => this.set({ options: this.withChosen([]), failed: true }));
    }
  }

  /**
   * A gene dropdown opened.
   *
   * A whole-transcriptome dataset does not inline its ~30k names; they are fetched here,
   * once, on first open — the list is then resident and every keystroke filters locally,
   * exactly as for a targeted panel. Until it arrives the dropdown falls back to asking the
   * server per keystroke.
   */
  async ensureList(): Promise<void> {
    const controls = this.controls();
    if (this.remote && controls && !this.listLoading) {
      this.listLoading = true;
      // A switch to another remote-gene dataset mid-fetch would otherwise hand it this
      // dataset's names as its own.
      const current = this.listLoad.next();
      try {
        const names = await controls.searchFeatures('', GenePickerModel.LIST_MAX);
        if (current() && names.length && this.remote) {
          this.run(() => {
            this.names = names;
            this.set({ remote: false });
          });
        }
      } catch {
        // Keep the per-keystroke search; the list is a convenience, not a requirement.
      } finally {
        if (current()) this.listLoading = false;
      }
    }
    this.run(() => this.set({
      options: this.withChosen(this.remote ? [] : searchGeneNames(this.names, '')),
    }));
  }

  /** Options for `names`, plus the genes already chosen. */
  private withChosen(names: readonly string[]): PanelOption<string>[] {
    const seen = new Set(names);
    return [...this.chosen().filter((g) => !seen.has(g)), ...names].map(geneOption);
  }

  private set(patch: Partial<GenePickerState>): void {
    this.state$.next({ ...this.state$.value, ...patch });
  }
}
