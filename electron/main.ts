import { app, BrowserWindow, ipcMain, shell, safeStorage } from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import url from 'url';

let mainWindow: BrowserWindow | null = null;
let oauthServer: http.Server | null = null;
let oauthState: string | null = null;
let oauthPort: number | null = null;

const isDev = !app.isPackaged;
const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_SCOPES = 'activity:read_all,activity:write,profile:read_all';

function logDev(...args: unknown[]): void {
  if (isDev) {
    console.log('[Apollo Main]', ...args);
  }
}

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
  const iconPath = path.join(__dirname, '..', 'public', 'assets', 'logo-256.png');
  // Preload is emitted to dist-electron/preload.js (same dir level as main.js)
  const preloadPath = path.join(__dirname, 'preload.js');

  logDev('Runtime paths', {
    appPath: app.getAppPath(),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    preloadPath,
    iconPath,
  });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false, // Don't show until content is ready
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: !isDev, // Enable webSecurity in production
      // Enable these for better debugging in production
      devTools: isDev,
      nodeIntegrationInWorker: false,
      webviewTag: false,
    },
    title: 'Apollo',
    backgroundColor: '#0D1B2A',
    icon: iconPath
  });
  
  // Show window when page is ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Load the app
  const loadApp = async () => {
    if (isDev) {
      try {
        logDev('Loading app from Vite dev server');
        await mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
      } catch (error) {
        console.error('Failed to load dev server:', error);
      }
    } else {
      try {
        await loadProductionWindow(mainWindow);
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
        
        await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`);
      }
    }
    
  };
  
  // Start the app
  loadApp().catch(error => {
    console.error('Failed to load app:', error);
    app.quit();
  });

  mainWindow.on('closed', () => { 
    mainWindow = null; 
    if (oauthServer) {
      oauthServer.close();
      oauthServer = null;
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (oauthServer) {
    oauthServer.close();
    oauthServer = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ----- Strava OAuth -----

/** Generate a cryptographically random state string for OAuth CSRF protection. */
function generateOAuthState(): string {
  return require('crypto').randomBytes(32).toString('hex');
}

function startOAuthServer(): Promise<{ code: string; scope?: string }> {
  return new Promise((resolve, reject) => {
    if (oauthServer) {
      oauthServer.close();
      oauthServer = null;
    }
    oauthServer = http.createServer((req, res) => {
      const parsed = url.parse(req.url || '', true);
      if (parsed.pathname === '/callback' && parsed.query.code) {
        // Validate CSRF state parameter
        if (!oauthState || parsed.query.state !== oauthState) {
          res.writeHead(403, { 'Content-Type': 'text/html' });
          res.end(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px;">
              <h2>Authentication failed</h2>
              <p>Invalid state parameter. Please try connecting again from the app.</p>
            </body></html>
          `);
          return;
        }
        oauthState = null; // Consume the state (one-time use)
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family:sans-serif;text-align:center;padding:40px;">
            <h2>Strava connected</h2>
            <p>You can close this window and return to the app.</p>
          </body></html>
        `);
        resolve({
          code: parsed.query.code as string,
          scope: parsed.query.scope as string | undefined,
        });
        setTimeout(() => {
          oauthServer?.close();
          oauthServer = null;
        }, 500);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    // Use a random ephemeral port instead of a hardcoded one
    oauthServer.listen(0, '127.0.0.1', () => {
      const addr = oauthServer!.address();
      oauthPort = typeof addr === 'object' && addr ? addr.port : null;
    });
    oauthServer.on('error', reject);
  });
}

ipcMain.handle('strava:get-auth-url', (_, clientId: string) => {
  if (!oauthPort) return null;
  oauthState = generateOAuthState();
  const redirectUri = `http://127.0.0.1:${oauthPort}/callback`;
  return `${STRAVA_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(STRAVA_SCOPES)}&approval_prompt=force&state=${encodeURIComponent(oauthState)}`;
});

ipcMain.handle('strava:exchange-code', async (_, { clientId, clientSecret, code }: { clientId: string; clientSecret: string; code: string }) => {
  if (!oauthPort) throw new Error('OAuth server is not running');
  const redirectUri = `http://127.0.0.1:${oauthPort}/callback`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
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

ipcMain.handle('strava:refresh-token', async (_, { clientId, clientSecret, refreshToken }: { clientId: string; clientSecret: string; refreshToken: string }) => {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
  return res.json();
});

ipcMain.handle('oauth:start-server', () => startOAuthServer());

// Garmin: placeholder for when you have API access (OAuth 2.0 + PKCE)
ipcMain.handle('garmin:get-auth-url', (_, _config: { clientId: string; codeChallenge: string; state: string }) => {
  // Garmin uses PKCE; implement when you have Garmin Developer Program access
  return null;
});

ipcMain.handle('garmin:exchange-code', async () => {
  return { error: 'Garmin integration requires Garmin Connect Developer Program approval.' };
});

ipcMain.handle('open-external', (_, targetUrl: string) => {
  // Only allow http/https URLs to prevent opening arbitrary protocols
  try {
    const parsed = new URL(targetUrl);
    const TRUSTED_DOMAINS = ['strava.com', 'www.strava.com', 'connect.garmin.com'];
    if (parsed.protocol === 'https:' && TRUSTED_DOMAINS.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
      shell.openExternal(targetUrl);
    }
  } catch {
    // invalid URL — ignore
  }
});

// ----- Secure Credential Storage (safeStorage API) -----
// Uses Electron's OS-level encryption (DPAPI on Windows, Keychain on macOS,
// libsecret on Linux) to encrypt sensitive OAuth credentials at rest.
// Encrypted blobs are stored as Base64 in a local JSON file inside the
// app's userData directory — never in localStorage or IndexedDB.

const SECURE_STORE_PATH = path.join(app.getPath('userData'), 'secure-credentials.json');

/** Read the encrypted credentials file from disk */
function readSecureStore(): Record<string, string> {
  try {
    if (fs.existsSync(SECURE_STORE_PATH)) {
      const raw = fs.readFileSync(SECURE_STORE_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {
    // corrupted file — start fresh
  }
  return {};
}

/** Write the encrypted credentials file to disk */
function writeSecureStore(store: Record<string, string>): void {
  try {
    const dir = path.dirname(SECURE_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SECURE_STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Apollo] Failed to write secure store:', err);
  }
}

/** Store a credential securely using OS-level encryption */
ipcMain.handle('secure-storage:set', (_, key: string, value: string) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        success: false,
        error: 'OS-level encryption is unavailable. Refusing to store sensitive credentials insecurely.',
      };
    }
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
ipcMain.handle('secure-storage:get', (_, key: string) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return null;
    }
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
ipcMain.handle('secure-storage:remove', (_, key: string) => {
  try {
    const store = readSecureStore();
    delete store[key];
    writeSecureStore(store);
    return { success: true };
  } catch (err) {
    console.error('[Apollo] secure-storage:remove error:', err);
    return { success: false, error: String(err) };
  }
});

/** Check if safeStorage encryption is available */
ipcMain.handle('secure-storage:is-available', () => {
  return safeStorage.isEncryptionAvailable();
});
