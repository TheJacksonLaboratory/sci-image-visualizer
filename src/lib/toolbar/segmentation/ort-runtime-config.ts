/**
 * Shared base URL/path for onnxruntime-web's WASM sidecar files
 * (`ort-wasm-simd-threaded.wasm` / `.jsep.mjs`), used by every ONNX-model tool
 * in the library: SAM (in-process and worker) and Cellpose-SAM.
 *
 * Defaults to `'/assets/ort/'` — a host that serves onnxruntime-web's `dist`
 * WASM files there (as jit-ui does via its `project.json` asset glob) needs no
 * configuration and behaves exactly as before this knob existed. A host that
 * cannot serve them at that path — e.g. a static deployment behind an auth
 * proxy, or one that prefers a CDN — calls {@link setOrtWasmBase} ONCE at app
 * init to point the runtime elsewhere:
 *
 * ```ts
 * // version MUST match the onnxruntime-web the library was built against
 * setOrtWasmBase('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/');
 * ```
 *
 * Must be set before the first segmentation runs; the value is read at use time
 * by each tool (and passed into the SAM worker via its load message), so a
 * single call at bootstrap covers SAM and Cellpose alike.
 */
let ortWasmBase = '/assets/ort/';

/** Override where onnxruntime-web loads its WASM sidecars from. See module docs. */
export function setOrtWasmBase(base: string): void {
  ortWasmBase = base;
}

/** The configured onnxruntime-web WASM base (default `'/assets/ort/'`). */
export function getOrtWasmBase(): string {
  return ortWasmBase;
}
