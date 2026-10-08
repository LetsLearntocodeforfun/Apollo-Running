/**
 * Pure security policy helpers for the Electron main process (v1.0.6).
 *
 * Kept free of Electron, Node and DOM imports so the same rules can be
 * type-checked by tsconfig.node.json (lib ES2022, no DOM) and unit-tested
 * from vitest (src/__tests__/electronSecurity.test.ts).
 *
 * Policy summary:
 *  - The window may only show the app itself: its packaged index.html (any
 *    hash/query) or, in development, the Vite dev server.
 *  - Sub-frames may additionally show generated content (blob:, data:,
 *    about:blank / about:srcdoc) — the plan printout uses
 *    `<iframe src="blob:…">` + `contentWindow.print()`.
 *  - Links leave the app only through the OS browser, and only to an
 *    allow-list of https destinations (one list shared by window.open and the
 *    `open-external` IPC).
 *  - IPC is served to the app's top frame only.
 *  - Browser permissions are denied except sanitized clipboard writes.
 */

/** GitHub releases page (manual updates on macOS, release notes). */
export const RELEASES_URL = 'https://github.com/LetsLearntocodeforfun/Apollo-Running/releases';

const RELEASES_PATH = '/LetsLearntocodeforfun/Apollo-Running/releases';

/**
 * Domains (and their subdomains) whose https pages may be opened in the OS
 * browser: activity platforms and their auth / help pages.
 */
export const EXTERNAL_DOMAIN_ALLOWLIST: readonly string[] = [
  'strava.com',
  'intervals.icu',
  'connect.garmin.com',
];

/** Longest URL accepted from the renderer for opening externally. */
const MAX_EXTERNAL_URL_LENGTH = 2048;

/**
 * Normalized `href` when `raw` may be opened in the OS browser, else null.
 * Only https, no embedded credentials or custom ports, and either an
 * allow-listed domain or this project's GitHub releases pages.
 */
export function getAllowedExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_EXTERNAL_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  if (EXTERNAL_DOMAIN_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`))) return parsed.href;
  if (host === 'github.com' && (parsed.pathname === RELEASES_PATH || parsed.pathname.startsWith(`${RELEASES_PATH}/`))) {
    return parsed.href;
  }
  return null;
}

/** True when `raw` may be opened in the OS browser (see {@link getAllowedExternalUrl}). */
export function isAllowedExternalUrl(raw: unknown): boolean {
  return getAllowedExternalUrl(raw) !== null;
}

/** Where the trusted app is served from. */
export interface TrustedAppLocation {
  /** `file://` URL of the loaded index.html (packaged builds), or null. */
  indexUrl: string | null;
  /** Vite dev server origin (e.g. `http://localhost:5173`) — development only, else null. */
  devServerOrigin: string | null;
  /** Compare file paths case-insensitively (Windows). */
  caseInsensitivePaths?: boolean;
}

/** Decoded, optionally lower-cased path of a file URL for comparison. */
function normalizedFilePath(u: URL, caseInsensitive: boolean): string {
  let p = u.pathname;
  try {
    p = decodeURIComponent(p);
  } catch { /* keep encoded form */ }
  return caseInsensitive ? p.toLowerCase() : p;
}

/**
 * True when `raw` is the app itself: the loaded index.html (any query/hash,
 * e.g. HashRouter routes) or, in development, a page on the dev server.
 */
export function isTrustedAppUrl(raw: unknown, trusted: TrustedAppLocation): boolean {
  if (typeof raw !== 'string' || !raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (trusted.devServerOrigin && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    try {
      if (parsed.origin === new URL(trusted.devServerOrigin).origin) return true;
    } catch { /* malformed dev origin — fall through */ }
  }
  if (trusted.indexUrl && parsed.protocol === 'file:') {
    try {
      const index = new URL(trusted.indexUrl);
      const ci = !!trusted.caseInsensitivePaths;
      return index.protocol === 'file:'
        && parsed.host.toLowerCase() === index.host.toLowerCase()
        && normalizedFilePath(parsed, ci) === normalizedFilePath(index, ci);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Top-level navigation policy (`will-navigate`, `will-redirect`, main-frame
 * `will-frame-navigate`): same-document navigations and the app itself only.
 */
export function isAllowedTopLevelNavigation(raw: unknown, isSameDocument: boolean, trusted: TrustedAppLocation): boolean {
  if (isSameDocument) return true;
  return isTrustedAppUrl(raw, trusted);
}

/**
 * Sub-frame navigation policy: generated content (blob:, data:, about:blank,
 * about:srcdoc), same-document navigations, or the app itself. Remote pages
 * are never framed.
 */
export function isAllowedSubframeNavigation(raw: unknown, isSameDocument: boolean, trusted: TrustedAppLocation): boolean {
  if (isSameDocument) return true;
  if (typeof raw !== 'string') return false;
  if (raw === 'about:blank' || raw === 'about:srcdoc') return true;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') return true;
  return isTrustedAppUrl(raw, trusted);
}

/**
 * IPC sender policy: only the app's top frame may call privileged handlers.
 * `frameUrl` is `event.senderFrame.url`; `isTopFrame` is `!senderFrame.parent`.
 */
export function isTrustedSenderUrl(frameUrl: unknown, isTopFrame: boolean, trusted: TrustedAppLocation): boolean {
  return isTopFrame && isTrustedAppUrl(frameUrl, trusted);
}

/** Browser permissions the app may use. Everything else is denied. */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

/** True when a web permission request/check should be granted. */
export function isAllowedPermission(permission: unknown): boolean {
  return typeof permission === 'string' && ALLOWED_PERMISSIONS.has(permission);
}

/** Validated `updater:configure` payload (non-booleans become false). */
export interface UpdaterPrefs {
  autoCheck: boolean;
  autoDownload: boolean;
}

/** Coerce untrusted `updater:configure` input; only literal `true` enables an option. */
export function parseUpdaterPrefs(input: unknown): UpdaterPrefs {
  const rec = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return { autoCheck: rec.autoCheck === true, autoDownload: rec.autoDownload === true };
}

/** Result of checking a Strava OAuth loopback callback. */
export type OAuthCallbackCheck =
  | { kind: 'not-found' }
  | { kind: 'bad-state' }
  | { kind: 'denied' }
  | { kind: 'code'; code: string; scope?: string };

/**
 * Classify a request to the OAuth loopback server. The CSRF `state` is
 * checked on EVERY branch — including `?error=` — so another local page
 * can't cancel (or complete) a pending connect.
 */
export function checkOAuthCallback(requestUrl: string | undefined, expectedState: string | null): OAuthCallbackCheck {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl || '/', 'http://127.0.0.1');
  } catch {
    return { kind: 'not-found' };
  }
  if (parsed.pathname !== '/callback') return { kind: 'not-found' };
  const state = parsed.searchParams.get('state');
  if (!expectedState || !state || state !== expectedState) return { kind: 'bad-state' };
  if (parsed.searchParams.get('error')) return { kind: 'denied' };
  const code = parsed.searchParams.get('code');
  if (!code) return { kind: 'bad-state' };
  const scope = parsed.searchParams.get('scope') ?? undefined;
  return { kind: 'code', code, scope };
}

/** Name for a corrupt credential store moved aside (kept, never overwritten). */
export function corruptStoreBackupName(fileName: string, now: Date = new Date()): string {
  return `${fileName}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`;
}
