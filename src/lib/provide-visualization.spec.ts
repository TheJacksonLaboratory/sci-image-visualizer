import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

import { Provider } from '@angular/core';
import { provideVisualization } from './provide-visualization';

/**
 * `provideVisualization()` promises to list EVERY stateful service of the chain, so
 * a component-scoped viewer (jit-ui's pipeline preview) gets its own copy instead of
 * sharing the root one. A service that holds per-viewer state — a Subject, or a
 * host bound with `bindHost` — and is missing from the list silently couples two
 * live viewers (review CORE-6: both showed the sticky SAM toast, and a spatial
 * selection in one muted the other).
 *
 * This scans the library for such `@Injectable`s, so a new one fails here until it
 * is either provided or consciously allow-listed as shared.
 */

/** Stateful, but deliberately NOT per viewer — with the reason. */
const SHARED_ON_PURPOSE: Record<string, string> = {
  // The host's own SpatialDataPort adapter: provided by the host, not the chain.
  SpatialDataHttpService: 'host-provided data port adapter',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

function statefulInjectables(): { name: string; file: string }[] {
  const found: { name: string; file: string }[] = [];
  for (const file of sources(__dirname)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('@Injectable')) continue;
    if (!/new (Behavior|Replay)?Subject\b|bindHost\(/.test(text)) continue;
    const cls = /@Injectable\([^)]*\)\s*export class (\w+)/.exec(text);
    if (cls) found.push({ name: cls[1], file: relative(__dirname, file) });
  }
  return found;
}

function providedClassNames(providers: Provider[]): Set<string> {
  const names = new Set<string>();
  for (const p of providers) {
    if (typeof p === 'function') names.add(p.name);
  }
  return names;
}

describe('provideVisualization()', () => {
  it('finds the stateful services it is meant to check (sanity)', () => {
    const names = statefulInjectables().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['PlotlyService', 'RegionStore', 'WandToolService']));
  });

  it('lists every stateful @Injectable of the chain, or it is allow-listed as shared', () => {
    const provided = providedClassNames(provideVisualization());
    const missing = statefulInjectables()
      .filter((s) => !provided.has(s.name) && !(s.name in SHARED_ON_PURPOSE))
      .map((s) => `${s.name} (${s.file})`);
    expect(missing).toEqual([]);
  });
});
