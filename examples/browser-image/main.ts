import 'zone.js';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideHttpClient } from '@angular/common/http';
import { MessageService } from 'primeng/api';
import { AppComponent } from './app.component';

/**
 * App-level providers the library expects from any host:
 *  - provideHttpClient(): the OSD/Plotly services inject HttpClient (auth-safe
 *    asset fetches). Unused on the serverless path but required to construct them.
 *  - provideAnimations(): the PrimeNG toolbar/dialog components need it.
 *  - MessageService: PrimeNG toast service used by the toolbar.
 * The per-viewer ports (IMAGE_STATE_PORT, …) are bound in AppComponent's providers.
 */
bootstrapApplication(AppComponent, {
  providers: [provideHttpClient(), provideAnimations(), MessageService],
}).catch((err) => console.error(err));
