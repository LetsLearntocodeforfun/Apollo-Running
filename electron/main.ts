import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import url from 'url';

let mainWindow: BrowserWindow | null = null;
let oauthServer: http.Server | null = null;

const isDev = !app.isPackaged;
const OAUTH_CALLBACK_PORT = 45678;
const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_SCOPES = 'activity:read_all,activity:write,profile:read_all';

// Debug paths (only in development)
if (isDev) {
  console.log('App is packaged:', app.isPackaged);
  console.log('App path:', app.getAppPath());
  console.log('Exec path:', process.execPath);
  console.log('CWD:', process.cwd());
  console.log('__dirname:', __dirname);
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'public', 'assets', 'logo-256.png');
  // Preload is emitted to dist-electron/preload.js (same dir level as main.js)
  const preloadPath = path.join(__dirname, 'preload.js');
  
  // Log important paths for debugging (dev only)
  if (isDev) {
    console.log('App path:', app.getAppPath());
    console.log('Exec path:', process.execPath);
    console.log('Resources path:', process.resourcesPath);
    console.log('Preload path:', preloadPath);
    console.log('Icon path:', iconPath);
  }

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
      devTools: true,
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
        console.log('Development mode: Loading from dev server...');
        await mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
      } catch (error) {
        console.error('Failed to load dev server:', error);
      }
    } else {
      try {
        console.log('Production mode: Attempting to load index.html...');
        
        // In production, prefer app.asar (app.getAppPath()) and fall back to unpacked/dev paths
        const appPath = app.getAppPath(); // points to app.asar in packaged build
        const possibleIndexPaths = [
          path.join(appPath, 'dist', 'index.html'), // packaged (asar)
          path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html'), // explicit asar path
          path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'index.html'), // unpacked fallback
          path.join(__dirname, '..', 'dist', 'index.html'), // dev/dir run fallback
        ];

        console.log('Trying to load from possible paths:', possibleIndexPaths);
        
        let loaded = false;
        for (const indexPath of possibleIndexPaths) {
          try {
            console.log('Attempting to load from:', indexPath);
            const exists = fs.existsSync(indexPath);
            console.log(`File exists at ${indexPath}:`, exists);
            
            if (exists) {
              // First try with loadFile
              try {
                await mainWindow.loadFile(indexPath);
                console.log(`Successfully loaded with loadFile: ${indexPath}`);
                loaded = true;
                break;
              } catch (loadFileError) {
                console.warn(`loadFile failed for ${indexPath}:`, (loadFileError as Error).message);
                
                // Try with loadURL as fallback
                const fileUrl = `file://${indexPath.replace(/\\/g, '/')}`;
                console.log(`Trying fallback with loadURL: ${fileUrl}`);
                await mainWindow.loadURL(fileUrl);
                console.log(`Successfully loaded with loadURL: ${fileUrl}`);
                loaded = true;
                break;
              }
            }
          } catch (err) {
            console.warn(`Failed to load from ${indexPath}:`, err.message);
          }
        }

        if (!loaded) {
          throw new Error('Failed to load index.html from any known location');
        }
      } catch (error) {
        console.error('Failed to load app:', error);

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
                <pre>${error.message}\n\n${error.stack || 'No stack trace available'}</pre>
                <p>App path: ${app.getAppPath()}</p>
                <p>Resources path: ${process.resourcesPath}</p>
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
