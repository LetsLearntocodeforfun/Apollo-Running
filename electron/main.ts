import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import http from 'http';
import url from 'url';

let mainWindow: BrowserWindow | null = null;
let oauthServer: http.Server | null = null;

const isDev = process.env.NODE_ENV !== 'production' || !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Apollo',
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
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
const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const OAUTH_CALLBACK_PORT = 45678;
const STRAVA_SCOPES = 'activity:read_all,activity:write,profile:read_all';

function startOAuthServer(): Promise<{ code: string; scope?: string }> {
  return new Promise((resolve, reject) => {
    if (oauthServer) {
      oauthServer.close();
      oauthServer = null;
    }
    oauthServer = http.createServer((req, res) => {
      const parsed = url.parse(req.url || '', true);
      if (parsed.pathname === '/callback' && parsed.query.code) {
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
    oauthServer.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => {});
    oauthServer.on('error', reject);
  });
}

ipcMain.handle('strava:get-auth-url', (_, clientId: string) => {
  const redirectUri = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`;
  return `${STRAVA_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(STRAVA_SCOPES)}&approval_prompt=force`;
});

ipcMain.handle('strava:exchange-code', async (_, { clientId, clientSecret, code }: { clientId: string; clientSecret: string; code: string }) => {
  const redirectUri = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`;
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

ipcMain.handle('open-external', (_, url: string) => {
  shell.openExternal(url);
});
