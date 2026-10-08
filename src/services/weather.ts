/**
 * Weather Integration Service
 *
 * Opt-in weather forecasting using Open-Meteo API (free, no API key).
 * Provides race day forecasts, heat-adjusted predictions, and
 * training weather context.
 */

import { persistence } from './db/persistence';
import { formatTimeSec } from './racePrediction';
import { normalizeMarathonId } from '../data/worldMajors';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WeatherForecast {
  date: string;
  tempHighF: number;
  tempLowF: number;
  tempAvgF: number;
  humidityPct: number;
  windMph: number;
  windGustMph: number;
  precipitationInch: number;
  precipitationProbPct: number;
  uvIndex: number;
  condition: WeatherCondition;
  sunrise: string;
  sunset: string;
  feelsLikeHighF: number;
  feelsLikeLowF: number;
}

export type WeatherCondition =
  | 'clear'
  | 'partly_cloudy'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'heavy_rain'
  | 'snow'
  | 'thunderstorm';

export interface WeatherPreferences {
  enabled: boolean;
  enabledAt?: string;
}

export interface RaceWeatherAssessment {
  forecast: WeatherForecast;
  riskLevel: 'ideal' | 'good' | 'caution' | 'warning' | 'danger';
  heatAdjustmentPct: number;
  adjustedTimeSec: number;
  adjustedTimeFormatted: string;
  tips: string[];
  summary: string;
}

export interface LocationCoords {
  latitude: number;
  longitude: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'apollo_weather_prefs';
const CACHE_KEY = 'apollo_weather_cache';
const CACHE_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours

/** Ely et al. (2007) heat penalty — ~1.75% per 10°F above 55°F */
const IDEAL_TEMP_F = 55;
const HEAT_PCT_PER_10F = 1.75;
const HUMIDITY_PCT_PER_10 = 0.5;
const IDEAL_HUMIDITY = 40;

// WMO weather codes → our conditions
const WMO_CODE_MAP: Record<number, WeatherCondition> = {
  0: 'clear', 1: 'clear', 2: 'partly_cloudy', 3: 'cloudy',
  45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
  56: 'drizzle', 57: 'drizzle',
  61: 'rain', 63: 'rain', 65: 'heavy_rain',
  66: 'rain', 67: 'heavy_rain',
  71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow',
  80: 'rain', 81: 'rain', 82: 'heavy_rain',
  85: 'snow', 86: 'snow',
  95: 'thunderstorm', 96: 'thunderstorm', 99: 'thunderstorm',
};

// ── Preferences ───────────────────────────────────────────────────────────────

export function getWeatherPrefs(): WeatherPreferences {
  const raw = persistence.getItem(STORAGE_KEY);
  if (!raw) return { enabled: false };
  try { return JSON.parse(raw); } catch { return { enabled: false }; }
}

export function setWeatherPrefs(prefs: WeatherPreferences): void {
  persistence.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function isWeatherEnabled(): boolean {
  return getWeatherPrefs().enabled;
}

export function enableWeather(): void {
  setWeatherPrefs({ enabled: true, enabledAt: new Date().toISOString() });
}

export function disableWeather(): void {
  setWeatherPrefs({ enabled: false });
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface WeatherCache {
  key: string;
  fetchedAt: number;
  forecasts: WeatherForecast[];
}

function getCacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(2)}_${lon.toFixed(2)}`;
}

function getCachedForecasts(lat: number, lon: number): WeatherForecast[] | null {
  const raw = persistence.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    const cache: WeatherCache = JSON.parse(raw);
    const key = getCacheKey(lat, lon);
    if (cache.key !== key) return null;
    if (Date.now() - cache.fetchedAt > CACHE_DURATION_MS) return null;
    return cache.forecasts;
  } catch { return null; }
}

function setCachedForecasts(lat: number, lon: number, forecasts: WeatherForecast[]): void {
  const cache: WeatherCache = {
    key: getCacheKey(lat, lon),
    fetchedAt: Date.now(),
    forecasts,
  };
  persistence.setItem(CACHE_KEY, JSON.stringify(cache));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function wmoToCondition(code: number): WeatherCondition {
  return WMO_CODE_MAP[code] ?? 'partly_cloudy';
}

function formatTimeHHMM(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${m} ${ampm}`;
}

// Re-export for consumers that import formatTimeSec from weather
export { formatTimeSec } from './racePrediction';

// ── API ───────────────────────────────────────────────────────────────────────

/**
 * Fetch a 7-day forecast from Open-Meteo API.
 * Returns null on network failure (graceful offline fallback).
 */
export async function fetchForecast(coords: LocationCoords): Promise<WeatherForecast[] | null> {
  // Validate coordinate bounds
  if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) return null;
  if (Math.abs(coords.latitude) > 90 || Math.abs(coords.longitude) > 180) return null;

  // Check cache first
  const cached = getCachedForecasts(coords.latitude, coords.longitude);
  if (cached) return cached;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', coords.latitude.toFixed(4));
  url.searchParams.set('longitude', coords.longitude.toFixed(4));
  url.searchParams.set('daily', [
    'temperature_2m_max', 'temperature_2m_min',
    'apparent_temperature_max', 'apparent_temperature_min',
    'relative_humidity_2m_mean',
    'wind_speed_10m_max', 'wind_gusts_10m_max',
    'precipitation_sum', 'precipitation_probability_max',
    'uv_index_max', 'weather_code',
    'sunrise', 'sunset',
  ].join(','));
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'auto');

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const daily = data.daily;
    if (!daily || !daily.time) return null;

    const forecasts: WeatherForecast[] = (daily.time as string[]).map((date: string, i: number) => ({
      date,
      tempHighF: Math.round(daily.temperature_2m_max[i]),
      tempLowF: Math.round(daily.temperature_2m_min[i]),
      tempAvgF: Math.round((daily.temperature_2m_max[i] + daily.temperature_2m_min[i]) / 2),
      humidityPct: Math.round(daily.relative_humidity_2m_mean?.[i] ?? 50),
      windMph: Math.round(daily.wind_speed_10m_max[i]),
      windGustMph: Math.round(daily.wind_gusts_10m_max[i]),
      precipitationInch: Math.round(daily.precipitation_sum[i] * 100) / 100,
      precipitationProbPct: Math.round(daily.precipitation_probability_max?.[i] ?? 0),
      uvIndex: Math.round(daily.uv_index_max?.[i] ?? 0),
      condition: wmoToCondition(daily.weather_code[i]),
      sunrise: formatTimeHHMM(daily.sunrise[i]),
      sunset: formatTimeHHMM(daily.sunset[i]),
      feelsLikeHighF: Math.round(daily.apparent_temperature_max[i]),
      feelsLikeLowF: Math.round(daily.apparent_temperature_min[i]),
    }));

    setCachedForecasts(coords.latitude, coords.longitude, forecasts);
    return forecasts;
  } catch {
    return null; // Graceful offline fallback
  }
}

// ── Race Weather Assessment ───────────────────────────────────────────────────

/**
 * Calculate heat adjustment percentage using Ely et al. model.
 * Returns percentage slowdown (positive = slower).
 */
export function calculateHeatAdjustment(tempF: number, humidityPct: number): number {
  let pct = 0;
  if (tempF > IDEAL_TEMP_F) {
    pct += ((tempF - IDEAL_TEMP_F) / 10) * HEAT_PCT_PER_10F;
  }
  if (humidityPct > IDEAL_HUMIDITY) {
    pct += ((humidityPct - IDEAL_HUMIDITY) / 10) * HUMIDITY_PCT_PER_10;
  }
  return Math.round(pct * 100) / 100;
}

/**
 * Determine weather risk level for racing.
 */
export function getWeatherRiskLevel(tempF: number, humidityPct: number, windMph: number): RaceWeatherAssessment['riskLevel'] {
  const heatIndex = tempF + (humidityPct > 50 ? (humidityPct - 50) * 0.15 : 0);

  if (heatIndex >= 90 || tempF >= 85) return 'danger';
  if (heatIndex >= 80 || tempF >= 75) return 'warning';
  if (tempF >= 65 || humidityPct >= 80 || windMph >= 20) return 'caution';
  if (tempF >= 45 && tempF <= 60 && humidityPct < 70) return 'ideal';
  return 'good';
}

/**
 * Assess race day weather impact on marathon performance.
 */
export function assessRaceWeather(
  forecast: WeatherForecast,
  targetTimeSec: number,
): RaceWeatherAssessment {
  // Use the average temp during race hours (approximated by avg of high/low)
  const raceTemp = forecast.tempAvgF;
  const humidity = forecast.humidityPct;
  const wind = forecast.windMph;

  const heatPct = calculateHeatAdjustment(raceTemp, humidity);
  const adjustedSec = Math.round(targetTimeSec * (1 + heatPct / 100));
  const riskLevel = getWeatherRiskLevel(raceTemp, humidity, wind);

  const tips: string[] = [];

  // Temperature tips
  if (raceTemp >= 75) {
    tips.push('High heat expected. Start conservatively — aim 5-10 sec/mi slower than goal pace for the first 5K.');
    tips.push('Increase fluid intake to 150-200% of normal. Take water at every aid station.');
    tips.push('Wear light-colored, moisture-wicking clothing. Apply sunscreen before the race.');
  } else if (raceTemp >= 65) {
    tips.push('Warm conditions — dress lightly and consider starting 3-5 sec/mi slower.');
    tips.push('Extra hydration will be important. Don\'t skip aid stations.');
  } else if (raceTemp <= 35) {
    tips.push('Cold weather — wear throwaway layers for the start. Keep extremities covered.');
    tips.push('Warm up thoroughly before the start. Cold muscles are injury-prone.');
  } else if (raceTemp >= 45 && raceTemp <= 60) {
    tips.push('Near-ideal racing temperature. Trust your training paces.');
  }

  // Wind tips
  if (wind >= 20) {
    tips.push(`Strong winds (${wind} mph) expected. Draft behind other runners when possible.`);
    tips.push('Mentally prepare for headwind sections — maintain effort, not pace.');
  } else if (wind >= 12) {
    tips.push(`Moderate wind (${wind} mph). Tuck in behind groups on exposed stretches.`);
  }

  // Rain tips
  if (forecast.precipitationProbPct >= 60) {
    tips.push('Rain likely. Apply anti-chafe product liberally. Wear a disposable poncho at the start.');
    tips.push('Wet roads = slippery. Be cautious on turns and painted surfaces.');
  }

  // Humidity tips
  if (humidity >= 80) {
    tips.push('Very high humidity will impair sweat evaporation. Slow down and focus on effort, not pace.');
  }

  // Build summary
  const conditionStr = forecast.condition.replace(/_/g, ' ');
  let summary = `${conditionStr.charAt(0).toUpperCase() + conditionStr.slice(1)}, ${raceTemp}°F`;
  if (humidity >= 60) summary += `, ${humidity}% humidity`;
  if (wind >= 10) summary += `, ${wind} mph wind`;
  summary += '.';

  if (heatPct > 0) {
    summary += ` Heat adjustment: +${heatPct.toFixed(1)}% (${formatTimeSec(adjustedSec)} adjusted target).`;
  } else {
    summary += ' Conditions are favorable for your target time.';
  }

  return {
    forecast,
    riskLevel,
    heatAdjustmentPct: heatPct,
    adjustedTimeSec: adjustedSec,
    adjustedTimeFormatted: formatTimeSec(adjustedSec),
    tips,
    summary,
  };
}

// ── Location lookups for World Majors ─────────────────────────────────────────

/** Known coords for World Major Marathons, keyed by stable race id. */
const MARATHON_COORDS: Record<string, LocationCoords> = {
  tokyo:   { latitude: 35.6895, longitude: 139.6917 },
  boston:  { latitude: 42.3601, longitude: -71.0589 },
  london:  { latitude: 51.5074, longitude: -0.1278 },
  berlin:  { latitude: 52.5200, longitude: 13.4050 },
  chicago: { latitude: 41.8781, longitude: -87.6298 },
  nyc:     { latitude: 40.7128, longitude: -74.0060 },
};

/**
 * Get coordinates for a known marathon ID (stable id, or a legacy
 * '*-marathon-2026' id, which is normalised first).
 */
export function getMarathonCoords(marathonId: string): LocationCoords | null {
  return MARATHON_COORDS[normalizeMarathonId(marathonId)] ?? null;
}

/**
 * Fetch weather for a specific marathon by ID.
 * Returns null if marathon not found or network error.
 */
export async function fetchMarathonWeather(marathonId: string): Promise<WeatherForecast[] | null> {
  const coords = getMarathonCoords(marathonId);
  if (!coords) return null;
  return fetchForecast(coords);
}
