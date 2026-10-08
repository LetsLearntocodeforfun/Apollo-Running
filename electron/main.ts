import { app, BrowserWindow, ipcMain, shell, safeStorage, session, type IpcMainInvokeEvent } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import {
  RELEASES_URL,
  checkOAuthCallback,
  corruptStoreBackupName,
  getAllowedExternalUrl,
  isAllowedPermission,
  isAllowedSubframeNavigation,
  isAllowedTopLevelNavigation,
  isTrustedSenderUrl,
  parseUpdaterPrefs,
  type TrustedAppLocation,
} from './security';

let mainWindow: BrowserWindow | null = null;
let oauthServer: http.Server | null = null;
let oauthState: string | null = null;
let oauthPort: number | null = null;

const isDev = !app.isPackaged;
const DEV_SERVER_URL = 'http://localhost:5173';
const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_SCOPES = 'activity:read_all,activity:write,profile:read_all';

function logDev(...args: unknown[]): void {
  if (isDev) {
    console.log('[Apollo Main]', ...args);
  }
}

// ----- Single instance -----
// A second launch focuses the existing window instead of opening another copy
// (two instances would race on the same IndexedDB / credential files).
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// ----- Trusted origin -----

/** `file://` URL of the index.html actually loaded (set before loading it). */
let loadedIndexUrl: string | null = null;

/** Where the app is served from: the packaged index.html, or the dev server in development. */
function trustedLocation(): TrustedAppLocation {
  return {
    indexUrl: loadedIndexUrl,
    devServerOrigin: isDev ? DEV_SERVER_URL : null,
    caseInsensitivePaths: process.platform === 'win32',
  };
}

/** Only the app's own top frame may call privileged IPC handlers. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame) return false;
  return isTrustedSenderUrl(frame.url, frame.parent === null, trustedLocation());
}

/** `ipcMain.handle` that rejects calls from untrusted frames (e.g. a framed or navigated page). */
function handleTrusted<A extends unknown[], R>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) {
      console.warn(`[Apollo] Blocked IPC "${channel}" from untrusted frame:`, event.senderFrame?.url);
      throw new Error('Blocked: request did not come from the Apollo app.');
    }
    return listener(event, ...(args as A));
  });
}

/** Open an allow-listed https URL in the OS browser. Returns whether it was opened. */
function openExternalIfAllowed(targetUrl: unknown): boolean {
  const allowed = getAllowedExternalUrl(targetUrl);
  if (!allowed) return false;
  shell.openExternal(allowed).catch((err) => console.warn('[Apollo] Could not open external URL:', err));
  return true;
}

// ----- Session hardening -----

/** Deny every web permission except sanitized clipboard writes ("Copy" buttons). */
function applySessionSecurity(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isAllowedPermission(permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission) => isAllowedPermission(permission));
}

// Any other web contents (there shouldn't be any) gets the same lock-down.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url: targetUrl }) => {
    openExternalIfAllowed(targetUrl);
    return { action: 'deny' };
  });
});

function getCandidateIndexPaths(): string[] {
  const appPath = app.getAppPath();
  return [
    path.join(appPath, 'dist', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'index.html'),
    path.join(__dirname, '..', 'dist', 'index.html'),
  ];
}

async function loadProductionWindow(win: BrowserWindow): Promise<void> {
  const candidates = getCandidateIndexPaths();
  let lastError: unknown = null;

  for (const indexPath of candidates) {
    if (!fs.existsSync(indexPath)) continue;
    try {
      // Trust this exact file for navigation and IPC before it starts running.
      loadedIndexUrl = pathToFileURL(indexPath).href;
      await win.loadFile(indexPath);
      logDev('Loaded app from', indexPath);
      return;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`Failed to load index.html from known locations: ${lastError.message}`);
  }
  throw new Error('Failed to load index.html from known locations');
}

function createWindow() {
  // Packaged builds ship public/ inside dist/ (Vite copies it); dev reads public/ directly.
  const iconPath = app.isPackaged
    ? path.join(__dirname, '..', 'dist', 'assets', 'logo-256.png')
    : path.join(__dirname, '..', 'public', 'assets', 'logo-256.png');
  // Preload is emitted to dist-electron/preload.js (same dir level as main.js)
  const preloadPath = path.join(__dirname, 'preload.js');

  logDev('Runtime paths', {
    appPath: app.getAppPath(),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    preloadPath,
    iconPath,
  });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false, // Don't show until content is ready
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: isDev,
      nodeIntegrationInWorker: false,
      webviewTag: false,
    },
    title: 'Apollo',
    backgroundColor: '#0D1B2A',
    icon: iconPath
  });
  mainWindow = win;

  // Prevent the renderer from navigating away from the app. Allow-listed
  // https links (Strava, intervals.icu, GitHub releases) open in the OS browser.
  win.webContents.on('will-navigate', (event) => {
    if (isAllowedTopLevelNavigation(event.url, event.isSameDocument, trustedLocation())) return;
    event.preventDefault();
    openExternalIfAllowed(event.url);
  });

  // Sub-frames may only show generated content (blob:/data:/about:blank — the
  // plan printout uses a blob iframe) or the app itself; never remote pages.
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return; // covered by will-navigate
    if (!isAllowedSubframeNavigation(event.url, event.isSameDocument, trustedLocation())) {
      event.preventDefault();
    }
  });

  win.webContents.on('will-redirect', (event) => {
    const allowed = event.isMainFrame
      ? isAllowedTopLevelNavigation(event.url, false, trustedLocation())
      : isAllowedSubframeNavigation(event.url, false, trustedLocation());
    if (!allowed) event.preventDefault();
  });

  // Block new-window requests; open trusted external URLs in the OS browser.
  // (`<a download href="blob:…">` saves are downloads, not windows — the
  // default save dialog handles them.)
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    openExternalIfAllowed(targetUrl);
    return { action: 'deny' };
  });

  // Show window when page is ready
  win.once('ready-to-show', () => {
    win.show();
  });

  // Load the app
  const loadApp = async () => {
    if (isDev) {
      try {
        logDev('Loading app from Vite dev server');
        await win.loadURL(DEV_SERVER_URL);
        win.webContents.openDevTools();
      } catch (error) {
        console.error('Failed to load dev server:', error);
      }
    } else {
      try {
        await loadProductionWindow(win);
      } catch (error) {
        console.error('Failed to load app:', error);

        // Escape HTML entities to prevent XSS in error messages
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const errMsg = esc(error instanceof Error ? error.message : String(error));
        const errStack = esc(error instanceof Error && error.stack ? error.stack : 'No stack trace available');

        // Show error page
        const errorHtml = `
          <!DOCTYPE html>
          <html>
            <head>
              <title>Error Loading Apollo</title>
              <style>
                body { 
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                  background-color: #0D1B2A;
                  color: #E8C05A;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                  padding: 20px;
                  text-align: center;
                }
                .error-container {
                  max-width: 600px;
                  padding: 30px;
                  border: 2px solid #E07B30;
                  border-radius: 10px;
                  background-color: rgba(13, 27, 42, 0.9);
                }
                h1 { color: #E07B30; }
                pre {
                  background: rgba(0, 0, 0, 0.3);
                  padding: 15px;
                  border-radius: 5px;
                  overflow: auto;
                  max-height: 200px;
                  text-align: left;
                }
              </style>
            </head>
            <body>
              <div class="error-container">
                <h1>Failed to Load Apollo</h1>
                <p>An error occurred while loading the application. Please try reinstalling the app.</p>
                <p>Error details:</p>
                <pre>${errMsg}\n\n${errStack}</pre>
                <p>App path: ${esc(app.getAppPath())}</p>
                <p>Resources path: ${esc(process.resourcesPath)}</p>
              </div>
            </body>
          </html>
        `;
        
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`);
      }
    }
    
  };
  
  // Start the app
  loadApp().catch(error => {
    console.error('Failed to load app:', error);
    app.quit();
  });

  win.on('closed', () => { 
    if (mainWindow === win) mainWindow = null;
    closeOAuthServer();
  });
}

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    applySessionSecurity();
    createWindow();
  });
}

app.on('window-all-closed', () => {
  closeOAuthServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (hasSingleInstanceLock && BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ----- Strava OAuth -----

/** How long to wait for the user to approve access in the browser. */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

interface OAuthCallbackResult { code: string; scope?: string }
interface PendingOAuth {
  /** Resolves with the loopback port once the callback server is listening. */
  listening: Promise<number>;
  /** Resolves when Strava redirects back with an authorization code. */
  result: Promise<OAuthCallbackResult>;
}
let pendingOAuth: PendingOAuth | null = null;

/** Generate a cryptographically random state string for OAuth CSRF protection. */
function generateOAuthState(): string {
  return randomBytes(32).toString('hex');
}

function oauthPage(title: string, message: string): string {
  return `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
    <h2>${title}</h2><p>${message}</p></body></html>`;
}

/** Close a callback server (the current one by default). */
function closeOAuthServer(server: http.Server | null = oauthServer): void {
  if (!server) return;
  server.close();
  if (oauthServer === server) {
    oauthServer = null;
    pendingOAuth = null;
    // A state that can no longer be redeemed must not be accepted later.
    oauthState = null;
  }
}

/**
 * Start — or reuse — the loopback server that receives Strava's redirect.
 * Idempotent, so the renderer can request the auth URL and start waiting for
 * the code in either order. `oauthPort` is kept after the server closes
 * because the token exchange must send the same redirect_uri.
 */
function ensureOAuthServer(): PendingOAuth {
  if (pendingOAuth) return pendingOAuth;

  let resolveResult!: (value: OAuthCallbackResult) => void;
  let rejectResult!: (err: Error) => void;
  const result = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  result.catch(() => { /* handled by whoever awaits it */ });

  const server = http.createServer((req, res) => {
    // The CSRF state is checked on every branch, including ?error=, so another
    // local page can't cancel or complete a pending connect.
    const check = checkOAuthCallback(req.url, oauthState);
    if (check.kind === 'not-found') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (check.kind === 'bad-state') {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end(oauthPage('Authentication failed', 'Invalid state parameter. Please try connecting again from the app.'));
      return;
    }
    oauthState = null; // Consume the state (one-time use)
    clearTimeout(timer);
    if (check.kind === 'denied') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(oauthPage('Strava not connected', 'Authorization was cancelled. You can close this window.'));
      rejectResult(new Error('Strava authorization was cancelled.'));
      setTimeout(() => closeOAuthServer(server), 500);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(oauthPage('Strava connected', 'You can close this window and return to the app.'));
    // The next connect attempt gets a fresh server.
    if (oauthServer === server) pendingOAuth = null;
    resolveResult({ code: check.code, scope: check.scope });
    setTimeout(() => closeOAuthServer(server), 500);
  });

  const timer = setTimeout(() => {
    rejectResult(new Error('Timed out waiting for Strava authorization. Please try again.'));
    closeOAuthServer(server);
  }, OAUTH_TIMEOUT_MS);

  const listening = new Promise<number>((resolve, reject) => {
    server.once('error', (err) => {
      clearTimeout(timer);
      rejectResult(err);
      closeOAuthServer(server);
      reject(err);
    });
    // Random ephemeral port, loopback only
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      oauthPort = typeof addr === 'object' && addr ? addr.port : null;
      if (oauthPort) resolve(oauthPort);
      else reject(new Error('Could not start the Strava callback server'));
    });
  });
  listening.catch(() => { /* surfaced through the IPC handlers */ });

  oauthServer = server;
  pendingOAuth = { listening, result };
  return pendingOAuth;
}

/** A short, printable string from the renderer (IDs, codes, tokens). */
function requireString(value: unknown, name: string, maxLength = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value.trim();
}

handleTrusted('strava:get-auth-url', async (_, clientId: unknown) => {
  const id = requireString(clientId, 'Strava client ID', 64);
  const port = await ensureOAuthServer().listening;
  oauthState = generateOAuthState();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  return `${STRAVA_AUTH_URL}?client_id=${encodeURIComponent(id)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(STRAVA_SCOPES)}&approval_prompt=force&state=${encodeURIComponent(oauthState)}`;
});

handleTrusted('strava:exchange-code', async (_, payload: { clientId: string; clientSecret: string; code: string }) => {
  if (!oauthPort) throw new Error('OAuth server is not running');
  const redirectUri = `http://127.0.0.1:${oauthPort}/callback`;
  const body = new URLSearchParams({
    client_id: requireString(payload?.clientId, 'Strava client ID', 64),
    client_secret: requireString(payload?.clientSecret, 'Strava client secret'),
    code: requireString(payload?.code, 'authorization code'),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }
  return res.json();
});

handleTrusted('strava:refresh-token', async (_, payload: { clientId: string; clientSecret: string; refreshToken: string }) => {
  const body = new URLSearchParams({
    client_id: requireString(payload?.clientId, 'Strava client ID', 64),
    client_secret: requireString(payload?.clientSecret, 'Strava client secret'),
    grant_type: 'refresh_token',
    refresh_token: requireString(payload?.refreshToken, 'refresh token'),
  });
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  // The renderer maps 400/401/403 to "reconnect Strava" (strava.ts).
  if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
  return res.json();
});

handleTrusted('oauth:start-server', async () => {
  const pending = ensureOAuthServer();
  await pending.listening;
  return pending.result;
});

// Garmin: placeholder for when you have API access (OAuth 2.0 + PKCE)
handleTrusted('garmin:get-auth-url', (_, _config: { clientId: string; codeChallenge: string; state: string }) => {
  // Garmin uses PKCE; implement when you have Garmin Developer Program access
  return null;
});

handleTrusted('garmin:exchange-code', async () => {
  return { error: 'Garmin integration requires Garmin Connect Developer Program approval.' };
});

handleTrusted('open-external', (_, targetUrl: unknown) => {
  // Only allow-listed https URLs (shared allow-list in ./security) — never
  // arbitrary protocols or hosts.
  return openExternalIfAllowed(targetUrl);
});

// ----- Secure Credential Storage (safeStorage API) -----
// Uses Electron's OS-level encryption (DPAPI on Windows, Keychain on macOS,
// libsecret on Linux) to encrypt sensitive OAuth credentials at rest.
// Encrypted blobs are stored as Base64 in a local JSON file inside the
// app's userData directory — never in localStorage or IndexedDB.

const SECURE_STORE_PATH = path.join(app.getPath('userData'), 'secure-credentials.json');

/**
 * Read the encrypted credentials file from disk. A corrupt file is moved
 * aside (`*.corrupt-<time>`) instead of being overwritten by the next write;
 * an unreadable file throws so a write can't silently drop the other keys.
 */
function readSecureStore(): Record<string, string> {
  if (!fs.existsSync(SECURE_STORE_PATH)) return {};
  const raw = fs.readFileSync(SECURE_STORE_PATH, 'utf-8');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const store: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') store[key] = value;
      }
      return store;
    }
  } catch {
    // fall through: corrupt
  }
  const backup = path.join(path.dirname(SECURE_STORE_PATH), corruptStoreBackupName(path.basename(SECURE_STORE_PATH)));
  fs.renameSync(SECURE_STORE_PATH, backup);
  console.error(`[Apollo] Credential store was corrupt — kept a copy at ${backup} and started fresh.`);
  return {};
}

/**
 * Write the encrypted credentials file atomically: a private (0600) temp file
 * is written and fsynced, then renamed over the old one. Throws on failure so
 * callers report `{ success: false }` instead of claiming it was saved.
 */
function writeSecureStore(store: Record<string, string>): void {
  const dir = path.dirname(SECURE_STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${SECURE_STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(store, null, 2), 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, SECURE_STORE_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
    console.error('[Apollo] Failed to write secure store:', err);
    throw err;
  }
}

const ALLOWED_SECURE_KEYS = new Set([
  'strava_tokens', 'strava_credentials',
  'garmin_tokens', 'garmin_credentials',
  'intervals_credentials',
]);

/**
 * Why credentials can't be encrypted for real, or null when they can.
 * On Linux without a keyring, safeStorage falls back to a hard-coded key
 * ("basic_text") — that is not encryption, so Apollo refuses to claim it is.
 */
function encryptionUnavailableReason(): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    return 'OS-level encryption is unavailable. Refusing to store sensitive credentials insecurely.';
  }
  if (process.platform === 'linux') {
    try {
      if (safeStorage.getSelectedStorageBackend() === 'basic_text') {
        return 'No system keyring (GNOME Keyring / KWallet) was found, so credentials can\'t be encrypted. '
          + 'They will work until Apollo is closed.';
      }
    } catch { /* backend query unsupported — trust isEncryptionAvailable */ }
  }
  return null;
}

/** Store a credential securely using OS-level encryption */
handleTrusted('secure-storage:set', (_, key: unknown, value: unknown) => {
  try {
    if (typeof key !== 'string' || !ALLOWED_SECURE_KEYS.has(key)) {
      return { success: false, error: 'Invalid credential key' };
    }
    if (typeof value !== 'string') return { success: false, error: 'Invalid credential value' };
    const unavailable = encryptionUnavailableReason();
    if (unavailable) return { success: false, error: unavailable };
    const encrypted = safeStorage.encryptString(value);
    const store = readSecureStore();
    store[key] = encrypted.toString('base64');
    writeSecureStore(store);
    return { success: true, encrypted: true };
  } catch (err) {
    console.error('[Apollo] secure-storage:set error:', err);
    return { success: false, error: String(err) };
  }
});

/** Retrieve and decrypt a stored credential */
handleTrusted('secure-storage:get', (_, key: unknown) => {
  try {
    if (typeof key !== 'string' || !ALLOWED_SECURE_KEYS.has(key)) return null;
    // Reading still works on a basic_text backend so existing installs keep
    // their connections; new writes are refused (see encryptionUnavailableReason).
    if (!safeStorage.isEncryptionAvailable()) return null;
    const store = readSecureStore();
    const encoded = store[key];
    if (!encoded) return null;

    const buffer = Buffer.from(encoded, 'base64');
    return safeStorage.decryptString(buffer);
  } catch (err) {
    console.error('[Apollo] secure-storage:get error:', err);
    return null;
  }
});

/** Remove a stored credential */
handleTrusted('secure-storage:remove', (_, key: unknown) => {
  try {
    if (typeof key !== 'string' || !ALLOWED_SECURE_KEYS.has(key)) return { success: false, error: 'Invalid credential key' };
    const store = readSecureStore();
    if (!(key in store)) return { success: true };
    delete store[key];
    writeSecureStore(store);
    return { success: true };
  } catch (err) {
    console.error('[Apollo] secure-storage:remove error:', err);
    return { success: false, error: String(err) };
  }
});

/** Check if safeStorage encryption is available (false on Linux without a keyring) */
handleTrusted('secure-storage:is-available', () => {
  return encryptionUnavailableReason() === null;
});

// ----- Auto-Updater -----
// Uses electron-updater with GitHub releases. Opt-in only — the renderer
// sends preferences via IPC and the main process respects them.
// macOS builds are not code-signed, so Squirrel.Mac can't apply updates:
// there, updates are manual downloads from the releases page.

/** Whether downloaded updates can be installed by the app on this platform. */
const CAN_AUTO_INSTALL = process.platform !== 'darwin';
/** Where to get an update manually (macOS). */
const MANUAL_DOWNLOAD_URL = `${RELEASES_URL}/latest`;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = isDev ? console : null;

type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

interface UpdateState {
  status: UpdateStatus;
  version: string | null;
  releaseNotes: string | null;
  downloadProgress: number | null;
  error: string | null;
  /** False on macOS: show a "Download from GitHub" link instead of Download/Install. */
  canAutoInstall: boolean;
  /** Releases page for manual updates (macOS), else null. */
  manualDownloadUrl: string | null;
}

const updateState: UpdateState = {
  status: 'idle',
  version: null,
  releaseNotes: null,
  downloadProgress: null,
  error: null,
  canAutoInstall: CAN_AUTO_INSTALL,
  manualDownloadUrl: CAN_AUTO_INSTALL ? null : MANUAL_DOWNLOAD_URL,
};

function sendUpdateState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('updater:state-changed', { ...updateState });
}

autoUpdater.on('checking-for-update', () => {
  updateState.status = 'checking';
  updateState.error = null;
  sendUpdateState();
});

autoUpdater.on('update-available', (info: UpdateInfo) => {
  updateState.status = 'available';
  updateState.version = info.version;
  updateState.releaseNotes = typeof info.releaseNotes === 'string'
    ? info.releaseNotes
    : Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map(n => typeof n === 'string' ? n : n.note).join('\n')
      : null;
  sendUpdateState();
});

autoUpdater.on('update-not-available', () => {
  updateState.status = 'not-available';
  updateState.error = null;
  sendUpdateState();
});

autoUpdater.on('download-progress', (progress) => {
  updateState.status = 'downloading';
  updateState.downloadProgress = Math.round(progress.percent);
  sendUpdateState();
});

autoUpdater.on('update-downloaded', () => {
  updateState.status = 'downloaded';
  updateState.downloadProgress = 100;
  sendUpdateState();
});

autoUpdater.on('error', (err) => {
  updateState.status = 'error';
  updateState.error = err?.message ?? 'Unknown update error';
  sendUpdateState();
});

/** Renderer asks for current update state */
handleTrusted('updater:get-state', () => {
  return { ...updateState };
});

/** Renderer triggers a manual check for updates */
handleTrusted('updater:check', async () => {
  if (isDev) {
    return { ...updateState, status: 'not-available', error: 'Updates disabled in development mode' };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ...updateState };
  } catch (err) {
    updateState.status = 'error';
    updateState.error = err instanceof Error ? err.message : String(err);
    return { ...updateState };
  }
});

/** Renderer triggers download of the available update (not on macOS — manual download there) */
handleTrusted('updater:download', async () => {
  if (!CAN_AUTO_INSTALL || updateState.status !== 'available') return { ...updateState };
  try {
    await autoUpdater.downloadUpdate();
    return { ...updateState };
  } catch (err) {
    updateState.status = 'error';
    updateState.error = err instanceof Error ? err.message : String(err);
    return { ...updateState };
  }
});

/** Install the downloaded update and restart */
handleTrusted('updater:install', () => {
  if (CAN_AUTO_INSTALL && updateState.status === 'downloaded') {
    autoUpdater.quitAndInstall(false, true);
  }
  return { ...updateState };
});

/** Open the GitHub releases page in the OS browser (manual updates on macOS). */
handleTrusted('updater:open-download-page', () => {
  return openExternalIfAllowed(MANUAL_DOWNLOAD_URL);
});

/**
 * Renderer sends auto-update preferences so the main process can
 * act on them (e.g. auto-check + auto-download on launch).
 * Input is validated (only literal booleans); macOS never auto-downloads.
 */
handleTrusted('updater:configure', async (_, rawPrefs: unknown) => {
  if (isDev) return { ...updateState };
  const prefs = parseUpdaterPrefs(rawPrefs);
  const autoDownload = CAN_AUTO_INSTALL && prefs.autoDownload;
  autoUpdater.autoDownload = autoDownload;
  autoUpdater.autoInstallOnAppQuit = autoDownload;
  if (prefs.autoCheck) {
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Non-fatal — user will see error state in UI
    }
  }
  return { ...updateState };
});
