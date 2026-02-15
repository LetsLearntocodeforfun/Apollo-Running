import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import './App.css';
import Dashboard from './pages/Dashboard';
import Training from './pages/Training';
import Settings from './pages/Settings';
import Activities from './pages/Activities';
import Insights from './pages/Insights';
import WelcomeFlow from './pages/WelcomeFlow';
import AuthStravaCallback from './pages/AuthStravaCallback';
import NotFound from './pages/NotFound';
import { getWelcomeCompleted } from './services/planProgress';

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
      <div className="app">
        <nav className="nav">
          <div className="nav-brand">Apollo</div>
          <NavLink to="/" className={({ isActive }) => (isActive ? 'active' : '')} end>Dashboard</NavLink>
          <NavLink to="/training" className={({ isActive }) => (isActive ? 'active' : '')}>Training Plan</NavLink>
          <NavLink to="/activities" className={({ isActive }) => (isActive ? 'active' : '')}>Activities</NavLink>
          <NavLink to="/insights" className={({ isActive }) => (isActive ? 'active' : '')}>Insights</NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>Settings</NavLink>
        </nav>
        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/training" element={<Training />} />
            <Route path="/activities" element={<Activities />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/auth/strava/callback" element={<AuthStravaCallback />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
