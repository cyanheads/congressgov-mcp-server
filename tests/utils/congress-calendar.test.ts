/**
 * @fileoverview Tests for the congress numbering arithmetic shared by the services and config.
 * @module tests/utils/congress-calendar.test
 */

import { describe, expect, it } from 'vitest';
import { congressFirstYear, currentCongressNumber, ordinal } from '@/utils/congress-calendar.js';

describe('ordinal', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [101, '101st'],
    [111, '111th'],
    [112, '112th'],
    [118, '118th'],
    [119, '119th'],
  ])('%i → %s', (n, expected) => {
    expect(ordinal(n)).toBe(expected);
  });
});

describe('congressFirstYear', () => {
  it.each([
    [1, 1789],
    [101, 1989],
    [118, 2023],
    [119, 2025],
  ])('congress %i opened in %i', (congress, year) => {
    expect(congressFirstYear(congress)).toBe(year);
  });
});

describe('currentCongressNumber', () => {
  it.each([
    ['2023-01-03T00:00:00Z', 118],
    ['2024-12-31T23:59:59Z', 118],
    ['2025-01-03T00:00:00Z', 119],
    ['2026-11-01T00:00:00Z', 119],
  ])('%s → %i', (iso, congress) => {
    expect(currentCongressNumber(new Date(iso))).toBe(congress);
  });
});
