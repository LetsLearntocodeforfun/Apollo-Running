import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  strava: {
    getAuthUrl: (clientId: string) => ipcRenderer.invoke('strava:get-auth-url', clientId),
    exchangeCode: (payload: { clientId: string; clientSecret: string; code: string }) =>
      ipcRenderer.invoke('strava:exchange-code', payload),
    refreshToken: (payload: { clientId: string; clientSecret: string; refreshToken: string }) =>
      ipcRenderer.invoke('strava:refresh-token', payload),
  },
  oauth: {
    startServer: () => ipcRenderer.invoke('oauth:start-server'),
  },
  garmin: {
    getAuthUrl: (config: { clientId: string; codeChallenge: string; state: string }) =>
      ipcRenderer.invoke('garmin:get-auth-url', config),
    exchangeCode: (payload: unknown) => ipcRenderer.invoke('garmin:exchange-code', payload),
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
});
