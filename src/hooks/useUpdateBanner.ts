import { useCallback, useEffect, useRef, useState } from 'react';
import { getAppPreferences } from '../services/appPreferences';

/** GitHub Releases page of the desktop app (already listed in networkInventory as 'github-releases'). */
export const RELEASES_PAGE_URL = 'https://github.com/LetsLearntocodeforfun/Apollo-Running/releases/latest';

/**
 * macOS builds are ad-hoc signed, so Squirrel.Mac rejects every downloaded
 * update (sync review B3/S7). On macOS the banner offers the download page
 * instead of downloading ~120 MB that can never install.
 */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
}

export interface UpdateBanner {
  tone: 'info' | 'success' | 'error';
  message: string;
  /** A button, e.g. "Download" or "Restart now". */
  action?: { label: string; run: () => void };
  /** Show an "Open download page" link to the releases page. */
  showDownloadPage: boolean;
}

/** Banner for an updater state, or null when there is nothing to say. Pure, for tests. */
export function bannerForUpdateState(
  state: UpdateState,
  opts: { mac: boolean; autoDownload: boolean; download: () => void; install: () => void },
): UpdateBanner | null {
  const version = state.version ? `Apollo ${state.version}` : 'A new version of Apollo';
  switch (state.status) {
    case 'available':
      if (opts.mac) {
        return {
          tone: 'info',
          message: `${version} is available. On macOS, download it from the releases page and replace the app.`,
          showDownloadPage: true,
        };
      }
      if (opts.autoDownload) return null; // the download starts by itself; progress follows
      return { tone: 'info', message: `${version} is available.`, action: { label: 'Download', run: opts.download }, showDownloadPage: false };
    case 'downloading':
      return {
        tone: 'info',
        message: `Downloading update${state.downloadProgress != null ? ` (${state.downloadProgress}%)` : ''}…`,
        showDownloadPage: false,
      };
    case 'downloaded':
      return { tone: 'success', message: `${version} is ready. Restart to install it.`, action: { label: 'Restart now', run: opts.install }, showDownloadPage: false };
    case 'error':
      return {
        tone: 'error',
        message: `The update couldn't be installed${state.error ? `: ${state.error}` : '.'} You can download the new version from the releases page.`,
        showDownloadPage: true,
      };
    default:
      return null;
  }
}

/**
 * Desktop auto-update (opt-in in Settings › About): configures the updater on
 * launch and turns its state into a banner for the shell's status region.
 * Errors stay visible until dismissed (they used to be cleared silently).
 */
export function useUpdateBanner(): { banner: UpdateBanner | null; dismiss: () => void } {
  const [banner, setBanner] = useState<UpdateBanner | null>(null);
  const configuredRef = useRef(false);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api?.updater) return;
    const prefs = getAppPreferences();
    if (!prefs.autoCheckUpdates) return;

    const mac = isMacPlatform();
    const autoDownload = prefs.autoDownloadUpdates && !mac;
    const download = () => { void api.updater.download(); };
    const install = () => { void api.updater.install(); };

    // Subscribe on every run (StrictMode mounts twice); configure only once.
    const unsubscribe = api.updater.onStateChanged((state) => {
      setBanner(bannerForUpdateState(state, { mac, autoDownload, download, install }));
    });
    if (!configuredRef.current) {
      configuredRef.current = true;
      void api.updater.configure({ autoCheck: true, autoDownload }).catch(() => { /* reported via state */ });
    }
    return unsubscribe;
  }, []);

  const dismiss = useCallback(() => setBanner(null), []);
  return { banner, dismiss };
}
