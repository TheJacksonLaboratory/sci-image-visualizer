import { InjectionToken } from '@angular/core';

/**
 * Whether this browser can run the napari-js (WebGPU) renderer: resolves true once a GPU adapter
 * has been granted, false when there is no `navigator.gpu` (Firefox before 141, Safari before 26,
 * any page that is not a secure context), when the browser offers no adapter (a blocklisted GPU,
 * WebGPU switched off), or when asking for one fails or hangs.
 */
export type WebGpuProbe = () => Promise<boolean>;

/** How long an adapter request may take before WebGPU is treated as unavailable. An adapter is
 *  normally granted in milliseconds; one that never answers must not hold the first render up. */
export const WEBGPU_PROBE_TIMEOUT_MS = 3000;

/**
 * The probe the router asks before it routes a plot to napari-js. Without WebGPU the napari-js
 * viewer cannot start, so the router falls back (the 2D types to OpenSeadragon, with the spatial
 * markers drawn by the WebGL fallback; the 3D types to Plotly) instead of failing the render.
 *
 * Provide your own to force a path, e.g. `{ provide: WEBGPU_PROBE, useValue: () =>
 * Promise.resolve(false) }` to try the WebGL fallback on a machine that has WebGPU.
 */
export const WEBGPU_PROBE = new InjectionToken<WebGpuProbe>('WEBGPU_PROBE', {
  providedIn: 'root',
  factory: () => probeWebGpu,
});

let probed: Promise<boolean> | null = null;

/** {@link detectWebGpu}, asked once per page: an adapter is not granted again for every plot. */
export function probeWebGpu(): Promise<boolean> {
  probed ??= detectWebGpu();
  return probed;
}

/** Forget the cached answer (tests). */
export function resetWebGpuProbe(): void {
  probed = null;
}

interface GpuLike {
  requestAdapter(): Promise<unknown>;
}

/** Ask the browser for a WebGPU adapter; see {@link WebGpuProbe}. */
export async function detectWebGpu(
  nav: { gpu?: GpuLike } | undefined = globalThis.navigator as { gpu?: GpuLike } | undefined,
  timeoutMs = WEBGPU_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const gpu = nav?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const adapter = await Promise.race([gpu.requestAdapter(), timeout]);
    return adapter != null;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
