/**
 * Garmin Connect Personal API: request policy for the Electron main process
 * (v1.0.8, DS-01).
 *
 * Garmin's Personal API (https://personal.connectapi.garmin.com) answers
 * every CORS preflight with 403, whatever the Origin, so the renderer can't
 * call it with `fetch`. The main process makes the requests instead, through
 * two IPC handlers (`garmin:obtain-token`, `garmin:request`). This module
 * holds their pure policy. Like ./security, it has no Electron, Node or DOM
 * imports, so tsconfig.node.json type-checks it and vitest unit-tests it
 * (src/__tests__/garminProxy.test.ts):
 *
 *  - one fixed https origin. The renderer picks a path, never a host.
 *  - GET only, and only the read endpoints Apollo uses (an allow-list of
 *    exact paths with numeric IDs or ISO dates).
 *  - query parameters are plain key/value pairs, checked and encoded here.
 *  - the token endpoint's reply must look like a JWT.
 *
 * Nothing is stored in the main process. The renderer keeps the API key
 * (encrypted at rest; see src/services/storage.ts) and sends it, or a bearer
 * token minted from it, with each call.
 */

/** Garmin Connect Personal API origin (no trailing slash). */
export const GARMIN_PERSONAL_API_ORIGIN = 'https://personal.connectapi.garmin.com';

/** POST here with `Authorization: ApiKey <key>`. The reply body is a bearer JWT (plain text, valid ≤ 24 h). */
export const GARMIN_TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';

/** Garmin's 64-bit activity IDs: decimal, no leading zero. */
const ACTIVITY_ID = '[1-9]\\d{0,18}';

/**
 * Read endpoints the renderer may call. Anchored, so nothing can be appended
 * (no `..`, extra segments, query strings or fragments in the path).
 */
const ALLOWED_PATHS: readonly RegExp[] = [
  // Activity summaries, paginated, filtered by local start date.
  /^\/activitylist-service\/activities\/search\/activities$/,
  // One activity: summary, metadata and split summaries.
  new RegExp(`^/activity-service/activity/${ACTIVITY_ID}$`),
  // The original activity file (a ZIP holding the FIT, GPX or TCX).
  new RegExp(`^/download-service/files/activity/${ACTIVITY_ID}$`),
  // The account's profile settings (display name, user ID).
  /^\/userprofile-service\/userprofile\/settings$/,
];

/** Longest path accepted from the renderer. */
const MAX_PATH_LENGTH = 200;
/** Query parameter names: camelCase identifiers like `startDate`. */
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
/** Query values: short, printable ASCII. Dates, numbers, words and the like. */
const QUERY_VALUE = /^[\x20-\x7e]{0,64}$/;
const MAX_QUERY_PARAMS = 20;

/** JWT: three base64url segments (the signature may be empty for unsigned tokens). */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
/** Longest token accepted from Garmin (real ones are ~1–2 KB). */
export const GARMIN_MAX_TOKEN_LENGTH = 16 * 1024;

/** Largest JSON reply passed to the renderer (a 99-activity page is ~1 MB). */
export const GARMIN_MAX_JSON_BYTES = 16 * 1024 * 1024;
/** Largest original-file download (FIT ZIPs are usually 50 KB–2 MB; ultra runs can reach ~20 MB). */
export const GARMIN_MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Request timeouts: JSON calls and file downloads. */
export const GARMIN_JSON_TIMEOUT_MS = 30_000;
export const GARMIN_FILE_TIMEOUT_MS = 90_000;

/** What the renderer expects back: parsed-as-text JSON, or a binary file (base64). */
export type GarminAccept = 'json' | 'file';

/** True when `path` is one of the allow-listed Personal API read endpoints. */
export function isAllowedGarminPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  return ALLOWED_PATHS.some((re) => re.test(path));
}

/**
 * Encode the renderer's query object, or null when any part of it is not
 * allowed (wrong type, odd key, long or non-printable value, too many keys).
 * `undefined` / `null` mean "no query".
 */
export function encodeGarminQuery(query: unknown): string | null {
  if (query === undefined || query === null) return '';
  if (typeof query !== 'object' || Array.isArray(query)) return null;
  const entries = Object.entries(query as Record<string, unknown>);
  if (entries.length > MAX_QUERY_PARAMS) return null;
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (!QUERY_KEY.test(key)) return null;
    let text: string;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
    else if (typeof value === 'boolean') text = value ? 'true' : 'false';
    else return null;
    if (!QUERY_VALUE.test(text)) return null;
    params.append(key, text);
  }
  return params.toString();
}

/**
 * Full URL for an allow-listed GET, or null when the path or query isn't
 * allowed. The origin is fixed, so the renderer can't reach another host.
 */
export function buildGarminApiUrl(path: unknown, query?: unknown): string | null {
  if (!isAllowedGarminPath(path)) return null;
  const qs = encodeGarminQuery(query);
  if (qs === null) return null;
  return `${GARMIN_PERSONAL_API_ORIGIN}${path}${qs ? `?${qs}` : ''}`;
}

/** `'file'` only when asked for exactly that; anything else is JSON. */
export function parseGarminAccept(value: unknown): GarminAccept {
  return value === 'file' ? 'file' : 'json';
}

/** Accept header for each kind of reply (Garmin's own client sends the same). */
export function garminAcceptHeader(accept: GarminAccept): string {
  return accept === 'file'
    ? 'application/zip, application/x-zip-compressed, application/octet-stream'
    : 'application/json';
}

/**
 * The bearer token from the token endpoint's reply body, or null when the
 * body doesn't look like a JWT (an HTML error page, an empty reply…).
 */
export function parseGarminTokenBody(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  const token = body.trim();
  if (!token || token.length > GARMIN_MAX_TOKEN_LENGTH || !JWT_SHAPE.test(token)) return null;
  return token;
}

/** Seconds from a `Retry-After` header (delta-seconds form), clamped to 0–300; null when absent or a date. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), 300);
}
