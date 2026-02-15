/**
 * Coaching Preferences — user settings for daily recap, weekly readiness recap,
 * and notification timing. Persisted in localStorage.
 */

const PREFS_KEY = 'apollo_coaching_prefs';

export interface CoachingPreferences {
  /** Whether the user opted in to daily recaps */
  dailyRecapEnabled: boolean;
  /** Time of day for daily recap (HH:MM, 24h format) */
  dailyRecapTime: string;
  /** Whether the user opted in to weekly Race Day Readiness recap */
  weeklyRecapEnabled: boolean;
  /** Day of week for weekly recap: 0=Mon .. 6=Sun */
  weeklyRecapDay: number;
  /** Whether onboarding for coaching prefs has been completed */
  onboardingDone: boolean;
}

const DEFAULT_PREFS: CoachingPreferences = {
  dailyRecapEnabled: true,
  dailyRecapTime: '20:00',
  weeklyRecapEnabled: true,
  weeklyRecapDay: 6, // Sunday by default
  onboardingDone: false,
};

export function getCoachingPreferences(): CoachingPreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function setCoachingPreferences(prefs: Partial<CoachingPreferences>): void {
  const current = getCoachingPreferences();
  const merged = { ...current, ...prefs };
  localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
}

export function isCoachingOnboardingDone(): boolean {
  return getCoachingPreferences().onboardingDone;
}

export function setCoachingOnboardingDone(done: boolean): void {
  setCoachingPreferences({ onboardingDone: done });
}

/** Check if current time is past the daily recap time for today */
export function isDailyRecapDue(): boolean {
  const prefs = getCoachingPreferences();
  if (!prefs.dailyRecapEnabled) return false;

  const now = new Date();
  const [h, m] = prefs.dailyRecapTime.split(':').map(Number);
  const recapTime = new Date(now);
  recapTime.setHours(h, m, 0, 0);

  // Has the recap time passed today?
  if (now < recapTime) return false;

  // Check if we already showed a recap today
  const lastShown = localStorage.getItem('apollo_daily_recap_last');
  if (lastShown) {
    const lastDate = new Date(lastShown);
    if (
      lastDate.getFullYear() === now.getFullYear() &&
      lastDate.getMonth() === now.getMonth() &&
      lastDate.getDate() === now.getDate()
    ) {
      return false; // Already shown today
    }
  }
  return true;
}

export function markDailyRecapShown(): void {
  localStorage.setItem('apollo_daily_recap_last', new Date().toISOString());
}

/** Check if weekly recap is due */
export function isWeeklyRecapDue(): boolean {
  const prefs = getCoachingPreferences();
  if (!prefs.weeklyRecapEnabled) return false;

  const now = new Date();
  // JS: 0=Sun, 1=Mon..6=Sat. Our convention: 0=Mon..6=Sun
  const jsDay = now.getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1; // convert to 0=Mon..6=Sun

  if (ourDay !== prefs.weeklyRecapDay) return false;

  const lastShown = localStorage.getItem('apollo_weekly_recap_last');
  if (lastShown) {
    const lastDate = new Date(lastShown);
    const diffMs = now.getTime() - lastDate.getTime();
    if (diffMs < 24 * 60 * 60 * 1000) return false; // Already shown within 24h
  }
  return true;
}

export function markWeeklyRecapShown(): void {
  localStorage.setItem('apollo_weekly_recap_last', new Date().toISOString());
}

/** Day names for UI display */
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Suggest best day for weekly recap based on plan's long run day */
export function suggestWeeklyRecapDay(longRunDayIndex: number | null): number {
  if (longRunDayIndex != null && longRunDayIndex >= 0 && longRunDayIndex <= 6) {
    // Day after long run
    return (longRunDayIndex + 1) % 7;
  }
  return 6; // Default to Sunday
}
