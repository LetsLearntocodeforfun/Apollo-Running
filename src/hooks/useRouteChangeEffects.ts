import { useEffect, useRef, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';

/** Page names used for `document.title` ("<Page> · Apollo"), keyed by the first path segment. */
const PAGE_TITLES: Record<string, string> = {
  '': 'Today',
  plan: 'Plan',
  activities: 'Activities',
  progress: 'Progress',
  race: 'Race Day',
  settings: 'Settings',
  auth: 'Connecting',
  // Legacy paths redirect, but name them in case a title is read mid-redirect.
  training: 'Plan',
  analytics: 'Progress',
  insights: 'Progress',
  'race-strategy': 'Race Day',
};

/** Human page name for a router pathname, e.g. "/progress" → "Progress". */
export function pageTitleForPath(pathname: string): string {
  const segment = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return PAGE_TITLES[segment] ?? 'Page not found';
}

/** Full document title for a router pathname, e.g. "Plan · Apollo". */
export function documentTitleForPath(pathname: string): string {
  return `${pageTitleForPath(pathname)} · Apollo`;
}

/**
 * Route-change housekeeping keyed on the pathname (query changes such as
 * switching tabs don't trigger it): sets `document.title` to
 * "<Page> · Apollo" and, after the first route, scrolls back to the top.
 *
 * Returns true once the user has navigated away from the first route, so the
 * page frame knows whether to move focus (never on app launch).
 */
export function useRouteChangeEffects(): boolean {
  const { pathname } = useLocation();
  const firstPath = useRef(pathname);
  const navigated = useRef(false);
  // Derived during render so the page frame mounted in the same commit sees it.
  if (pathname !== firstPath.current) navigated.current = true;

  useEffect(() => {
    document.title = documentTitleForPath(pathname);
    if (!navigated.current) return;
    try {
      window.scrollTo({ top: 0, left: 0 });
    } catch {
      /* not implemented in some test environments */
    }
  }, [pathname]);

  return navigated.current;
}

/** How long to wait for a page that renders its heading late (data loading). */
const HEADING_WAIT_MS = 4000;

/**
 * Focus may move to the new page heading only while the user hasn't already
 * moved on: focus is on <body>, on the main region, or still in the nav link
 * they just activated.
 */
function focusIsUnclaimed(): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  if (active.id === 'main') return true;
  return !!active.closest('nav');
}

function focusHeading(heading: HTMLElement): void {
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

/**
 * On mount, move focus to the first `<h1>` inside `rootRef` (made focusable
 * with tabIndex -1) so screen readers announce the new page. Mount happens
 * after a lazily loaded page resolves; a page that renders its heading later
 * (while loading data) is awaited with a MutationObserver for a few seconds.
 */
export function usePageHeadingFocus(rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;

    const tryFocus = (): boolean => {
      const heading = root.querySelector<HTMLElement>('h1');
      if (!heading) return false;
      if (focusIsUnclaimed()) focusHeading(heading);
      return true;
    };
    if (tryFocus() || typeof MutationObserver === 'undefined') return;

    const observer = new MutationObserver(() => {
      if (tryFocus()) stop();
    });
    const timer = window.setTimeout(() => observer.disconnect(), HEADING_WAIT_MS);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
    observer.observe(root, { childList: true, subtree: true });
    return stop;
    // Mount-only on purpose: the frame is keyed by pathname, so it remounts per page.
  }, []);
}
