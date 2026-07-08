import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { PresetSet } from '../../models/class-preset';

/**
 * Port for persisting the per-user annotation-class preset set (jit-ui#70).
 *
 * The library defines the contract; the app supplies an adapter that talks to the
 * jit-service `/api/preferences/annotation-classes` endpoint. The user is keyed
 * server-side from the authenticated JWT, so no user id is passed here.
 *
 * Mirrors `RegionIoPort` / `REGION_IO_PORT`.
 */
export interface PreferencesPort {
  /** Load the current user's preset set; resolves to `null` if none has been saved yet. */
  loadPresetSet(): Observable<PresetSet | null>;

  /** Persist (upsert) the current user's preset set. */
  savePresetSet(set: PresetSet): Observable<void>;
}

export const PREFERENCES_PORT = new InjectionToken<PreferencesPort>('PREFERENCES_PORT');
