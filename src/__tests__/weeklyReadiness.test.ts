/**
 * Unit tests for weeklyReadiness.ts
 *
 * Tests the letter grade computation and readiness score structure.
 */

import { describe, it, expect } from 'vitest';
import { letterGrade } from '@/services/weeklyReadiness';

// ── letterGrade ───────────────────────────────────────────────────────────────

describe('letterGrade', () => {
  it('should return A+ for scores >= 95', () => {
    expect(letterGrade(95)).toBe('A+');
    expect(letterGrade(100)).toBe('A+');
    expect(letterGrade(99)).toBe('A+');
  });

  it('should return A for scores 88-94', () => {
    expect(letterGrade(88)).toBe('A');
    expect(letterGrade(94)).toBe('A');
    expect(letterGrade(90)).toBe('A');
  });

  it('should return B+ for scores 82-87', () => {
    expect(letterGrade(82)).toBe('B+');
    expect(letterGrade(87)).toBe('B+');
    expect(letterGrade(85)).toBe('B+');
  });

  it('should return B for scores 75-81', () => {
    expect(letterGrade(75)).toBe('B');
    expect(letterGrade(81)).toBe('B');
    expect(letterGrade(78)).toBe('B');
  });

  it('should return C+ for scores 68-74', () => {
    expect(letterGrade(68)).toBe('C+');
    expect(letterGrade(74)).toBe('C+');
    expect(letterGrade(70)).toBe('C+');
  });

  it('should return C for scores 60-67', () => {
    expect(letterGrade(60)).toBe('C');
    expect(letterGrade(67)).toBe('C');
    expect(letterGrade(63)).toBe('C');
  });

  it('should return D for scores below 60', () => {
    expect(letterGrade(59)).toBe('D');
    expect(letterGrade(0)).toBe('D');
    expect(letterGrade(30)).toBe('D');
  });

  it('should handle boundary values exactly', () => {
    expect(letterGrade(94.9)).toBe('A');   // Not quite A+
    expect(letterGrade(95.0)).toBe('A+');
    expect(letterGrade(87.9)).toBe('B+');  // Not quite A
    expect(letterGrade(88.0)).toBe('A');
  });

  it('should be monotonically increasing (higher score = better grade)', () => {
    const grades = ['D', 'C', 'C+', 'B', 'B+', 'A', 'A+'];
    const gradeOrder = (g: string) => grades.indexOf(g);

    const scores = [50, 60, 68, 75, 82, 88, 95];
    for (let i = 1; i < scores.length; i++) {
      expect(gradeOrder(letterGrade(scores[i]))).toBeGreaterThanOrEqual(
        gradeOrder(letterGrade(scores[i - 1])),
      );
    }
  });
});
