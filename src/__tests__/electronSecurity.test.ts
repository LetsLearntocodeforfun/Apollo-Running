/**
 * Tests for the Electron main-process security policy (electron/security.ts):
 * external-link allow-list, navigation / sub-frame rules, trusted IPC sender,
 * permissions, updater-pref validation and the OAuth loopback state check.
 * v1.0.9: the session request filter and its `file://` jail, blocked-request
 * logging, the synced-folder backup rules (snapshot validation, pruning,
 * temp-file sweep) and the update-request header filter. The renderer ↔ main
 * snapshot contract is tested in backupSnapshotContract.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOCKED_REQUEST_LOG_LIMIT,
  MAX_BACKUP_SNAPSHOT_CHARS,
  RELEASES_URL,
  SNAPSHOT_FUTURE_TOLERANCE_MS,
  UPDATER_TRACKING_HEADERS,
  checkOAuthCallback,
  clampBackupFolderRetention,
  corruptStoreBackupName,
  createBlockedRequestReporter,
  describeUrlForLog,
  filterUpdaterRequestHeaders,
  formatBackupSnapshotName,
  getAllowedExternalUrl,
  isAllowedExternalUrl,
  isAllowedPermission,
  isAllowedRendererRequestUrl,
  isAllowedSubframeNavigation,
  isAllowedTopLevelNavigation,
  isDisallowedBackupDirectory,
  isManagedBackupSnapshotName,
  isOwnStaleSnapshotTempFile,
  isTrustedAppUrl,
  isTrustedSenderUrl,
  parseBackupSnapshotTime,
  parseUpdaterPrefs,
  selectSnapshotsToPrune,
  stripUpdaterTrackingHeaders,
  validateBackupSnapshotPayload,
  type TrustedAppLocation,
} from '../../electron/security';
import { NETWORK_DESTINATIONS, getNetworkDestinations } from '@/services/networkInventory';
import { importAllData } from '@/services/dataManager';
import { persistence } from '@/services/db/persistence';

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

  it("allows only this project's GitHub releases pages", () => {
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

describe('renderer session webRequest egress & file:// bundle jail', () => {
  it('allows file:// assets strictly inside the app bundle dist/ directory and blocks arbitrary local files', () => {
    expect(
      isAllowedRendererRequestUrl(
        'file:///Applications/Apollo.app/Contents/Resources/app.asar/dist/index.html',
        PACKAGED,
      ),
    ).toBe(true);
    expect(
      isAllowedRendererRequestUrl(
        'file:///Applications/Apollo.app/Contents/Resources/app.asar/dist/assets/index-abc123.js',
        PACKAGED,
      ),
    ).toBe(true);
    expect(
      isAllowedRendererRequestUrl(
        'file:///Applications/Apollo.app/Contents/Resources/app.asar/dist/assets/inter.woff2',
        PACKAGED,
      ),
    ).toBe(true);

    // Blocks local filesystem reads outside dist/ (including `..` traversal)
    expect(isAllowedRendererRequestUrl('file:///etc/passwd', PACKAGED)).toBe(false);
    expect(isAllowedRendererRequestUrl('file:///Users/runner/.ssh/id_rsa', PACKAGED)).toBe(false);
    expect(
      isAllowedRendererRequestUrl(
        'file:///Applications/Apollo.app/Contents/Resources/app.asar/dist/../package.json',
        PACKAGED,
      ),
    ).toBe(false);
    expect(
      isAllowedRendererRequestUrl('file:///Applications/Apollo.app/Contents/Resources/app.asar/dist/', PACKAGED),
    ).toBe(false);
  });

  it('allows blob:, data:, intervals.icu and www.strava.com over HTTPS, and blocks all other hosts/schemes', () => {
    expect(isAllowedRendererRequestUrl('blob:file:///uuid-1234', PACKAGED)).toBe(true);
    expect(isAllowedRendererRequestUrl(`data:image/svg+xml;base64,${'A'.repeat(10_000)}`, PACKAGED)).toBe(true);
    expect(isAllowedRendererRequestUrl('https://intervals.icu/api/v1/athlete/0/activities', PACKAGED)).toBe(true);
    expect(isAllowedRendererRequestUrl('https://www.strava.com/api/v3/athlete/activities', PACKAGED)).toBe(true);

    // Blocks unencrypted HTTP, custom ports, embedded credentials, Garmin (proxied in main), and unknown hosts
    expect(isAllowedRendererRequestUrl('http://intervals.icu/api/v1/athlete/0', PACKAGED)).toBe(false);
    expect(isAllowedRendererRequestUrl('https://intervals.icu:8443/api', PACKAGED)).toBe(false);
    expect(isAllowedRendererRequestUrl('https://user:pw@intervals.icu/api', PACKAGED)).toBe(false);
    expect(isAllowedRendererRequestUrl('https://personal.connectapi.garmin.com/userprofile-service', PACKAGED)).toBe(
      false,
    );
    expect(isAllowedRendererRequestUrl('https://telemetry.evil.example/collect', PACKAGED)).toBe(false);
    expect(isAllowedRendererRequestUrl('wss://evil.example/socket', PACKAGED)).toBe(false);
  });

  it('allows Vite dev server HTTP/WebSocket and devtools:// only when enabled in dev', () => {
    expect(isAllowedRendererRequestUrl('http://localhost:5173/@vite/client', DEV, { allowDevTools: true })).toBe(true);
    expect(isAllowedRendererRequestUrl('ws://localhost:5173/?token=abc', DEV, { allowDevTools: true })).toBe(true);
    expect(
      isAllowedRendererRequestUrl('devtools://devtools/bundled/inspector.html', DEV, { allowDevTools: true }),
    ).toBe(true);

    // Blocked in packaged mode
    expect(isAllowedRendererRequestUrl('http://localhost:5173/@vite/client', PACKAGED, { allowDevTools: false })).toBe(
      false,
    );
    expect(
      isAllowedRendererRequestUrl('devtools://devtools/bundled/inspector.html', PACKAGED, { allowDevTools: false }),
    ).toBe(false);
  });

  it('keeps GitHub blocked on the default session: electron-updater uses its own session', async () => {
    // v1.0.9: the old GitHub exception for non-renderer requests never saw updater
    // traffic and only opened GitHub to everything else; it was removed.
    expect(isAllowedRendererRequestUrl(`${RELEASES_URL}/download/v1.0.9/latest.yml`, PACKAGED)).toBe(false);
    expect(
      isAllowedRendererRequestUrl(
        'https://release-assets.githubusercontent.com/github-production-release-asset/1',
        PACKAGED,
      ),
    ).toBe(false);
    expect(
      isAllowedRendererRequestUrl('https://api.github.com/repos/LetsLearntocodeforfun/Apollo-Running', PACKAGED),
    ).toBe(false);
    // The assumption behind that removal: electron-updater's requests go through
    // session.fromPartition('electron-updater'). Re-check main.ts if this changes.
    const { NET_SESSION_NAME } = await import('electron-updater/out/electronHttpExecutor');
    expect(NET_SESSION_NAME).toBe('electron-updater');
  });

  it('refuses encoded separators, NUL, malformed escapes and dot segments in file:// paths', () => {
    const dist = 'file:///Applications/Apollo.app/Contents/Resources/app.asar/dist';
    for (const url of [
      `${dist}/..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd`,
      `${dist}/..%2f..%2fetc%2fpasswd`,
      `${dist}/..%5C..%5Cetc%5Cpasswd`,
      `${dist}/..%5c..%5cetc`,
      `${dist}/assets%2Findex-abc123.js`,
      `${dist}/index.html%00.png`,
      `${dist}/assets/%E0%A4%A.js`,
      `${dist}/%2e%2e/package.json`,
      `${dist}/assets/..\\..\\..\\package.json`,
    ]) {
      expect(isAllowedRendererRequestUrl(url, PACKAGED), url).toBe(false);
    }
    // Ordinary escapes inside dist/ still load
    expect(isAllowedRendererRequestUrl(`${dist}/assets/Inter%20Variable.woff2`, PACKAGED)).toBe(true);
    expect(isAllowedRendererRequestUrl(`${dist}/assets/caf%C3%A9.png`, PACKAGED)).toBe(true);
  });

  it('applies the same jail to a Windows install (drive letter, case-insensitive paths)', () => {
    const WIN: TrustedAppLocation = {
      indexUrl: 'file:///C:/Program%20Files/Apollo/resources/app.asar/dist/index.html',
      devServerOrigin: null,
      caseInsensitivePaths: true,
    };
    const dist = 'file:///C:/Program%20Files/Apollo/resources/app.asar/dist';
    expect(isAllowedRendererRequestUrl(`${dist}/assets/index-abc123.js`, WIN)).toBe(true);
    expect(
      isAllowedRendererRequestUrl(
        'file:///c:/program%20files/apollo/resources/app.asar/dist/assets/index-abc123.js',
        WIN,
      ),
    ).toBe(true);

    expect(isAllowedRendererRequestUrl('file:///C:/Windows/win.ini', WIN)).toBe(false);
    expect(
      isAllowedRendererRequestUrl('file:///D:/Program%20Files/Apollo/resources/app.asar/dist/assets/a.js', WIN),
    ).toBe(false);
    expect(isAllowedRendererRequestUrl(`${dist}/..%5C..%5C..%5C..%5CWindows%5Cwin.ini`, WIN)).toBe(false);
    expect(isAllowedRendererRequestUrl(`${dist}/..%5c..%5csecret.txt`, WIN)).toBe(false);
    expect(isAllowedRendererRequestUrl(`${dist}/..%2F..%2Fsecret.txt`, WIN)).toBe(false);
    expect(isAllowedRendererRequestUrl(`${dist}/assets\\..\\..\\..\\secret.txt`, WIN)).toBe(false);
    expect(isAllowedRendererRequestUrl(`${dist}/index.html%00`, WIN)).toBe(false);
    // A UNC host is another machine (and Windows would offer it the user's NTLM credentials)
    expect(isAllowedRendererRequestUrl('file://attacker.example/share/payload.js', WIN)).toBe(false);
  });

  it('allows an install on a UNC share only from that same host', () => {
    const UNC: TrustedAppLocation = {
      indexUrl: 'file://fileserver/apps/Apollo/resources/app.asar/dist/index.html',
      devServerOrigin: null,
      caseInsensitivePaths: true,
    };
    const asset = '/apps/Apollo/resources/app.asar/dist/assets/index-abc123.js';
    expect(isAllowedRendererRequestUrl(`file://fileserver${asset}`, UNC)).toBe(true);
    expect(isAllowedRendererRequestUrl(`file://FILESERVER${asset.toLowerCase()}`, UNC)).toBe(true);

    expect(isAllowedRendererRequestUrl(`file://otherserver${asset}`, UNC)).toBe(false);
    expect(isAllowedRendererRequestUrl(`file://${asset}`, UNC)).toBe(false);
    expect(isAllowedRendererRequestUrl(`file:////fileserver${asset}`, UNC)).toBe(false);
    expect(
      isAllowedRendererRequestUrl('file://fileserver/apps/Apollo/resources/app.asar/dist/..%5C..%5Csecrets.txt', UNC),
    ).toBe(false);
  });

  it('decodes a path exactly once: a double-encoded separator stays part of a file name inside dist', () => {
    const dist = 'file:///Applications/Apollo.app/Contents/Resources/app.asar/dist';
    // Chromium also decodes a file URL once, so `%252f` names a file containing the text "%2f", never a "/".
    for (const name of ['..%252f..%252fetc%252fpasswd', '..%255C..%255Csecret.txt', 'a%2500b.js', '%252e%252e']) {
      expect(isAllowedRendererRequestUrl(`${dist}/assets/${name}`, PACKAGED), name).toBe(true);
    }
    // Encoded only once, the same names would be real separators, NUL or a dot segment: refused.
    for (const name of ['..%2f..%2fetc%2fpasswd', '..%5C..%5Csecret.txt', 'a%00b.js', '%2e%2e']) {
      expect(isAllowedRendererRequestUrl(`${dist}/assets/${name}`, PACKAGED), name).toBe(false);
    }
  });

  it("allows only what Node's own file-URL decoder also places inside dist", () => {
    // Dot segments in every spelling, separators and NUL encoded once and twice, malformed and overlong escapes.
    const segments = ['..', '%2e%2e', '.%2E', '%2E.', '.', '%2e', '...', '..%2f', '..%5C', '..%252f', '..%255c'];
    segments.push('%c0%af', '%ef%bc%8f', '..%00', '%2500', '%zz', '%E0%A4%A', '..\\', '%252e%252e');
    const corpus = (dist: string) =>
      segments.flatMap((s) => [
        `${dist}/${s}/etc/passwd`,
        `${dist}/assets/${s}/x.js`,
        `${dist}/${s}x.js`,
        `${dist}/assets/${s}`,
      ]);
    const inside = (p: string, dir: string, paths: typeof path.posix) => {
      const rel = paths.relative(dir, p);
      return rel !== '' && rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel);
    };

    const posixDir = '/Applications/Apollo.app/Contents/Resources/app.asar/dist';
    const posixAllowed = corpus(`file://${posixDir}`).filter((url) => isAllowedRendererRequestUrl(url, PACKAGED));
    expect(posixAllowed.length).toBeGreaterThan(20); // harmless names are in the corpus too: not a vacuous pass
    for (const url of posixAllowed)
      expect(inside(fileURLToPath(url, { windows: false }), posixDir, path.posix), url).toBe(true);

    let decodesWindowsUrls = false;
    try {
      decodesWindowsUrls = fileURLToPath('file:///C:/a', { windows: true }) === 'C:\\a';
    } catch {
      /* Node without the `windows` option: the macOS/Linux half above still ran */
    }
    if (!decodesWindowsUrls) return;
    const WIN: TrustedAppLocation = {
      indexUrl: 'file:///C:/Program%20Files/Apollo/resources/app.asar/dist/index.html',
      devServerOrigin: null,
      caseInsensitivePaths: true,
    };
    const winUrl = 'file:///C:/Program%20Files/Apollo/resources/app.asar/dist';
    const winAllowed = corpus(winUrl)
      .concat([`${winUrl.replace('C:', 'C|')}/a.js`, `${winUrl.replace('C:', 'c%3A')}/a.js`, `${winUrl}../a.js`])
      .filter((url) => isAllowedRendererRequestUrl(url, WIN));
    expect(winAllowed.length).toBeGreaterThan(20);
    const winDir = 'C:\\Program Files\\Apollo\\resources\\app.asar\\dist';
    for (const url of winAllowed)
      expect(inside(fileURLToPath(url, { windows: true }), winDir, path.win32), url).toBe(true);
  });
});

describe('blocked request logging', () => {
  it('logs only the scheme, host and path of a blocked URL', () => {
    expect(describeUrlForLog('https://user:pw@telemetry.evil.example:8443/collect?token=abc#frag')).toBe(
      'https://telemetry.evil.example:8443/collect',
    );
    expect(describeUrlForLog('wss://evil.example/socket?session=1')).toBe('wss://evil.example/socket');
    expect(describeUrlForLog('file:///Users/runner/.ssh/id_rsa')).toBe('file:///Users/runner/.ssh/id_rsa');
    const script = 'javascript:alert(document.cookie)';
    expect(describeUrlForLog(script)).toBe(`javascript: (${script.length} characters)`);
    // Control characters can't break the log line; long URLs are capped
    expect(describeUrlForLog('https://evil.example/a\nb\u0001c')).toBe('https://evil.example/ab%01c');
    expect(describeUrlForLog(`https://evil.example/${'a'.repeat(500)}`)).toHaveLength(201);
    expect(describeUrlForLog('not a url')).toBe('(unparseable URL)');
    expect(describeUrlForLog(undefined)).toBe('(no URL)');
  });

  it('reports the first 20 blocked requests, then one summary line, then nothing', () => {
    const warn = vi.fn();
    const report = createBlockedRequestReporter(warn);
    for (let i = 0; i < 50; i++) report(`https://evil.example/${i}?secret=${i}`, i % 2 === 0);
    expect(BLOCKED_REQUEST_LOG_LIMIT).toBe(20);
    expect(warn).toHaveBeenCalledTimes(21);
    expect(warn.mock.calls[0][0]).toBe('[Apollo] Blocked a renderer request: https://evil.example/0');
    expect(warn.mock.calls[1][0]).toBe('[Apollo] Blocked a non-renderer request: https://evil.example/1');
    expect(warn.mock.calls[19][0]).toBe('[Apollo] Blocked a non-renderer request: https://evil.example/19');
    expect(warn.mock.calls[20][0]).toBe(
      '[Apollo] More requests were blocked; only the first 20 are logged until Apollo restarts.',
    );
    expect(warn.mock.calls.flat().join('\n')).not.toContain('secret');
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

describe("update requests never carry electron-updater's per-install ID", () => {
  const STAGING_ID = '6f1c0b6e-2d5a-5c3e-9b7a-0c4d2e8f1a3b';

  it('removes x-user-staging-id in any letter case and keeps every other header as it was', () => {
    const headers = {
      'User-Agent': 'electron-builder',
      'x-user-staging-id': STAGING_ID,
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    };
    const stripped = stripUpdaterTrackingHeaders(headers);
    expect(stripped).toEqual({
      'User-Agent': 'electron-builder',
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    });
    expect(Object.keys(stripped)).toEqual(['User-Agent', 'Accept', 'Cache-Control']);
    expect(headers['x-user-staging-id']).toBe(STAGING_ID); // the input is not modified
    for (const name of ['X-User-Staging-Id', 'X-USER-STAGING-ID', 'x-User-Staging-ID']) {
      expect(stripUpdaterTrackingHeaders({ [name]: STAGING_ID, Range: 'bytes=0-99' }), name).toEqual({
        Range: 'bytes=0-99',
      });
    }
    // Look-alike names and multi-value headers are kept
    const others = { 'x-user-staging-id-hint': 'a', 'x-staging-id': 'b', Accept: ['text/html', 'application/json'] };
    expect(stripUpdaterTrackingHeaders(others)).toEqual(others);
    expect(stripUpdaterTrackingHeaders({})).toEqual({});
    expect(stripUpdaterTrackingHeaders(undefined)).toEqual({});
    expect(stripUpdaterTrackingHeaders(null)).toEqual({});
  });

  it('answers every request exactly once, and cancels rather than send headers it cannot read', () => {
    const check = vi.fn();
    filterUpdaterRequestHeaders({ requestHeaders: { 'x-user-staging-id': STAGING_ID, Accept: '*/*' } }, check);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith({ requestHeaders: { Accept: '*/*' } });

    // A download (no ID) goes out unchanged, Range header included
    const download = vi.fn();
    filterUpdaterRequestHeaders({ requestHeaders: { accept: '*/*', Range: 'bytes=100-199' } }, download);
    expect(download).toHaveBeenCalledWith({ requestHeaders: { accept: '*/*', Range: 'bytes=100-199' } });

    for (const details of [
      {},
      { requestHeaders: undefined },
      {
        get requestHeaders(): Record<string, string> {
          throw new Error('unreadable');
        },
      },
    ]) {
      const callback = vi.fn();
      filterUpdaterRequestHeaders(details, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
  });

  it("matches electron-updater's own code (re-check main.ts and UPDATER_TRACKING_HEADERS if this fails)", () => {
    const outDir = path.dirname(createRequire(import.meta.url).resolve('electron-updater/out/AppUpdater.js'));
    const appUpdater = readFileSync(path.join(outDir, 'AppUpdater.js'), 'utf8');
    // The per-install ID header it adds to update checks is one we strip…
    const sent = /computeFinalHeaders\(\{\s*"([^"]+)":\s*stagingUserId\s*\}\)/.exec(appUpdater);
    expect(sent?.[1]).toBeDefined();
    expect(UPDATER_TRACKING_HEADERS.has(String(sent?.[1]).toLowerCase())).toBe(true);
    // …and staged rollouts are decided on this computer from the same ID, so removing it changes no update.
    expect(appUpdater).toMatch(/async isStagingMatch\(updateInfo\) \{[\s\S]{0,1000}?this\.stagingUserIdPromise\.value/);
    // autoUpdater.netSession, where main.ts registers the filter, is the session its HTTP executor uses.
    expect(appUpdater).toMatch(/get netSession\(\) \{\s*return \(0, electronHttpExecutor_1\.getNetSession\)\(\);/);
    // A session has one onBeforeSendHeaders listener: electron-updater registers none that ours could replace.
    const jsFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return jsFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
      });
    const files = jsFiles(outDir);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/webRequest/);
  });
});

describe('OAuth loopback callback', () => {
  const STATE = 'a'.repeat(64);

  it('accepts a code only with the expected state', () => {
    expect(checkOAuthCallback(`/callback?code=abc&scope=read&state=${STATE}`, STATE)).toEqual({
      kind: 'code',
      code: 'abc',
      scope: 'read',
    });
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
    expect(corruptStoreBackupName('secure-credentials.json', new Date('2026-10-08T12:34:56.789Z'))).toBe(
      'secure-credentials.json.corrupt-2026-10-08T12-34-56-789Z',
    );
  });
});

describe('synced-folder backup security policy', () => {
  it('formats UTC auto-backup snapshot filenames deterministically', () => {
    const name = formatBackupSnapshotName(new Date('2026-10-31T06:25:00.123Z'));
    expect(name).toBe('apollo-auto-backup-2026-10-31-062500-123.json.gz');
    expect(isManagedBackupSnapshotName(name)).toBe(true);
  });

  it('matches only Apollo managed auto-backup filenames (never user files, manual exports, or path traversal)', () => {
    expect(isManagedBackupSnapshotName('apollo-auto-backup-2026-10-31-062500-123.json.gz')).toBe(true);
    expect(isManagedBackupSnapshotName('apollo-auto-backup-2026-10-31-062500.json.gz')).toBe(true);

    // Rejects user files, manual exports, temp files, traversal, and non-strings
    expect(isManagedBackupSnapshotName('apollo-export-2026-10-31.json')).toBe(false);
    expect(isManagedBackupSnapshotName('apollo-backup-2026-10-31.json.gz')).toBe(false);
    expect(isManagedBackupSnapshotName('apollo-auto-backup-2026-10-31-062500-123.json.gz.tmp')).toBe(false);
    expect(isManagedBackupSnapshotName('../apollo-auto-backup-2026-10-31-062500-123.json.gz')).toBe(false);
    expect(isManagedBackupSnapshotName('sub/apollo-auto-backup-2026-10-31-062500-123.json.gz')).toBe(false);
    expect(isManagedBackupSnapshotName('sub\\apollo-auto-backup-2026-10-31-062500-123.json.gz')).toBe(false);
    expect(isManagedBackupSnapshotName('notes.txt')).toBe(false);
    expect(isManagedBackupSnapshotName(null)).toBe(false);
    expect(isManagedBackupSnapshotName(123)).toBe(false);
  });

  it('rejects disallowed backup directories (roots, relative paths, NUL bytes, traversal) and allows subfolders', () => {
    // Allowed POSIX, Windows drive, and Windows UNC subfolders
    expect(isDisallowedBackupDirectory('/Users/runner/Library/Mobile Documents/com~apple~CloudDocs/Apollo')).toBe(
      false,
    );
    expect(isDisallowedBackupDirectory('/Volumes/ExternalDrive/ApolloBackups')).toBe(false);
    expect(isDisallowedBackupDirectory('C:\\Users\\runner\\Dropbox\\Apollo')).toBe(false);
    expect(isDisallowedBackupDirectory('D:/OneDrive/Apollo/')).toBe(false);
    expect(isDisallowedBackupDirectory('\\\\nas\\backups\\Apollo')).toBe(false);

    // Disallowed roots, relative paths, NUL bytes, traversal, and non-strings
    expect(isDisallowedBackupDirectory('/')).toBe(true);
    expect(isDisallowedBackupDirectory('///')).toBe(true);
    expect(isDisallowedBackupDirectory('C:\\')).toBe(true);
    expect(isDisallowedBackupDirectory('C:/')).toBe(true);
    expect(isDisallowedBackupDirectory('c:\\\\')).toBe(true);
    expect(isDisallowedBackupDirectory('C:relative')).toBe(true);
    expect(isDisallowedBackupDirectory('\\\\nas\\backups')).toBe(true);
    expect(isDisallowedBackupDirectory('\\\\nas\\backups\\')).toBe(true);
    expect(isDisallowedBackupDirectory('backups/apollo')).toBe(true);
    expect(isDisallowedBackupDirectory('./backups')).toBe(true);
    expect(isDisallowedBackupDirectory('/Users/..')).toBe(true);
    expect(isDisallowedBackupDirectory('/Users/runner/Apollo\0evil')).toBe(true);
    expect(isDisallowedBackupDirectory('')).toBe(true);
    expect(isDisallowedBackupDirectory('   ')).toBe(true);
    expect(isDisallowedBackupDirectory(null)).toBe(true);
    expect(isDisallowedBackupDirectory(undefined)).toBe(true);
  });

  it('clamps backup folder retention to an integer within [3, 50]', () => {
    expect(clampBackupFolderRetention(10)).toBe(10);
    expect(clampBackupFolderRetention(1)).toBe(3);
    expect(clampBackupFolderRetention(-10)).toBe(3);
    expect(clampBackupFolderRetention(200)).toBe(50);
    expect(clampBackupFolderRetention(14.9)).toBe(14);
    expect(clampBackupFolderRetention(undefined)).toBe(10);
    expect(clampBackupFolderRetention('invalid', 20)).toBe(20);
    expect(clampBackupFolderRetention(Number.NaN, 1)).toBe(3);
  });

  /** Metadata as exportAllData writes it, for `keyCount` data entries. */
  const meta = (keyCount: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    exportDate: '2026-10-31T06:25:00.000Z',
    appName: 'Apollo Running',
    version: '1.0.9',
    keyCount,
    purpose: 'backup',
    ...overrides,
  });
  const ONE_KEY = { apollo_plan: '{}' };

  it('validates backup snapshot JSON payloads and rejects credentials, non-apollo keys, caches, or tampered counts', () => {
    const valid = JSON.stringify({
      metadata: {
        exportDate: '2026-10-31T06:25:00.000Z',
        appName: 'Apollo Running',
        version: '1.0.8',
        keyCount: 2,
        purpose: 'backup',
        checksum: 'deadbeef',
      },
      data: {
        apollo_activities_store: '[]',
        apollo_plan: '{"id":"marathon"}',
      },
    });
    expect(validateBackupSnapshotPayload(valid)).toEqual({ ok: true, json: valid });

    // Non-string / empty / oversized / malformed checksum
    expect(validateBackupSnapshotPayload(null).ok).toBe(false);
    expect(validateBackupSnapshotPayload('').ok).toBe(false);
    expect(validateBackupSnapshotPayload('x'.repeat(MAX_BACKUP_SNAPSHOT_CHARS + 1)).ok).toBe(false);
    expect(validateBackupSnapshotPayload('{not json').ok).toBe(false);
    expect(validateBackupSnapshotPayload('[]').ok).toBe(false);
    expect(
      validateBackupSnapshotPayload(JSON.stringify({ metadata: meta(1, { checksum: 'not-hex!' }), data: ONE_KEY })).ok,
    ).toBe(false);

    // Wrong appName or keyCount mismatch
    expect(
      validateBackupSnapshotPayload(JSON.stringify({ metadata: meta(1, { appName: 'Other' }), data: ONE_KEY })).ok,
    ).toBe(false);
    expect(validateBackupSnapshotPayload(JSON.stringify({ metadata: meta(2), data: ONE_KEY })).ok).toBe(false);
    expect(validateBackupSnapshotPayload(JSON.stringify({ metadata: meta(0), data: [] })).ok).toBe(false);

    // Rejects credentials, nested backups, quarantine, non-apollo keys, caches, device-state, and prototype keys
    for (const forbidden of [
      'strava_tokens',
      'strava_credentials',
      'garmin_tokens',
      'garmin_credentials',
      'garmin_personal_api',
      'intervals_credentials',
      'apollo_backup_registry',
      'apollo_backup_data_123',
      'apollo_quarantine_apollo_activities_store_2026',
      'apollo_route_cache',
      'apollo_last_integrity_check',
      'apollo_needs_reconnect',
      'apollo_storage_persist_requested',
      'arbitrary_other_key',
      '__proto__',
      'constructor',
      'prototype',
      `apollo_${'x'.repeat(130)}`,
    ]) {
      const bad = JSON.stringify({ metadata: meta(1), data: { [forbidden]: '"secret"' } });
      const res = validateBackupSnapshotPayload(bad);
      expect(res.ok, forbidden).toBe(false);
      expect(res.error, forbidden).toMatch(/disallowed key/);
    }
    // Values must be strings
    expect(validateBackupSnapshotPayload(JSON.stringify({ metadata: meta(1), data: { apollo_plan: {} } })).ok).toBe(
      false,
    );
  });

  it('rejects unknown top-level fields, such as a smuggled strava_tokens entry', () => {
    const smuggled = JSON.stringify({ metadata: meta(1), data: ONE_KEY, strava_tokens: '{"access_token":"secret"}' });
    expect(validateBackupSnapshotPayload(smuggled)).toEqual({
      ok: false,
      reason: 'invalid',
      error: 'Backup snapshot has an unexpected top-level field "strava_tokens".',
    });
    const protoAtRoot = `{"__proto__":{"polluted":true},"metadata":${JSON.stringify(meta(1))},"data":{"apollo_plan":"{}"}}`;
    expect(validateBackupSnapshotPayload(protoAtRoot).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(validateBackupSnapshotPayload(JSON.stringify({ metadata: meta(1) })).ok).toBe(false);
    expect(validateBackupSnapshotPayload(JSON.stringify({ data: ONE_KEY })).ok).toBe(false);
  });

  it('rejects unknown metadata fields instead of dropping them (import checks the checksum over the metadata)', () => {
    for (const extra of [{ source: 'desktop' }, { checksumAlgorithm: 'sha256' }, { constructor: 'x' }]) {
      const res = validateBackupSnapshotPayload(JSON.stringify({ metadata: meta(1, extra), data: ONE_KEY }));
      expect(res.ok, JSON.stringify(extra)).toBe(false);
      expect(res.error).toMatch(/unexpected field/);
    }
    const protoInMetadata = `{"metadata":{"__proto__":{"polluted":true},${JSON.stringify(meta(1)).slice(1)},"data":{"apollo_plan":"{}"}}`;
    expect(validateBackupSnapshotPayload(protoInMetadata).ok).toBe(false);
  });

  it('rejects malformed or missing metadata values, and accepts the boundaries', () => {
    for (const overrides of [
      { exportDate: 1761892000000 },
      { exportDate: 'x'.repeat(65) },
      { version: 109 },
      { version: `1.0.9-${'x'.repeat(27)}` },
      { purpose: 'restore' },
      { purpose: 7 },
      { keyCount: 1.5 },
      { keyCount: '1' },
      { checksum: 42 },
      { checksum: 'abc' },
    ]) {
      const res = validateBackupSnapshotPayload(JSON.stringify({ metadata: meta(1, overrides), data: ONE_KEY }));
      expect(res.ok, JSON.stringify(overrides)).toBe(false);
    }
    for (const field of ['exportDate', 'appName', 'version', 'keyCount', 'purpose']) {
      const metadata = meta(1);
      delete metadata[field];
      expect(validateBackupSnapshotPayload(JSON.stringify({ metadata, data: ONE_KEY })).ok, field).toBe(false);
    }
    // 64-char exportDate, 32-char version, purpose 'export' and no checksum are fine
    const edge = meta(1, { exportDate: 'x'.repeat(64), version: 'v'.repeat(32), purpose: 'export' });
    expect(validateBackupSnapshotPayload(JSON.stringify({ metadata: edge, data: ONE_KEY })).ok).toBe(true);
  });

  it('rejects a snapshot without data (keyCount 0) as "empty"', () => {
    expect(validateBackupSnapshotPayload(JSON.stringify({ metadata: meta(0), data: {} }))).toEqual({
      ok: false,
      reason: 'empty',
      error: 'Backup snapshot has no Apollo data to back up.',
    });
    // A count that doesn't match the (empty) data is a malformed snapshot, not an empty one
    expect(validateBackupSnapshotPayload(JSON.stringify({ metadata: meta(3), data: {} }))).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('writes JSON rebuilt from the validated parts, in the original key order', () => {
    // An unusual but valid key order comes back unchanged
    const reordered =
      '{"data":{"apollo_shoes":"[]","apollo_plan":"{}"},"metadata":{"checksum":"DEADBEEF","purpose":"backup","keyCount":2,"version":"1.0.9","appName":"Apollo Running","exportDate":"2026-10-31T06:25:00.000Z"}}';
    expect(validateBackupSnapshotPayload(reordered)).toEqual({ ok: true, json: reordered });
    // Pretty-printed input is written compactly
    expect(validateBackupSnapshotPayload(JSON.stringify(JSON.parse(reordered), null, 2)).json).toBe(reordered);
    // A duplicate key can't smuggle anything past validation: only the parsed value is checked AND written
    const head = `{"metadata":${JSON.stringify(meta(1))}`;
    const duplicated = `${head},"data":{"strava_tokens":"secret"},"data":{"apollo_plan":"{}"}}`;
    const res = validateBackupSnapshotPayload(duplicated);
    expect(res.json).toBe(`${head},"data":{"apollo_plan":"{}"}}`);
    expect(res.json).not.toContain('strava_tokens');
  });
});

describe('synced-folder pruning (selectSnapshotsToPrune)', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.parse('2026-11-01T12:00:00.000Z');
  const snap = (ms: number) => formatBackupSnapshotName(new Date(ms));
  /** `n` managed names, one per hour, oldest first, the newest one hour before `end`. */
  const hourly = (n: number, end: number = NOW) => Array.from({ length: n }, (_, i) => snap(end - (n - i) * HOUR));
  const JUST_WRITTEN = snap(NOW);

  it('keeps maxFiles snapshots, counting the one just written, and deletes the oldest first', () => {
    const older = hourly(12);
    expect(selectSnapshotsToPrune([JUST_WRITTEN, ...older].reverse(), JUST_WRITTEN, 10, NOW)).toEqual(
      older.slice(0, 3),
    );
    expect(selectSnapshotsToPrune([...hourly(9), JUST_WRITTEN], JUST_WRITTEN, 10, NOW)).toEqual([]);
    expect(selectSnapshotsToPrune([], JUST_WRITTEN, 10, NOW)).toEqual([]);
  });

  it('never selects the snapshot just written, even when a clock change makes it the oldest', () => {
    const now = NOW - 6 * HOUR; // clock set back 6 h: the earlier snapshots now look up to 5 h "ahead"
    const justWritten = snap(now);
    const earlier = hourly(5); // 07:00 … 11:00, within the 24 h tolerance, so they still count
    const toDelete = selectSnapshotsToPrune([justWritten, ...earlier], justWritten, 3, now);
    expect(toDelete).toEqual(earlier.slice(0, 3));
    expect(toDelete).not.toContain(justWritten);
    // Its slot is kept even if the directory listing doesn't show it yet
    expect(selectSnapshotsToPrune(earlier, justWritten, 3, now)).toEqual(earlier.slice(0, 3));
  });

  it('neither deletes nor counts snapshots dated more than 24 h ahead', () => {
    const future = [snap(NOW + SNAPSHOT_FUTURE_TOLERANCE_MS + 1), snap(Date.parse('2027-03-01T00:00:00.000Z'))];
    const older = hourly(3);
    // Counted: 3 older + the new one; keep 3, so only the oldest goes. The future-dated files stay.
    expect(selectSnapshotsToPrune([...future, ...older, JUST_WRITTEN], JUST_WRITTEN, 3, NOW)).toEqual([older[0]]);
    expect(selectSnapshotsToPrune([...future, ...hourly(2), JUST_WRITTEN], JUST_WRITTEN, 3, NOW)).toEqual([]);
  });

  it('counts snapshots up to exactly 24 h ahead (another device whose clock runs a little fast)', () => {
    const ahead = snap(NOW + SNAPSHOT_FUTURE_TOLERANCE_MS);
    const older = hourly(2);
    // Counted: 2 older + 1 ahead + the new one; keep 3: the oldest goes, the newest-dated stays.
    expect(selectSnapshotsToPrune([ahead, ...older, JUST_WRITTEN], JUST_WRITTEN, 3, NOW)).toEqual([older[0]]);
  });

  it('ignores managed-looking names whose date cannot exist', () => {
    const impossible = [
      'apollo-auto-backup-2026-02-30-120000-000.json.gz', // Feb 30
      'apollo-auto-backup-2026-13-01-120000-000.json.gz', // month 13
      'apollo-auto-backup-2026-00-10-120000-000.json.gz', // month 0
      'apollo-auto-backup-2026-10-00-120000-000.json.gz', // day 0
      'apollo-auto-backup-2026-10-31-240000-000.json.gz', // hour 24
      'apollo-auto-backup-2026-10-31-236000-000.json.gz', // minute 60
      'apollo-auto-backup-2026-10-31-235960-000.json.gz', // second 60
      'apollo-auto-backup-0026-10-31-120000-000.json.gz', // year 26 (Date.UTC would read 1926)
    ];
    for (const name of impossible) {
      expect(isManagedBackupSnapshotName(name), name).toBe(true);
      expect(parseBackupSnapshotTime(name), name).toBeNull();
    }
    expect(parseBackupSnapshotTime('apollo-auto-backup-2026-10-31-062500-123.json.gz')).toBe(
      Date.parse('2026-10-31T06:25:00.123Z'),
    );
    expect(parseBackupSnapshotTime('apollo-auto-backup-2026-10-31-062500.json.gz')).toBe(
      Date.parse('2026-10-31T06:25:00.000Z'),
    );
    const older = hourly(3);
    expect(selectSnapshotsToPrune([...impossible, ...older, JUST_WRITTEN], JUST_WRITTEN, 3, NOW)).toEqual([older[0]]);
  });

  it('never selects files Apollo did not create, however many there are', () => {
    const managed = 'apollo-auto-backup-2026-10-31-062500-123.json.gz';
    const foreign = [
      'notes.txt',
      'apollo-export-2026-10-31.json',
      'apollo-backup-2026-10-31.json',
      managed.toUpperCase(),
      `${managed}.tmp`,
      `${managed}.4242.1761891900123.0a1b2c3d.tmp`,
      `${managed}.bak`,
      'apollo-auto-backup-2026-10-31-062500-123 (1).json.gz', // a sync client's conflict copy
      `../${managed}`,
      `sub/${managed}`,
      `sub\\${managed}`,
      ...Array.from({ length: 60 }, (_, i) => `IMG_${1000 + i}.jpg`),
    ];
    expect(selectSnapshotsToPrune([...foreign, JUST_WRITTEN], JUST_WRITTEN, 3, NOW)).toEqual([]);
    const older = hourly(4);
    expect(selectSnapshotsToPrune([...foreign, ...older, JUST_WRITTEN], JUST_WRITTEN, 3, NOW)).toEqual(
      older.slice(0, 2),
    );
  });

  it('clamps maxFiles to [3, 50] and orders by the time in the name, milliseconds included', () => {
    const names = [...hourly(60), JUST_WRITTEN];
    expect(selectSnapshotsToPrune(names, JUST_WRITTEN, 0, NOW)).toHaveLength(58); // keeps 3
    expect(selectSnapshotsToPrune(names, JUST_WRITTEN, 1000, NOW)).toHaveLength(11); // keeps 50
    expect(selectSnapshotsToPrune(names, JUST_WRITTEN, Number.NaN, NOW)).toHaveLength(51); // default 10
    // Sorting the names as text would put …062500-123 before …062500 ('-' < '.'); by time it's after
    const a = 'apollo-auto-backup-2026-10-31-062500.json.gz';
    const b = 'apollo-auto-backup-2026-10-31-062500-123.json.gz';
    const c = 'apollo-auto-backup-2026-10-31-062501-000.json.gz';
    expect(selectSnapshotsToPrune([c, b, a, JUST_WRITTEN], JUST_WRITTEN, 3, NOW)).toEqual([a]);
  });

  it('ignores duplicate names and deletes nothing when "now" is not a valid time', () => {
    const older = hourly(3);
    expect(selectSnapshotsToPrune([...older, ...older, JUST_WRITTEN, JUST_WRITTEN], JUST_WRITTEN, 3, NOW)).toEqual([
      older[0],
    ]);
    expect(selectSnapshotsToPrune([...hourly(20), JUST_WRITTEN], JUST_WRITTEN, 3, Number.NaN)).toEqual([]);
    expect(selectSnapshotsToPrune([...hourly(20), JUST_WRITTEN], JUST_WRITTEN, 3, new Date('invalid'))).toEqual([]);
    expect(selectSnapshotsToPrune([...hourly(20), JUST_WRITTEN], JUST_WRITTEN, 3, new Date(NOW))).toHaveLength(18);
  });
});

describe('synced-folder temp-file sweep (isOwnStaleSnapshotTempFile)', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.parse('2026-11-01T12:00:00.000Z');
  const TWO_HOURS_AGO = NOW - 2 * HOUR;
  /** A temp name exactly as main.ts builds it: `<snapshot>.<pid>.<ms>.<8 hex>.tmp`. */
  const tempName = (createdMs: number) =>
    `${formatBackupSnapshotName(new Date(createdMs))}.4242.${createdMs}.0a1b2c3d.tmp`;

  it("matches Apollo's own temp files once both their mtime and their name's time are over an hour old", () => {
    expect(isOwnStaleSnapshotTempFile(tempName(TWO_HOURS_AGO), TWO_HOURS_AGO, NOW)).toBe(true);
    expect(isOwnStaleSnapshotTempFile(tempName(TWO_HOURS_AGO), TWO_HOURS_AGO, new Date(NOW))).toBe(true);
  });

  it('keeps temp files that are an hour old or younger by either clock (a write may be in progress)', () => {
    const recent = NOW - 59 * 60 * 1000;
    expect(isOwnStaleSnapshotTempFile(tempName(recent), recent, NOW)).toBe(false);
    expect(isOwnStaleSnapshotTempFile(tempName(NOW - HOUR), NOW - HOUR, NOW)).toBe(false);
    // Old mtime but a recent time in the name (FAT/exFAT mtimes are local time): keep
    expect(isOwnStaleSnapshotTempFile(tempName(recent), TWO_HOURS_AGO, NOW)).toBe(false);
    // Recent mtime: still being written to: keep
    expect(isOwnStaleSnapshotTempFile(tempName(TWO_HOURS_AGO), recent, NOW)).toBe(false);
  });

  it('keeps temp files with future or invalid times, and everything when "now" is invalid', () => {
    expect(isOwnStaleSnapshotTempFile(tempName(TWO_HOURS_AGO), NOW + HOUR, NOW)).toBe(false);
    expect(isOwnStaleSnapshotTempFile(tempName(NOW + HOUR), TWO_HOURS_AGO, NOW)).toBe(false);
    expect(isOwnStaleSnapshotTempFile(tempName(TWO_HOURS_AGO), Number.NaN, NOW)).toBe(false);
    expect(isOwnStaleSnapshotTempFile(tempName(TWO_HOURS_AGO), TWO_HOURS_AGO, Number.NaN)).toBe(false);
    expect(isOwnStaleSnapshotTempFile(tempName(TWO_HOURS_AGO), TWO_HOURS_AGO, new Date('invalid'))).toBe(false);
  });

  it('never matches files Apollo did not create', () => {
    const monthOld = NOW - 30 * 24 * HOUR;
    const snapshot = formatBackupSnapshotName(new Date(TWO_HOURS_AGO));
    for (const name of [
      snapshot, // the snapshot itself
      `${snapshot}.tmp`,
      `${snapshot}.4242.${TWO_HOURS_AGO}.0A1B2C3D.tmp`, // upper-case hex: not how main.ts names them
      `${snapshot}.4242.${TWO_HOURS_AGO}.0a1b2c3.tmp`, // 7 hex digits
      `${snapshot}.4242.${TWO_HOURS_AGO}.0a1b2c3d.tmp.bak`,
      `${snapshot}.${TWO_HOURS_AGO}.0a1b2c3d.tmp`, // no pid
      `../${snapshot}.4242.${TWO_HOURS_AGO}.0a1b2c3d.tmp`,
      `sub/${snapshot}.4242.${TWO_HOURS_AGO}.0a1b2c3d.tmp`,
      `apollo-auto-backup-2026-02-30-120000-000.json.gz.4242.${TWO_HOURS_AGO}.0a1b2c3d.tmp`, // impossible date
      `secure-credentials.json.4242.${TWO_HOURS_AGO}.tmp`,
      `backup-folder-config.json.4242.${TWO_HOURS_AGO}.tmp`,
      '~$report.docx.tmp',
      'download.tmp',
    ]) {
      expect(isOwnStaleSnapshotTempFile(name, monthOld, NOW), name).toBe(false);
    }
    expect(isOwnStaleSnapshotTempFile(null, monthOld, NOW)).toBe(false);
  });
});

describe('privacy network inventory & importAllData key isolation', () => {
  it('discloses every outbound service (including Garmin Personal API on desktop) with zero defaultOn destinations', () => {
    expect(NETWORK_DESTINATIONS.every((d) => d.defaultOn === false)).toBe(true);

    const desktopHosts = getNetworkDestinations('desktop').map((d) => d.host);
    expect(desktopHosts).toContain('personal.connectapi.garmin.com');
    expect(desktopHosts).toContain('intervals.icu');
    expect(desktopHosts).toContain('www.strava.com (api/v3)');

    const webHosts = getNetworkDestinations('web').map((d) => d.host);
    expect(webHosts).not.toContain('personal.connectapi.garmin.com');
    expect(webHosts).toContain('this website (/api)');
  });

  it('names the hosts the desktop updater really contacts, and the Garmin file-download redirect', () => {
    // electron-updater's GitHub provider reads github.com only (no api.github.com for a
    // public repo); GitHub redirects release files to release-assets.githubusercontent.com.
    const github = NETWORK_DESTINATIONS.find((d) => d.id === 'github-releases');
    expect(github?.host).toBe('github.com, release-assets.githubusercontent.com');
    expect(github?.platform).toBe('desktop');
    const garmin = NETWORK_DESTINATIONS.find((d) => d.id === 'garmin-personal-api');
    expect(garmin?.dataSent).toMatch(/redirected to Garmin.s file-storage host/);
  });

  it("says the updater's device ID stays on the computer, and main.ts keeps that promise", () => {
    const github = NETWORK_DESTINATIONS.find((d) => d.id === 'github-releases');
    expect(github?.dataSent).toMatch(
      /random device ID .*; Apollo removes it before the request leaves your computer\./,
    );
    expect(github?.dataSent).not.toMatch(/carries a random ID/);
    // The filter sits on electron-updater's own session and is registered before the first window.
    const mainSource = readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');
    expect(mainSource).toMatch(
      /autoUpdater\.netSession\.webRequest\.onBeforeSendHeaders\(\s*filterUpdaterRequestHeaders\s*\)/,
    );
    expect(mainSource).toMatch(
      /app\.whenReady\(\)\.then\(\(\) => \{[^}]*applyUpdaterPrivacy\(\);[^}]*createWindow\(\);/,
    );
  });

  it('importAllData ignores credentials, backup registries, quarantine keys, caches, and prototype keys', () => {
    persistence.setItem('apollo_backup_registry', '[{"id":"keep-me"}]');
    const rawPayload = JSON.parse(
      '{"metadata":{"appName":"Apollo Running","keyCount":6,"exportDate":"2026-10-31","version":"1.0.9"},"data":{"apollo_shoes":"[]","strava_tokens":"evil","apollo_backup_registry":"[]","apollo_quarantine_x":"{}","apollo_route_cache":"{}","__proto__":"polluted"}}',
    );
    expect(importAllData(rawPayload)).toBe(true);
    expect(persistence.getItem('apollo_shoes')).toBe('[]');
    expect(persistence.getItem('strava_tokens')).toBeNull();
    expect(persistence.getItem('apollo_backup_registry')).toBe('[{"id":"keep-me"}]');
    expect(persistence.getItem('apollo_quarantine_x')).toBeNull();
    expect(persistence.getItem('apollo_route_cache')).toBeNull();
  });
});
