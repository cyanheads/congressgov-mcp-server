/**
 * @fileoverview Tests for resolving a requested document format to an upstream URL.
 * @module tests/services/congress-documents/document-formats.test
 */

import { describe, expect, it } from 'vitest';
import {
  describeFormat,
  selectDocumentUrl,
} from '@/services/congress-documents/document-formats.js';

/** A bill text version's `formats[]`, as Congress.gov returns it. */
const BILL_FORMATS = [
  { type: 'Formatted Text', url: 'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr.htm' },
  { type: 'PDF', url: 'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr.pdf' },
  {
    type: 'United States Legislative Markup',
    url: 'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr_uslm.xml',
  },
  { type: 'Formatted XML', url: 'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr.xml' },
];

describe('selectDocumentUrl', () => {
  it('resolves text to the Formatted Text URL', () => {
    expect(selectDocumentUrl(BILL_FORMATS, 'text')).toBe(
      'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr.htm',
    );
  });

  it('prefers United States Legislative Markup over Formatted XML', () => {
    expect(selectDocumentUrl(BILL_FORMATS, 'xml')).toBe(
      'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr_uslm.xml',
    );
  });

  it('falls back to Formatted XML when no USLM is published', () => {
    const legacy = BILL_FORMATS.filter((f) => f.type !== 'United States Legislative Markup');
    expect(selectDocumentUrl(legacy, 'xml')).toBe(
      'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr.xml',
    );
  });

  it('returns undefined when the format is not published for this document', () => {
    const pdfOnly = [{ type: 'PDF', url: 'https://www.congress.gov/118/crpt/hrpt1/CRPT.pdf' }];
    expect(selectDocumentUrl(pdfOnly, 'text')).toBeUndefined();
    expect(selectDocumentUrl(pdfOnly, 'xml')).toBeUndefined();
  });

  it('never resolves to a PDF', () => {
    const urls = [selectDocumentUrl(BILL_FORMATS, 'text'), selectDocumentUrl(BILL_FORMATS, 'xml')];
    for (const url of urls) expect(url).not.toMatch(/\.pdf$/);
  });

  it('prefers a non-errata entry over an errata reprint', () => {
    const withErrata = [
      { isErrata: 'Y', type: 'Formatted Text', url: 'https://www.congress.gov/errata.htm' },
      { isErrata: 'N', type: 'Formatted Text', url: 'https://www.congress.gov/report.htm' },
    ];
    expect(selectDocumentUrl(withErrata, 'text')).toBe('https://www.congress.gov/report.htm');
  });

  it('falls back to an errata entry when it is the only one', () => {
    const errataOnly = [
      { isErrata: 'Y', type: 'Formatted Text', url: 'https://www.congress.gov/errata.htm' },
    ];
    expect(selectDocumentUrl(errataOnly, 'text')).toBe('https://www.congress.gov/errata.htm');
  });

  it('matches the upstream label case-insensitively and ignores surrounding space', () => {
    const odd = [{ type: '  formatted text ', url: 'https://www.congress.gov/x.htm' }];
    expect(selectDocumentUrl(odd, 'text')).toBe('https://www.congress.gov/x.htm');
  });

  it('skips entries whose url is missing, blank, or not a string', () => {
    const sparse = [
      { type: 'Formatted Text' },
      { type: 'Formatted Text', url: '   ' },
      { type: 'Formatted Text', url: 42 },
      { type: 'Formatted Text', url: 'https://www.congress.gov/good.htm' },
    ];
    expect(selectDocumentUrl(sparse, 'text')).toBe('https://www.congress.gov/good.htm');
  });

  it('returns undefined for a non-array, empty array, or non-object rows', () => {
    expect(selectDocumentUrl(undefined, 'text')).toBeUndefined();
    expect(selectDocumentUrl([], 'text')).toBeUndefined();
    expect(selectDocumentUrl([null, 'nope', 7], 'text')).toBeUndefined();
  });
});

describe('describeFormat', () => {
  it('names the upstream labels each format searches for', () => {
    expect(describeFormat('text')).toBe('Formatted Text');
    expect(describeFormat('xml')).toBe('United States Legislative Markup / Formatted XML');
  });
});
