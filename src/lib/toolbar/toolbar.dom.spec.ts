import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Tooltip } from 'primeng/tooltip';

import { VisualizationModule } from '../visualization.module';
import { ToolbarComponent } from './toolbar.component';
import { PlotType } from '../contracts/plot-type';
import { IImageInfo } from '../contracts/image.contract';
import { ALL_TOOLBAR_TOOLS } from '../contracts/toolbar-config';
import { ToolbarToolContribution } from '../contracts/toolbar-tool.contract';

/**
 * DOM characterization of the plotting toolbar (§6 ToolbarComponent split).
 *
 * Renders the real template through VisualizationModule (so any child
 * components it is split into are used) for a handful of plot-type / flag
 * combinations and reduces it to a flat list of the controls a user sees, in
 * DOM order — wrapper elements are ignored, so the list must stay identical
 * across the template split. Each control is described by what identifies it:
 * its icon or image, its static tooltip, whether it is shown "on" (not text-
 * styled) and disabled, a slider's value, a text label.
 */
function signature(fixture: ComponentFixture<unknown>): string[] {
  const root = fixture.nativeElement as HTMLElement;
  const out: string[] = [];
  // Read the tooltip off the directive, so a bound [pTooltip] reads like a static one.
  const tooltipOf = (el: Element): string => {
    const de = fixture.debugElement.query((d) => d.nativeElement === el);
    const content = de?.injector.get(Tooltip, null)?.content;
    return typeof content === 'string' ? content : '';
  };
  const iconOf = (el: Element): string => {
    // The rendered icon span, so a bound [icon] reads like a static one.
    const span = el.querySelector('.p-button-icon');
    const pi = span ? Array.from(span.classList).filter((c) => c === 'pi' || c.startsWith('pi-')) : [];
    if (pi.length) return pi.join(' ');
    const img = el.querySelector('img');
    if (img) return (img.getAttribute('src') ?? '').replace('assets/plotting/', '');
    const i = el.querySelector('i');
    return i ? i.className.replace('ng-star-inserted', '').trim() : (el.textContent ?? '').trim();
  };
  const visit = (el: Element): void => {
    const tag = el.tagName.toLowerCase();
    if (el.classList.contains('toolbar-separator')) {
      out.push('|');
      return;
    }
    if (el.classList.contains('toolbar-text')) {
      out.push(`text:${(el.textContent ?? '').replace(/\s+/g, ' ').trim()}`);
      return;
    }
    if (tag === 'p-button') {
      const button = el.querySelector('button');
      const on = button && !button.classList.contains('p-button-text') ? ' on' : '';
      const disabled = button?.disabled ? ' disabled' : '';
      const tip = tooltipOf(el).replace(/\s+/g, ' ').trim();
      out.push(`button:${iconOf(el)}${on}${disabled}${tip ? ` "${tip}"` : ''}`);
      return;
    }
    if (tag === 'p-slider') {
      const handles = Array.from(el.querySelectorAll('.p-slider-handle')).map((h) =>
        h.getAttribute('aria-valuenow'),
      );
      out.push(`slider:${handles.join('-')}`);
      return;
    }
    if (tag === 'p-dropdown') {
      out.push(`dropdown:${(el.querySelector('.p-dropdown-label')?.textContent ?? '').trim()}`);
      return;
    }
    if (tag === 'p-inputnumber') {
      out.push('number');
      return;
    }
    if (tag === 'p-menu') {
      out.push('menu');
      return;
    }
    for (const child of Array.from(el.children)) visit(child);
  };
  visit(root.querySelector('p-toolbar') as Element);
  return out;
}

const tool: ToolbarToolContribution = {
  id: 'detect',
  label: 'Detect',
  icon: { pi: 'pi-search' },
  runTooltip: 'Detect things',
  models: () => [{ id: 'a', label: 'A', info: 'first' }],
  defaultModelId: () => 'a',
  params: [{ key: 'k', label: 'K', kind: 'number', min: 0, max: 1, step: 0.1 } as never],
  defaultParams: () => ({}),
  progress: { status$: null as never, busy$: null as never, progress$: null as never },
  run: async () => 0,
};

const image = (over: Partial<IImageInfo>): IImageInfo => ({ fileName: 'a.tif', ...over }) as IImageInfo;

describe('ToolbarComponent (DOM characterization)', () => {
  let fixture: ComponentFixture<ToolbarComponent>;

  beforeEach(async () => {
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
    await TestBed.configureTestingModule({
      imports: [VisualizationModule, NoopAnimationsModule],
    }).compileComponents();
    fixture = TestBed.createComponent(ToolbarComponent);
  });

  afterEach(() => {
    fixture.destroy();
    jest.restoreAllMocks();
  });

  async function render(inputs: Record<string, unknown>): Promise<string[]> {
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    await fixture.whenStable(); // ngModel writes slider / dropdown values a tick later
    fixture.detectChanges();
    return signature(fixture);
  }

  const plotTypeOptions = [
    { type: PlotType.IMAGE, label: 'Image', icon: 'pi pi-image' },
    { type: PlotType.HEATMAP, label: 'Heatmap', icon: 'assets/plotting/heatmap.svg' },
    { type: PlotType.NAPARI_ISOSURFACE, label: 'Isosurface', icon: 'pi pi-box' },
    { type: PlotType.NAPARI_SURFACE, label: 'Surface', icon: 'pi pi-box' },
  ];

  it('Image view, z-stack, brush active, SAM models and a contributed tool', async () => {
    expect(
      await render({
        imageInfo: image({ isStack: true }),
        plotTypeOptions,
        selectedPlotType: PlotType.IMAGE,
        maxIndex: 9,
        zIndex: 3,
        activeDragMode: 'brush',
        brushSize: 60,
        canUndo: true,
        samModels: [{ id: 'vit_t', label: 'ViT-T' }],
        samModelId: 'vit_t',
        contributedTools: [tool],
      }),
    ).toMatchSnapshot();
  });

  it('Heatmap, stack in single-image mode, wand active, no SAM models', async () => {
    expect(
      await render({
        imageInfo: image({ isStack: true, showStack: false }),
        plotTypeOptions,
        selectedPlotType: PlotType.HEATMAP,
        maxIndex: 4,
        zIndex: 1,
        activeDragMode: 'wand',
        wandSensitivity: 2.5,
        canRedo: true,
      }),
    ).toMatchSnapshot();
  });

  it('napari isosurface 3D: iso band, camera controls, axes, resolution', async () => {
    expect(
      await render({
        imageInfo: image({}),
        plotTypeOptions,
        selectedPlotType: PlotType.NAPARI_ISOSURFACE,
        isHeatmap: false,
        isoRange: [40, 200],
        activeSurface3dMode: 'orbit',
        axesVisible: true,
      }),
    ).toMatchSnapshot();
  });

  it('3D spatial cloud with screen-space region tools, eraser active', async () => {
    expect(
      await render({
        imageInfo: image({}),
        hasSpatialDataset: true,
        selectedPlotType: PlotType.SPATIAL_OMICS_3D,
        isHeatmap: false,
        is3dRegions: true,
        activeDragMode: 'eraseVertex',
        vertexEraserRadius: 35,
      }),
    ).toMatchSnapshot();
  });

  it('pipeline subset: zoom and region tools only', async () => {
    expect(
      await render({
        imageInfo: image({}),
        selectedPlotType: PlotType.IMAGE,
        activeDragMode: 'zoomToBox',
        tools: { ...ALL_TOOLBAR_TOOLS, specialTools: false, help: false },
      }),
    ).toMatchSnapshot();
  });
});
