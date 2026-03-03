/**
 * Tests for Weather Integration Service
 */

import { describe, it, expect } from 'vitest';
import {
  calculateHeatAdjustment,
  getWeatherRiskLevel,
  assessRaceWeather,
  getMarathonCoords,
  formatTimeSec,
  type WeatherForecast,
} from '@/services/weather';

// ── Heat Adjustment (Ely Model) ───────────────────────────────────────────────

describe('calculateHeatAdjustment', () => {
  it('should return 0% at ideal conditions (55°F, 40% humidity)', () => {
    expect(calculateHeatAdjustment(55, 40)).toBe(0);
  });

  it('should return 0% below ideal temperature', () => {
    expect(calculateHeatAdjustment(45, 30)).toBe(0);
  });

  it('should increase with temperature above 55°F', () => {
    const adj65 = calculateHeatAdjustment(65, 40);
    const adj75 = calculateHeatAdjustment(75, 40);
    const adj85 = calculateHeatAdjustment(85, 40);

    expect(adj65).toBeGreaterThan(0);
    expect(adj75).toBeGreaterThan(adj65);
    expect(adj85).toBeGreaterThan(adj75);
  });

  it('should be ~1.75% per 10°F above 55', () => {
    const adj = calculateHeatAdjustment(65, 40);
    expect(adj).toBeCloseTo(1.75, 1);
  });

  it('should add humidity penalty above 40%', () => {
    const noHumidity = calculateHeatAdjustment(70, 40);
    const highHumidity = calculateHeatAdjustment(70, 80);
    expect(highHumidity).toBeGreaterThan(noHumidity);
  });

  it('should be ~0.5% per 10% humidity above 40%', () => {
    const baseline = calculateHeatAdjustment(55, 40);
    const humid = calculateHeatAdjustment(55, 60);
    expect(humid - baseline).toBeCloseTo(1.0, 1);
  });

  it('should handle extreme heat (90°F, 80% humidity)', () => {
    const adj = calculateHeatAdjustment(90, 80);
    expect(adj).toBeGreaterThan(5);
    expect(adj).toBeLessThan(15);
  });
});

// ── Weather Risk Level ────────────────────────────────────────────────────────

describe('getWeatherRiskLevel', () => {
  it('should return "ideal" for perfect racing conditions', () => {
    expect(getWeatherRiskLevel(52, 45, 5)).toBe('ideal');
  });

  it('should return "good" for acceptable conditions', () => {
    expect(getWeatherRiskLevel(42, 50, 8)).toBe('good');
  });

  it('should return "caution" for warm or windy conditions', () => {
    expect(getWeatherRiskLevel(68, 50, 5)).toBe('caution');
  });

  it('should return "caution" for high humidity', () => {
    expect(getWeatherRiskLevel(55, 85, 5)).toBe('caution');
  });

  it('should return "caution" for strong wind', () => {
    expect(getWeatherRiskLevel(55, 50, 22)).toBe('caution');
  });

  it('should return "warning" for hot conditions (75°F+)', () => {
    expect(getWeatherRiskLevel(76, 50, 5)).toBe('warning');
  });

  it('should return "danger" for extreme heat (85°F+)', () => {
    expect(getWeatherRiskLevel(86, 50, 5)).toBe('danger');
  });

  it('should return "warning" for high heat index below danger threshold', () => {
    // heatIndex = 82 + (90-50)*0.15 = 88, which is >= 80 → warning (danger requires >= 90)
    expect(getWeatherRiskLevel(82, 90, 5)).toBe('warning');
  });
});

// ── Race Weather Assessment ───────────────────────────────────────────────────

describe('assessRaceWeather', () => {
  const idealForecast: WeatherForecast = {
    date: '2026-10-11',
    tempHighF: 58,
    tempLowF: 48,
    tempAvgF: 53,
    humidityPct: 40,
    windMph: 8,
    windGustMph: 15,
    precipitationInch: 0,
    precipitationProbPct: 10,
    uvIndex: 4,
    condition: 'partly_cloudy',
    sunrise: '6:45 AM',
    sunset: '6:15 PM',
    feelsLikeHighF: 56,
    feelsLikeLowF: 45,
  };

  const hotForecast: WeatherForecast = {
    ...idealForecast,
    tempHighF: 82,
    tempLowF: 68,
    tempAvgF: 75,
    humidityPct: 70,
    condition: 'clear',
  };

  it('should return zero adjustment for ideal conditions', () => {
    const result = assessRaceWeather(idealForecast, 12600); // 3:30:00, 53°F/40%
    expect(result.heatAdjustmentPct).toBe(0);
    expect(result.adjustedTimeSec).toBe(12600);
    expect(result.riskLevel).toBe('ideal');
  });

  it('should increase adjusted time in hot conditions', () => {
    const result = assessRaceWeather(hotForecast, 12600);
    expect(result.heatAdjustmentPct).toBeGreaterThan(3);
    expect(result.adjustedTimeSec).toBeGreaterThan(12600);
  });

  it('should provide heat tips when hot', () => {
    const result = assessRaceWeather(hotForecast, 12600);
    expect(result.tips.length).toBeGreaterThan(0);
    expect(result.tips.some((t) => t.toLowerCase().includes('heat') || t.toLowerCase().includes('hydration'))).toBe(true);
  });

  it('should provide wind tips when windy', () => {
    const windyForecast = { ...idealForecast, windMph: 22 };
    const result = assessRaceWeather(windyForecast, 12600);
    expect(result.tips.some((t) => t.toLowerCase().includes('wind'))).toBe(true);
  });

  it('should provide rain tips when rain likely', () => {
    const rainyForecast = { ...idealForecast, precipitationProbPct: 80, condition: 'rain' as const };
    const result = assessRaceWeather(rainyForecast, 12600);
    expect(result.tips.some((t) => t.toLowerCase().includes('rain') || t.toLowerCase().includes('wet'))).toBe(true);
  });

  it('should include a summary string', () => {
    const result = assessRaceWeather(idealForecast, 12600);
    expect(result.summary).toBeTruthy();
    expect(result.summary.length).toBeGreaterThan(10);
  });

  it('should format adjusted time correctly', () => {
    const result = assessRaceWeather(hotForecast, 12600);
    expect(result.adjustedTimeFormatted).toMatch(/^\d+:\d{2}:\d{2}$/);
  });
});

// ── Marathon Coordinates ──────────────────────────────────────────────────────

describe('getMarathonCoords', () => {
  it('should return coordinates for known World Majors', () => {
    const boston = getMarathonCoords('boston-marathon-2026');
    expect(boston).not.toBeNull();
    expect(boston!.latitude).toBeCloseTo(42.36, 1);

    const tokyo = getMarathonCoords('tokyo-marathon-2026');
    expect(tokyo).not.toBeNull();
    expect(tokyo!.latitude).toBeCloseTo(35.69, 1);
  });

  it('should return null for unknown marathon', () => {
    expect(getMarathonCoords('unknown-marathon')).toBeNull();
  });

  it('should have coordinates for all 6 World Majors', () => {
    const ids = [
      'tokyo-marathon-2026', 'boston-marathon-2026', 'london-marathon-2026',
      'berlin-marathon-2026', 'chicago-marathon-2026', 'nyc-marathon-2026',
    ];
    for (const id of ids) {
      const coords = getMarathonCoords(id);
      expect(coords).not.toBeNull();
      expect(coords!.latitude).toBeGreaterThan(-90);
      expect(coords!.longitude).toBeGreaterThan(-180);
    }
  });
});

// ── formatTimeSec ─────────────────────────────────────────────────────────────

describe('formatTimeSec', () => {
  it('should format 3:30:00', () => {
    expect(formatTimeSec(12600)).toBe('3:30:00');
  });

  it('should format 4:00:00', () => {
    expect(formatTimeSec(14400)).toBe('4:00:00');
  });

  it('should pad minutes and seconds', () => {
    expect(formatTimeSec(3661)).toBe('1:01:01');
  });
});
