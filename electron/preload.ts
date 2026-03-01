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
  secureStorage: {
    /** Store a value encrypted with OS-level encryption (DPAPI / Keychain / libsecret) */
    set: (key: string, value: string): Promise<{ success: boolean; encrypted?: boolean; error?: string }> =>
      ipcRenderer.invoke('secure-storage:set', key, value),
    /** Retrieve and decrypt a stored value */
    get: (key: string): Promise<string | null> =>
      ipcRenderer.invoke('secure-storage:get', key),
    /** Remove a stored value */
    remove: (key: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('secure-storage:remove', key),
    /** Check if OS-level encryption is available */
    isAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke('secure-storage:is-available'),
  },
  updater: {
    /** Get current update state */
    getState: (): Promise<UpdateState> =>
      ipcRenderer.invoke('updater:get-state'),
    /** Manually check for updates */
    check: (): Promise<UpdateState> =>
      ipcRenderer.invoke('updater:check'),
    /** Download an available update */
    download: (): Promise<UpdateState> =>
      ipcRenderer.invoke('updater:download'),
    /** Install downloaded update and restart */
    install: (): Promise<UpdateState> =>
      ipcRenderer.invoke('updater:install'),
    /** Send auto-update preferences to main process */
    configure: (prefs: { autoCheck: boolean; autoDownload: boolean }): Promise<UpdateState> =>
      ipcRenderer.invoke('updater:configure', prefs),
    /** Listen for update state changes from the main process */
    onStateChanged: (callback: (state: UpdateState) => void): (() => void) => {
      const handler = (_event: unknown, state: UpdateState) => callback(state);
      ipcRenderer.on('updater:state-changed', handler);
      return () => ipcRenderer.removeListener('updater:state-changed', handler);
    },
  },
});

// Type used by the updater bridge (mirrors main process UpdateState)
interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  version: string | null;
  releaseNotes: string | null;
  downloadProgress: number | null;
  error: string | null;
}
