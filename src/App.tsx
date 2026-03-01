import { useState, useEffect, useRef } from 'react';
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
import { getStravaTokens } from './services/storage';
import { runAutoSync } from './services/autoSync';
import {
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
  const autoSyncRanRef = useRef(false);
  const updaterConfiguredRef = useRef(false);

  // Auto-sync Strava on launch (opt-in)
  useEffect(() => {
    if (autoSyncRanRef.current) return;
    autoSyncRanRef.current = true;

    const prefs = getAppPreferences();
    if (!prefs.autoSyncOnLaunch) return;
    if (!getStravaTokens()) return;
    if (!isAutoSyncCooldownElapsed()) return;

    setSyncToast('Syncing Strava activities…');
    runAutoSync()
      .then((results) => {
        markAutoSyncRan();
        const newCount = results.filter((r) => r.isNew).length;
        if (newCount > 0) {
          setSyncToast(`Synced ${newCount} new activit${newCount === 1 ? 'y' : 'ies'} from Strava`);
        } else {
          setSyncToast('Strava is up to date');
        }
        setTimeout(() => setSyncToast(null), 4000);
      })
      .catch(() => {
        setSyncToast('Strava sync failed — will retry next launch');
        setTimeout(() => setSyncToast(null), 4000);
      });
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
        <div style={{
          position: 'fixed', top: 16, right: 16, zIndex: 9999,
          background: 'var(--bg-elevated, #1B2838)', color: 'var(--text, #E0E0E0)',
          border: '1px solid var(--strava, #FC4C02)', borderRadius: 'var(--radius-md, 8px)',
          padding: '0.75rem 1.25rem', fontSize: '0.88rem', fontWeight: 500,
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', gap: '0.5rem',
          animation: 'fadeIn 0.3s ease',
        }}>
          <span style={{ color: 'var(--strava, #FC4C02)', fontSize: '1rem' }}>⟳</span>
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
