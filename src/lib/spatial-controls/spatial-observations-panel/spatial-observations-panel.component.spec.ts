import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { SpatialObservationsPanelComponent } from './spatial-observations-panel.component';
import { ISpatialControls } from '../../contracts/visualizer.contract';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../../contracts/display-types';
import {
  bindInputs, fakeSpatialControls, one, panelNamed, shallowPanel,
} from '../../testing/spatial-panel-testing';

const dataset: SpatialDataset = {
  id: 'demo',
  name: 'Demo brain',
  observations: { count: 1983, x: new Float32Array(0), y: new Float32Array(0) },
  columns: [
    { kind: 'categorical', name: 'region', categories: ['Cortex', 'Thalamus'], colors: ['#f00', '#00f'] },
    { kind: 'continuous', name: 'total_counts', unit: 'counts', logScaleHint: true },
  ],
  features: { count: 12, names: ['Ttr', 'Mbp'] },
};

describe('SpatialObservationsPanelComponent', () => {
  let fixture: ComponentFixture<SpatialObservationsPanelComponent>;
  let component: SpatialObservationsPanelComponent;
  let controls: jest.Mocked<ISpatialControls>;
  let view$: BehaviorSubject<SpatialViewState>;
  let dataset$: BehaviorSubject<SpatialDataset | null>;

  async function build(inputs: Record<string, unknown> = {}) {
    shallowPanel(SpatialObservationsPanelComponent);
    await TestBed.configureTestingModule({ imports: [SpatialObservationsPanelComponent] }).compileComponents();
    fixture = TestBed.createComponent(SpatialObservationsPanelComponent);
    component = fixture.componentInstance;
    bindInputs(fixture, { controls, dataset: dataset$, view: view$, ...inputs });
  }

  beforeEach(() => {
    ({ controls, view$, dataset$ } = fakeSpatialControls(dataset));
  });

  describe('colour source', () => {
    beforeEach(async () => {
      await build();
      (controls.setViewState as jest.Mock).mockClear();
    });

    it('offers "None" plus every column, labelled by kind', () => {
      expect(component['columnOptions'][0]).toEqual({ label: 'None (flat colour)', value: null });
      expect(component['columnOptions'].map((o) => o.value)).toEqual([null, 'region', 'total_counts']);
      expect(component['columnOptions'][1].label).toContain('2 categories');
      expect(component['columnOptions'][2].label).toContain('counts');
    });

    it('colours by a column', () => {
      component['onColumn']('region');
      expect(controls.colorByColumn).toHaveBeenCalledWith('region');
    });

    it('clears the colouring when None is chosen', () => {
      component['onColumn'](null);
      expect(controls.clearColorBy).toHaveBeenCalled();
    });

    it('column and gene are mutually exclusive, so the source is never ambiguous', () => {
      component['onGene']('Ttr');
      expect(component['selectedColumn']).toBeNull();
      expect(controls.colorByFeature).toHaveBeenCalledWith('Ttr');

      component['onColumn']('region');
      expect(component['selectedGene']).toBeNull();
    });

    it('reflects a colour source set elsewhere (e.g. by the host)', () => {
      controls.colorByFeature('Mbp');
      expect(component['selectedGene']).toBe('Mbp');
      expect(component['selectedColumn']).toBeNull();
    });

    it('clearing the dropdown clears the colour source', () => {
      component['onGene'](null);
      expect(controls.clearColorBy).toHaveBeenCalled();
      expect(component['selectedGene']).toBeNull();
    });
  });

  describe('display, gene map and 3D scene', () => {
    beforeEach(async () => {
      await build();
      (controls.setViewState as jest.Mock).mockClear();
    });

    it('writes point scale and opacity through', () => {
      component['onPointScale'](2.5);
      expect(controls.setViewState).toHaveBeenCalledWith({ pointScale: 2.5 });
      component['onOpacity'](0.4);
      expect(controls.setViewState).toHaveBeenCalledWith({ opacity: 0.4 });
    });

    it('ignores an empty slider value rather than storing undefined', () => {
      component['onPointScale'](undefined);
      component['onOpacity'](undefined);
      expect(controls.setViewState).not.toHaveBeenCalled();
    });

    it('writes the log toggle and the percentile clip', () => {
      component['onLogScale'](true);
      expect(controls.setViewState).toHaveBeenCalledWith({ logScale: true });
      component['onClip']([0.05, 0.95]);
      expect(controls.setViewState).toHaveBeenCalledWith({ percentileClip: [0.05, 0.95] });
    });

    it('offers the gene map only while a gene is the colour source', () => {
      expect(component['canMapGene']).toBe(false); // nothing to map
      component['onColumn']('region');
      expect(component['canMapGene']).toBe(false); // a column is not a gene
      view$.next({ ...view$.value, colorBy: { kind: 'feature', name: 'Ttr' } });
      expect(component['canMapGene']).toBe(true);
    });

    it('writes the gene-map toggle and its bandwidth, ignoring an empty slider', () => {
      component['onGeneMap'](true);
      expect(controls.setViewState).toHaveBeenCalledWith({ geneMap: true });
      component['onGeneMapSmoothing'](2);
      expect(controls.setViewState).toHaveBeenCalledWith({ geneMapSmoothing: 2 });
      // The map's opacity is its own: turning the cells down to read the field
      // beneath them must not dim the field too.
      component['onGeneMapOpacity'](0.4);
      expect(controls.setViewState).toHaveBeenCalledWith({ geneMapOpacity: 0.4 });
      (controls.setViewState as jest.Mock).mockClear();
      component['onGeneMapOpacity'](undefined);
      expect(controls.setViewState).not.toHaveBeenCalled();
    });

    it('writes the volume and cloud visibility independently', () => {
      // The point of separate toggles: every combination is reachable, including
      // the density volumes alone.
      component['onShowVolume'](false);
      expect(controls.setViewState).toHaveBeenCalledWith({ showVolume: false });
      component['onShowPoints'](false);
      expect(controls.setViewState).toHaveBeenCalledWith({ showPoints: false });
      expect(component.view.showVolume).toBe(false);
      expect(component.view.showPoints).toBe(false);
    });

    it('writes the volume opacity, separately from the markers', () => {
      component['onVolumeOpacity'](0.2);
      expect(controls.setViewState).toHaveBeenCalledWith({ volumeOpacity: 0.2 });
      // Turning the backdrop down must leave the measurement drawn over it alone.
      expect(component.view.opacity).toBe(DEFAULT_SPATIAL_VIEW.opacity);
      (controls.setViewState as jest.Mock).mockClear();
      component['onVolumeOpacity'](undefined);
      expect(controls.setViewState).not.toHaveBeenCalled();
    });

    it('opens the section picker mid-stack and releases it back to every section', () => {
      expect(component['oneSection']).toBe(false);
      expect(component['isSectioned']).toBe(true); // three sections in the mock
      expect(component['lastSection']).toBe(2);

      component['onOneSection'](true);
      // The middle slide, not the first: for a brain the first is a nearly empty
      // olfactory-bulb section, which reads as a broken control.
      expect(controls.setViewState).toHaveBeenCalledWith({ pointSection: 1 });
      expect(component['oneSection']).toBe(true);
      expect(component['sectionLabel']).toBe('2 of 3');

      component['onPointSection'](2);
      expect(component['sectionLabel']).toBe('3 of 3');

      component['onOneSection'](false);
      expect(controls.setViewState).toHaveBeenCalledWith({ pointSection: null });
      expect(component['oneSection']).toBe(false);
    });

    it('offers no section picker for a dataset whose z is not sectioned', () => {
      component['sections'] = null;
      expect(component['isSectioned']).toBe(false);
      expect(component['sectionLabel']).toBe('');
      // A single section is not a stack to step through either.
      component['sections'] = Float32Array.from([5]);
      expect(component['isSectioned']).toBe(false);
    });

    it('writes the density toggle and its bandwidth, ignoring an empty slider', () => {
      component['onDensityVolume'](true);
      expect(controls.setViewState).toHaveBeenCalledWith({ densityVolume: true });
      component['onDensitySmoothing'](2.5);
      expect(controls.setViewState).toHaveBeenCalledWith({ densitySmoothing: 2.5 });
      (controls.setViewState as jest.Mock).mockClear();
      component['onDensitySmoothing'](undefined);
      expect(controls.setViewState).not.toHaveBeenCalled();
    });

    it('says when a column has more categories than the 3D cloud can colour', () => {
      // subclass (338) is served for the density volumes; a user who picks it in the
      // cloud sees one flat colour, and a console warning is not something anyone
      // reads — so the panel says why, and what does render it.
      component.is3d = true;
      component.legend = Array.from({ length: 338 }, (_, i) => ({
        label: `s${i}`, color: '#888888',
      }));
      expect(component['exceedsCloudPalette']).toBe(true);
      // 95, not 96: one of the LUT's 96 distinguishable blocks is reserved for a
      // missing value, and the panel must publish what the renderer enforces —
      // at 96 the cloud drew flat with no warning at all.
      expect(component['cloudPaletteLimit']).toBe(95);
      component.legend = Array.from({ length: 96 }, () => ({ label: 'c', color: '#888' }));
      expect(component['exceedsCloudPalette']).toBe(true);

      // Within the ceiling, or in 2D, there is nothing to warn about.
      component.legend = Array.from({ length: 95 }, () => ({ label: 'c', color: '#888' }));
      expect(component['exceedsCloudPalette']).toBe(false);
      component.legend = Array.from({ length: 338 }, () => ({ label: 'c', color: '#888' }));
      component.is3d = false;
      expect(component['exceedsCloudPalette']).toBe(false);
    });

    it('says what the density volumes are showing, and that it is an estimate', () => {
      // An estimate is only honest if the reader can tell it from measurement.
      expect(component['densityNote']).toContain('not measured cells');
      expect(component['densityNote']).toContain('all cells');
      // …and how to actually see them: the cloud is drawn over the fields.
      expect(component['densityNote']).toContain('Lower Opacity');

      component.legend = [{ label: 'A', color: '#f00' }];
      expect(component['densityNote']).toContain('largest clusters');
    });
  });

  it('drops stale picker state when the dataset changes', async () => {
    await build();
    component['onGene']('Ttr');
    dataset$.next({ ...dataset, id: 'other', name: 'Other', columns: [] });
    expect(component['selectedGene']).toBeNull();
    expect(component['columnOptions']).toHaveLength(1); // just "None"
  });

  it('asks to open from its header, and switches the points from its checkbox', async () => {
    await build({ open: false });
    const root = fixture.nativeElement as HTMLElement;
    const asked: boolean[] = [];
    component.openChange.subscribe((on) => asked.push(on));
    (one(panelNamed(root, 'Observations'), '.sc-panel-head') as HTMLElement).click();
    expect(asked).toEqual([true]);
    expect(root.querySelector('.sc-panel-body')).toBeNull();
    component['onShowPoints'](false);
    expect(view$.value.showPoints).toBe(false);
  });
});
