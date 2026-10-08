/**
 * Network inventory (v1.0.6) — every destination Apollo can contact, why,
 * when, and what is sent. Settings › Data & Privacy lists these so the
 * "nothing leaves your device unless you connect a service" promise is
 * checkable. Keep this in sync with the code (intervals.ts, strava.ts,
 * stravaWeb.ts, electron/main.ts) and the CSP (vite.config.ts,
 * public/staticwebapp.config.json).
 */

/** Which build contacts a destination. */
export type NetworkPlatform = 'all' | 'desktop' | 'web';

export interface NetworkDestination {
  /** Stable identifier. */
  id: string;
  /** Host name(s) contacted. */
  host: string;
  /** Why Apollo talks to it. */
  purpose: string;
  /** What makes Apollo contact it. */
  trigger: string;
  /** What is sent. */
  dataSent: string;
  /** True only if contacted without the user connecting or enabling anything. */
  defaultOn: boolean;
  /** Which builds contact it. */
  platform: NetworkPlatform;
}

/** Every network destination of the app. None is contacted by default. */
export const NETWORK_DESTINATIONS: readonly NetworkDestination[] = [
  {
    id: 'intervals-api',
    host: 'intervals.icu',
    purpose: 'Read your activities, wellness (sleep, HRV, resting HR) and sport settings; write planned workouts to your calendar when plan push is on.',
    trigger: 'Only after you connect intervals.icu: when you sync (manually, or on launch / in the background if you turned that on), open an activity, sync wellness (if enabled) or push your plan (if enabled).',
    dataSent: 'Your intervals.icu API key (HTTP Basic auth), athlete ID, date ranges and activity IDs; planned workouts when you push your plan.',
    defaultOn: false,
    platform: 'all',
  },
  {
    id: 'strava-api',
    host: 'www.strava.com (api/v3)',
    purpose: 'Read your Strava activities and athlete profile.',
    trigger: 'Only after you connect Strava: when you sync or open an activity.',
    dataSent: 'Your Strava access token, activity IDs and paging parameters.',
    defaultOn: false,
    platform: 'all',
  },
  {
    id: 'strava-oauth',
    host: 'www.strava.com (oauth)',
    purpose: 'Sign in to Strava and keep the connection alive (authorize, token exchange and refresh).',
    trigger: 'When you click Connect Strava (the sign-in page opens in your browser), and when the access token expires during a sync (about every 6 hours).',
    dataSent: 'Desktop: your Strava client ID and client secret plus the authorization code or refresh token, sent by the app itself (main process), never by the page. Web: the code or refresh token go to Apollo\u2019s own server (below), which adds the secret.',
    defaultOn: false,
    platform: 'all',
  },
  {
    id: 'oauth-loopback',
    host: '127.0.0.1 (this computer only)',
    purpose: 'Desktop: receive Strava\u2019s sign-in redirect on a temporary local port.',
    trigger: 'Only while you connect Strava; closes after one use or 5 minutes.',
    dataSent: 'Nothing leaves your computer: your browser hands the one-time authorization code back to Apollo.',
    defaultOn: false,
    platform: 'desktop',
  },
  {
    id: 'github-releases',
    host: 'github.com, objects.githubusercontent.com',
    purpose: 'Desktop: check for and download app updates (GitHub Releases of LetsLearntocodeforfun/Apollo-Running).',
    trigger: 'Only if you turn on automatic update checks, or click Check for updates / Open download page.',
    dataSent: 'A standard HTTPS request: your IP address, the app version and platform. No account or training data.',
    defaultOn: false,
    platform: 'desktop',
  },
  {
    id: 'web-bff',
    host: 'this website (/api)',
    purpose: 'Web: exchange and refresh Strava tokens through Apollo\u2019s own server so the client secret never reaches the browser.',
    trigger: 'When you connect Strava in the browser, and when its token is refreshed.',
    dataSent: 'The Strava authorization code or refresh token.',
    defaultOn: false,
    platform: 'web',
  },
];

/** Destinations relevant to the current build. */
export function getNetworkDestinations(platform: Exclude<NetworkPlatform, 'all'>): NetworkDestination[] {
  return NETWORK_DESTINATIONS.filter((d) => d.platform === 'all' || d.platform === platform);
}
