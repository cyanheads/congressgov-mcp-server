/**
 * @fileoverview Tests for resolving a requested document format to an upstream
 * URL: GPO format lists, CRS report formats, and the part a committee report's
 * format URL belongs to.
 * @module tests/services/congress-documents/document-formats.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  describeFormat,
  formatUrlPart,
  selectCrsDocumentUrl,
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

/** CRS `formats[]` as `/crsreport/{id}` returns them. */
const CRS = 'https://www.congress.gov/crs_external_products';
const R46406_FORMATS = [
  { format: 'PDF', url: `${CRS}/R/PDF/R46406/R46406.10.pdf` },
  { format: 'HTML', url: `${CRS}/R/HTML/R46406.html` },
];
const RL30010_PDF = `${CRS}/RL/PDF/RL30010/RL30010.3.pdf`;

/** The error `fn` throws, for assertions on its code and data. */
function thrownBy(fn: () => unknown): McpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('expected a throw');
}

describe('selectCrsDocumentUrl', () => {
  it('is needed because the GPO selector reads no CRS entry', () => {
    expect(selectDocumentUrl(R46406_FORMATS, 'text')).toBeUndefined();
    expect(selectDocumentUrl(R46406_FORMATS, 'xml')).toBeUndefined();
  });

  it('picks the HTML entry wherever it sits in the list', () => {
    expect(selectCrsDocumentUrl(R46406_FORMATS, 'R46406')).toBe(`${CRS}/R/HTML/R46406.html`);
    expect(
      selectCrsDocumentUrl(
        [
          { format: 'HTML', url: `${CRS}/RL/HTML/93-931.html` },
          { format: 'PDF', url: `${CRS}/RL/PDF/93-931/93-931.pdf` },
        ],
        '93-931',
      ),
    ).toBe(`${CRS}/RL/HTML/93-931.html`);
  });

  it('reads an HTML-only report', () => {
    expect(
      selectCrsDocumentUrl([{ format: 'HTML', url: `${CRS}/IN/HTML/IN12753.html` }], 'IN12753'),
    ).toBe(`${CRS}/IN/HTML/IN12753.html`);
  });

  it('returns the URL as published, whose path need not follow the report ID', () => {
    expect(
      selectCrsDocumentUrl([{ format: 'HTML', url: ` ${CRS}/RA/HTML/RL32893.html ` }], 'RL32893'),
    ).toBe(`${CRS}/RA/HTML/RL32893.html`);
  });

  it('matches the label case-insensitively and skips entries with no usable URL', () => {
    expect(
      selectCrsDocumentUrl(
        [
          { format: 'HTML' },
          { format: 'HTML', url: '   ' },
          { format: 'HTML', url: 42 },
          null,
          'HTML',
          { format: ' html ', url: `${CRS}/R/HTML/R1.html` },
        ],
        'R1',
      ),
    ).toBe(`${CRS}/R/HTML/R1.html`);
  });

  it('fails format_unavailable naming the PDF of a report with no HTML', () => {
    const error = thrownBy(() =>
      selectCrsDocumentUrl([{ format: 'PDF', url: RL30010_PDF }], 'RL30010'),
    );
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toContain(RL30010_PDF);
    expect(error.message).toContain('RL30010');
    expect(error.data).toEqual({
      reason: 'format_unavailable',
      reportNumber: 'RL30010',
      formats: [{ format: 'PDF', url: RL30010_PDF }],
      retryable: false,
    });
  });

  it('names every published format when none is HTML', () => {
    const error = thrownBy(() =>
      selectCrsDocumentUrl(
        [
          { format: 'EPUB', url: `${CRS}/R/EPUB/R2.epub` },
          { format: 'PDF', url: `${CRS}/R/PDF/R2/R2.pdf` },
        ],
        'R2',
      ),
    );
    expect(error.data).toMatchObject({
      reason: 'format_unavailable',
      formats: [
        { format: 'EPUB', url: `${CRS}/R/EPUB/R2.epub` },
        { format: 'PDF', url: `${CRS}/R/PDF/R2/R2.pdf` },
      ],
    });
    expect(error.message).toContain(`${CRS}/R/EPUB/R2.epub`);
    expect(error.message).toContain(`${CRS}/R/PDF/R2/R2.pdf`);
  });

  it.each([
    ['no formats key', undefined],
    ['an empty list', []],
    ['entries without a URL', [{ format: 'HTML' }, { format: 'PDF', url: ' ' }, null]],
    ['a non-list', { format: 'HTML', url: `${CRS}/R/HTML/R3.html` }],
  ])('fails document_unavailable for %s', (_label, formats) => {
    const error = thrownBy(() => selectCrsDocumentUrl(formats, 'R3'));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toEqual({
      reason: 'document_unavailable',
      reportNumber: 'R3',
      retryable: false,
    });
    expect(error.message).toContain('R3');
  });
});

describe('formatUrlPart', () => {
  const BASE = 'https://www.congress.gov/117/crpt/hrpt70/generated';

  it('reads an unsuffixed file name as Part 1', () => {
    expect(formatUrlPart(`${BASE}/CRPT-117hrpt70.htm`)).toBe(1);
    expect(formatUrlPart(`${BASE}/CRPT-117hrpt70.pdf`)).toBe(1);
  });

  it('reads the N of a -pt{N} marker, Part 1 included', () => {
    expect(formatUrlPart(`${BASE}/CRPT-117hrpt70-pt2.htm`)).toBe(2);
    expect(formatUrlPart(`${BASE}/CRPT-117hrpt70-pt2.pdf`)).toBe(2);
    expect(formatUrlPart(`${BASE}/CRPT-110hrpt28-pt1.htm`)).toBe(1);
    expect(formatUrlPart(`${BASE}/CRPT-110hrpt28-pt4.htm`)).toBe(4);
    expect(formatUrlPart(`${BASE}/CRPT-118hrpt9-pt12.htm`)).toBe(12);
  });

  it('reads the part an errata file carries', () => {
    expect(formatUrlPart(`${BASE}/CRPT-117hrpt130err-pt1-ERRATA.htm`)).toBe(1);
    expect(formatUrlPart(`${BASE}/CRPT-117hrpt130err-pt3-ERRATA.pdf`)).toBe(3);
  });

  it('reads the marker from the file name alone', () => {
    expect(formatUrlPart('https://www.congress.gov/x-pt9.y/CRPT-118hrpt5.htm')).toBe(1);
    expect(formatUrlPart(`${BASE}/CRPT-118hrpt5.htm?v=-pt9.`)).toBe(1);
    expect(formatUrlPart(`${BASE}/CRPT-118hrpt5.htm#-pt9.`)).toBe(1);
    expect(formatUrlPart(`${BASE}/CRPT-118hrpt5-pt2.htm?v=1`)).toBe(2);
  });

  it('reads only a delimited marker', () => {
    expect(formatUrlPart(`${BASE}/CRPT-118hrpt5-pt2x.htm`)).toBe(1);
    expect(formatUrlPart(`${BASE}/CRPT-118hrpt5-pt.htm`)).toBe(1);
    expect(formatUrlPart(`${BASE}/CRPT-118hrpt5-pt3`)).toBe(3);
  });
});
