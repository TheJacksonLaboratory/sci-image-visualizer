import * as Plotly from 'plotly.js-dist-min';

import { IntensityProfile } from '../../contracts/visualizer.contract';

/**
 * Render the floating intensity-profile inset chart into `divId` — one line
 * trace per profile line, each drawn in its line's colour. The x axis is in
 * microns when the sampler tagged the profiles so (the image carries a pixel
 * size), otherwise in pixels. A no-op when the element is missing.
 */
export function renderIntensityInset(divId: string, profiles: IntensityProfile[]): void {
  const el = document.getElementById(divId);
  if (!el) return;
  const traces = (profiles ?? []).map((p, i) => ({
    x: p.positions,
    y: p.values,
    type: 'scatter',
    mode: 'lines',
    line: { color: p.color ?? '#FFD400', width: 2 },
    name: `Line ${i + 1}`,
    hoverinfo: 'x+y',
  }));
  const unit = (profiles ?? []).find((p) => p.unit)?.unit ?? 'px';
  const xTitle = unit === 'µm' ? 'Position (µm)' : 'Position (px)';
  void Plotly.react(
    el,
    traces as unknown as Plotly.Data[],
    {
      margin: { t: 6, r: 8, b: 38, l: 40 },
      xaxis: { title: xTitle, zeroline: false, color: '#ddd' },
      yaxis: { title: 'Intensity', zeroline: false, color: '#ddd' },
      showlegend: false,
      paper_bgcolor: 'rgba(25,25,25,0.9)',
      plot_bgcolor: 'rgba(25,25,25,0.9)',
      font: { color: '#eee', size: 10 },
    } as unknown as Plotly.Layout,
    { displayModeBar: false, responsive: true } as unknown as Plotly.Config,
  );
}
