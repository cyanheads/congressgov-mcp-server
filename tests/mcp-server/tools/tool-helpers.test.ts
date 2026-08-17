/**
 * @fileoverview Tests for shared tool-helpers — normalizeOptionalString, validateIsoDateTime,
 * numericIdentifier/toIdentifierNumber, lawNumberIdentifier/toLawNumber,
 * validateDateTimeRange, buildEffectiveQuery, notifyIfNoMatches.
 * @module tests/mcp-server/tools/tool-helpers.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  buildEffectiveQuery,
  lawNumberIdentifier,
  normalizeOptionalString,
  notifyIfNoMatches,
  numericIdentifier,
  toIdentifierNumber,
  toLawNumber,
  validateDateTimeRange,
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

  // ── Calendar validity (shape matches but the date is impossible) — #35 ──────

  it('accepts a real leap-day datetime', () => {
    expect(validateIsoDateTime('2024-02-29T12:00:00Z', 'fromDateTime')).toBe(
      '2024-02-29T12:00:00Z',
    );
  });

  it('rejects February 30 even with a valid time component', () => {
    expect(() => validateIsoDateTime('2023-02-30T00:00:00Z', 'fromDateTime')).toThrow(/ISO 8601/);
  });

  it('rejects month 13', () => {
    expect(() => validateIsoDateTime('2023-13-01T00:00:00Z', 'fromDateTime')).toThrow(/ISO 8601/);
  });

  it('rejects February 29 in a non-leap year', () => {
    expect(() => validateIsoDateTime('2023-02-29T00:00:00Z', 'toDateTime')).toThrow(/ISO 8601/);
  });

  it('rejects day 00 and month 00', () => {
    expect(() => validateIsoDateTime('2023-01-00T00:00:00Z', 'fromDateTime')).toThrow(/ISO 8601/);
    expect(() => validateIsoDateTime('2023-00-15T00:00:00Z', 'fromDateTime')).toThrow(/ISO 8601/);
  });

  it('rejects impossible time components (hour 25, minute 60, second 60)', () => {
    expect(() => validateIsoDateTime('2023-05-01T25:00:00Z', 'fromDateTime')).toThrow(/ISO 8601/);
    expect(() => validateIsoDateTime('2023-05-01T00:60:00Z', 'fromDateTime')).toThrow(/ISO 8601/);
    expect(() => validateIsoDateTime('2023-05-01T00:00:60Z', 'fromDateTime')).toThrow(/ISO 8601/);
  });
});

describe('numericIdentifier / toIdentifierNumber', () => {
  const schema = numericIdentifier('Test identifier.');

  it('accepts a positive integer', () => {
    expect(schema.parse(9479)).toBe(9479);
  });

  it('accepts a digit string, including zero-padded', () => {
    expect(schema.parse('9479')).toBe('9479');
    expect(schema.parse('0009479')).toBe('0009479');
  });

  it.each(['abc', '12a', '9479x', '94.5', '-5', '+5', '0', '000', '', '   ', ' 9479 ', '1e3'])(
    'rejects %o',
    (value) => {
      expect(() => schema.parse(value)).toThrow();
    },
  );

  it.each([0, -5, 1.5])('rejects the non-positive-integer number %o', (value) => {
    expect(() => schema.parse(value)).toThrow();
  });

  it('emits a JSON-Schema-serializable union (no transform)', () => {
    const json = z.toJSONSchema(schema) as { anyOf?: Array<Record<string, unknown>> };
    expect(json.anyOf).toHaveLength(2);
    expect(json.anyOf?.map((variant) => variant.type)).toEqual(['integer', 'string']);
  });

  it('normalizes both forms to a number', () => {
    expect(toIdentifierNumber(9479)).toBe(9479);
    expect(toIdentifierNumber('9479')).toBe(9479);
    expect(toIdentifierNumber('0009479')).toBe(9479);
  });
});

describe('lawNumberIdentifier / toLawNumber', () => {
  const schema = lawNumberIdentifier('Test law number.');

  it('accepts a positive integer', () => {
    expect(schema.parse(90)).toBe(90);
  });

  it('accepts a digit string, including zero-padded', () => {
    expect(schema.parse('90')).toBe('90');
    expect(schema.parse('0090')).toBe('0090');
  });

  it('accepts the compound citation form list rows carry', () => {
    expect(schema.parse('118-90')).toBe('118-90');
  });

  it.each([
    ['prefix with no law number', '118-'],
    ['law number with a bare hyphen prefix', '-90'],
    ['zero law number in a citation', '118-0'],
    ['a three-part citation', '118-90-1'],
    ['an en-dash citation', '118–90'],
    ['non-numeric', 'abc'],
    ['digits with a trailing letter', '90x'],
    ['decimal', '9.5'],
    ['negative', '-5'],
    ['zero', '0'],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['padded digits', ' 90 '],
    ['scientific notation', '1e3'],
    ['hexadecimal', '0x10'],
  ])('rejects %s', (_label, value) => {
    expect(() => schema.parse(value)).toThrow();
  });

  it.each([0, -5, 1.5])('rejects the non-positive-integer number %o', (value) => {
    expect(() => schema.parse(value)).toThrow();
  });

  it('emits a JSON-Schema-serializable union (no transform)', () => {
    const json = z.toJSONSchema(schema) as { anyOf?: Array<Record<string, unknown>> };
    expect(json.anyOf).toHaveLength(2);
    expect(json.anyOf?.map((variant) => variant.type)).toEqual(['integer', 'string']);
  });

  it('normalizes every accepted form to the bare law number', () => {
    expect(toLawNumber(90, 118)).toBe(90);
    expect(toLawNumber('90', 118)).toBe(90);
    expect(toLawNumber('0090', 118)).toBe(90);
    expect(toLawNumber('118-90', 118)).toBe(90);
  });

  it('rejects a citation whose congress contradicts the congress input', () => {
    expect(() => toLawNumber('119-90', 118)).toThrow(/119/);
    expect(() => toLawNumber('119-90', 118)).toThrow(/congress=118/);
  });

  it('names both recovery paths when the congress contradicts the citation', () => {
    expect(() => toLawNumber('119-90', 118)).toThrow(/lawNumber=90/);
  });
});

describe('validateDateTimeRange', () => {
  const EARLY = '2026-08-01T00:00:00Z';
  const LATE = '2026-08-11T00:00:00Z';

  it('accepts an ordered range', () => {
    expect(() => validateDateTimeRange(EARLY, LATE)).not.toThrow();
  });

  it('accepts a zero-width range (from === to)', () => {
    expect(() => validateDateTimeRange(EARLY, EARLY)).not.toThrow();
  });

  it('accepts fromDateTime alone', () => {
    expect(() => validateDateTimeRange(EARLY, undefined)).not.toThrow();
  });

  it('accepts toDateTime alone', () => {
    expect(() => validateDateTimeRange(undefined, LATE)).not.toThrow();
  });

  it('accepts both bounds absent', () => {
    expect(() => validateDateTimeRange(undefined, undefined)).not.toThrow();
  });

  it('rejects a reversed range', () => {
    expect(() => validateDateTimeRange(LATE, EARLY)).toThrow(/earlier than or equal to/);
  });

  it('rejects a range reversed by only one second', () => {
    expect(() => validateDateTimeRange('2026-08-01T00:00:01Z', '2026-08-01T00:00:00Z')).toThrow(
      /earlier than or equal to/,
    );
  });

  it('names both bounds in the error message', () => {
    expect(() => validateDateTimeRange(LATE, EARLY)).toThrow(new RegExp(LATE));
    expect(() => validateDateTimeRange(LATE, EARLY)).toThrow(new RegExp(EARLY));
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

describe('notifyIfNoMatches', () => {
  const MESSAGE = 'No bills matched the filters.';

  const notify = (data: unknown[], count: number) => {
    const ctx = createMockContext();
    notifyIfNoMatches(ctx, { data, pagination: { count } }, MESSAGE);
    return getEnrichment(ctx).notice;
  };

  it('emits the notice when the result set is genuinely empty', () => {
    expect(notify([], 0)).toBe(MESSAGE);
  });

  it('stays silent on an empty page of a non-empty result set', () => {
    expect(notify([], 10_081)).toBeUndefined();
  });

  it('stays silent when the total is one — a single-row set paged past', () => {
    expect(notify([], 1)).toBeUndefined();
  });

  it('stays silent when the page carries rows', () => {
    expect(notify([{ number: 1 }], 1)).toBeUndefined();
  });

  it('stays silent when the page carries rows and more pages remain', () => {
    expect(notify([{ number: 1 }, { number: 2 }], 500)).toBeUndefined();
  });

  it('passes the caller-supplied message through verbatim', () => {
    const ctx = createMockContext();
    notifyIfNoMatches(ctx, { data: [], pagination: { count: 0 } }, 'No actions found for HR 9479.');
    expect(getEnrichment(ctx).notice).toBe('No actions found for HR 9479.');
  });
});
