import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
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
import { getWelcomeCompleted } from './services/planProgress';

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
  return (
    <div className="app">
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
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
