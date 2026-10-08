/// <reference types="vite/client" />

declare global {
  interface StravaTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    athlete: { id: number; firstname: string; lastname: string; profile: string };
  }

  interface UpdateState {
    status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
    version: string | null;
    releaseNotes: string | null;
    downloadProgress: number | null;
    error: string | null;
    /** False where the app can't update itself (macOS without code signing): open the download page instead. */
    canAutoInstall?: boolean;
    /** Release page to open when canAutoInstall is false. */
    manualDownloadUrl?: string | null;
  }

  interface ElectronAPI {
    strava: {
      getAuthUrl: (clientId: string) => Promise<string>;
      exchangeCode: (p: { clientId: string; clientSecret: string; code: string }) => Promise<StravaTokenResponse>;
      refreshToken: (p: { clientId: string; clientSecret: string; refreshToken: string }) => Promise<StravaTokenResponse>;
    };
    oauth: { startServer: () => Promise<{ code: string; scope?: string }> };
    garmin: {
      getAuthUrl: (config: { clientId: string; codeChallenge: string; state: string }) => Promise<string | null>;
      exchangeCode: (p: unknown) => Promise<{ error?: string }>;
    };
    openExternal: (url: string) => Promise<void>;
    secureStorage: {
      set: (key: string, value: string) => Promise<{ success: boolean; encrypted?: boolean; error?: string }>;
      get: (key: string) => Promise<string | null>;
      remove: (key: string) => Promise<{ success: boolean; error?: string }>;
      isAvailable: () => Promise<boolean>;
    };
    updater: {
      getState: () => Promise<UpdateState>;
      check: () => Promise<UpdateState>;
      download: () => Promise<UpdateState>;
      install: () => Promise<UpdateState>;
      configure: (prefs: { autoCheck: boolean; autoDownload: boolean }) => Promise<UpdateState>;
      /** Opens this repository's latest release page in the system browser (macOS manual update). */
      openDownloadPage: () => Promise<boolean>;
      onStateChanged: (callback: (state: UpdateState) => void) => () => void;
    };
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
