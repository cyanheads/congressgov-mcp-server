/**
 * @fileoverview Tests for the summary page budget and per-row character window.
 *
 * Resolves cyanheads/congressgov-mcp-server#70.
 *
 * @module tests/mcp-server/tools/summary-window.test
 */

import { describe, expect, it } from 'vitest';

import {
  type SummaryPage,
  safeWindowEnd,
  summaryContinuationCall,
  summaryWindowNotice,
  windowSummaryPage,
} from '@/mcp-server/tools/summary-window.js';
import {
  DEFAULT_SUMMARY_TEXT_CHARACTERS,
  MAX_CONTENT_CHARACTERS,
  SUMMARY_PAGE_CHARACTERS,
} from '@/mcp-server/tools/tool-helpers.js';

/** Dense markup: every window edge in the sweep below lands inside something. */
const MARKUP =
  '<p><strong>Widget Act of 2026</strong></p>' +
  '<p>The bill&nbsp;requires A &amp; B to file &lt;forms&gt; before 2027, ' +
  'and directs the Secretary &#8212; acting through the Administrator &#x2014; to report.</p>' +
  '<ul><li>First item &quot;quoted&quot;;</li>' +
  '<li>Second item, <em>emphasized </em>and cross-referenced;</li>' +
  '<li>Third item &apos;single-quoted&apos;.</li></ul>' +
  '<p>Afterward the bill <a href="https://example.test/a?x=1&amp;y=2">links out</a> and ends.</p>';

/** A page of one row, ready for the windower. */
function onePage(text: string, extra: Record<string, unknown> = {}): SummaryPage {
  return {
    data: [{ actionDesc: 'Introduced in House', versionCode: '00', text, ...extra }],
    pagination: { count: 1, nextOffset: null },
  };
}

/** Follow `textNextOffset` to null, collecting each window. */
function walk(text: string, characterLimit: number): string[] {
  const windows: string[] = [];
  let characterOffset: number | null = 0;
  for (let guard = 0; characterOffset !== null; guard++) {
    if (guard > 5_000) throw new Error('window walk did not terminate');
    const result = windowSummaryPage(onePage(text), {
      offset: 0,
      characterOffset,
      characterLimit,
    });
    const row = result.page.data[0] as Record<string, unknown>;
    windows.push(row.text as string);
    const next = row.textNextOffset;
    characterOffset = typeof next === 'number' ? next : null;
  }
  return windows;
}

const endsInsideTag = (window: string) => window.lastIndexOf('<') > window.lastIndexOf('>');
const endsInsideReference = (window: string) => /&[#0-9A-Za-z]{0,11}$/.test(window);

describe('safeWindowEnd', () => {
  it('retracts off an unterminated tag', () => {
    //                      0123456789
    const text = 'abc<strong>bold</strong>';
    expect(safeWindowEnd(text, 0, 7)).toBe(3);
  });

  it('leaves an end that sits after a closed tag alone', () => {
    const text = 'abc<strong>bold</strong>';
    expect(safeWindowEnd(text, 0, 13)).toBe(13);
  });

  it('retracts off a pending character reference', () => {
    const text = 'abc&nbsp;def';
    expect(safeWindowEnd(text, 0, 6)).toBe(3);
  });

  it('leaves an end after a complete character reference alone', () => {
    const text = 'abc&nbsp;def';
    expect(safeWindowEnd(text, 0, 10)).toBe(10);
  });

  it('retracts to the earlier of a pending tag and a pending reference', () => {
    const text = 'x<a href="y&amp';
    expect(safeWindowEnd(text, 0, text.length)).toBe(1);
  });

  it('ignores a stray ampersand too far back to be a reference', () => {
    const text = `a&${'b'.repeat(40)}`;
    expect(safeWindowEnd(text, 0, 30)).toBe(30);
  });

  it('keeps the requested end when the construct spans the whole window', () => {
    const text = '<strong>bold</strong>';
    expect(safeWindowEnd(text, 0, 4)).toBe(4);
  });
});

describe('windowSummaryPage — per-row window', () => {
  it('returns a row that fits untouched, with no window metadata', () => {
    const page = onePage(MARKUP);
    const result = windowSummaryPage(page, { offset: 0 });
    expect(result.page.data[0]).toBe(page.data[0]);
    expect(result.page.data[0]).not.toHaveProperty('textTotalCharacters');
    expect(result.windowed).toHaveLength(0);
    expect(result.stoppedForSize).toBe(false);
  });

  it('windows a row past the limit and publishes its offsets', () => {
    const text = 'x'.repeat(120);
    const result = windowSummaryPage(onePage(text), { offset: 0, characterLimit: 50 });
    expect(result.page.data[0]).toMatchObject({
      text: 'x'.repeat(50),
      textTotalCharacters: 120,
      textTruncated: true,
      textNextOffset: 50,
    });
    expect(result.windowed).toEqual([
      expect.objectContaining({
        index: 0,
        totalCharacters: 120,
        start: 0,
        end: 50,
        nextOffset: 50,
      }),
    ]);
  });

  it('closes the walk with textNextOffset null on the last window', () => {
    const text = 'x'.repeat(120);
    const result = windowSummaryPage(onePage(text), {
      offset: 0,
      characterOffset: 100,
      characterLimit: 50,
    });
    expect(result.page.data[0]).toMatchObject({
      text: 'x'.repeat(20),
      textTotalCharacters: 120,
      textTruncated: false,
      textNextOffset: null,
    });
  });

  it.each([48, 53, 64, 71, 89, 97])(
    'reassembles the exact upstream text walking at characterLimit %i',
    (characterLimit) => {
      const windows = walk(MARKUP, characterLimit);
      expect(windows.join('')).toBe(MARKUP);
      expect(windows.length).toBeGreaterThan(3);
      for (const [index, window] of windows.entries()) {
        expect(window.length, `window ${index} is empty`).toBeGreaterThan(0);
        expect(
          endsInsideTag(window),
          `window ${index} splits a tag: ${JSON.stringify(window)}`,
        ).toBe(false);
        expect(
          endsInsideReference(window),
          `window ${index} splits a reference: ${JSON.stringify(window)}`,
        ).toBe(false);
      }
    },
  );

  it('reassembles exactly even when a construct is longer than the whole window', () => {
    const windows = walk(MARKUP, 5);
    expect(windows.join('')).toBe(MARKUP);
    expect(windows.every((window) => window.length > 0)).toBe(true);
  });

  /**
   * The documented fallback: MARKUP's anchor open tag is 45 characters, so a
   * window narrower than that cannot both start at the tag and clear it. The
   * requested limit wins, the walk keeps moving, and reassembly stays exact.
   */
  it.each([32, 37, 41])('honors a limit narrower than one tag at characterLimit %i', (limit) => {
    const windows = walk(MARKUP, limit);
    expect(windows.join('')).toBe(MARKUP);
    expect(windows.every((window) => window.length > 0 && window.length <= limit)).toBe(true);
    expect(windows.some(endsInsideTag)).toBe(true);
  });

  it('a mid-text characterOffset windows from there with no offset snapping', () => {
    const result = windowSummaryPage(onePage(MARKUP), {
      offset: 0,
      characterOffset: 17,
      characterLimit: 40,
    });
    const row = result.page.data[0] as Record<string, unknown>;
    const end = row.textNextOffset as number;
    expect(row.text).toBe(MARKUP.slice(17, end));
    expect(end).toBeLessThanOrEqual(57);
  });

  it('returns an empty window and flags offsetPastEnd past a row end', () => {
    const result = windowSummaryPage(onePage('short summary'), {
      offset: 0,
      characterOffset: 13,
      characterLimit: 100,
    });
    expect(result.page.data[0]).toMatchObject({
      text: '',
      textTotalCharacters: 13,
      textTruncated: false,
      textNextOffset: null,
    });
    expect(result.offsetPastEnd).toBe(true);
  });

  it('does not flag offsetPastEnd while any row still has text at that offset', () => {
    const page: SummaryPage = {
      data: [{ text: 'short' }, { text: 'a much longer summary body' }],
      pagination: { count: 2, nextOffset: null },
    };
    const result = windowSummaryPage(page, { offset: 0, characterOffset: 10, characterLimit: 100 });
    expect(result.offsetPastEnd).toBe(false);
    expect(result.page.data[0]).toMatchObject({ text: '' });
    expect(result.page.data[1]).toMatchObject({ text: 'ger summary body' });
  });

  it('never flags offsetPastEnd at characterOffset 0, even on an empty summary', () => {
    const result = windowSummaryPage(onePage(''), { offset: 0 });
    expect(result.offsetPastEnd).toBe(false);
    expect(result.page.data[0]).not.toHaveProperty('textTotalCharacters');
  });

  it('leaves a row carrying no text field alone', () => {
    const page: SummaryPage = {
      data: [{ actionDesc: 'Introduced in House' }],
      pagination: { count: 1, nextOffset: null },
    };
    const result = windowSummaryPage(page, { offset: 0, characterOffset: 500 });
    expect(result.page.data[0]).toEqual({ actionDesc: 'Introduced in House' });
    expect(result.offsetPastEnd).toBe(false);
  });

  it('defaults the row window to DEFAULT_SUMMARY_TEXT_CHARACTERS', () => {
    const result = windowSummaryPage(onePage('y'.repeat(DEFAULT_SUMMARY_TEXT_CHARACTERS + 10)), {
      offset: 0,
    });
    expect((result.page.data[0] as Record<string, unknown>).textNextOffset).toBe(
      DEFAULT_SUMMARY_TEXT_CHARACTERS,
    );
  });
});

describe('windowSummaryPage — page budget', () => {
  /** A row whose serialized length is roughly `chars` plus a little scaffolding. */
  const row = (chars: number, index: number) => ({
    actionDesc: 'Introduced in House',
    versionCode: '00',
    text: `${index}`.padEnd(chars, 'z'),
  });

  it('keeps a page that fits byte-identical, pagination included', () => {
    const page: SummaryPage = {
      data: [row(1_000, 0), row(1_000, 1)],
      pagination: { count: 40, nextOffset: 2 },
    };
    const result = windowSummaryPage(page, { offset: 0 });
    expect(JSON.stringify(result.page)).toBe(JSON.stringify(page));
    expect(result.stoppedForSize).toBe(false);
    expect(result.droppedRows).toBe(0);
  });

  it('stops mid-page and resumes at the first row not returned', () => {
    const data = Array.from({ length: 10 }, (_, index) => row(6_000, index));
    const result = windowSummaryPage(
      { data, pagination: { count: 200, nextOffset: 10 } },
      { offset: 20 },
    );
    expect(result.stoppedForSize).toBe(true);
    expect(result.page.data.length).toBeLessThan(10);
    expect(result.page.pagination.nextOffset).toBe(20 + result.page.data.length);
    expect(result.droppedRows).toBe(10 - result.page.data.length);
    const used = result.page.data.reduce((sum, kept) => sum + JSON.stringify(kept).length, 0);
    expect(used).toBeLessThanOrEqual(SUMMARY_PAGE_CHARACTERS);
    /** The first dropped row is the row the resumed page starts with. */
    expect(data[result.page.data.length]).toBe(data.at(result.page.data.length));
  });

  it('returns one row when the first windowed row already fills the budget', () => {
    const data = [
      row(DEFAULT_SUMMARY_TEXT_CHARACTERS + 5_000, 0),
      row(DEFAULT_SUMMARY_TEXT_CHARACTERS + 5_000, 1),
    ];
    const result = windowSummaryPage(
      { data, pagination: { count: 5, nextOffset: 2 } },
      { offset: 0 },
    );
    expect(result.page.data).toHaveLength(1);
    expect(result.stoppedForSize).toBe(true);
    expect(result.page.pagination.nextOffset).toBe(1);
    expect((result.page.data[0] as Record<string, unknown>).textNextOffset).toBe(
      DEFAULT_SUMMARY_TEXT_CHARACTERS,
    );
  });

  it('always returns the first row, even when it alone clears the budget', () => {
    const result = windowSummaryPage(
      { data: [row(400_000, 0), row(10, 1)], pagination: { count: 2, nextOffset: null } },
      { offset: 0, characterLimit: MAX_CONTENT_CHARACTERS },
    );
    expect(result.page.data).toHaveLength(1);
    expect(JSON.stringify(result.page.data[0]).length).toBeGreaterThan(SUMMARY_PAGE_CHARACTERS);
    expect(result.stoppedForSize).toBe(true);
    expect(result.page.pagination.nextOffset).toBe(1);
  });

  it('leaves pagination untouched when nothing was dropped', () => {
    const page: SummaryPage = {
      data: [row(10, 0)],
      pagination: { count: 99, nextOffset: null },
    };
    const result = windowSummaryPage(page, { offset: 40 });
    expect(result.page.pagination).toEqual({ count: 99, nextOffset: null });
  });
});

describe('summaryContinuationCall', () => {
  it('lower-cases the upstream bill type so the printed call parses', () => {
    expect(
      summaryContinuationCall({
        congress: 118,
        billType: 'HR',
        billNumber: '2882',
        versionCode: '49',
        characterOffset: 25_000,
      }),
    ).toBe(
      'congressgov_bill_lookup {"operation":"summaries","congress":118,"billType":"hr","billNumber":"2882","versionCode":"49","characterOffset":25000}',
    );
  });

  it('omits versionCode when the row carries none', () => {
    expect(
      summaryContinuationCall({
        congress: '119',
        billType: 'sconres',
        billNumber: 38,
        characterOffset: 0,
      }),
    ).toBe(
      'congressgov_bill_lookup {"operation":"summaries","congress":119,"billType":"sconres","billNumber":"38","characterOffset":0}',
    );
  });
});

describe('summaryWindowNotice', () => {
  const bounded = (data: Record<string, unknown>[], characterLimit: number, count: number) =>
    windowSummaryPage(
      { data, pagination: { count, nextOffset: null } },
      {
        offset: 0,
        characterLimit,
      },
    );

  it('is absent when neither limit fired', () => {
    expect(
      summaryWindowNotice(bounded([{ text: 'hi' }], 100, 1), 20, () => undefined),
    ).toBeUndefined();
  });

  it('discloses a size-driven stop and where to resume', () => {
    const data = Array.from({ length: 10 }, () => ({ text: 'z'.repeat(6_000) }));
    const notice = summaryWindowNotice(bounded(data, 25_000, 200), 10, () => undefined);
    expect(notice).toMatch(/Returned \d+ of the 10 rows requested/);
    expect(notice).toContain('50,000-character budget');
    expect(notice).toMatch(/Continue at offset \d+\./);
  });

  it('names the continuation call for the first windowed row', () => {
    const notice = summaryWindowNotice(
      bounded([{ versionCode: '49', text: 'z'.repeat(1_000) }], 400, 1),
      20,
      () => 'congressgov_bill_lookup {"operation":"summaries"}',
    );
    expect(notice).toContain('runs 1,000 characters; characters 1–400 returned.');
    expect(notice).toContain('Continue with: congressgov_bill_lookup {"operation":"summaries"}');
  });

  it('counts the other windowed rows on the page', () => {
    const data = [
      { text: 'a'.repeat(1_000) },
      { text: 'b'.repeat(1_000) },
      { text: 'c'.repeat(1_000) },
    ];
    const notice = summaryWindowNotice(bounded(data, 400, 3), 20, () => 'CALL');
    expect(notice).toContain("3 rows on this page carry windowed text; each row's textNextOffset");
  });
});
