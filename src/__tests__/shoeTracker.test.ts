/**
 * Shoe Tracker service tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  addShoe,
  updateShoe,
  retireShoe,
  reactivateShoe,
  deleteShoe,
  getShoes,
  getActiveShoes,
  getRetiredShoes,
  getDefaultShoe,
  getShoeById,
  assignShoeToActivity,
  getShoeActivities,
  getActivityShoe,
  calculateDegradation,
  checkRetirementAlerts,
  getShoesSummary,
} from '@/services/shoeTracker';
import { persistence } from '@/services/db/persistence';

// Clear storage between tests
beforeEach(() => {
  persistence.clear();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function addTrainer() {
  return addShoe({
    name: 'Daily Trainer',
    brand: 'Nike',
    model: 'Pegasus 41',
    category: 'training',
    purchaseDate: '2025-01-01',
  });
}

function addRacer() {
  return addShoe({
    name: 'Race Day',
    brand: 'Nike',
    model: 'Vaporfly 3',
    category: 'racing',
    purchaseDate: '2025-01-01',
  });
}

// ── Shoe CRUD ─────────────────────────────────────────────────────────────────

describe('Shoe CRUD', () => {
  it('adds a shoe with defaults', () => {
    const shoe = addTrainer();
    expect(shoe.name).toBe('Daily Trainer');
    expect(shoe.brand).toBe('Nike');
    expect(shoe.model).toBe('Pegasus 41');
    expect(shoe.category).toBe('training');
    expect(shoe.status).toBe('active');
    expect(shoe.maxMileage).toBe(500); // default for training
    expect(shoe.currentMileage).toBe(0);
    expect(shoe.isDefault).toBe(true); // first shoe auto-becomes default
    expect(shoe.id).toMatch(/^shoe_/);
  });

  it('uses category-specific default mileage limits', () => {
    const trainer = addTrainer();
    expect(trainer.maxMileage).toBe(500);
    const racer = addRacer();
    expect(racer.maxMileage).toBe(300);
  });

  it('allows custom max mileage', () => {
    const shoe = addShoe({
      name: 'Custom',
      brand: 'Hoka',
      model: 'Clifton 9',
      category: 'both',
      purchaseDate: '2025-01-01',
      maxMileage: 350,
    });
    expect(shoe.maxMileage).toBe(350);
  });

  it('auto-sets first shoe as default', () => {
    const shoe = addTrainer();
    expect(shoe.isDefault).toBe(true);
  });

  it('clears old default when new default is set', () => {
    const first = addTrainer();
    const second = addShoe({
      name: 'Second',
      brand: 'Brooks',
      model: 'Ghost 15',
      category: 'training',
      purchaseDate: '2025-02-01',
      isDefault: true,
    });
    expect(second.isDefault).toBe(true);
    // Reload first shoe — should no longer be default
    expect(getShoeById(first.id)!.isDefault).toBe(false);
  });

  it('updates shoe fields', () => {
    const shoe = addTrainer();
    const updated = updateShoe(shoe.id, { name: 'Old Trainer', maxMileage: 450 });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Old Trainer');
    expect(updated!.maxMileage).toBe(450);
    expect(updated!.brand).toBe('Nike'); // unchanged
  });

  it('returns null when updating non-existent shoe', () => {
    expect(updateShoe('fake_id', { name: 'Nope' })).toBeNull();
  });

  it('retires a shoe', () => {
    const shoe = addTrainer();
    const retired = retireShoe(shoe.id);
    expect(retired).not.toBeNull();
    expect(retired!.status).toBe('retired');
    expect(retired!.retiredAt).toBeDefined();
  });

  it('assigns next default when default shoe is retired', () => {
    const first = addTrainer();
    const second = addShoe({
      name: 'Backup',
      brand: 'Asics',
      model: 'Nimbus 26',
      category: 'training',
      purchaseDate: '2025-02-01',
    });
    retireShoe(first.id);
    expect(getDefaultShoe()?.id).toBe(second.id);
  });

  it('reactivates a retired shoe', () => {
    const shoe = addTrainer();
    retireShoe(shoe.id);
    const reactivated = reactivateShoe(shoe.id);
    expect(reactivated!.status).toBe('active');
    expect(reactivated!.retiredAt).toBeUndefined();
  });

  it('deletes a shoe and its activities', () => {
    const shoe = addTrainer();
    assignShoeToActivity('act_1', 5.0, '2025-01-15', shoe.id);
    expect(deleteShoe(shoe.id)).toBe(true);
    expect(getShoeById(shoe.id)).toBeNull();
    expect(getShoeActivities(shoe.id)).toEqual([]);
  });

  it('returns false when deleting non-existent shoe', () => {
    expect(deleteShoe('fake_id')).toBe(false);
  });
});

// ── Shoe Queries ──────────────────────────────────────────────────────────────

describe('Shoe Queries', () => {
  it('getShoes returns all shoes', () => {
    addTrainer();
    addRacer();
    expect(getShoes().length).toBe(2);
  });

  it('getActiveShoes filters retired shoes', () => {
    const trainer = addTrainer();
    addRacer();
    retireShoe(trainer.id);
    expect(getActiveShoes().length).toBe(1);
    expect(getRetiredShoes().length).toBe(1);
  });

  it('getDefaultShoe returns the default', () => {
    addTrainer();
    const def = getDefaultShoe();
    expect(def).not.toBeNull();
    expect(def!.name).toBe('Daily Trainer');
  });

  it('getDefaultShoe returns null when no shoes', () => {
    expect(getDefaultShoe()).toBeNull();
  });
});

// ── Activity Assignment & Mileage ─────────────────────────────────────────────

describe('Activity Assignment', () => {
  it('assigns activity to specified shoe and accumulates mileage', () => {
    const shoe = addTrainer();
    const updated = assignShoeToActivity('act_1', 6.2, '2025-01-15', shoe.id);
    expect(updated).not.toBeNull();
    expect(updated!.currentMileage).toBe(6.2);

    const updated2 = assignShoeToActivity('act_2', 3.1, '2025-01-16', shoe.id);
    expect(updated2!.currentMileage).toBe(9.3);
  });

  it('assigns to default shoe when no shoeId provided', () => {
    const shoe = addTrainer();
    const updated = assignShoeToActivity('act_1', 5.0, '2025-01-15');
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(shoe.id);
    expect(updated!.currentMileage).toBe(5.0);
  });

  it('returns null when no default shoe exists', () => {
    expect(assignShoeToActivity('act_1', 5.0, '2025-01-15')).toBeNull();
  });

  it('does not double-assign the same activity', () => {
    const shoe = addTrainer();
    assignShoeToActivity('act_1', 5.0, '2025-01-15', shoe.id);
    assignShoeToActivity('act_1', 5.0, '2025-01-15', shoe.id); // duplicate
    expect(getShoeById(shoe.id)!.currentMileage).toBe(5.0); // not 10
  });

  it('getShoeActivities returns activities for a shoe', () => {
    const shoe = addTrainer();
    assignShoeToActivity('act_1', 5.0, '2025-01-15', shoe.id);
    assignShoeToActivity('act_2', 3.0, '2025-01-16', shoe.id);
    const activities = getShoeActivities(shoe.id);
    expect(activities.length).toBe(2);
    expect(activities[0].date).toBe('2025-01-16'); // desc order
  });

  it('getActivityShoe returns the shoe for an activity', () => {
    const shoe = addTrainer();
    assignShoeToActivity('act_1', 5.0, '2025-01-15', shoe.id);
    const found = getActivityShoe('act_1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(shoe.id);
  });

  it('getActivityShoe returns null for unknown activity', () => {
    expect(getActivityShoe('unknown')).toBeNull();
  });
});

// ── Degradation & Alerts ──────────────────────────────────────────────────────

describe('Degradation Calculation', () => {
  it('calculates basic degradation', () => {
    const shoe = addTrainer();
    // Manually set mileage by assigning activities
    for (let i = 0; i < 10; i++) {
      assignShoeToActivity(`act_${i}`, 40, `2025-01-${String(i + 1).padStart(2, '0')}`, shoe.id);
    }
    // shoe now has 400 mi out of 500
    const deg = calculateDegradation(shoe.id);
    expect(deg).not.toBeNull();
    expect(deg!.usagePct).toBe(80);
    expect(deg!.remainingMiles).toBe(100);
    expect(deg!.urgency).toBe('warning'); // 80% triggers warning
  });

  it('returns critical urgency when over limit', () => {
    const shoe = addTrainer();
    assignShoeToActivity('act_big', 510, '2025-01-15', shoe.id);
    const deg = calculateDegradation(shoe.id);
    expect(deg!.usagePct).toBe(102);
    expect(deg!.remainingMiles).toBe(0);
    expect(deg!.urgency).toBe('critical');
    expect(deg!.statusMessage).toContain('exceeded');
  });

  it('returns retired urgency for retired shoes', () => {
    const shoe = addTrainer();
    assignShoeToActivity('act_1', 100, '2025-01-15', shoe.id);
    retireShoe(shoe.id);
    const deg = calculateDegradation(shoe.id);
    expect(deg!.urgency).toBe('retired');
    expect(deg!.statusMessage).toContain('retired');
  });

  it('detects race-day warning', () => {
    const shoe = addRacer(); // 300 mi limit

    // Simulate recent weekly mileage: 4 weeks of ~50 mi/week on this shoe
    const today = new Date();
    for (let w = 0; w < 4; w++) {
      for (let d = 0; d < 5; d++) {
        const runDate = new Date(today);
        runDate.setDate(today.getDate() - (w * 7 + d));
        assignShoeToActivity(
          `act_w${w}_d${d}`,
          10, // 10 mi per run × 5 runs × 4 weeks = 200 mi
          runDate.toISOString().slice(0, 10),
          shoe.id,
        );
      }
    }
    // shoe has 200 mi, at 50/week, 100 mi remaining = 2 weeks
    // Race in 4 weeks → will exceed (200 + 50*4 = 400 > 300)
    const raceDate = new Date(today);
    raceDate.setDate(raceDate.getDate() + 28);
    const deg = calculateDegradation(shoe.id, raceDate.toISOString().slice(0, 10));
    expect(deg!.exceedsBeforeRace).toBe(true);
    expect(deg!.urgency).toBe('warning');
    expect(deg!.statusMessage).toContain('race day');
  });

  it('returns null for non-existent shoe', () => {
    expect(calculateDegradation('fake_id')).toBeNull();
  });
});

describe('Retirement Alerts', () => {
  it('returns only warning/critical shoes', () => {
    const good = addTrainer();
    assignShoeToActivity('act_1', 100, '2025-01-15', good.id); // 20% — ok

    const worn = addShoe({
      name: 'Worn Out',
      brand: 'Asics',
      model: 'Gel-Kayano',
      category: 'training',
      purchaseDate: '2024-01-01',
    });
    assignShoeToActivity('act_2', 450, '2025-01-15', worn.id); // 90% — warning

    const alerts = checkRetirementAlerts();
    expect(alerts.length).toBe(1);
    expect(alerts[0].shoeId).toBe(worn.id);
    expect(alerts[0].urgency).toBe('warning');
  });

  it('getShoesSummary returns all shoes', () => {
    addTrainer();
    addRacer();
    const summary = getShoesSummary();
    expect(summary.length).toBe(2);
  });
});
