import { useState, useEffect, useRef, useCallback } from 'react';
import { HashRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import './App.css';
import Dashboard from './pages/Dashboard';
import Training from './pages/Training';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
import Activities from './pages/Activities';
import Insights from './pages/Insights';
import WelcomeFlow from './pages/WelcomeFlow';
import AuthStravaCallback from './pages/AuthStravaCallback';
import NotFound from './pages/NotFound';
import RaceStrategyPage from './pages/RaceStrategy';
import { getWelcomeCompleted } from './services/planProgress';
import { runSync } from './services/autoSync';
import { syncPlanCalendarIfChanged } from './services/planCalendarSync';
import {
  getLastActivitySyncTime,
  isActivitySourceConnected,
  isSyncRunning,
} from './services/activitySource';
import {
  APP_PREFS_CHANGED_EVENT,
  getAppPreferences,
  isAutoSyncCooldownElapsed,
  markAutoSyncRan,
} from './services/appPreferences';

const logoUrl = new URL('/assets/logo-1024.png', import.meta.url).href;

function PageWrapper({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <div key={location.pathname} className="page-enter">
      {children}
    </div>
  );
}

function AppShell() {
  const [syncToast, setSyncToast] = useState<string | null>(null);
  const [updateToast, setUpdateToast] = useState<{ message: string; action?: () => void; actionLabel?: string } | null>(null);
  const [prefsVersion, setPrefsVersion] = useState(0);
  const launchSyncRanRef = useRef(false);
  const syncToastTimerRef = useRef<number | undefined>(undefined);
  const updaterConfiguredRef = useRef(false);

  /** Show a sync toast; autoHideMs = 0 keeps it up (progress messages). */
  const showSyncToast = useCallback((message: string | null, autoHideMs: number = 4000) => {
    window.clearTimeout(syncToastTimerRef.current);
    setSyncToast(message);
    if (message && autoHideMs > 0) {
      syncToastTimerRef.current = window.setTimeout(() => setSyncToast(null), autoHideMs);
    }
  }, []);

  // Re-read sync preferences when Settings changes them.
  useEffect(() => {
    const onPrefsChanged = () => setPrefsVersion((v) => v + 1);
    window.addEventListener(APP_PREFS_CHANGED_EVENT, onPrefsChanged);
    return () => window.removeEventListener(APP_PREFS_CHANGED_EVENT, onPrefsChanged);
  }, []);

  // Automatic activity sync (opt-in; turned on when a source is connected):
  // once on launch, then every N minutes while Apollo is open.
  useEffect(() => {
    const prefs = getAppPreferences();
    if (!prefs.autoSyncOnLaunch) return;
    const intervalMs = Math.max(0, prefs.backgroundSyncMinutes) * 60_000;

    const sync = (announce: boolean) => {
      if (!isActivitySourceConnected() || isSyncRunning() || !isAutoSyncCooldownElapsed()) return;
      markAutoSyncRan();
      if (announce) showSyncToast('Syncing activities…', 0);
      runSync({ onProgress: announce ? (p) => showSyncToast(p.message, 0) : undefined })
        .then(({ summary }) => {
          const added = summary?.added ?? 0;
          const error = summary?.errors[0]?.message;
          if (added > 0) {
            showSyncToast(`Synced ${added} new activit${added === 1 ? 'y' : 'ies'}`);
          } else if (!announce) {
            return; // background syncs stay quiet unless something new arrived
          } else if (error) {
            showSyncToast(`Sync problem: ${error}`, 7000);
          } else {
            showSyncToast('Activities are up to date');
          }
        })
        .catch(() => {
          if (announce) showSyncToast('Sync failed — will retry later');
        });
    };

    if (!launchSyncRanRef.current) {
      launchSyncRanRef.current = true;
      sync(true);
    }
    if (intervalMs === 0) return;

    const timer = window.setInterval(() => sync(false), intervalMs);
    // Timers pause while the computer sleeps — catch up on wake, refocus or reconnect.
    const catchUp = () => {
      if (document.visibilityState !== 'visible') return;
      const last = getLastActivitySyncTime();
      if (!last || Date.now() - Date.parse(last) >= intervalMs) sync(false);
    };
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('focus', catchUp);
    window.addEventListener('online', catchUp);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', catchUp);
      window.removeEventListener('focus', catchUp);
      window.removeEventListener('online', catchUp);
    };
  }, [prefsVersion, showSyncToast]);

  // "Send your plan to your watch" auto-update (opt-in, Training page): runs on
  // launch and when Apollo regains focus, independent of activity auto-sync.
  // The service only calls intervals.icu when the plan or paces changed (or a
  // day has passed), and never throws.
  useEffect(() => {
    void syncPlanCalendarIfChanged();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void syncPlanCalendarIfChanged();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  // Configure auto-updater on launch (Electron only, opt-in)
  useEffect(() => {
    if (updaterConfiguredRef.current) return;
    updaterConfiguredRef.current = true;

    const api = window.electronAPI;
    if (!api?.updater) return;

    const prefs = getAppPreferences();
    if (!prefs.autoCheckUpdates) return;

    api.updater.configure({
      autoCheck: true,
      autoDownload: prefs.autoDownloadUpdates,
    });

    const unsub = api.updater.onStateChanged((state) => {
      if (state.status === 'available' && !prefs.autoDownloadUpdates) {
        setUpdateToast({
          message: `Update v${state.version} available`,
          action: () => {
            api.updater.download();
            setUpdateToast({ message: 'Downloading update…' });
          },
          actionLabel: 'Download',
        });
      } else if (state.status === 'downloaded') {
        setUpdateToast({
          message: `Update v${state.version} ready — restart to install`,
          action: () => api.updater.install(),
          actionLabel: 'Restart Now',
        });
      } else if (state.status === 'error') {
        // Silently clear — update errors aren't critical
        setTimeout(() => setUpdateToast(null), 5000);
      }
    });

    return unsub;
  }, []);

  return (
    <div className="app">
      {/* Auto-sync toast notification */}
      {syncToast && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', top: 16, right: 16, zIndex: 9999,
          background: 'var(--bg-elevated, #1B2838)', color: 'var(--text, #E0E0E0)',
          border: '1px solid var(--apollo-teal, #5BB5B5)', borderRadius: 'var(--radius-md, 8px)',
          padding: '0.75rem 1.25rem', fontSize: '0.88rem', fontWeight: 500,
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', gap: '0.5rem',
          animation: 'fadeIn 0.3s ease',
        }}>
          <span aria-hidden="true" style={{ color: 'var(--apollo-teal, #5BB5B5)', fontSize: '1rem' }}>⟳</span>
          {syncToast}
        </div>
      )}

      {/* Auto-update toast notification */}
      {updateToast && (
        <div style={{
          position: 'fixed', top: syncToast ? 72 : 16, right: 16, zIndex: 9998,
          background: 'var(--bg-elevated, #1B2838)', color: 'var(--text, #E0E0E0)',
          border: '1px solid var(--apollo-gold, #E8C05A)', borderRadius: 'var(--radius-md, 8px)',
          padding: '0.75rem 1.25rem', fontSize: '0.88rem', fontWeight: 500,
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', gap: '0.75rem',
          animation: 'fadeIn 0.3s ease',
        }}>
          <span style={{ color: 'var(--apollo-gold, #E8C05A)', fontSize: '1rem' }}>↑</span>
          <span>{updateToast.message}</span>
          {updateToast.action && (
            <button
              type="button"
              onClick={updateToast.action}
              style={{
                background: 'var(--apollo-gold, #E8C05A)', color: '#0D1B2A',
                border: 'none', borderRadius: 'var(--radius-sm, 4px)',
                padding: '0.3rem 0.75rem', fontSize: '0.78rem', fontWeight: 700,
                cursor: 'pointer', fontFamily: 'var(--font-display, inherit)',
                whiteSpace: 'nowrap',
              }}
            >{updateToast.actionLabel}</button>
          )}
          <button
            type="button"
            onClick={() => setUpdateToast(null)}
            style={{
              background: 'none', border: 'none', color: 'var(--text-muted, #888)',
              cursor: 'pointer', fontSize: '1.1rem', padding: '0 0.25rem', lineHeight: 1,
            }}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      <nav className="nav">
        <NavLink to="/" className="nav-brand" end>
          <img src={logoUrl} alt="Apollo" className="nav-brand-logo" />
          <span className="nav-brand-text">Apollo</span>
        </NavLink>
        <div className="nav-links">
          <NavLink to="/" className={({ isActive }) => (isActive ? 'active' : '')} end>
            <span className="nav-icon">◈</span> Dashboard
          </NavLink>
          <NavLink to="/training" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="nav-icon">⚡</span> Training Plan
          </NavLink>
          <NavLink to="/analytics" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="nav-icon">📈</span> Analytics
          </NavLink>
          <NavLink to="/activities" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="nav-icon">🏅</span> Activities
          </NavLink>
          <NavLink to="/insights" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="nav-icon">📊</span> Insights
          </NavLink>
          <NavLink to="/race-strategy" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="nav-icon">🏅</span> Race Strategy
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="nav-icon">⚙</span> Settings
          </NavLink>
        </div>
      </nav>
      <main className="main">
        <PageWrapper>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/training" element={<Training />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/activities" element={<Activities />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/race-strategy" element={<RaceStrategyPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/auth/strava/callback" element={<AuthStravaCallback />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </PageWrapper>
      </main>
    </div>
  );
}

export default function App() {
  const [welcomeDone, setWelcomeDone] = useState(getWelcomeCompleted);

  useEffect(() => {
    setWelcomeDone(getWelcomeCompleted());
  }, []);

  // A file dropped outside an import drop zone must not navigate the window to
  // that file (the browser and Electron default), which would replace Apollo
  // with the file's contents. Drop zones handle the event first and call
  // preventDefault(); drags without files (text, links) are left alone.
  // Lives here, not in AppShell, so onboarding is covered too.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  if (!welcomeDone) {
    return (
      <WelcomeFlow
        onComplete={() => setWelcomeDone(true)}
      />
    );
  }

  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}
