/**
 * Where Apollo is running and what that build can do.
 *
 * v1.0.7: the free web version (GitHub Pages) has no backend, so anything that
 * needs one — Strava's OAuth token exchange, the auto-updater, the OS keychain —
 * is desktop-only there. Screens ask these helpers instead of probing
 * `window.electronAPI` themselves.
 */

/** True inside the Electron desktop app (the preload exposes `window.electronAPI`). */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!(window as { electronAPI?: unknown }).electronAPI;
}

/** True in a plain browser (the web version, or `npm run dev`). */
export function isWeb(): boolean {
  return typeof window !== 'undefined' && !isDesktop();
}

/**
 * Whether the web build may offer Strava. Off by default: Strava needs a server
 * to keep the client secret, and the web backend still lacks OAuth state/PKCE
 * (PX-08). A self-hosted build that fixed that can opt in with
 * `VITE_WEB_STRAVA=true`.
 */
function webStravaEnabled(): boolean {
  return import.meta.env.VITE_WEB_STRAVA === 'true';
}

/** Whether this build can connect to Strava. */
export function isStravaAvailable(): boolean {
  return isDesktop() || webStravaEnabled();
}

/** Shown wherever a desktop-only connection would otherwise appear on the web. */
export const STRAVA_DESKTOP_ONLY_NOTE =
  'Strava sync is available in the desktop app. In your browser, use intervals.icu or import activity files instead.';
