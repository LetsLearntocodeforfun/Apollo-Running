/**
 * Tests for the Garmin Connect Personal API request policy used by the
 * Electron main process (electron/garminProxy.ts, v1.0.8 DS-01): the renderer
 * may only reach a fixed https origin, with GET requests to an allow-list of
 * read endpoints and a checked, encoded query.
 */

import { describe, it, expect } from 'vitest';
import {
  GARMIN_MAX_TOKEN_LENGTH,
  GARMIN_PERSONAL_API_ORIGIN,
  buildGarminApiUrl,
  encodeGarminQuery,
  garminAcceptHeader,
  isAllowedGarminPath,
  parseGarminAccept,
  parseGarminTokenBody,
  parseRetryAfter,
} from '../../electron/garminProxy';

const LIST = '/activitylist-service/activities/search/activities';
const PROFILE = '/userprofile-service/userprofile/settings';

describe('Garmin path allow-list', () => {
  it('allows the read endpoints Apollo uses', () => {
    expect(isAllowedGarminPath(LIST)).toBe(true);
    expect(isAllowedGarminPath(PROFILE)).toBe(true);
    expect(isAllowedGarminPath('/activity-service/activity/21345678901')).toBe(true);
    expect(isAllowedGarminPath('/download-service/files/activity/21345678901')).toBe(true);
  });

  it('rejects traversal, extra segments, queries, fragments and look-alikes', () => {
    expect(isAllowedGarminPath('/activity-service/activity/1/../../userprofile-service')).toBe(false);
    expect(isAllowedGarminPath('/activity-service/activity/1/details')).toBe(false);
    expect(isAllowedGarminPath('/activity-service/activity/1?x=1')).toBe(false);
    expect(isAllowedGarminPath('/activity-service/activity/1#frag')).toBe(false);
    expect(isAllowedGarminPath(`${LIST}/`)).toBe(false);
    expect(isAllowedGarminPath(`${PROFILE}\n`)).toBe(false);
    expect(isAllowedGarminPath('/activity-service/activity/%2e%2e')).toBe(false);
    expect(isAllowedGarminPath('/ACTIVITY-SERVICE/activity/1')).toBe(false);
    expect(isAllowedGarminPath('/wellness-service/wellness/dailySummary')).toBe(false);
  });

  it('rejects other hosts and schemes', () => {
    expect(isAllowedGarminPath(`https://evil.example${PROFILE}`)).toBe(false);
    expect(isAllowedGarminPath(`//evil.example${PROFILE}`)).toBe(false);
    expect(isAllowedGarminPath(`${GARMIN_PERSONAL_API_ORIGIN}${PROFILE}`)).toBe(false);
    expect(isAllowedGarminPath(`file://${PROFILE}`)).toBe(false);
  });

  it('accepts only plain decimal activity IDs (no zero, leading zero, sign or > 19 digits)', () => {
    expect(isAllowedGarminPath('/activity-service/activity/0')).toBe(false);
    expect(isAllowedGarminPath('/activity-service/activity/0123')).toBe(false);
    expect(isAllowedGarminPath('/activity-service/activity/-1')).toBe(false);
    expect(isAllowedGarminPath('/activity-service/activity/1e9')).toBe(false);
    expect(isAllowedGarminPath('/activity-service/activity/12345678901234567890')).toBe(false);
    expect(isAllowedGarminPath('/activity-service/activity/1234567890123456789')).toBe(true);
  });

  it('rejects non-strings, empty and over-long paths', () => {
    expect(isAllowedGarminPath(undefined)).toBe(false);
    expect(isAllowedGarminPath(null)).toBe(false);
    expect(isAllowedGarminPath(42)).toBe(false);
    expect(isAllowedGarminPath({ toString: () => PROFILE })).toBe(false);
    expect(isAllowedGarminPath('')).toBe(false);
    expect(isAllowedGarminPath(`${PROFILE}${'/a'.repeat(200)}`)).toBe(false);
  });
});

describe('Garmin query encoding', () => {
  it('treats undefined / null as no query', () => {
    expect(encodeGarminQuery(undefined)).toBe('');
    expect(encodeGarminQuery(null)).toBe('');
    expect(encodeGarminQuery({})).toBe('');
  });

  it('encodes strings, finite numbers and booleans', () => {
    expect(
      encodeGarminQuery({
        start: 40,
        limit: 40,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        excludeChildren: false,
      }),
    ).toBe('start=40&limit=40&startDate=2026-01-01&endDate=2026-12-31&excludeChildren=false');
  });

  it('escapes characters that could add parameters', () => {
    expect(encodeGarminQuery({ q: 'a&b=c d' })).toBe('q=a%26b%3Dc+d');
  });

  it('rejects arrays, non-objects and too many keys', () => {
    expect(encodeGarminQuery(['a'])).toBeNull();
    expect(encodeGarminQuery('start=0')).toBeNull();
    expect(encodeGarminQuery(5)).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(encodeGarminQuery(many)).toBeNull();
  });

  it('rejects odd keys', () => {
    expect(encodeGarminQuery({ 'start-date': '1' })).toBeNull();
    expect(encodeGarminQuery({ __proto__x: '1' })).toBeNull();
    expect(encodeGarminQuery({ '1start': '1' })).toBeNull();
    expect(encodeGarminQuery({ ['k'.repeat(41)]: '1' })).toBeNull();
  });

  it('rejects unsupported, non-finite, long or non-printable values', () => {
    expect(encodeGarminQuery({ a: { b: 1 } })).toBeNull();
    expect(encodeGarminQuery({ a: null })).toBeNull();
    expect(encodeGarminQuery({ a: Number.NaN })).toBeNull();
    expect(encodeGarminQuery({ a: Number.POSITIVE_INFINITY })).toBeNull();
    expect(encodeGarminQuery({ a: 'x'.repeat(65) })).toBeNull();
    expect(encodeGarminQuery({ a: 'line\r\nX-Injected: 1' })).toBeNull();
    expect(encodeGarminQuery({ a: 'caf\u00e9' })).toBeNull();
  });
});

describe('Garmin request URL', () => {
  it('always uses the fixed https origin', () => {
    expect(buildGarminApiUrl(PROFILE)).toBe(`${GARMIN_PERSONAL_API_ORIGIN}${PROFILE}`);
    expect(buildGarminApiUrl(LIST, { start: 0, limit: 40 })).toBe(
      `${GARMIN_PERSONAL_API_ORIGIN}${LIST}?start=0&limit=40`,
    );
    expect(GARMIN_PERSONAL_API_ORIGIN.startsWith('https://')).toBe(true);
  });

  it('returns null when the path or query is not allowed', () => {
    expect(buildGarminApiUrl('/not/allowed')).toBeNull();
    expect(buildGarminApiUrl(LIST, { a: 'line\nbreak' })).toBeNull();
    expect(buildGarminApiUrl(LIST, ['x'])).toBeNull();
  });
});

describe('Garmin accept kinds', () => {
  it("is 'file' only when asked for exactly that", () => {
    expect(parseGarminAccept('file')).toBe('file');
    expect(parseGarminAccept('json')).toBe('json');
    expect(parseGarminAccept('FILE')).toBe('json');
    expect(parseGarminAccept(undefined)).toBe('json');
    expect(parseGarminAccept({})).toBe('json');
  });

  it('sends matching Accept headers', () => {
    expect(garminAcceptHeader('json')).toBe('application/json');
    expect(garminAcceptHeader('file')).toContain('application/zip');
  });
});

describe('Garmin token reply', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE4MDAwMDAwMDB9.c2lnbmF0dXJl';

  it('accepts a JWT-shaped body, trimmed', () => {
    expect(parseGarminTokenBody(jwt)).toBe(jwt);
    expect(parseGarminTokenBody(`  ${jwt}\n`)).toBe(jwt);
    expect(parseGarminTokenBody('eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.')).toBe('eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.');
  });

  it('rejects HTML, JSON, empty, non-string and over-long bodies', () => {
    expect(parseGarminTokenBody('<html><body>Error</body></html>')).toBeNull();
    expect(parseGarminTokenBody('{"error":"Unauthorized"}')).toBeNull();
    expect(parseGarminTokenBody('')).toBeNull();
    expect(parseGarminTokenBody('   ')).toBeNull();
    expect(parseGarminTokenBody(undefined)).toBeNull();
    expect(parseGarminTokenBody(42)).toBeNull();
    expect(parseGarminTokenBody(`a.${'b'.repeat(GARMIN_MAX_TOKEN_LENGTH)}.c`)).toBeNull();
    expect(parseGarminTokenBody(`${jwt}\nX-Injected: 1`)).toBeNull();
  });
});

describe('Retry-After', () => {
  it('reads delta-seconds, rounded and clamped to 0–300', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter(' 1.6 ')).toBe(2);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('86400')).toBe(300);
  });

  it('ignores absent, negative and HTTP-date values', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
  });
});
