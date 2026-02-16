/// <reference types="vite/client" />

interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete: { id: number; firstname: string; lastname: string; profile: string };
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
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
