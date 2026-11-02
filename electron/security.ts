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
 *  - v1.0.9: every request on the default session (the window's and any
 *    other) must pass one allow-list (`isAllowedRendererRequestUrl`). The
 *    synced-folder backup rules (snapshot validation, pruning, temp-file
 *    sweep) live here too, so they can be unit-tested.
 *  - v1.0.9: update checks and downloads never carry electron-updater's
 *    per-install ID (`filterUpdaterRequestHeaders`).
 */

/** GitHub releases page (manual updates on macOS, release notes). */
export const RELEASES_URL = 'https://github.com/LetsLearntocodeforfun/Apollo-Running/releases';

const RELEASES_PATH = '/LetsLearntocodeforfun/Apollo-Running/releases';

/**
 * Domains (and their subdomains) whose https pages may be opened in the OS
 * browser. v1.0.7 (PX-11): besides activity platforms, this covers every
 * official site the app links to — World Marathon Majors race websites and
 * the coaches' official plans, books and apps — which v1.0.6 silently
 * blocked. src/__tests__/externalLinks.test.ts fails if an in-app link is
 * missing here.
 */
export const EXTERNAL_DOMAIN_ALLOWLIST: readonly string[] = [
  // Activity platforms and their auth / help pages
  'strava.com',
  'intervals.icu',
  'connect.garmin.com',
  // World Marathon Majors official websites (src/data/worldMajors.ts)
  'marathon.tokyo',
  'baa.org',
  'tcslondonmarathon.com',
  'bmw-berlin-marathon.com',
  'chicagomarathon.com',
  'nyrr.org',
  // Official coach sources linked from plans (src/data/plans.ts attribution)
  'halhigdon.com',
  'lukehumphreyrunning.com',
  'humankinetics.com',
  'nike.com',
  'furman.edu',
  'vdoto2.com',
  'jeffgalloway.com',
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
  } catch {
    /* keep encoded form */
  }
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
    } catch {
      /* malformed dev origin — fall through */
    }
  }
  if (trusted.indexUrl && parsed.protocol === 'file:') {
    try {
      const index = new URL(trusted.indexUrl);
      const ci = !!trusted.caseInsensitivePaths;
      return (
        index.protocol === 'file:' &&
        parsed.host.toLowerCase() === index.host.toLowerCase() &&
        normalizedFilePath(parsed, ci) === normalizedFilePath(index, ci)
      );
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
export function isAllowedTopLevelNavigation(
  raw: unknown,
  isSameDocument: boolean,
  trusted: TrustedAppLocation,
): boolean {
  if (isSameDocument) return true;
  return isTrustedAppUrl(raw, trusted);
}

/**
 * Sub-frame navigation policy: generated content (blob:, data:, about:blank,
 * about:srcdoc), same-document navigations, or the app itself. Remote pages
 * are never framed.
 */
export function isAllowedSubframeNavigation(
  raw: unknown,
  isSameDocument: boolean,
  trusted: TrustedAppLocation,
): boolean {
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

/** HTTPS origins the renderer itself may contact directly via fetch (opt-in syncs only). */
const RENDERER_HTTPS_HOST_ALLOWLIST: ReadonlySet<string> = new Set(['intervals.icu', 'www.strava.com']);

/**
 * Percent-encoded `/`, `\` or NUL in a `file:` URL path. The app's own asset
 * URLs never contain them, and once decoded they could smuggle `../` or `..\`
 * past the bundle-prefix check, so such requests are refused outright.
 */
const ENCODED_PATH_HAZARD_RE = /%(?:2f|5c|00)/i;

/**
 * Electron `session.defaultSession.webRequest.onBeforeRequest` policy for every
 * request on the default session: the app window's, and non-renderer requests
 * too (v1.0.9: they no longer get a separate allow-list). electron-updater is
 * not affected either way: it makes its requests on its own session
 * (partition `electron-updater`), which this filter never sees.
 *  - `blob:` and `data:` (print frames, CSV/JSON/ICS downloads, inline assets)
 *  - `devtools:` ONLY when `opts.allowDevTools` is true
 *  - `http:` / `https:` / `ws:` / `wss:` to `trusted.devServerOrigin` ONLY in dev
 *  - `file:` strictly inside the directory tree containing `trusted.indexUrl`
 *    (prevents `file://` local filesystem probing outside the app bundle).
 *    Paths with encoded `/`, `\` or NUL, malformed escapes, or `.` / `..`
 *    segments are refused rather than decoded and prefix-matched. The rules
 *    are platform-independent (Windows drive letters and UNC hosts included).
 *  - `https://intervals.icu` and `https://www.strava.com` (standard port, no URL credentials)
 *  - Everything else is cancelled before it leaves the app.
 */
export function isAllowedRendererRequestUrl(
  raw: unknown,
  trusted: TrustedAppLocation,
  opts: { allowDevTools?: boolean } = {},
): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  if (raw.startsWith('data:') || raw.startsWith('blob:')) {
    try {
      const p = new URL(raw);
      return p.protocol === 'data:' || p.protocol === 'blob:';
    } catch {
      return false;
    }
  }
  if (raw.length > 4096) return false;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol === 'devtools:') {
    return opts.allowDevTools === true;
  }

  if (
    trusted.devServerOrigin &&
    (parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'ws:' ||
      parsed.protocol === 'wss:')
  ) {
    try {
      const dev = new URL(trusted.devServerOrigin);
      if (parsed.host.toLowerCase() === dev.host.toLowerCase()) return true;
    } catch {
      /* malformed dev origin — fall through */
    }
  }

  if (trusted.indexUrl && parsed.protocol === 'file:') {
    try {
      const index = new URL(trusted.indexUrl);
      if (index.protocol !== 'file:' || parsed.host.toLowerCase() !== index.host.toLowerCase()) {
        return false;
      }
      if (ENCODED_PATH_HAZARD_RE.test(parsed.pathname)) return false;
      // decodeURIComponent throws on a malformed escape: refused by the catch below.
      const decoded = decodeURIComponent(parsed.pathname);
      if (decoded.includes('\0') || decoded.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) {
        return false;
      }
      const ci = !!trusted.caseInsensitivePaths;
      const indexPath = normalizedFilePath(index, ci);
      const reqPath = ci ? decoded.toLowerCase() : decoded;
      const lastSlash = indexPath.lastIndexOf('/');
      if (lastSlash < 0) return false;
      const bundleDir = indexPath.slice(0, lastSlash + 1);
      return reqPath.startsWith(bundleDir) && reqPath.length > bundleDir.length;
    } catch {
      return false;
    }
  }

  if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port) {
    return RENDERER_HTTPS_HOST_ALLOWLIST.has(parsed.hostname.toLowerCase());
  }

  return false;
}

/** Blocked requests logged one by one per app run; after that, a single summary line. */
export const BLOCKED_REQUEST_LOG_LIMIT = 20;

/** Longest URL text written to the log for one blocked request. */
const MAX_LOGGED_URL_CHARS = 200;

/**
 * A blocked request's URL as log text: scheme, host and path only. Credentials,
 * query and fragment (which can carry tokens) are left out, opaque URLs
 * (`data:`, `javascript:` …) are reduced to their scheme and length, and the
 * result is capped at 200 characters. The URL parser percent-encodes control
 * characters, so the text can't break the log line.
 */
export function describeUrlForLog(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '(no URL)';
  let text: string;
  try {
    const u = new URL(raw);
    text =
      u.host || u.protocol === 'file:'
        ? `${u.protocol}//${u.host}${u.pathname}`
        : `${u.protocol} (${raw.length} characters)`;
  } catch {
    return '(unparseable URL)';
  }
  return text.length > MAX_LOGGED_URL_CHARS ? `${text.slice(0, MAX_LOGGED_URL_CHARS)}…` : text;
}

/**
 * Reporter for requests cancelled by the session filter. It passes the first
 * `limit` to `warn` one by one (see {@link describeUrlForLog}), then one
 * summary line, then stays quiet until the app restarts. That is enough to
 * diagnose a feature the filter breaks in the field, without flooding the log.
 */
export function createBlockedRequestReporter(
  warn: (message: string) => void,
  limit: number = BLOCKED_REQUEST_LOG_LIMIT,
): (url: unknown, fromRenderer: boolean) => void {
  let count = 0;
  return (url, fromRenderer) => {
    count += 1;
    if (count <= limit) {
      warn(`[Apollo] Blocked a ${fromRenderer ? 'renderer' : 'non-renderer'} request: ${describeUrlForLog(url)}`);
    } else if (count === limit + 1) {
      warn(`[Apollo] More requests were blocked; only the first ${limit} are logged until Apollo restarts.`);
    }
  };
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
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return { autoCheck: rec.autoCheck === true, autoDownload: rec.autoDownload === true };
}

/** Result of checking a Strava OAuth loopback callback. */
export type OAuthCallbackCheck =
  { kind: 'not-found' } | { kind: 'bad-state' } | { kind: 'denied' } | { kind: 'code'; code: string; scope?: string };

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

// ── Synced-Folder Auto-Backups (Epic 2C) ──────────────────────────────────────

export const BACKUP_SNAPSHOT_PREFIX = 'apollo-auto-backup-';
export const BACKUP_SNAPSHOT_SUFFIX = '.json.gz';
export const MAX_BACKUP_SNAPSHOT_CHARS = 64 * 1024 * 1024;
const MAX_SNAPSHOT_KEY_LENGTH = 128;

const MANAGED_BACKUP_SNAPSHOT_RE =
  /^apollo-auto-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3}))?\.json\.gz$/;
/** Temp file of a snapshot write (electron/main.ts): `<managed name>.<pid>.<ms>.<8 hex>.tmp`. */
const SNAPSHOT_TEMP_FILE_RE =
  /^(apollo-auto-backup-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d{3})?\.json\.gz)\.\d{1,10}\.(\d{1,16})\.[0-9a-f]{8}\.tmp$/;
const SNAPSHOT_CHECKSUM_RE = /^[0-9a-f]{8,128}$/i;

const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Credentials: never in a snapshot. Must match CREDENTIAL_KEYS in
 * src/services/db/persistence.ts (src/__tests__/backupSnapshotContract.test.ts).
 */
export const SNAPSHOT_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'strava_tokens',
  'strava_credentials',
  'garmin_tokens',
  'garmin_credentials',
  'garmin_personal_api',
  'intervals_credentials',
]);

/**
 * Device/session state: never in a snapshot. Must match DEVICE_STATE_KEYS in
 * src/services/dataManager.ts (src/__tests__/backupSnapshotContract.test.ts).
 */
export const SNAPSHOT_DEVICE_STATE_KEYS: ReadonlySet<string> = new Set([
  'apollo_last_integrity_check',
  'apollo_needs_reconnect',
  'apollo_storage_persist_requested',
]);

/**
 * The only metadata fields a snapshot may have: BackupMetadata
 * (src/services/dataManager.ts) plus the `checksum` that backupService.ts
 * embeds. Unknown fields are rejected, not dropped: import verifies the
 * checksum over the metadata (minus checksum) and the data, so silently
 * dropping a field would make a good snapshot fail verification.
 */
export const SNAPSHOT_METADATA_KEYS: ReadonlySet<string> = new Set([
  'exportDate',
  'appName',
  'version',
  'keyCount',
  'purpose',
  'checksum',
]);

/** Metadata the renderer always writes (exportAllData); only `checksum` may be absent. */
const REQUIRED_SNAPSHOT_METADATA_KEYS: readonly string[] = ['exportDate', 'appName', 'version', 'keyCount', 'purpose'];

/** `ExportPurpose` values (src/services/dataManager.ts). */
export const SNAPSHOT_EXPORT_PURPOSES: ReadonlySet<string> = new Set(['backup', 'export']);

const MAX_SNAPSHOT_EXPORT_DATE_CHARS = 64;
const MAX_SNAPSHOT_VERSION_CHARS = 32;
const MAX_SNAPSHOT_PURPOSE_CHARS = 32;

/** Snapshots dated more than this far after "now" are never pruned or counted (see selectSnapshotsToPrune). */
export const SNAPSHOT_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Apollo's own snapshot temp files are swept once older than this (see isOwnStaleSnapshotTempFile). */
export const STALE_SNAPSHOT_TEMP_AGE_MS = 60 * 60 * 1000;

/**
 * Main-process filename for a compressed auto-backup snapshot:
 * `apollo-auto-backup-YYYY-MM-DD-HHmmss-SSS.json.gz` (UTC).
 */
export function formatBackupSnapshotName(now: Date = new Date()): string {
  const t = Number.isFinite(now.getTime()) ? now : new Date();
  const yyyy = String(t.getUTCFullYear()).padStart(4, '0');
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const min = String(t.getUTCMinutes()).padStart(2, '0');
  const ss = String(t.getUTCSeconds()).padStart(2, '0');
  const sss = String(t.getUTCMilliseconds()).padStart(3, '0');
  return `${BACKUP_SNAPSHOT_PREFIX}${yyyy}-${mm}-${dd}-${hh}${min}${ss}-${sss}${BACKUP_SNAPSHOT_SUFFIX}`;
}

/**
 * True ONLY for filenames created by Apollo's synced-folder backup rotation.
 * Rejects path separators, `..`, temp files, manual exports, and user files so
 * retention pruning can never delete anything Apollo did not create.
 */
export function isManagedBackupSnapshotName(name: unknown): boolean {
  return typeof name === 'string' && MANAGED_BACKUP_SNAPSHOT_RE.test(name);
}

/**
 * True when `dirPath` must be rejected as a synced backup folder:
 * non-strings, empty/whitespace, NUL bytes, `..` traversal segments, relative
 * paths, or filesystem/UNC share roots (`/`, `C:\`, `C:/`, `\\server\share\`).
 */
export function isDisallowedBackupDirectory(dirPath: unknown): boolean {
  if (typeof dirPath !== 'string') return true;
  if (dirPath.includes('\0') || !dirPath.trim()) return true;
  if (/(?:^|[\\/])\.\.(?:$|[\\/])/.test(dirPath)) return true;

  // Windows UNC path: \\server\share\subfolder...
  if (dirPath.startsWith('\\\\')) {
    const uncMatch = /^\\\\[^\\/]+\\[^\\/]+\\+(.+)$/.exec(dirPath);
    if (!uncMatch) return true;
    const sub = uncMatch[1].replace(/[\\/]+$/, '').trim();
    return sub.length === 0;
  }

  // Windows drive-letter path: C:\subfolder... or C:/subfolder...
  if (/^[A-Za-z]:[\\/]/.test(dirPath)) {
    const rest = dirPath
      .slice(2)
      .replace(/^[\\/]+/, '')
      .replace(/[\\/]+$/, '')
      .trim();
    return rest.length === 0;
  }

  // POSIX absolute path: /subfolder... (reject `//...` network-like prefixes and `/`)
  if (dirPath.startsWith('/') && !dirPath.startsWith('//')) {
    const rest = dirPath.replace(/^\/+/, '').replace(/\/+$/, '').trim();
    return rest.length === 0;
  }

  // Relative or unrecognized path
  return true;
}

/** Clamp synced-folder snapshot retention count to an integer in `[3, 50]`. */
export function clampBackupFolderRetention(raw: unknown, fallback: number = 10): number {
  const safeFallback =
    typeof fallback === 'number' && Number.isFinite(fallback) ? Math.min(50, Math.max(3, Math.trunc(fallback))) : 10;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return safeFallback;
  return Math.min(50, Math.max(3, Math.trunc(raw)));
}

export type BackupSnapshotValidation =
  | { ok: true; json: string; error?: undefined; reason?: undefined }
  | { ok: false; error: string; reason: 'empty' | 'invalid'; json?: undefined };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isShortString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length <= maxChars;
}

/** A field or key name for an error message: JSON-quoted (no control characters) and cut to 64 characters. */
function quoteName(name: string): string {
  return JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}…` : name);
}

/**
 * True for data keys a snapshot must not contain: anything but `apollo_` keys
 * of at most 128 characters, credentials, device state, in-app backups
 * (`apollo_backup_*`), quarantined copies (`apollo_quarantine_*`), caches
 * (`*_cache`) and prototype keys. The same keys the renderer never exports
 * (dataManager.isExcludedFromExport); src/__tests__/backupSnapshotContract.test.ts
 * keeps the two in step.
 */
export function isDisallowedSnapshotKey(key: string): boolean {
  return (
    FORBIDDEN_OBJECT_KEYS.has(key) ||
    SNAPSHOT_CREDENTIAL_KEYS.has(key) ||
    SNAPSHOT_DEVICE_STATE_KEYS.has(key) ||
    !key.startsWith('apollo_') ||
    key.length > MAX_SNAPSHOT_KEY_LENGTH ||
    key.startsWith('apollo_backup_') ||
    key.startsWith('apollo_quarantine_') ||
    key.endsWith('_cache')
  );
}

/** Why one metadata field is unacceptable, or null when it is fine. */
function snapshotMetadataProblem(key: string, value: unknown, dataEntryCount: number): string | null {
  switch (key) {
    case 'exportDate':
      return isShortString(value, MAX_SNAPSHOT_EXPORT_DATE_CHARS) ? null : 'Backup snapshot exportDate is malformed.';
    case 'appName':
      return value === 'Apollo Running' ? null : 'Backup snapshot is not from Apollo Running.';
    case 'version':
      return isShortString(value, MAX_SNAPSHOT_VERSION_CHARS) ? null : 'Backup snapshot version is malformed.';
    case 'keyCount':
      return typeof value === 'number' && Number.isInteger(value) && value === dataEntryCount
        ? null
        : 'Backup snapshot keyCount does not match data.';
    case 'purpose':
      return isShortString(value, MAX_SNAPSHOT_PURPOSE_CHARS) && SNAPSHOT_EXPORT_PURPOSES.has(value)
        ? null
        : 'Backup snapshot purpose is malformed.';
    case 'checksum':
      return typeof value === 'string' && SNAPSHOT_CHECKSUM_RE.test(value)
        ? null
        : 'Backup snapshot checksum is malformed.';
    default:
      return `Backup snapshot metadata has an unexpected field ${quoteName(key)}.`;
  }
}

/**
 * Validate a backup snapshot JSON string from the renderer before compressing
 * and writing it to the user's synced folder.
 *
 * The JSON returned is rebuilt from validated parts, never the renderer's raw
 * string:
 *  - the root has exactly `metadata` and `data`;
 *  - metadata has only SNAPSHOT_METADATA_KEYS: exportDate (≤ 64 chars),
 *    appName ('Apollo Running'), version (≤ 32 chars), keyCount (the number
 *    of data entries), purpose (an ExportPurpose) and an optional hex
 *    checksum. Unknown fields are rejected (see SNAPSHOT_METADATA_KEYS);
 *  - data has at least one entry, each an allowed key
 *    ({@link isDisallowedSnapshotKey}) with a string value.
 * Key order is preserved, so a snapshot built by the renderer (backupService.ts)
 * comes back byte-for-byte identical and its checksum still verifies on import.
 * `reason: 'empty'` means there was simply no data to back up yet.
 */
export function validateBackupSnapshotPayload(raw: unknown): BackupSnapshotValidation {
  const invalid = (error: string): BackupSnapshotValidation => ({ ok: false, error, reason: 'invalid' });
  if (typeof raw !== 'string' || raw.length === 0) {
    return invalid('Backup snapshot payload must be a non-empty JSON string.');
  }
  if (raw.length > MAX_BACKUP_SNAPSHOT_CHARS) {
    return invalid('Backup snapshot payload exceeds the maximum allowed size.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('Backup snapshot payload is not valid JSON.');
  }
  if (!isPlainRecord(parsed)) {
    return invalid('Backup snapshot payload must be a JSON object.');
  }

  const rootKeys = Object.keys(parsed);
  const unexpectedRootKey = rootKeys.find((key) => key !== 'metadata' && key !== 'data');
  if (unexpectedRootKey !== undefined) {
    return invalid(`Backup snapshot has an unexpected top-level field ${quoteName(unexpectedRootKey)}.`);
  }
  const { metadata, data } = parsed;
  if (!isPlainRecord(metadata)) {
    return invalid('Backup snapshot metadata is missing.');
  }
  if (!isPlainRecord(data)) {
    return invalid('Backup snapshot data must be a plain object.');
  }

  const dataEntries = Object.entries(data);
  const cleanMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const problem = snapshotMetadataProblem(key, value, dataEntries.length);
    if (problem) return invalid(problem);
    cleanMetadata[key] = value;
  }
  const missing = REQUIRED_SNAPSHOT_METADATA_KEYS.find(
    (key) => !Object.prototype.hasOwnProperty.call(cleanMetadata, key),
  );
  if (missing !== undefined) {
    return invalid(`Backup snapshot metadata is missing ${quoteName(missing)}.`);
  }
  if (dataEntries.length === 0) {
    return { ok: false, error: 'Backup snapshot has no Apollo data to back up.', reason: 'empty' };
  }

  const cleanData: Record<string, string> = {};
  for (const [key, value] of dataEntries) {
    if (isDisallowedSnapshotKey(key)) {
      return invalid(`Backup snapshot contains disallowed key ${quoteName(key)}.`);
    }
    if (typeof value !== 'string') {
      return invalid(`Backup snapshot value for ${quoteName(key)} must be a string.`);
    }
    cleanData[key] = value;
  }

  const rebuilt: Record<string, unknown> = {};
  for (const key of rootKeys) rebuilt[key] = key === 'metadata' ? cleanMetadata : cleanData;
  return { ok: true, json: JSON.stringify(rebuilt) };
}

/**
 * UTC time (ms since the epoch) embedded in a managed snapshot name, or null
 * when the name isn't one or its date doesn't exist (Feb 30, hour 24, second
 * 60, or a year below 100, which Date.UTC would move to the 1900s).
 */
export function parseBackupSnapshotTime(name: unknown): number | null {
  if (typeof name !== 'string') return null;
  const match = MANAGED_BACKUP_SNAPSHOT_RE.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second, millis] = match.slice(1).map((part) => Number(part ?? 0));
  const time = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const date = new Date(time);
  const exact =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return exact ? time : null;
}

function toEpochMs(now: Date | number): number {
  return typeof now === 'number' ? now : now.getTime();
}

/**
 * Names of Apollo's own synced-folder snapshots to delete so that at most
 * `maxFiles` (clamped to [3, 50]) remain, counting the snapshot just written.
 * Oldest first, by the UTC time in the name.
 *  - Only managed names with a valid embedded time are considered: user files,
 *    manual exports and temp files are never selected.
 *  - `justWrittenName` is never selected and always keeps its slot, even when
 *    a clock change makes it look older than the rest (or a directory listing
 *    doesn't show it yet).
 *  - Names dated more than 24 h after `now` (SNAPSHOT_FUTURE_TOLERANCE_MS) are
 *    neither deleted nor counted, so a clock that is or was wrong on this or
 *    another device can't push out the snapshots that are really newest.
 *  - Returns [] when `now` is not a valid time: when in doubt, delete nothing.
 */
export function selectSnapshotsToPrune(
  names: readonly string[],
  justWrittenName: string,
  maxFiles: number,
  now: Date | number = Date.now(),
): string[] {
  const nowMs = toEpochMs(now);
  if (!Number.isFinite(nowMs)) return [];
  const othersToKeep = clampBackupFolderRetention(maxFiles) - 1; // one slot belongs to the snapshot just written
  const seen = new Set<string>([justWrittenName]);
  const candidates: { name: string; time: number }[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const time = parseBackupSnapshotTime(name);
    if (time === null || time - nowMs > SNAPSHOT_FUTURE_TOLERANCE_MS) continue;
    candidates.push({ name, time });
  }
  if (candidates.length <= othersToKeep) return [];
  candidates.sort((a, b) => a.time - b.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return candidates.slice(0, candidates.length - othersToKeep).map((c) => c.name);
}

/**
 * True for a temp file left behind by one of Apollo's own interrupted snapshot
 * writes (`<managed snapshot name>.<pid>.<ms>.<8 lowercase hex>.tmp`, exactly
 * as electron/main.ts names them) when both its modification time and the
 * creation time in its name are more than an hour (STALE_SNAPSHOT_TEMP_AGE_MS)
 * before `now`. Requiring both keeps a write that is still in progress safe
 * even when the folder reports odd modification times (FAT/exFAT drives store
 * local time). Anything else is left alone: other apps' temp files, a time in
 * the future, an invalid `now`.
 */
export function isOwnStaleSnapshotTempFile(name: unknown, mtimeMs: number, now: Date | number = Date.now()): boolean {
  if (typeof name !== 'string') return false;
  const match = SNAPSHOT_TEMP_FILE_RE.exec(name);
  if (!match || parseBackupSnapshotTime(match[1]) === null) return false;
  const nowMs = toEpochMs(now);
  const createdMs = Number(match[2]);
  return (
    Number.isFinite(nowMs) &&
    Number.isFinite(mtimeMs) &&
    nowMs - mtimeMs > STALE_SNAPSHOT_TEMP_AGE_MS &&
    nowMs - createdMs > STALE_SNAPSHOT_TEMP_AGE_MS
  );
}

// ── Update checks (electron-updater) ──────────────────────────────────────────

/**
 * Request headers that would identify this installation to the update server,
 * in lower case. electron-updater 6.x adds `x-user-staging-id`, a random ID it
 * creates once and keeps in userData/.updaterId, to every update check
 * (AppUpdater.getUpdateInfoAndProvider).
 */
export const UPDATER_TRACKING_HEADERS: ReadonlySet<string> = new Set(['x-user-staging-id']);

/**
 * `headers` without the update library's per-install ID (UPDATER_TRACKING_HEADERS,
 * matched in any letter case). Every other header is kept, unchanged and in
 * order, and the input is not modified. Anything that isn't a headers object
 * yields `{}`.
 */
export function stripUpdaterTrackingHeaders<V>(
  headers: Readonly<Record<string, V>> | null | undefined,
): Record<string, V> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !UPDATER_TRACKING_HEADERS.has(name.toLowerCase())),
  );
}

/** The part of Electron's `onBeforeSendHeaders` details this module reads. */
export interface BeforeSendHeadersDetails {
  requestHeaders?: Record<string, string>;
}

/** Electron's `onBeforeSendHeaders` answer (BeforeSendResponse). */
export interface BeforeSendHeadersResponse {
  cancel?: boolean;
  requestHeaders?: Record<string, string | string[]>;
}

/**
 * `webRequest.onBeforeSendHeaders` listener for electron-updater's session
 * (electron/main.ts). It answers every request exactly once, so update checks
 * and downloads never stall, and always with the per-install ID removed
 * ({@link stripUpdaterTrackingHeaders}). Electron always passes the request's
 * headers; if they ever can't be read, the request is cancelled rather than
 * sent as it is.
 */
export function filterUpdaterRequestHeaders(
  details: BeforeSendHeadersDetails,
  callback: (response: BeforeSendHeadersResponse) => void,
): void {
  let response: BeforeSendHeadersResponse = { cancel: true };
  try {
    const headers = details?.requestHeaders;
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      response = { requestHeaders: stripUpdaterTrackingHeaders(headers) };
    }
  } catch {
    /* unreadable headers: cancel (below) rather than risk sending the ID */
  }
  callback(response);
}
