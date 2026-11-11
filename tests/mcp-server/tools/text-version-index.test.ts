/**
 * @fileoverview The `text` page each lookup returns: rows stamped `offset + i`,
 * the copy of the last version an enacted bill appends past the end dropped, and
 * a next offset set from `count`. Input pages are the ones CongressApiService
 * builds (cut to `limit`, `nextOffset` from upstream's `next`) for 119th H.R. 1
 * (6 versions, the Public Law version appended to every page) and 118th H.R. 2
 * (3 versions, nothing appended), 2026-11-11.
 * @module tests/mcp-server/tools/text-version-index.test
 */

import { describe, expect, it } from 'vitest';

import { textVersionPage } from '@/mcp-server/tools/text-version-index.js';

/** A page of `types`, with the pagination the service builds for it. */
function page(types: readonly string[], count: number, nextOffset: number | null) {
  return { data: types.map((type) => ({ type })), pagination: { count, nextOffset } };
}

/** The `type` and stamped index of each row, in order, and the next offset. */
function stamped(result: {
  data: Array<Record<string, unknown>>;
  pagination: { nextOffset: number | null };
}) {
  return {
    rows: result.data.map((row) => [row.type, row.textVersionIndex]),
    nextOffset: result.pagination.nextOffset,
  };
}

describe('textVersionPage', () => {
  /** 119th H.R. 1: indices 0–4 page by offset; Public Law (5) follows every page. */
  const [ENR, EAS, PCS, EH, RH] = ['Enrolled', 'EAS', 'PCS', 'EH', 'RH'] as const;
  const PL = 'Public Law';

  it.each([
    ['a full first page, its copy cut', 0, [ENR, EAS], 2, [0, 1], 2],
    ['a full middle page, its copy cut', 2, [PCS, EH], 4, [2, 3], 4],
    ['the page that covers the last version', 4, [RH, PL], null, [4, 5], null],
    ['a page ending two short of the last version', 3, [EH, RH, PL], null, [3, 4, 5], null],
    ['the whole list in one page', 0, [ENR, EAS, PCS, EH, RH, PL], null, [0, 1, 2, 3, 4, 5], null],
    ['the last version alone, at its own offset', 5, [PL], null, [5], null],
  ] as const)('stamps %s by its offset', (_label, offset, types, next, indices, nextOffset) => {
    expect(stamped(textVersionPage(page(types, 6, next), { offset }))).toEqual({
      rows: types.map((type, i) => [type, indices[i]]),
      nextOffset,
    });
  });

  it.each([
    ['at limit 1 from offset 4', 4, [RH]],
    ['at limit 5 from offset 0', 0, [ENR, EAS, PCS, EH, RH]],
  ] as const)(
    'points a page whose upstream next stops short of the last version at it, %s',
    (_label, offset, types) => {
      const result = textVersionPage(page(types, 6, null), { offset });
      expect(stamped(result)).toEqual({
        rows: types.map((type, i) => [type, offset + i]),
        nextOffset: 5,
      });
    },
  );

  it.each([
    ['just past the end', 6],
    ['far past the end', 99],
  ] as const)('drops the copy of the last version %s, leaving the page empty', (_label, offset) => {
    expect(textVersionPage(page([PL], 6, null), { offset })).toEqual({
      data: [],
      pagination: { count: 6, nextOffset: null },
    });
  });

  it.each([
    ['the first page', 0, ['PCS'], 1, [0], 1],
    ['a middle page', 1, ['EH'], 2, [1], 2],
    ['the last page', 2, ['IH'], null, [2], null],
    ['the whole list', 0, ['PCS', 'EH', 'IH'], null, [0, 1, 2], null],
  ] as const)(
    'stamps %s of a list with nothing appended, keeping its next offset',
    (_label, offset, types, next, indices, nextOffset) => {
      expect(stamped(textVersionPage(page(types, 3, next), { offset }))).toEqual({
        rows: types.map((type, i) => [type, indices[i]]),
        nextOffset,
      });
    },
  );

  it('returns an empty page past the end of a list with nothing appended', () => {
    expect(textVersionPage(page([], 3, null), { offset: 4 })).toEqual(page([], 3, null));
  });

  it('keeps every other field of a row and the pagination, and leaves the input untouched', () => {
    const input = {
      data: [{ type: 'EH', date: '2025-05-22T04:00:00Z', formats: [{ type: 'PDF', url: 'u' }] }],
      pagination: { count: 3, nextOffset: 2 },
    };
    const before = structuredClone(input);
    expect(textVersionPage(input, { offset: 1 })).toEqual({
      data: [{ ...before.data[0], textVersionIndex: 1 }],
      pagination: { count: 3, nextOffset: 2 },
    });
    expect(input).toEqual(before);
  });
});
