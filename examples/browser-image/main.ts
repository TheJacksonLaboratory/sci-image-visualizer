import 'zone.js';
// Global PrimeNG styles the library's components need (theme + base + icons +
// PrimeFlex utilities). A host normally loads these; jit-ui does via its styles[].
import 'primeicons/primeicons.css';
import 'primeng/resources/primeng.min.css';
import 'primeflex/primeflex.css';
import 'primeng/resources/themes/saga-blue/theme.css';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideHttpClient } from '@angular/common/http';
import { MessageService, ConfirmationService } from 'primeng/api';
import { setOrtWasmBase } from '@jax-data-science/sci-image-visualizer';
import { AppComponent } from './app.component';

/**
 * App-level providers the library expects from any host:
 *  - provideHttpClient(): the OSD/Plotly services inject HttpClient (auth-safe
 *    asset fetches). Unused on the serverless path but required to construct them.
 *  - provideAnimations(): the PrimeNG toolbar/dialog components need it.
 *  - MessageService / ConfirmationService: PrimeNG toast + confirm-dialog
 *    services the toolbar and region editor inject.
 * The per-viewer ports (IMAGE_STATE_PORT, …) are bound in AppComponent's providers.
 */
// Load onnxruntime-web's WASM sidecars from a CDN instead of the default
// same-origin '/assets/ort/'. This static demo is hosted on GitHub Pages: while
// the repo is private, Pages sits behind an auth proxy that 302-redirects
// same-origin sub-resource requests (including ORT's `.mjs`/`.wasm`) to a login
// page — so SAM/Cellpose can't load their runtime from our own origin. jsDelivr
// is a separate origin, unproxied, and serves the files with the right MIME +
// CORS. The version MUST match the onnxruntime-web the library was built against.
// (A normally-hosted app that serves the sidecars at /assets/ort/ omits this.)
setOrtWasmBase('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/');

bootstrapApplication(AppComponent, {
  providers: [provideHttpClient(), provideAnimations(), MessageService, ConfirmationService],
}).catch((err) => console.error(err));
