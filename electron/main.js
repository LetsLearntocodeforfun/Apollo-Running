var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import http from 'http';
import url from 'url';
var mainWindow = null;
var oauthServer = null;
var isDev = process.env.NODE_ENV !== 'production' || !app.isPackaged;
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
    }
    else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }
    mainWindow.on('closed', function () { mainWindow = null; });
}
app.whenReady().then(createWindow);
app.on('window-all-closed', function () {
    if (oauthServer) {
        oauthServer.close();
        oauthServer = null;
    }
    if (process.platform !== 'darwin')
        app.quit();
});
app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0)
        createWindow();
});
// ----- Strava OAuth -----
var STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
var STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
var OAUTH_CALLBACK_PORT = 45678;
var STRAVA_SCOPES = 'activity:read_all,activity:write,profile:read_all';
function startOAuthServer() {
    return new Promise(function (resolve, reject) {
        if (oauthServer) {
            oauthServer.close();
            oauthServer = null;
        }
        oauthServer = http.createServer(function (req, res) {
            var parsed = url.parse(req.url || '', true);
            if (parsed.pathname === '/callback' && parsed.query.code) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end("\n          <html><body style=\"font-family:sans-serif;text-align:center;padding:40px;\">\n            <h2>Strava connected</h2>\n            <p>You can close this window and return to the app.</p>\n          </body></html>\n        ");
                resolve({
                    code: parsed.query.code,
                    scope: parsed.query.scope,
                });
                setTimeout(function () {
                    oauthServer === null || oauthServer === void 0 ? void 0 : oauthServer.close();
                    oauthServer = null;
                }, 500);
            }
            else {
                res.writeHead(404);
                res.end();
            }
        });
        oauthServer.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', function () { });
        oauthServer.on('error', reject);
    });
}
ipcMain.handle('strava:get-auth-url', function (_, clientId) {
    var redirectUri = "http://127.0.0.1:".concat(OAUTH_CALLBACK_PORT, "/callback");
    return "".concat(STRAVA_AUTH_URL, "?client_id=").concat(clientId, "&redirect_uri=").concat(encodeURIComponent(redirectUri), "&response_type=code&scope=").concat(encodeURIComponent(STRAVA_SCOPES), "&approval_prompt=force");
});
ipcMain.handle('strava:exchange-code', function (_1, _a) { return __awaiter(void 0, [_1, _a], void 0, function (_, _b) {
    var redirectUri, body, res, err;
    var clientId = _b.clientId, clientSecret = _b.clientSecret, code = _b.code;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                redirectUri = "http://127.0.0.1:".concat(OAUTH_CALLBACK_PORT, "/callback");
                body = new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    code: code,
                    grant_type: 'authorization_code',
                    redirect_uri: redirectUri,
                });
                return [4 /*yield*/, fetch(STRAVA_TOKEN_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: body.toString(),
                    })];
            case 1:
                res = _c.sent();
                if (!!res.ok) return [3 /*break*/, 3];
                return [4 /*yield*/, res.text()];
            case 2:
                err = _c.sent();
                throw new Error(err || "HTTP ".concat(res.status));
            case 3: return [2 /*return*/, res.json()];
        }
    });
}); });
ipcMain.handle('strava:refresh-token', function (_1, _a) { return __awaiter(void 0, [_1, _a], void 0, function (_, _b) {
    var body, res;
    var clientId = _b.clientId, clientSecret = _b.clientSecret, refreshToken = _b.refreshToken;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                body = new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                });
                return [4 /*yield*/, fetch(STRAVA_TOKEN_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: body.toString(),
                    })];
            case 1:
                res = _c.sent();
                if (!res.ok)
                    throw new Error("Refresh failed: ".concat(res.status));
                return [2 /*return*/, res.json()];
        }
    });
}); });
ipcMain.handle('oauth:start-server', function () { return startOAuthServer(); });
// Garmin: placeholder for when you have API access (OAuth 2.0 + PKCE)
ipcMain.handle('garmin:get-auth-url', function (_, _config) {
    // Garmin uses PKCE; implement when you have Garmin Developer Program access
    return null;
});
ipcMain.handle('garmin:exchange-code', function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        return [2 /*return*/, { error: 'Garmin integration requires Garmin Connect Developer Program approval.' }];
    });
}); });
ipcMain.handle('open-external', function (_, url) {
    shell.openExternal(url);
});
