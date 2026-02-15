import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('electronAPI', {
    strava: {
        getAuthUrl: function (clientId) { return ipcRenderer.invoke('strava:get-auth-url', clientId); },
        exchangeCode: function (payload) {
            return ipcRenderer.invoke('strava:exchange-code', payload);
        },
        refreshToken: function (payload) {
            return ipcRenderer.invoke('strava:refresh-token', payload);
        },
    },
    oauth: {
        startServer: function () { return ipcRenderer.invoke('oauth:start-server'); },
    },
    garmin: {
        getAuthUrl: function (config) {
            return ipcRenderer.invoke('garmin:get-auth-url', config);
        },
        exchangeCode: function (payload) { return ipcRenderer.invoke('garmin:exchange-code', payload); },
    },
    openExternal: function (url) { return ipcRenderer.invoke('open-external', url); },
});
