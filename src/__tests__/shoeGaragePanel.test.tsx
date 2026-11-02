/**
 * ShoeGaragePanel wear bar accessibility (v1.0.9): aria-valuenow stays within
 * 0–100 even for a shoe past its limit, and aria-valuetext states the real
 * wear percentage and distance in the athlete's unit.
 */

import { createElement } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ShoeGaragePanel from '@/components/ShoeGaragePanel';
import { addShoe, unitDistanceToMiles } from '@/services/shoeTracker';
import { setDistanceUnit } from '@/services/unitPreferences';

function openGarage() {
  render(createElement(ShoeGaragePanel));
  fireEvent.click(screen.getByRole('button', { name: /Manage shoes/ }));
}

describe('ShoeGaragePanel wear progress bar', () => {
  it('clamps aria-valuenow to 0–100 and states the real wear and miles in aria-valuetext', () => {
    setDistanceUnit('mi');
    addShoe({ brand: 'Brooks', model: 'Glycerin 21', maxMiles: 400, initialMiles: 448 });
    addShoe({ brand: 'Nike', model: 'Pegasus 41', maxMiles: 400, initialMiles: 100, isDefault: false });
    openGarage();

    const worn = screen.getByRole('progressbar', { name: 'Brooks Glycerin 21 wear' });
    expect(worn.getAttribute('aria-valuenow')).toBe('100');
    expect(worn.getAttribute('aria-valuemin')).toBe('0');
    expect(worn.getAttribute('aria-valuemax')).toBe('100');
    expect(worn.getAttribute('aria-valuetext')).toBe('112% worn: 448.0 mi of 400 mi');

    const fresh = screen.getByRole('progressbar', { name: 'Nike Pegasus 41 wear' });
    expect(fresh.getAttribute('aria-valuenow')).toBe('25');
    expect(fresh.getAttribute('aria-valuetext')).toBe('25% worn: 100.0 mi of 400 mi');
  });

  it('uses kilometres in aria-valuetext for athletes who run in km', () => {
    setDistanceUnit('km');
    addShoe({
      brand: 'Hoka',
      model: 'Mach 6',
      maxMiles: unitDistanceToMiles(650, 'km'),
      initialMiles: unitDistanceToMiles(325, 'km'),
    });
    openGarage();

    const bar = screen.getByRole('progressbar', { name: 'Hoka Mach 6 wear' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(bar.getAttribute('aria-valuetext')).toBe('50% worn: 325.0 km of 650 km');
  });
});
