/**
 * App shell (v1.0.6): six-item navigation, lazy routes, legacy redirects that
 * keep the query string, focus/title on navigation, the Race Day countdown
 * badge and the always-mounted status banners (storage, reconnect, updates).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../App';
import ErrorBoundary from '../components/ErrorBoundary';
import { setWelcomeCompleted } from '../services/planProgress';
import { setMyRace } from '../services/myRace';
import { clearStorageDegraded, markStorageDegraded } from '../services/storageHealth';
import { clearNeedsReconnect, setNeedsReconnect } from '../services/connectionHealth';
import { addDays, todayKey } from '../utils/localDate';
import { bannerForUpdateState } from '../hooks/useUpdateBanner';
import { useStoreVersion } from '../hooks/useStoreVersion';
import { documentTitleForPath, pageTitleForPath } from '../hooks/useRouteChangeEffects';

vi.mock('../pages/Dashboard', () => ({ default: () => <h1>Today stub</h1> }));
vi.mock('../pages/Training', () => ({ default: () => <h1>Plan stub</h1> }));
vi.mock('../pages/Progress', () => ({ default: () => <h1>Progress stub</h1> }));
vi.mock('../pages/Activities', () => ({ default: () => <h1>Activities stub</h1> }));
vi.mock('../pages/RaceDay', () => ({ default: () => <h1>Race stub</h1> }));
vi.mock('../pages/Settings', () => ({ default: () => <h1>Settings stub</h1> }));
vi.mock('../pages/WelcomeFlow', () => ({
  default: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" onClick={onComplete}>Finish welcome</button>
  ),
}));
vi.mock('../services/planCalendarSync', () => ({ syncPlanCalendarIfChanged: vi.fn(() => Promise.resolve()) }));

function renderAt(hash: string) {
  window.location.hash = hash;
  return render(<App />);
}

const mainNav = () => screen.getByRole('navigation', { name: 'Main' });
/** Lazy pages can take a while to load under a busy full-suite run. */
const findHeading = (name: string) => screen.findByRole('heading', { name }, { timeout: 5000 });

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  setWelcomeCompleted(true);
});

afterEach(() => {
  clearStorageDegraded();
  clearNeedsReconnect('intervals');
  window.location.hash = '';
});

describe('navigation', () => {
  it('renders the six destinations in journey order; the brand is never the current page (B9)', async () => {
    renderAt('#/');
    await findHeading('Today stub');

    const items = within(mainNav()).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Today', 'Plan', 'Activities', 'Progress', 'Race Day', 'Settings']);

    expect(within(mainNav()).getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
    const brand = within(mainNav()).getByRole('link', { name: 'Apollo' });
    expect(brand.getAttribute('aria-current')).toBeNull();
    expect(brand.querySelector('img')?.getAttribute('alt')).toBe('');
    // Icons are decorative.
    for (const svg of Array.from(mainNav().querySelectorAll('svg'))) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('shows the onboarding flow until welcome is completed', async () => {
    setWelcomeCompleted(false);
    renderAt('#/');
    fireEvent.click(await screen.findByRole('button', { name: 'Finish welcome' }));
    await findHeading('Today stub');
  });

  it('renders the not-found page inside the shell for unknown routes', async () => {
    renderAt('#/nope');
    await findHeading('Page not found');
    expect(mainNav()).toBeTruthy();
  });

  it.each([
    ['#/training?tab=calendar', '#/plan?tab=calendar', 'Plan stub'],
    ['#/analytics', '#/progress?tab=trends', 'Progress stub'],
    ['#/analytics?tab=heart-rate', '#/progress?tab=heart-rate', 'Progress stub'],
    ['#/insights', '#/progress', 'Progress stub'],
    ['#/race-strategy?tab=fuel', '#/race?tab=fuel', 'Race stub'],
  ])('redirects %s to %s, keeping the query string', async (from, to, heading) => {
    renderAt(from);
    await findHeading(heading);
    expect(window.location.hash).toBe(to);
  });

  it('moves focus to the new page heading, sets the title and resets scroll after navigating', async () => {
    renderAt('#/');
    const today = await findHeading('Today stub');
    expect(document.title).toBe('Today · Apollo');
    // No focus move on launch.
    expect(document.activeElement).not.toBe(today);

    const planLink = within(mainNav()).getByRole('link', { name: 'Plan' });
    planLink.focus();
    fireEvent.click(planLink);

    const heading = await findHeading('Plan stub');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.title).toBe('Plan · Apollo');
    expect(window.scrollTo).toHaveBeenCalled();
    expect(planLink.getAttribute('aria-current')).toBe('page');
  });

  it('skip link focuses the main region without changing the route', async () => {
    renderAt('#/');
    await findHeading('Today stub');
    fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }));
    expect(document.activeElement?.id).toBe('main');
    expect(window.location.hash).toBe('#/');
  });

  it('page titles cover the new and legacy routes', () => {
    expect(pageTitleForPath('/')).toBe('Today');
    expect(pageTitleForPath('/progress')).toBe('Progress');
    expect(pageTitleForPath('/race')).toBe('Race Day');
    expect(pageTitleForPath('/analytics')).toBe('Progress');
    expect(pageTitleForPath('/whatever')).toBe('Page not found');
    expect(documentTitleForPath('/settings')).toBe('Settings · Apollo');
  });
});

describe('Race Day badge', () => {
  it('shows days to race, with a spoken label', async () => {
    setMyRace({ date: addDays(todayKey(), 47) });
    renderAt('#/');
    await findHeading('Today stub');
    const race = within(mainNav()).getByRole('link', { name: /Race Day/ });
    expect(race.querySelector('.nav-badge')?.textContent).toBe('47d');
    expect(race.textContent).toContain('47 days to race');
  });

  it('is hidden without a race date and after the race', async () => {
    setMyRace({ date: addDays(todayKey(), -3) });
    renderAt('#/');
    await findHeading('Today stub');
    expect(mainNav().querySelector('.nav-badge')).toBeNull();
  });
});

describe('status banners', () => {
  it('shows a blocking banner when storage becomes unavailable', async () => {
    renderAt('#/');
    await findHeading('Today stub');
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => markStorageDegraded('IndexedDB failed to open'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Storage unavailable');
    expect(alert.textContent).toContain('IndexedDB failed to open');
    expect(within(alert).getByRole('button', { name: 'Reload Apollo' })).toBeTruthy();
    // Rendered inside the always-mounted live region.
    expect(alert.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('links a needs-reconnect notice to Settings › Connections (but not on Settings itself)', async () => {
    setNeedsReconnect('intervals', 'intervals.icu rejected the API key (401).');
    renderAt('#/');
    await findHeading('Today stub');

    expect(screen.getByText(/intervals\.icu needs to be reconnected/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconnect' }).getAttribute('href')).toBe('#/settings?tab=connections');

    fireEvent.click(within(mainNav()).getByRole('link', { name: 'Settings' }));
    await findHeading('Settings stub');
    expect(screen.queryByRole('link', { name: 'Reconnect' })).toBeNull();
  });

  it('removes the reconnect notice once the source is reconnected', async () => {
    setNeedsReconnect('intervals', 'Rejected');
    renderAt('#/');
    await screen.findByRole('link', { name: 'Reconnect' });
    act(() => clearNeedsReconnect('intervals'));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Reconnect' })).toBeNull());
  });
});

describe('update banner (sync review B3/S7)', () => {
  const base: UpdateState = { status: 'idle', version: '1.0.7', releaseNotes: null, downloadProgress: null, error: null };
  const opts = (mac: boolean, autoDownload = false) => ({ mac, autoDownload, download: vi.fn(), install: vi.fn() });

  it('on macOS offers the download page instead of a download that cannot install', () => {
    const banner = bannerForUpdateState({ ...base, status: 'available' }, opts(true));
    expect(banner?.showDownloadPage).toBe(true);
    expect(banner?.action).toBeUndefined();
    expect(banner?.message).toContain('1.0.7');
  });

  it('elsewhere offers Download, then Restart now', () => {
    const o = opts(false);
    const available = bannerForUpdateState({ ...base, status: 'available' }, o);
    expect(available?.action?.label).toBe('Download');
    available?.action?.run();
    expect(o.download).toHaveBeenCalled();
    expect(bannerForUpdateState({ ...base, status: 'downloaded' }, o)?.action?.label).toBe('Restart now');
    // With auto-download on, there is nothing to click until it's ready.
    expect(bannerForUpdateState({ ...base, status: 'available' }, opts(false, true))).toBeNull();
  });

  it('keeps errors visible with the reason and the download page', () => {
    const banner = bannerForUpdateState({ ...base, status: 'error', error: 'Code signature invalid' }, opts(true));
    expect(banner?.tone).toBe('error');
    expect(banner?.message).toContain('Code signature invalid');
    expect(banner?.showDownloadPage).toBe(true);
  });

  it('says nothing while idle or up to date', () => {
    expect(bannerForUpdateState(base, opts(false))).toBeNull();
    expect(bannerForUpdateState({ ...base, status: 'not-available' }, opts(false))).toBeNull();
  });
});

describe('useStoreVersion', () => {
  function VersionProbe() {
    return <span data-testid="version">{useStoreVersion()}</span>;
  }

  it('bumps when the effective plan or day completion changes', () => {
    render(<VersionProbe />);
    expect(screen.getByTestId('version').textContent).toBe('0');
    act(() => {
      window.dispatchEvent(new CustomEvent('apollo:plan-overlay-changed'));
    });
    expect(screen.getByTestId('version').textContent).toBe('1');
    act(() => {
      window.dispatchEvent(new CustomEvent('apollo:plan-progress-changed'));
    });
    expect(screen.getByTestId('version').textContent).toBe('2');
  });
});

describe('ErrorBoundary (inline variant)', () => {
  function Boom({ fail }: { fail: boolean }) {
    if (fail) throw new Error('kaput');
    return <p>fine</p>;
  }

  it('shows a compact card instead of a full-screen takeover, and resets when resetKey changes', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary variant="inline" label="Recovery" resetKey="a"><Boom fail /></ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Recovery couldn’t be shown.');
    expect(alert.textContent).toContain('kaput');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(alert.closest('.welcome-flow')).toBeNull();

    rerender(<ErrorBoundary variant="inline" label="Recovery" resetKey="b"><Boom fail={false} /></ErrorBoundary>);
    expect(screen.getByText('fine')).toBeTruthy();
    consoleError.mockRestore();
  });
});
