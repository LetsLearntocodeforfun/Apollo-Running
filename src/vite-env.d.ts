/// <reference types="vite/client" />

declare global {
  interface StravaTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    athlete: { id: number; firstname: string; lastname: string; profile: string };
  }

  /** Reply of `garmin:obtain-token` (electron/main.ts). */
  interface GarminTokenReply {
    ok: boolean;
    /** HTTP status, or 0 when Garmin couldn't be reached. */
    status: number;
    retryAfter: number | null;
    /** Bearer token (a JWT) when ok. */
    token?: string;
    /** 'network' | 'timeout' | 'too-large' | 'bad-token' … (never secret). */
    error?: string;
  }

  /** A `garmin:request` call: an allow-listed GET (electron/garminProxy.ts). */
  interface GarminProxyRequest {
    path: string;
    query?: Record<string, string | number | boolean>;
    accessToken: string;
    /** 'file' for original activity files (bytes); JSON otherwise. */
    accept?: 'json' | 'file';
  }

  /** Reply of `garmin:request`. */
  interface GarminProxyReply {
    ok: boolean;
    /** HTTP status, or 0 when Garmin couldn't be reached. */
    status: number;
    retryAfter: number | null;
    /** JSON (and error) bodies as text. */
    text?: string;
    /** File downloads (`accept: 'file'`). */
    bytes?: Uint8Array;
    error?: string;
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
      refreshToken: (p: {
        clientId: string;
        clientSecret: string;
        refreshToken: string;
      }) => Promise<StravaTokenResponse>;
    };
    oauth: { startServer: () => Promise<{ code: string; scope?: string }> };
    /** v1.0.8 (DS-01): Garmin Connect Personal API, proxied by the main process (Garmin blocks CORS). */
    garmin: {
      obtainToken: (apiKey: string) => Promise<GarminTokenReply>;
      request: (req: GarminProxyRequest) => Promise<GarminProxyReply>;
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
    /** v1.0.7 (PX-12): run a flush before the window closes or the app quits. Optional for older builds. */
    lifecycle?: {
      onBeforeClose: (flush: () => Promise<void> | void) => () => void;
    };
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
