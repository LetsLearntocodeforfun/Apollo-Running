/**
 * Tests for the Electron main-process security policy (electron/security.ts):
 * external-link allow-list, navigation / sub-frame rules, trusted IPC sender,
 * permissions, updater-pref validation and the OAuth loopback state check.
 */

import { describe, it, expect } from 'vitest';
import {
  RELEASES_URL,
  checkOAuthCallback,
  corruptStoreBackupName,
  getAllowedExternalUrl,
  isAllowedExternalUrl,
  isAllowedPermission,
  isAllowedSubframeNavigation,
  isAllowedTopLevelNavigation,
  isTrustedAppUrl,
  isTrustedSenderUrl,
  parseUpdaterPrefs,
  type TrustedAppLocation,
} from '../../electron/security';

const PACKAGED: TrustedAppLocation = {
  indexUrl: 'file:///Applications/Apollo.app/Contents/Resources/app.asar/dist/index.html',
  devServerOrigin: null,
};
const DEV: TrustedAppLocation = { indexUrl: null, devServerOrigin: 'http://localhost:5173' };

describe('external URL allow-list', () => {
  it('allows https activity platforms and their subdomains', () => {
    expect(isAllowedExternalUrl('https://www.strava.com/activities/1')).toBe(true);
    expect(isAllowedExternalUrl('https://strava.com/settings/apps')).toBe(true);
    expect(isAllowedExternalUrl('https://intervals.icu/settings')).toBe(true);
    expect(isAllowedExternalUrl('https://forum.intervals.icu/t/1')).toBe(true);
    expect(isAllowedExternalUrl('https://connect.garmin.com/modern')).toBe(true);
  });

  it('allows only this project\'s GitHub releases pages', () => {
    expect(getAllowedExternalUrl(`${RELEASES_URL}/latest`)).toBe(`${RELEASES_URL}/latest`);
    expect(isAllowedExternalUrl(RELEASES_URL)).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/LetsLearntocodeforfun/Apollo-Running')).toBe(false);
    expect(isAllowedExternalUrl('https://github.com/LetsLearntocodeforfun/Apollo-Running/releases-evil')).toBe(false);
    expect(isAllowedExternalUrl('https://github.com/someone/else/releases')).toBe(false);
  });

  it('rejects other schemes, hosts, look-alikes, credentials and ports', () => {
    expect(isAllowedExternalUrl('http://www.strava.com/')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('https://evilstrava.com/')).toBe(false);
    expect(isAllowedExternalUrl('https://strava.com.evil.example/')).toBe(false);
    expect(isAllowedExternalUrl('https://user:pw@www.strava.com/')).toBe(false);
    expect(isAllowedExternalUrl('https://www.strava.com:8443/')).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
    expect(isAllowedExternalUrl(42)).toBe(false);
    expect(isAllowedExternalUrl(`https://www.strava.com/${'a'.repeat(3000)}`)).toBe(false);
  });

  it('returns the normalized href to pass to shell.openExternal', () => {
    expect(getAllowedExternalUrl('https://WWW.STRAVA.COM/a b')).toBe('https://www.strava.com/a%20b');
  });
});

describe('trusted app URL', () => {
  it('accepts the loaded index.html with any hash or query', () => {
    expect(isTrustedAppUrl(PACKAGED.indexUrl, PACKAGED)).toBe(true);
    expect(isTrustedAppUrl(`${PACKAGED.indexUrl}#/training`, PACKAGED)).toBe(true);
    expect(isTrustedAppUrl(`${PACKAGED.indexUrl}?x=1`, PACKAGED)).toBe(true);
  });

  it('rejects other files, remote pages and the dev server in packaged builds', () => {
    expect(isTrustedAppUrl('file:///tmp/evil.html', PACKAGED)).toBe(false);
    expect(isTrustedAppUrl('https://www.strava.com/', PACKAGED)).toBe(false);
    expect(isTrustedAppUrl('http://localhost:5173/', PACKAGED)).toBe(false);
    expect(isTrustedAppUrl('data:text/html,hi', PACKAGED)).toBe(false);
  });

  it('accepts the dev server only in development', () => {
    expect(isTrustedAppUrl('http://localhost:5173/#/plans', DEV)).toBe(true);
    expect(isTrustedAppUrl('http://localhost:5174/', DEV)).toBe(false);
  });

  it('matches Windows paths regardless of encoding and case when asked to', () => {
    const win: TrustedAppLocation = {
      indexUrl: 'file:///C:/Program%20Files/Apollo/resources/app.asar/dist/index.html',
      devServerOrigin: null,
      caseInsensitivePaths: true,
    };
    expect(isTrustedAppUrl('file:///c:/program files/apollo/resources/app.asar/dist/index.html#/', win)).toBe(true);
  });
});

describe('navigation policy', () => {
  it('top level: the app and same-document navigations only', () => {
    expect(isAllowedTopLevelNavigation(`${PACKAGED.indexUrl}#/x`, false, PACKAGED)).toBe(true);
    expect(isAllowedTopLevelNavigation('https://www.strava.com/', false, PACKAGED)).toBe(false);
    expect(isAllowedTopLevelNavigation('blob:file:///abc', false, PACKAGED)).toBe(false);
    expect(isAllowedTopLevelNavigation('https://anything.example/', true, PACKAGED)).toBe(true);
  });

  it('sub-frames: blob/data/about content (print iframes) but never remote pages', () => {
    expect(isAllowedSubframeNavigation('blob:file:///6f1c-uuid', false, PACKAGED)).toBe(true);
    expect(isAllowedSubframeNavigation('blob:null/6f1c-uuid', false, PACKAGED)).toBe(true);
    expect(isAllowedSubframeNavigation('data:text/html,<p>plan</p>', false, PACKAGED)).toBe(true);
    expect(isAllowedSubframeNavigation('about:blank', false, PACKAGED)).toBe(true);
    expect(isAllowedSubframeNavigation('about:srcdoc', false, PACKAGED)).toBe(true);
    expect(isAllowedSubframeNavigation('https://www.strava.com/', false, PACKAGED)).toBe(false);
    expect(isAllowedSubframeNavigation('file:///tmp/evil.html', false, PACKAGED)).toBe(false);
  });
});

describe('IPC sender policy', () => {
  it('serves only the app top frame', () => {
    expect(isTrustedSenderUrl(`${PACKAGED.indexUrl}#/settings`, true, PACKAGED)).toBe(true);
    expect(isTrustedSenderUrl(`${PACKAGED.indexUrl}#/settings`, false, PACKAGED)).toBe(false);
    expect(isTrustedSenderUrl('blob:file:///abc', true, PACKAGED)).toBe(false);
    expect(isTrustedSenderUrl('https://evil.example/', true, PACKAGED)).toBe(false);
    expect(isTrustedSenderUrl(undefined, true, PACKAGED)).toBe(false);
  });
});

describe('permissions', () => {
  it('denies everything except sanitized clipboard writes', () => {
    expect(isAllowedPermission('clipboard-sanitized-write')).toBe(true);
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'fullscreen']) {
      expect(isAllowedPermission(p)).toBe(false);
    }
  });
});

describe('updater preferences', () => {
  it('only literal true enables an option', () => {
    expect(parseUpdaterPrefs({ autoCheck: true, autoDownload: true })).toEqual({ autoCheck: true, autoDownload: true });
    expect(parseUpdaterPrefs({ autoCheck: 'yes', autoDownload: 1 })).toEqual({ autoCheck: false, autoDownload: false });
    expect(parseUpdaterPrefs(null)).toEqual({ autoCheck: false, autoDownload: false });
  });
});

describe('OAuth loopback callback', () => {
  const STATE = 'a'.repeat(64);

  it('accepts a code only with the expected state', () => {
    expect(checkOAuthCallback(`/callback?code=abc&scope=read&state=${STATE}`, STATE))
      .toEqual({ kind: 'code', code: 'abc', scope: 'read' });
    expect(checkOAuthCallback('/callback?code=abc&state=wrong', STATE)).toEqual({ kind: 'bad-state' });
    expect(checkOAuthCallback(`/callback?code=abc&state=${STATE}`, null)).toEqual({ kind: 'bad-state' });
  });

  it('checks the state on the error branch too (no cross-site cancel)', () => {
    expect(checkOAuthCallback('/callback?error=access_denied', STATE)).toEqual({ kind: 'bad-state' });
    expect(checkOAuthCallback(`/callback?error=access_denied&state=${STATE}`, STATE)).toEqual({ kind: 'denied' });
  });

  it('404s anything but /callback', () => {
    expect(checkOAuthCallback('/favicon.ico', STATE)).toEqual({ kind: 'not-found' });
    expect(checkOAuthCallback(undefined, STATE)).toEqual({ kind: 'not-found' });
  });
});

describe('corrupt credential store backup name', () => {
  it('is a sibling name with a filesystem-safe timestamp', () => {
    expect(corruptStoreBackupName('secure-credentials.json', new Date('2026-10-08T12:34:56.789Z')))
      .toBe('secure-credentials.json.corrupt-2026-10-08T12-34-56-789Z');
  });
});
