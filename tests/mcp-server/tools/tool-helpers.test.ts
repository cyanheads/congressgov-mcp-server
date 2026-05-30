/**
 * @fileoverview Tests for shared tool-helpers — validateIsoDateTime, normalizeOptionalString, buildEffectiveQuery.
 * @module tests/mcp-server/tools/tool-helpers.test
 */

import { describe, expect, it } from 'vitest';
import {
  buildEffectiveQuery,
  normalizeOptionalString,
  validateIsoDateTime,
} from '@/mcp-server/tools/tool-helpers.js';

describe('normalizeOptionalString', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeOptionalString(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(normalizeOptionalString('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(normalizeOptionalString('   ')).toBeUndefined();
  });

  it('trims and returns non-empty string', () => {
    expect(normalizeOptionalString('  hello  ')).toBe('hello');
  });

  it('returns value unchanged when no surrounding whitespace', () => {
    expect(normalizeOptionalString('value')).toBe('value');
  });
});

describe('validateIsoDateTime', () => {
  it('returns undefined when value is undefined', () => {
    expect(validateIsoDateTime(undefined, 'field')).toBeUndefined();
  });

  it('accepts well-formed ISO 8601 datetime strings', () => {
    expect(validateIsoDateTime('2026-01-15T00:00:00Z', 'fromDateTime')).toBe(
      '2026-01-15T00:00:00Z',
    );
    expect(validateIsoDateTime('2023-12-31T23:59:59Z', 'toDateTime')).toBe('2023-12-31T23:59:59Z');
  });

  it('throws on date-only string (missing time component)', () => {
    expect(() => validateIsoDateTime('2026-01-15', 'fromDateTime')).toThrow(/ISO 8601/);
  });

  it('throws on datetime with offset instead of Z', () => {
    expect(() => validateIsoDateTime('2026-01-15T00:00:00+05:00', 'fromDateTime')).toThrow(
      /ISO 8601/,
    );
  });

  it('throws on completely invalid string', () => {
    expect(() => validateIsoDateTime('not-a-date', 'fromDateTime')).toThrow(/ISO 8601/);
  });

  it('includes the field name in the error message', () => {
    expect(() => validateIsoDateTime('bad-date', 'myField')).toThrow(/myField/);
  });

  it('includes the bad value in the error message', () => {
    expect(() => validateIsoDateTime('bad-date', 'myField')).toThrow(/bad-date/);
  });

  it('rejects injection-like strings without crashing', () => {
    const injection = "2026-01-01'; DROP TABLE bills; --";
    expect(() => validateIsoDateTime(injection, 'fromDateTime')).toThrow(/ISO 8601/);
  });

  it('rejects very long strings (oversized input)', () => {
    const oversized = '2026-01-15T00:00:00Z' + 'x'.repeat(5000);
    expect(() => validateIsoDateTime(oversized, 'fromDateTime')).toThrow(/ISO 8601/);
  });
});

describe('buildEffectiveQuery', () => {
  it('returns scope alone when no filters are provided', () => {
    expect(buildEffectiveQuery('bills')).toBe('bills');
  });

  it('returns scope alone when filters is empty object', () => {
    expect(buildEffectiveQuery('bills', {})).toBe('bills');
  });

  it('appends non-empty filter values in (key=val) format', () => {
    const result = buildEffectiveQuery('bills', { congress: 118, billType: 'hr' });
    expect(result).toBe('bills (congress=118, billType=hr)');
  });

  it('omits undefined filter values', () => {
    const result = buildEffectiveQuery('members', { congress: undefined, stateCode: 'CA' });
    expect(result).toBe('members (stateCode=CA)');
  });

  it('omits null filter values', () => {
    const result = buildEffectiveQuery('members', { congress: null, stateCode: 'TX' });
    expect(result).toBe('members (stateCode=TX)');
  });

  it('omits empty-string filter values', () => {
    const result = buildEffectiveQuery('bills', { congress: 118, billType: '' });
    expect(result).toBe('bills (congress=118)');
  });

  it('returns scope alone when all filters are empty/null/undefined', () => {
    const result = buildEffectiveQuery('bills', { a: undefined, b: null, c: '' });
    expect(result).toBe('bills');
  });

  it('handles boolean false as a valid filter value', () => {
    const result = buildEffectiveQuery('members', { currentMember: false });
    expect(result).toBe('members (currentMember=false)');
  });

  it('handles numeric zero as a valid filter value', () => {
    const result = buildEffectiveQuery('members', { district: 0 });
    expect(result).toBe('members (district=0)');
  });
});
