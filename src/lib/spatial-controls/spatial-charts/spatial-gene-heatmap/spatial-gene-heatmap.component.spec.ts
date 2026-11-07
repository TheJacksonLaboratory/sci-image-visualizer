import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA, SimpleChange } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SpatialGeneHeatmapComponent } from './spatial-gene-heatmap.component';
import type { SpatialGeneHeatmapAccess } from '../../../contracts/visualizer.contract';
import type { SpatialGeneHeatmap } from '../../../contracts/spatial-dataset.contract';

/** 4 genes (the last never detected) x 6 cells in 2 groups; tiles of 4. */
const INFO: SpatialGeneHeatmap = {
  column: 'cluster',
  cells: 6,
  genes: ['Cd3e', 'Ms4a1', 'Lyz2', 'Xist'],
  expressedGenes: 3,
  peakGroup: [0, 1, 1, -1],
  geneMax: [3, 2, 1, 0],
  max: 3,
  groups: [
    { name: 'T', cells: 4, start: 0 },
    { name: 'B', cells: 2, start: 4 },
  ],
  transform: 'log1p',
  tileSize: 4,
  baseLevel: 0,
  finestLevel: 0,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SpatialGeneHeatmapComponent', () => {
  let fixture: ComponentFixture<SpatialGeneHeatmapComponent>;
  let component: SpatialGeneHeatmapComponent;
  let access: jest.Mocked<SpatialGeneHeatmapAccess>;
  /** The component's internals, for geometry the test sets and state it reads. */
  let c: any;

  async function build(info: SpatialGeneHeatmap = INFO) {
    access = {
      info: jest.fn().mockResolvedValue(info),
      means: jest.fn().mockResolvedValue({
        // genes x groups
        means: new Float32Array([2, 0, 0.5, 1.5, 0.2, 0.8, 0, 0]),
        fractions: new Float32Array([0.9, 0.1, 0.4, 1, 0.1, 0.5, 0, 0]),
      }),
      order: jest.fn().mockResolvedValue(new Uint32Array([5, 4, 3, 2, 1, 0])),
      tile: jest.fn().mockImplementation(async (_c, cx, gy, tx, ty) => {
        const rows = Math.min(4, Math.ceil(4 / 2 ** gy) - ty * 4);
        const cols = Math.min(4, Math.ceil(6 / 2 ** cx) - tx * 4);
        return new Float32Array(rows * cols).fill(1);
      }),
    };
    TestBed.resetTestingModule();
    TestBed.overrideComponent(SpatialGeneHeatmapComponent, {
      set: { imports: [CommonModule], schemas: [NO_ERRORS_SCHEMA] },
    });
    await TestBed.configureTestingModule({ imports: [SpatialGeneHeatmapComponent] }).compileComponents();
    fixture = TestBed.createComponent(SpatialGeneHeatmapComponent);
    component = fixture.componentInstance;
    c = component as any;
    component.access = access;
    component.column = 'cluster';
    component.ids = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'];
    fixture.detectChanges();
    // A known plot: 296 x 200 px at (104, 66).
    c.size = { w: 404, h: 270, dpr: 1 };
    component.ngOnChanges({ access: new SimpleChange(null, access, true) });
    await flush();
    await flush();
  }

  const pointer = (x: number, y: number) => ({ offsetX: x, offsetY: y, pointerId: 1, target: null }) as any;

  it('loads the layout for its column and fits the detected genes', async () => {
    await build();
    expect(access.info).toHaveBeenCalledWith('cluster');
    expect(c.info).toBe(INFO);
    expect(c.window).toEqual({ x0: 0, x1: 6, y0: 0, y1: 3 });
    expect(c.loading).toBeNull();
    expect(access.order).toHaveBeenCalledWith('cluster');
  });

  it('asks for the tiles the view needs, at the scale chosen', async () => {
    await build();
    component.draw();
    // 6 cells over 296 px and 3 genes over 200 px: one cell and one gene per level pixel.
    expect(access.tile).toHaveBeenCalledWith('cluster', 0, 0, 0, 0, 'expression');
    expect(access.tile).toHaveBeenCalledWith('cluster', 0, 0, 1, 0, 'expression');
    await flush();
    component.draw();
    expect(c.status).toContain('6 cells × 3 genes');
    expect(c.status).toContain('a column per cell');

    access.tile.mockClear();
    c.onCellScale('gene');
    component.draw();
    expect(access.tile).toHaveBeenCalledWith('cluster', 0, 0, 0, 0, 'gene');
  });

  it('names the cell, its group and the value under the pointer', async () => {
    await build();
    component.draw();
    await flush();
    // Column 4 (x = 104 + 4.5/6 * 296) of gene 1 (y = 66 + 1.5/3 * 200).
    c.onPointerMove(pointer(104 + (4.5 / 6) * 296, 66 + 100));
    const lines = c.hover.lines.map((l: any) => `${l.label}: ${l.value}`);
    expect(lines).toEqual(['Gene: Ms4a1', 'Cell: c1', 'cluster: B', 'Expression: 1.00']);
  });

  it('shows each group’s mean, z-scored, in the groups view', async () => {
    await build();
    c.onView('groups');
    await flush();
    expect(access.means).toHaveBeenCalledWith('cluster');
    component.draw();
    expect(c.legend.label).toBe('z-score');
    expect(c.status).toContain('3 genes × 2 groups');
    // Group B (second of 2 columns), gene Cd3e.
    c.onPointerMove(pointer(104 + 0.75 * 296, 66 + 30));
    const lines = c.hover.lines.map((l: any) => `${l.label}: ${l.value}`);
    expect(lines).toEqual([
      'Gene: Cd3e',
      'cluster: B (2 cells)',
      'Mean: 0.00',
      'Expressing: 10.0%',
      'z-score: -1.00',
    ]);
  });

  it('emits the gene clicked, and not a drag', async () => {
    await build();
    const clicked: string[] = [];
    component.geneClick.subscribe((g) => clicked.push(g));
    c.onPointerDown(pointer(200, 66 + 170));
    c.onPointerUp(pointer(200, 66 + 170));
    expect(clicked).toEqual(['Lyz2']);
    c.onPointerDown(pointer(200, 100));
    c.onPointerMove(pointer(260, 160));
    c.onPointerUp(pointer(260, 160));
    expect(clicked).toEqual(['Lyz2']);
  });

  it('finds a gene, showing the undetected ones when it is one of them', async () => {
    await build();
    c.search = 'xi';
    c.findGene();
    expect(c.hideUndetected).toBe(false);
    expect(c.highlightRow).toBe(3);
    expect(c.searchNote).toContain('Xist is never detected');
    c.search = 'nope';
    c.findGene();
    expect(c.searchNote).toContain('No gene matches');
  });

  it('zooms on the wheel about the pointer, genes only with Shift', async () => {
    await build();
    const wheel = (extra: Partial<WheelEvent>) =>
      c.onWheel({ offsetX: 104 + 148, offsetY: 66 + 100, deltaY: -100, preventDefault: jest.fn(), ...extra });
    wheel({ shiftKey: true } as any);
    expect(c.window.x1 - c.window.x0).toBe(6);
    expect(c.window.y1 - c.window.y0).toBeLessThan(3);
    c.resetZoom();
    wheel({});
    expect(c.window.x1 - c.window.x0).toBeLessThan(6);
  });

  it('says why it cannot show the heatmap', async () => {
    access = undefined as any;
    await build();
    access.info.mockRejectedValueOnce(new Error('HTTP 500'));
    component.ngOnChanges({ column: new SimpleChange('cluster', 'cluster', false) });
    await flush();
    expect(c.error).toContain('HTTP 500');
    expect(c.info).toBeNull();
  });
});
