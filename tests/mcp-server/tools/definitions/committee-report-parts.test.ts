/**
 * @fileoverview Multi-part committee reports through the real API and document
 * services, with only the network stubbed: Congress.gov files each part as its
 * own record under one report number, in no fixed order, and lists every part's
 * formats under one `/text` list. Covers part selection on `get`, `text`, and
 * `content`, the `parts` disclosure on both client surfaces, and the failures.
 * Fixtures follow the live 117/hrpt/70, 117/hrpt/130, and 118/hrpt/372 records.
 * @module tests/mcp-server/tools/definitions/committee-report-parts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.congress.gov/v3',
  }),
}));

import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { initCongressApi } from '@/services/congress-api/congress-api-service.js';
import { initCongressDocuments } from '@/services/congress-documents/congress-documents-service.js';
import { contentText, jsonResponse } from '../../../helpers/budget-fixtures.js';

const CRPT = 'https://www.congress.gov/117/crpt';
const CRPT_118 = 'https://www.congress.gov/118/crpt';

/** A Formatted Text and a PDF entry for one file, as `/text` lists them: one format per entry. */
function textEntries(base: string, isErrata = 'N') {
  return [
    { formats: [{ isErrata, type: 'Formatted Text', url: `${base}.htm` }] },
    { formats: [{ isErrata, type: 'PDF', url: `${base}.pdf` }] },
  ];
}

/** One report: its records and `/text` entries as upstream orders them, and its document bodies. */
interface ReportFixture {
  documents: Record<string, string>;
  records: Record<string, unknown>[];
  text: unknown[];
}

/** 117/hrpt/70 — upstream lists Part 2 first. */
const HRPT_70: ReportFixture = {
  records: [
    { citation: 'H. Rept. 117-70,Part 2', part: 2, title: 'Second part' },
    { citation: 'H. Rept. 117-70', part: 1, title: 'First part' },
  ],
  text: [
    ...textEntries(`${CRPT}/hrpt70/generated/CRPT-117hrpt70-pt2`),
    ...textEntries(`${CRPT}/hrpt70/generated/CRPT-117hrpt70`),
  ],
  documents: {
    [`${CRPT}/hrpt70/generated/CRPT-117hrpt70.htm`]: 'PART ONE BODY',
    [`${CRPT}/hrpt70/generated/CRPT-117hrpt70-pt2.htm`]: 'PART TWO BODY',
  },
};

/** 117/hrpt/130 — six records for three Books; each errata files under the part it corrects. */
const HRPT_130: ReportFixture = {
  records: [
    { citation: 'H. Rept. 117-130,Book 1', part: 1 },
    { citation: 'H. Rept. 117-130', part: 1 },
    { citation: 'H. Rept. 117-130,Book 2', part: 2 },
    { citation: 'H. Rept. 117-130,Errata', part: 3 },
    { citation: 'H. Rept. 117-130,Book 3', part: 3 },
    { citation: 'H. Rept. 117-130,Errata', part: 2 },
  ],
  text: [
    ...textEntries(`${CRPT}/hrpt130/generated/CRPT-117hrpt130-pt1`),
    ...textEntries(`${CRPT}/hrpt130/generated/CRPT-117hrpt130err-pt1-ERRATA`, 'Y'),
    ...textEntries(`${CRPT}/hrpt130/generated/CRPT-117hrpt130-pt2`),
    ...textEntries(`${CRPT}/hrpt130/generated/CRPT-117hrpt130err-pt3-ERRATA`, 'Y'),
    ...textEntries(`${CRPT}/hrpt130/generated/CRPT-117hrpt130-pt3`),
    ...textEntries(`${CRPT}/hrpt130/generated/CRPT-117hrpt130err-pt2-ERRATA`, 'Y'),
  ],
  documents: {
    [`${CRPT}/hrpt130/generated/CRPT-117hrpt130-pt3.htm`]: 'BOOK THREE BODY',
    [`${CRPT}/hrpt130/generated/CRPT-117hrpt130err-pt3-ERRATA.htm`]: 'BOOK THREE ERRATA',
  },
};

/** 118/hrpt/372 — records ordered 3, 1, 2, 4, and Part 4's PDF listed before its text. */
const HRPT_372: ReportFixture = {
  records: [3, 1, 2, 4].map((part) => ({ citation: `H. Rept. 118-372,Book ${part}`, part })),
  text: [3, 1, 2, 4].flatMap((part) => {
    const entries = textEntries(`${CRPT_118}/hrpt372/generated/CRPT-118hrpt372-pt${part}`);
    return part === 4 ? entries.reverse() : entries;
  }),
  documents: Object.fromEntries(
    [1, 2, 3, 4].map((part) => [
      `${CRPT_118}/hrpt372/generated/CRPT-118hrpt372-pt${part}.htm`,
      `BOOK ${part} BODY`,
    ]),
  ),
};

/** 118/hrpt/1 — a single-part report, its one record carrying no `part` field. */
const HRPT_1: ReportFixture = {
  records: [{ citation: 'H. Rept. 118-1', title: 'Only part' }],
  text: textEntries(`${CRPT_118}/hrpt1/generated/CRPT-118hrpt1`),
  documents: { [`${CRPT_118}/hrpt1/generated/CRPT-118hrpt1.htm`]: 'SINGLE PART BODY' },
};

const fixtures = new Map<string, ReportFixture>([
  ['117/hrpt/70', HRPT_70],
  ['117/hrpt/130', HRPT_130],
  ['118/hrpt/372', HRPT_372],
  ['118/hrpt/1', HRPT_1],
]);
const fetchMock = vi.fn<typeof fetch>();

/** Route a request the way Congress.gov would answer it from `fixtures`. */
async function route(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  const document = [...fixtures.values()]
    .map((report) => report.documents[`${url.origin}${url.pathname}`])
    .find((body) => body !== undefined);
  if (document !== undefined) {
    return new Response(`<html><body><pre>${document}</pre></body></html>`, {
      headers: { 'content-type': 'text/html' },
    });
  }
  const match = /^\/v3\/committee-report\/(\d+\/\w+\/\d+)(\/text)?$/.exec(url.pathname);
  const report = match ? fixtures.get(match[1] as string) : undefined;
  if (!report) return new Response('{"error":"not found"}', { status: 404 });
  return match?.[2]
    ? jsonResponse({ text: report.text, pagination: { count: report.text.length } })
    : jsonResponse({ committeeReports: report.records });
}

/** The www.congress.gov documents the call fetched. */
function documentsFetched(): string[] {
  return fetchMock.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.startsWith('https://www.congress.gov/'));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(route);
  vi.stubGlobal('fetch', fetchMock);
  initCongressApi();
  initCongressDocuments();
});

afterEach(() => vi.unstubAllGlobals());

const report70 = { congress: 117, reportType: 'hrpt', reportNumber: 70 } as const;
const report130 = { congress: 117, reportType: 'hrpt', reportNumber: 130 } as const;
const report372 = { congress: 118, reportType: 'hrpt', reportNumber: 372 } as const;
const report1 = { congress: 118, reportType: 'hrpt', reportNumber: 1 } as const;

describe('a multi-part committee report', () => {
  it("'get' returns Part 1 when part is omitted, whatever order upstream lists the parts in", async () => {
    const result = await runToolContract(committeeReportsTool, { operation: 'get', ...report70 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      report: { citation: 'H. Rept. 117-70', part: 1 },
      parts: [1, 2],
      effectiveQuery: 'HRPT 70, Part 1 (117th Congress)',
    });
    const text = contentText(result);
    expect(text).toContain('H. Rept. 117-70');
    expect(text).not.toContain('Part 2');
    expect(text).toContain('**Parts:** 1, 2');
  });

  it("'content' reads Part 1's document when part is omitted", async () => {
    const result = await runToolContract(committeeReportsTool, {
      operation: 'content',
      ...report70,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      content: {
        sourceUrl: `${CRPT}/hrpt70/generated/CRPT-117hrpt70.htm`,
        text: 'PART ONE BODY',
        documentTitle: 'Committee Report HRPT 117-70, Part 1',
      },
      parts: [1, 2],
      effectiveQuery: 'HRPT 117-70, Part 1, text characters 0–13',
    });
    const text = contentText(result);
    expect(text).toContain('# Committee Report HRPT 117-70, Part 1');
    expect(text).toContain('PART ONE BODY');
    expect(text).toContain('**Parts:** 1, 2');
    expect(documentsFetched()).toEqual([`${CRPT}/hrpt70/generated/CRPT-117hrpt70.htm`]);
  });

  it("'text' lists only Part 1's formats when part is omitted", async () => {
    const result = await runToolContract(committeeReportsTool, { operation: 'text', ...report70 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      text: textEntries(`${CRPT}/hrpt70/generated/CRPT-117hrpt70`),
      parts: [1, 2],
      totalCount: 2,
    });
    const text = contentText(result);
    expect(text).toContain('CRPT-117hrpt70.htm');
    expect(text).not.toContain('-pt2');
    expect(text).toContain('**Parts:** 1, 2');
  });

  it("serves part 2 on 'get', 'text', and 'content', each carrying parts on both surfaces", async () => {
    const get = await runToolContract(committeeReportsTool, {
      operation: 'get',
      ...report70,
      part: 2,
    });
    expect(get.structuredContent).toMatchObject({
      report: { citation: 'H. Rept. 117-70,Part 2' },
      parts: [1, 2],
    });
    expect(contentText(get)).toContain('H. Rept. 117-70,Part 2');

    const text = await runToolContract(committeeReportsTool, {
      operation: 'text',
      ...report70,
      part: 2,
    });
    expect(text.structuredContent).toMatchObject({
      text: textEntries(`${CRPT}/hrpt70/generated/CRPT-117hrpt70-pt2`),
      parts: [1, 2],
    });

    const content = await runToolContract(committeeReportsTool, {
      operation: 'content',
      ...report70,
      part: 2,
    });
    expect(content.structuredContent).toMatchObject({
      content: {
        sourceUrl: `${CRPT}/hrpt70/generated/CRPT-117hrpt70-pt2.htm`,
        text: 'PART TWO BODY',
        documentTitle: 'Committee Report HRPT 117-70, Part 2',
      },
      parts: [1, 2],
    });
    for (const result of [get, text, content]) {
      expect(contentText(result)).toContain('**Parts:** 1, 2');
    }
  });

  it('walks one part via nextOffset, every character once, from one fetch', async () => {
    const chunks: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      if (chunks.length > 10) throw new Error('walk did not terminate');
      const result = await runToolContract(committeeReportsTool, {
        operation: 'content',
        ...report70,
        part: 2,
        characterOffset: offset,
        characterLimit: 5,
      });
      const content = (result.structuredContent as { content: Record<string, unknown> }).content;
      chunks.push(content.text as string);
      offset = content.nextOffset as number | null;
    }
    expect(chunks).toEqual(['PART ', 'TWO B', 'ODY']);
    expect(documentsFetched()).toEqual([`${CRPT}/hrpt70/generated/CRPT-117hrpt70-pt2.htm`]);
  });

  it("fails an offset past the end of the selected part's text", async () => {
    const result = await runToolContract(committeeReportsTool, {
      operation: 'content',
      ...report70,
      part: 2,
      characterOffset: 'PART TWO BODY'.length,
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'offset_past_end' } },
    });
  });

  it.each(['get', 'text', 'content'] as const)(
    "fails '%s' for a part the report is not filed in, naming the parts it is",
    async (operation) => {
      const result = await runToolContract(committeeReportsTool, {
        operation,
        ...report70,
        part: 5,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'Committee report HRPT 117-70 has no part 5. Its parts are 1, 2.',
          data: {
            reason: 'not_found',
            part: 5,
            parts: [1, 2],
            recovery: { hint: 'Retry with part set to one of 1, 2, or omit part to read Part 1.' },
          },
        },
      });
      expect(contentText(result)).toContain('Its parts are 1, 2.');
      expect(documentsFetched()).toEqual([]);
    },
  );
});

describe('a report filed in Books with errata', () => {
  it("'get' part 3 returns the Book, not the errata upstream lists before it", async () => {
    const result = await runToolContract(committeeReportsTool, {
      operation: 'get',
      ...report130,
      part: 3,
    });
    expect(result.structuredContent).toMatchObject({
      report: { citation: 'H. Rept. 117-130,Book 3' },
      parts: [1, 2, 3],
    });
  });

  it("'content' part 3 reads the Book's own text, not its errata", async () => {
    const result = await runToolContract(committeeReportsTool, {
      operation: 'content',
      ...report130,
      part: 3,
    });
    expect(result.structuredContent).toMatchObject({
      content: {
        sourceUrl: `${CRPT}/hrpt130/generated/CRPT-117hrpt130-pt3.htm`,
        text: 'BOOK THREE BODY',
      },
      parts: [1, 2, 3],
    });
  });

  it("'text' part 3 keeps the part's errata beside its own formats", async () => {
    const result = await runToolContract(committeeReportsTool, {
      operation: 'text',
      ...report130,
      part: 3,
    });
    expect(result.structuredContent).toMatchObject({
      text: [
        ...textEntries(`${CRPT}/hrpt130/generated/CRPT-117hrpt130err-pt3-ERRATA`, 'Y'),
        ...textEntries(`${CRPT}/hrpt130/generated/CRPT-117hrpt130-pt3`),
      ],
      parts: [1, 2, 3],
    });
  });

  it("'get' falls back to the errata when it is the only record filed for the part", async () => {
    fixtures.set('117/hrpt/131', {
      records: [
        { citation: 'H. Rept. 117-131', part: 1 },
        { citation: 'H. Rept. 117-131,Errata', part: 2 },
      ],
      text: [],
      documents: {},
    });
    const result = await runToolContract(committeeReportsTool, {
      operation: 'get',
      congress: 117,
      reportType: 'hrpt',
      reportNumber: 131,
      part: 2,
    });
    expect(result.structuredContent).toMatchObject({
      report: { citation: 'H. Rept. 117-131,Errata' },
      parts: [1, 2],
    });
    fixtures.delete('117/hrpt/131');
  });
});

describe('a four-part report listed out of order', () => {
  it("'content' reads Part 1 by default", async () => {
    const result = await runToolContract(committeeReportsTool, {
      operation: 'content',
      ...report372,
    });
    expect(result.structuredContent).toMatchObject({
      content: { sourceUrl: `${CRPT_118}/hrpt372/generated/CRPT-118hrpt372-pt1.htm` },
      parts: [1, 2, 3, 4],
    });
  });

  it.each([1, 2, 3, 4])("'get' and 'content' with part %i describe the same part", async (part) => {
    const get = await runToolContract(committeeReportsTool, {
      operation: 'get',
      ...report372,
      part,
    });
    const content = await runToolContract(committeeReportsTool, {
      operation: 'content',
      ...report372,
      part,
    });
    expect(get.structuredContent).toMatchObject({
      report: { citation: `H. Rept. 118-372,Book ${part}`, part },
      parts: [1, 2, 3, 4],
    });
    expect(content.structuredContent).toMatchObject({
      content: {
        sourceUrl: `${CRPT_118}/hrpt372/generated/CRPT-118hrpt372-pt${part}.htm`,
        text: `BOOK ${part} BODY`,
      },
      parts: [1, 2, 3, 4],
    });
  });
});

describe('a single-part report', () => {
  it.each(['get', 'text', 'content'] as const)(
    "'%s' answers the same with part omitted or 1, and carries no parts",
    async (operation) => {
      const omitted = await runToolContract(committeeReportsTool, { operation, ...report1 });
      const explicit = await runToolContract(committeeReportsTool, {
        operation,
        ...report1,
        part: 1,
      });
      expect(omitted.isError).not.toBe(true);
      expect(explicit.structuredContent).toEqual(omitted.structuredContent);
      expect(explicit.content).toEqual(omitted.content);
      expect(omitted.structuredContent).not.toHaveProperty('parts');
      expect(contentText(omitted)).not.toContain('**Parts:**');
    },
  );

  it('serves its record, its whole format list, and its document unchanged', async () => {
    const get = await runToolContract(committeeReportsTool, { operation: 'get', ...report1 });
    expect(get.structuredContent).toMatchObject({
      report: HRPT_1.records[0],
      effectiveQuery: 'HRPT 1 (118th Congress)',
    });
    const text = await runToolContract(committeeReportsTool, { operation: 'text', ...report1 });
    expect((text.structuredContent as { text: unknown }).text).toEqual(HRPT_1.text);
    const content = await runToolContract(committeeReportsTool, {
      operation: 'content',
      ...report1,
    });
    expect(content.structuredContent).toMatchObject({
      content: {
        documentTitle: 'Committee Report HRPT 118-1',
        sourceUrl: `${CRPT_118}/hrpt1/generated/CRPT-118hrpt1.htm`,
        text: 'SINGLE PART BODY',
      },
      effectiveQuery: 'HRPT 118-1, text characters 0–16',
    });
  });

  it.each(['get', 'text', 'content'] as const)(
    "fails '%s' with part 2, naming [1]",
    async (operation) => {
      const result = await runToolContract(committeeReportsTool, {
        operation,
        ...report1,
        part: 2,
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'Committee report HRPT 118-1 has no part 2. Its parts are 1.',
          data: { reason: 'not_found', part: 2, parts: [1] },
        },
      });
      expect(contentText(result)).toContain('Its parts are 1.');
    },
  );
});

describe('a report whose /text lists no formats', () => {
  beforeEach(() => {
    fixtures.set('118/hrpt/2', {
      records: [{ citation: 'H. Rept. 118-2', part: 1 }],
      text: [],
      documents: {},
    });
  });
  afterEach(() => fixtures.delete('118/hrpt/2'));

  const report2 = { congress: 118, reportType: 'hrpt', reportNumber: 2 } as const;

  it("returns an empty 'text' list with no parts", async () => {
    const result = await runToolContract(committeeReportsTool, { operation: 'text', ...report2 });
    expect(result.structuredContent).toMatchObject({ text: [], totalCount: 0 });
    expect(result.structuredContent).not.toHaveProperty('parts');
  });

  it("fails 'content' as document_unavailable before any document fetch", async () => {
    const result = await runToolContract(committeeReportsTool, {
      operation: 'content',
      ...report2,
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'document_unavailable' } },
    });
    expect(documentsFetched()).toEqual([]);
  });
});
