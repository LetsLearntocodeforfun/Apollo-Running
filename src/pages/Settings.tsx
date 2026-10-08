/**
 * Settings (v1.0.6) — a shell of URL tabs: `/settings?tab=connections|sync|
 * profile|coaching|data|about` (unknown or missing → connections). Each tab
 * lives in src/pages/settings/ and reports feedback right next to its own
 * actions (no page-level banners).
 */

import { useSearchParams } from 'react-router-dom';
import { TabPanel, Tabs } from '../components/ui';
import ConnectionsTab from './settings/ConnectionsTab';
import SyncTab from './settings/SyncTab';
import ProfileTab from './settings/ProfileTab';
import CoachingTab from './settings/CoachingTab';
import DataTab from './settings/DataTab';
import AboutTab from './settings/AboutTab';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  isSettingsTabId,
  useKeychainError,
  type SettingsTabId,
} from './settings/shared';
import './settings/settings.css';

const TAB_ID_PREFIX = 'settings';
const TAB_ITEMS = SETTINGS_TABS.map((t) => ({ id: t.id, label: t.label }));

function ActiveTab({ tab }: { tab: SettingsTabId }) {
  switch (tab) {
    case 'sync': return <SyncTab />;
    case 'profile': return <ProfileTab />;
    case 'coaching': return <CoachingTab />;
    case 'data': return <DataTab />;
    case 'about': return <AboutTab />;
    case 'connections':
    default:
      return <ConnectionsTab />;
  }
}

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const activeTab: SettingsTabId = isSettingsTabId(requested) ? requested : DEFAULT_SETTINGS_TAB;
  const keychainError = useKeychainError();

  /** Keep the selected tab in `?tab=` (replacing history, preserving other params). */
  const selectTab = (id: string) => {
    if (!isSettingsTabId(id)) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', id);
      return next;
    }, { replace: true });
  };

  return (
    <div className="settings-page">
      <h1 className="page-title" tabIndex={-1}>Settings</h1>
      {keychainError && window.electronAPI && (
        <div className="card settings-card settings-card--gold settings-keychain" role="alert">
          <p className="settings-keychain-text">
            <strong className="settings-keychain-title">Sign-in not saved:</strong>{' '}
            your system keychain isn&apos;t available, so Apollo can&apos;t store your connection details securely.
            You&apos;re connected for this session, but you&apos;ll need to reconnect after restarting Apollo.
            On Linux, install or unlock a keyring such as GNOME Keyring or KWallet.
          </p>
          <p className="settings-hint">Details: {keychainError}</p>
        </div>
      )}
      <Tabs
        idPrefix={TAB_ID_PREFIX}
        label="Settings sections"
        tabs={TAB_ITEMS}
        value={activeTab}
        onChange={selectTab}
        className="settings-tabs"
      />
      <TabPanel idPrefix={TAB_ID_PREFIX} id={activeTab} className="settings-panel">
        <ActiveTab tab={activeTab} />
      </TabPanel>
    </div>
  );
}
