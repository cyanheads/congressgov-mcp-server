/**
 * @fileoverview Cross-tool input validation tests: injection attempts, oversized inputs,
 * missing required params, and Zod schema edge cases.
 * @module tests/mcp-server/tools/definitions/input-validation.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { amendmentLookupTool } from '@/mcp-server/tools/definitions/amendment-lookup.tool.js';
import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { billSummariesTool } from '@/mcp-server/tools/definitions/bill-summaries.tool.js';
import { committeeLookupTool } from '@/mcp-server/tools/definitions/committee-lookup.tool.js';
import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { crsReportsTool } from '@/mcp-server/tools/definitions/crs-reports.tool.js';
import { dailyRecordTool } from '@/mcp-server/tools/definitions/daily-record.tool.js';
import { enactedLawsTool } from '@/mcp-server/tools/definitions/enacted-laws.tool.js';
import { memberLookupTool } from '@/mcp-server/tools/definitions/member-lookup.tool.js';
import { rollVotesTool } from '@/mcp-server/tools/definitions/roll-votes.tool.js';
import { searchBillsTool } from '@/mcp-server/tools/definitions/search-bills.tool.js';
import { senateNominationsTool } from '@/mcp-server/tools/definitions/senate-nominations.tool.js';
import { anyLetterCase } from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

const mockApi = {
  listBills: vi.fn(),
  getBill: vi.fn(),
  getBillSubResource: vi.fn(),
  listLaws: vi.fn(),
  getLaw: vi.fn(),
  listMembers: vi.fn(),
  getMember: vi.fn(),
  getMemberLegislation: vi.fn(),
  listCommittees: vi.fn(),
  getCommittee: vi.fn(),
  getCommitteeSubResource: vi.fn(),
  listVotes: vi.fn(),
  getVote: vi.fn(),
  getVoteMembers: vi.fn(),
  listNominations: vi.fn(),
  getNomination: vi.fn(),
  getNominee: vi.fn(),
  getNominationSubResource: vi.fn(),
  listSummaries: vi.fn(),
  listCrsReports: vi.fn(),
  getCrsReport: vi.fn(),
  listCommitteeReports: vi.fn(),
  getCommitteeReport: vi.fn(),
  getCommitteeReportText: vi.fn(),
  listDailyRecord: vi.fn(),
  getDailyIssues: vi.fn(),
  getDailyArticles: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
});

// ── Zod schema-level validation (parse-time rejections) ───────────────────────

describe('billLookupTool — Zod schema validation', () => {
  it('rejects congress number of 0 (must be positive)', () => {
    expect(() => billLookupTool.input.parse({ operation: 'list', congress: 0 })).toThrow();
  });

  it('rejects negative congress number', () => {
    expect(() => billLookupTool.input.parse({ operation: 'list', congress: -1 })).toThrow();
  });

  it('rejects invalid operation value', () => {
    expect(() => billLookupTool.input.parse({ operation: 'delete', congress: 118 })).toThrow();
  });

  it('rejects invalid billType', () => {
    expect(() =>
      billLookupTool.input.parse({ operation: 'list', congress: 118, billType: 'invalid' }),
    ).toThrow();
  });

  it('rejects limit above 250', () => {
    expect(() =>
      billLookupTool.input.parse({ operation: 'list', congress: 118, limit: 251 }),
    ).toThrow();
  });

  it('rejects limit of 0', () => {
    expect(() =>
      billLookupTool.input.parse({ operation: 'list', congress: 118, limit: 0 }),
    ).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() =>
      billLookupTool.input.parse({ operation: 'list', congress: 118, offset: -1 }),
    ).toThrow();
  });

  // ── #70: the summaries version selector and the shared character window ──

  it('accepts a versionCode string on summaries', () => {
    expect(
      billLookupTool.input.parse({
        operation: 'summaries',
        congress: 118,
        billType: 'hr',
        billNumber: 2882,
        versionCode: '49',
      }).versionCode,
    ).toBe('49');
  });

  it('leaves versionCode undefined when it is omitted', () => {
    expect(
      billLookupTool.input.parse({ operation: 'summaries', congress: 118 }).versionCode,
    ).toBeUndefined();
  });

  it('rejects a non-string versionCode', () => {
    expect(() =>
      billLookupTool.input.parse({ operation: 'summaries', congress: 118, versionCode: 49 }),
    ).toThrow();
  });

  it('keeps the character-window bounds after the summaries-aware descriptions', () => {
    const base = { operation: 'summaries', congress: 118 };
    expect(() => billLookupTool.input.parse({ ...base, characterOffset: -1 })).toThrow();
    expect(() => billLookupTool.input.parse({ ...base, characterLimit: 0 })).toThrow();
    expect(() => billLookupTool.input.parse({ ...base, characterLimit: 100_001 })).toThrow();
    expect(billLookupTool.input.parse({ ...base, characterLimit: 100_000 }).characterLimit).toBe(
      100_000,
    );
  });
});

describe('memberLookupTool — Zod schema validation', () => {
  it('rejects invalid operation value', () => {
    expect(() => memberLookupTool.input.parse({ operation: 'delete' })).toThrow();
  });

  it('rejects stateCode longer than 2 characters', () => {
    expect(() => memberLookupTool.input.parse({ operation: 'list', stateCode: 'CAL' })).toThrow();
  });

  it('rejects stateCode shorter than 2 characters', () => {
    expect(() => memberLookupTool.input.parse({ operation: 'list', stateCode: 'C' })).toThrow();
  });

  it.each(['pelosi', 'P00197', 'P0001970', '1000197', 'Ñ000197'])(
    'rejects malformed bioguideId %o',
    (bioguideId) => {
      expect(() => memberLookupTool.input.parse({ operation: 'get', bioguideId })).toThrow();
    },
  );

  it('accepts a valid bioguideId', () => {
    expect(
      memberLookupTool.input.parse({ operation: 'get', bioguideId: 'P000197' }).bioguideId,
    ).toBe('P000197');
  });

  it.each(['12', 'C-', 'ÇA', 'California'])(
    'rejects non-ASCII-alphabetic stateCode %o',
    (stateCode) => {
      expect(() => memberLookupTool.input.parse({ operation: 'list', stateCode })).toThrow();
    },
  );

  it('advertises the verified bioguideId and stateCode patterns', () => {
    const json = z.toJSONSchema(memberLookupTool.input, { io: 'input' }) as {
      properties?: Record<string, { pattern?: string }>;
    };
    expect(json.properties?.bioguideId?.pattern).toBe('^[A-Za-z]\\d{6}$');
    expect(json.properties?.stateCode?.pattern).toBe('^[A-Za-z]{2}$');
  });

  it('rejects negative district', () => {
    // district min is 0 (at-large), negative is invalid
    expect(() =>
      memberLookupTool.input.parse({ operation: 'list', stateCode: 'CA', district: -1 }),
    ).toThrow();
  });
});

describe('committeeLookupTool — Zod schema validation', () => {
  it('rejects invalid chamber value', () => {
    expect(() =>
      committeeLookupTool.input.parse({
        operation: 'get',
        chamber: 'federal',
        committeeCode: 'xyz00',
      }),
    ).toThrow();
  });
});

describe('rollVotesTool — Zod schema validation', () => {
  it('rejects session number less than 1', () => {
    expect(() =>
      rollVotesTool.input.parse({ operation: 'list', congress: 118, session: 0 }),
    ).toThrow();
  });
});

// ── Handler-level validation (runtime throws) ────────────────────────────────

describe('billLookupTool — handler validation', () => {
  it('rejects malformed fromDateTime and surfaces actionable error', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      fromDateTime: '2024-01-01',
    });
    await expect(billLookupTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
  });

  it('rejects malformed toDateTime', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      toDateTime: 'January 1 2024',
    });
    await expect(billLookupTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
  });

  it('rejects injection-like dateTime strings', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      fromDateTime: "2024-01-01'; SELECT * FROM bills; --",
    });
    await expect(billLookupTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
  });

  // ── #48: reversed date ranges ─────────────────────────────────────────────

  it('rejects a reversed date range before the upstream call', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 119,
      billType: 'hr',
      fromDateTime: '2026-08-11T00:00:00Z',
      toDateTime: '2026-08-01T00:00:00Z',
    });
    await expect(billLookupTool.handler(input, ctx)).rejects.toThrow(/earlier than or equal to/);
    expect(mockApi.listBills).not.toHaveBeenCalled();
  });

  it('accepts a zero-width date range (from === to)', async () => {
    mockApi.listBills.mockResolvedValue({ data: [], pagination: { count: 0, nextOffset: null } });
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 119,
      fromDateTime: '2026-08-01T00:00:00Z',
      toDateTime: '2026-08-01T00:00:00Z',
    });
    await expect(billLookupTool.handler(input, ctx)).resolves.toBeDefined();
  });

  it('accepts either bound on its own', async () => {
    mockApi.listBills.mockResolvedValue({ data: [], pagination: { count: 0, nextOffset: null } });
    const ctx = createMockContext({ errors: billLookupTool.errors });
    await expect(
      billLookupTool.handler(
        billLookupTool.input.parse({
          operation: 'list',
          congress: 119,
          fromDateTime: '2026-08-11T00:00:00Z',
        }),
        ctx,
      ),
    ).resolves.toBeDefined();
    await expect(
      billLookupTool.handler(
        billLookupTool.input.parse({
          operation: 'list',
          congress: 119,
          toDateTime: '2026-08-01T00:00:00Z',
        }),
        ctx,
      ),
    ).resolves.toBeDefined();
  });

  it('treats blank form-client bounds as absent rather than reversed', async () => {
    mockApi.listBills.mockResolvedValue({ data: [], pagination: { count: 0, nextOffset: null } });
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 119,
      fromDateTime: '',
      toDateTime: '   ',
    });
    await expect(billLookupTool.handler(input, ctx)).resolves.toBeDefined();
    expect(mockApi.listBills).toHaveBeenCalledWith(
      expect.objectContaining({ fromDateTime: undefined, toDateTime: undefined }),
      ctx,
    );
  });
});

describe('billSummariesTool — handler validation', () => {
  it('rejects malformed fromDateTime', async () => {
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    const input = billSummariesTool.input.parse({ fromDateTime: '2024/01/01' });
    await expect(billSummariesTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
  });

  it('rejects malformed toDateTime', async () => {
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    const input = billSummariesTool.input.parse({ toDateTime: 'not-a-date' });
    await expect(billSummariesTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
  });

  // ── #48: reversed date ranges ─────────────────────────────────────────────

  it('rejects a reversed date range before the upstream call', async () => {
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    const input = billSummariesTool.input.parse({
      fromDateTime: '2026-08-11T00:00:00Z',
      toDateTime: '2026-08-01T00:00:00Z',
    });
    await expect(billSummariesTool.handler(input, ctx)).rejects.toThrow(/earlier than or equal to/);
    expect(mockApi.listSummaries).not.toHaveBeenCalled();
  });

  it('accepts a zero-width date range (from === to)', async () => {
    mockApi.listSummaries.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    const input = billSummariesTool.input.parse({
      fromDateTime: '2026-08-01T00:00:00Z',
      toDateTime: '2026-08-01T00:00:00Z',
    });
    await expect(billSummariesTool.handler(input, ctx)).resolves.toBeDefined();
  });

  it('leaves toDateTime open when only fromDateTime is supplied', async () => {
    mockApi.listSummaries.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    const input = billSummariesTool.input.parse({ fromDateTime: '2026-08-11T00:00:00Z' });
    await billSummariesTool.handler(input, ctx);
    expect(mockApi.listSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ fromDateTime: '2026-08-11T00:00:00Z', toDateTime: undefined }),
      ctx,
    );
  });

  it('does not synthesize a default fromDateTime when only toDateTime is supplied', async () => {
    mockApi.listSummaries.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    const input = billSummariesTool.input.parse({ toDateTime: '2020-01-01T00:00:00Z' });
    await billSummariesTool.handler(input, ctx);
    // A synthesized "7 days ago" default would sit after this toDateTime and read
    // as a reversed range — the default must stay suppressed here.
    expect(mockApi.listSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ fromDateTime: undefined, toDateTime: '2020-01-01T00:00:00Z' }),
      ctx,
    );
  });

  it('synthesizes a default fromDateTime with no toDateTime when neither bound is supplied', async () => {
    mockApi.listSummaries.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    await billSummariesTool.handler(billSummariesTool.input.parse({}), ctx);
    expect(mockApi.listSummaries).toHaveBeenCalledWith(
      expect.objectContaining({
        fromDateTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        toDateTime: undefined,
      }),
      ctx,
    );
  });
});

describe('committeeLookupTool — handler validation', () => {
  it('throws when sub-resource is missing committeeCode', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    const input = committeeLookupTool.input.parse({ operation: 'bills' });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });

  it('throws when committeeCode has unknown chamber prefix and chamber is not explicit', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    // A code-shaped value whose prefix names no chamber keeps its validation error,
    // before any request: no roster code of that shape lacks an h/s/j prefix (#114).
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      committeeCode: 'zzjd00',
    });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(
      /Could not infer chamber from committeeCode 'zzjd00'/,
    );
    expect(mockApi.listCommittees).not.toHaveBeenCalled();
    expect(mockApi.getCommitteeSubResource).not.toHaveBeenCalled();
  });

  it.each([
    ['list', {}],
    ['bills', { committeeCode: 'ssju00' }],
    ['nominations', { committeeCode: 'ssju00' }],
  ] as const)(
    'rejects a malformed fromDateTime on %s before any request',
    async (operation, rest) => {
      const ctx = createMockContext({ errors: committeeLookupTool.errors });
      const input = committeeLookupTool.input.parse({
        operation,
        ...rest,
        fromDateTime: '2025-03-01',
      });
      await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
      expect(mockApi.listCommittees).not.toHaveBeenCalled();
      expect(mockApi.getCommitteeSubResource).not.toHaveBeenCalled();
    },
  );

  it('rejects a reversed date range on reports before any request', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    const input = committeeLookupTool.input.parse({
      operation: 'reports',
      committeeCode: 'hsju00',
      fromDateTime: '2025-12-31T00:00:00Z',
      toDateTime: '2025-01-01T00:00:00Z',
    });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(
      /earlier than or equal to/,
    );
    expect(mockApi.getCommitteeSubResource).not.toHaveBeenCalled();
  });
});

describe('committeeReportsTool — handler validation', () => {
  it('rejects at parse-time when congress is missing (required field)', () => {
    // congress is required in the schema — parse throws before the handler runs
    expect(() => committeeReportsTool.input.parse({ operation: 'list' })).toThrow();
  });

  const report = { operation: 'get', congress: 117, reportType: 'hrpt', reportNumber: 70 };

  it.each([0, -1, 1.5, '2'])('rejects part %j at parse time', (part) => {
    expect(committeeReportsTool.input.safeParse({ ...report, part }).success).toBe(false);
  });

  it('accepts a positive integer part and leaves an omitted one unset', () => {
    expect(committeeReportsTool.input.parse({ ...report, part: 3 }).part).toBe(3);
    expect(committeeReportsTool.input.parse(report).part).toBeUndefined();
  });
});

describe('crsReportsTool — content window validation', () => {
  it.each([
    { characterOffset: -1 },
    { characterLimit: 0 },
    { characterLimit: 100_001 },
    { characterOffset: 1.5 },
  ])('rejects %j at parse time', (window) => {
    expect(
      crsReportsTool.input.safeParse({ operation: 'content', reportNumber: 'R46406', ...window })
        .success,
    ).toBe(false);
  });

  it('defaults the window to the first 25,000 characters and takes no format', () => {
    expect(
      crsReportsTool.input.parse({ operation: 'content', reportNumber: 'R46406' }),
    ).toMatchObject({ characterOffset: 0, characterLimit: 25_000 });
    expect(
      crsReportsTool.input.safeParse({
        operation: 'content',
        reportNumber: 'R46406',
        format: 'text',
      }).success,
    ).toBe(false);
  });
});

describe('crsReportsTool — handler validation', () => {
  it('defaults to 20-item limit for list', async () => {
    mockApi.listCrsReports.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const ctx = createMockContext({ errors: crsReportsTool.errors });
    const input = crsReportsTool.input.parse({ operation: 'list' });
    await crsReportsTool.handler(input, ctx);
    expect(mockApi.listCrsReports).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
      ctx,
    );
  });
});

describe('dailyRecordTool — handler validation', () => {
  it('throws when articles is missing volumeNumber', async () => {
    const ctx = createMockContext({ errors: dailyRecordTool.errors });
    const input = dailyRecordTool.input.parse({ operation: 'articles', issueNumber: 5 });
    await expect(dailyRecordTool.handler(input, ctx)).rejects.toThrow(/volumeNumber/);
  });
});

describe('enactedLawsTool — handler validation', () => {
  it('throws when get is missing lawNumber', async () => {
    const ctx = createMockContext({ errors: enactedLawsTool.errors });
    const input = enactedLawsTool.input.parse({
      operation: 'get',
      congress: 118,
      lawType: 'pub',
    });
    await expect(enactedLawsTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });
});

// ── Max/min value boundary tests ──────────────────────────────────────────────

describe('pagination boundary values', () => {
  it('billLookupTool accepts limit=1 (minimum)', () => {
    expect(() =>
      billLookupTool.input.parse({ operation: 'list', congress: 118, limit: 1 }),
    ).not.toThrow();
  });

  it('billLookupTool accepts limit=250 (maximum)', () => {
    expect(() =>
      billLookupTool.input.parse({ operation: 'list', congress: 118, limit: 250 }),
    ).not.toThrow();
  });

  it('memberLookupTool accepts district=0 (at-large)', () => {
    expect(() =>
      memberLookupTool.input.parse({
        operation: 'list',
        stateCode: 'AK',
        district: 0,
      }),
    ).not.toThrow();
  });

  it('rollVotesTool accepts session=1', () => {
    expect(() =>
      rollVotesTool.input.parse({ operation: 'list', congress: 119, session: 1 }),
    ).not.toThrow();
  });

  it('rollVotesTool accepts session=2', () => {
    expect(() =>
      rollVotesTool.input.parse({ operation: 'list', congress: 119, session: 2 }),
    ).not.toThrow();
  });
});

// ── Enrichment coverage for tools that were missing it ───────────────────────

describe('enactedLawsTool — enrichment', () => {
  it('sets effectiveQuery and totalCount on list', async () => {
    mockApi.listLaws.mockResolvedValue({
      data: [{ number: 1 }],
      pagination: { count: 1, nextOffset: null },
    });
    const ctx = createMockContext({ errors: enactedLawsTool.errors });
    const input = enactedLawsTool.input.parse({ operation: 'list', congress: 118 });
    await enactedLawsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeDefined();
    expect(enrichment.totalCount).toBe(1);
  });
});

describe('committeeLookupTool — enrichment', () => {
  it('sets enrichment on list', async () => {
    mockApi.listCommittees.mockResolvedValue({
      data: [{ name: 'Judiciary' }],
      pagination: { count: 1, nextOffset: null },
    });
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    const input = committeeLookupTool.input.parse({ operation: 'list' });
    await committeeLookupTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
  });

  it('sets effectiveQuery on get', async () => {
    mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Judiciary' } });
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    const input = committeeLookupTool.input.parse({
      operation: 'get',
      chamber: 'house',
      committeeCode: 'hsju00',
    });
    await committeeLookupTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('hsju00');
    expect(enrichment.totalCount).toBe(1);
  });
});

describe('senateNominationsTool — enrichment', () => {
  it('sets enrichment on list', async () => {
    mockApi.listNominations.mockResolvedValue({
      data: [{ nominationNumber: '100' }],
      pagination: { count: 1, nextOffset: null },
    });
    const ctx = createMockContext({ errors: senateNominationsTool.errors });
    const input = senateNominationsTool.input.parse({ operation: 'list', congress: 119 });
    await senateNominationsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
  });
});

describe('rollVotesTool — enrichment', () => {
  it('sets enrichment on list', async () => {
    mockApi.listVotes.mockResolvedValue({
      data: [{ rollCallNumber: 1 }],
      pagination: { count: 1, nextOffset: null },
    });
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    const input = rollVotesTool.input.parse({ operation: 'list', congress: 119, session: 1 });
    await rollVotesTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
  });
});

describe('crsReportsTool — enrichment', () => {
  it('sets enrichment on list', async () => {
    mockApi.listCrsReports.mockResolvedValue({
      data: [{ reportNumber: 'R40097' }],
      pagination: { count: 1, nextOffset: null },
    });
    const ctx = createMockContext({ errors: crsReportsTool.errors });
    const input = crsReportsTool.input.parse({ operation: 'list' });
    await crsReportsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
  });

  it('populates notice on empty list', async () => {
    mockApi.listCrsReports.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const ctx = createMockContext({ errors: crsReportsTool.errors });
    const input = crsReportsTool.input.parse({ operation: 'list' });
    await crsReportsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
  });
});

describe('committeeReportsTool — enrichment', () => {
  it('sets enrichment on list', async () => {
    mockApi.listCommitteeReports.mockResolvedValue({
      data: [{ reportNumber: 1 }],
      pagination: { count: 1, nextOffset: null },
    });
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    const input = committeeReportsTool.input.parse({ operation: 'list', congress: 118 });
    await committeeReportsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
  });

  it('sets effectiveQuery on get', async () => {
    mockApi.getCommitteeReport.mockResolvedValue({ reports: [{ title: 'Report' }] });
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    const input = committeeReportsTool.input.parse({
      operation: 'get',
      congress: 118,
      reportType: 'hrpt',
      reportNumber: 100,
    });
    await committeeReportsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBeDefined();
    expect(enrichment.totalCount).toBe(1);
  });
});

// ── Error contract advertisement (#32/#34/#84) ───────────────────────────────

describe('error contracts', () => {
  const REQUIRED_REASONS = [
    'not_found',
    'rate_limited',
    'invalid_request',
    'api_key_rejected',
    'upstream_error',
    'upstream_timeout',
  ];
  const contractTools = {
    amendment_lookup: amendmentLookupTool,
    bill_lookup: billLookupTool,
    bill_summaries: billSummariesTool,
    committee_lookup: committeeLookupTool,
    committee_reports: committeeReportsTool,
    crs_reports: crsReportsTool,
    daily_record: dailyRecordTool,
    enacted_laws: enactedLawsTool,
    member_lookup: memberLookupTool,
    roll_votes: rollVotesTool,
    senate_nominations: senateNominationsTool,
  };

  for (const [name, contractTool] of Object.entries(contractTools)) {
    it(`${name} advertises the shared upstream error contract`, () => {
      const reasons = (contractTool.errors ?? []).map((entry) => entry.reason);
      expect(reasons).toEqual(expect.arrayContaining(REQUIRED_REASONS));
    });
  }

  it.each([
    ['amendment_lookup', amendmentLookupTool],
    ['bill_lookup', billLookupTool],
    ['committee_reports', committeeReportsTool],
    ['crs_reports', crsReportsTool],
    ['daily_record', dailyRecordTool],
  ] as const)(
    '%s advertises the document error contract its content operation raises',
    (_name, contentTool) => {
      const reasons = (contentTool.errors ?? []).map((entry) => entry.reason);
      expect(reasons).toEqual(
        expect.arrayContaining([
          'document_unavailable',
          'format_unavailable',
          'document_fetch_failed',
          'document_too_large',
          'offset_past_end',
        ]),
      );
    },
  );
});

// ── Strict inputs ────────────────────────────────────────────────────────────

/**
 * Every parameter each tool accepts is declared, so no input is deliberately
 * open: an undeclared key is a caller's typo and must be rejected by name
 * rather than stripped, which would answer a different question than the one
 * asked. `tool()` stores `input` with `.strict()` applied and advertises
 * `additionalProperties: false` to match.
 */
describe('strict tool inputs', () => {
  const strictTools = {
    amendment_lookup: [amendmentLookupTool, { operation: 'list', congress: 118 }],
    bill_lookup: [billLookupTool, { operation: 'list', congress: 118 }],
    bill_summaries: [billSummariesTool, { congress: 118 }],
    committee_lookup: [committeeLookupTool, { operation: 'list', chamber: 'house' }],
    committee_reports: [committeeReportsTool, { operation: 'list', congress: 118 }],
    crs_reports: [crsReportsTool, { operation: 'list' }],
    daily_record: [dailyRecordTool, { operation: 'list' }],
    enacted_laws: [enactedLawsTool, { operation: 'list', congress: 118 }],
    member_lookup: [memberLookupTool, { operation: 'list' }],
    roll_votes: [rollVotesTool, { operation: 'list', chamber: 'house', congress: 118, session: 1 }],
    senate_nominations: [senateNominationsTool, { operation: 'list', congress: 118 }],
  } as const satisfies Record<string, readonly [{ input: z.ZodType }, Record<string, unknown>]>;

  for (const [name, [strictTool, valid]] of Object.entries(strictTools)) {
    it(`${name} rejects an undeclared argument key by name`, () => {
      const result = strictTool.input.safeParse({ ...valid, querry: 'semiconductors' });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({
        code: 'unrecognized_keys',
        keys: ['querry'],
      });
    });

    it(`${name} advertises additionalProperties: false`, () => {
      const json = z.toJSONSchema(strictTool.input, { io: 'input' }) as {
        additionalProperties?: boolean;
      };
      expect(json.additionalProperties).toBe(false);
    });
  }
});

// ── Codes in any letter case (#122) ──────────────────────────────────────────

describe('anyLetterCase', () => {
  it.each([
    ['lower', 'HRPT', 'hrpt'],
    ['lower', 'hRpT', 'hrpt'],
    ['upper', 'p000197', 'P000197'],
    ['title', 'hOUSE', 'House'],
    ['title', 'senate', 'Senate'],
  ] as const)('%s case reads %j as %j', (letterCase, sent, expected) => {
    expect(anyLetterCase(z.string(), letterCase).parse(sent)).toBe(expected);
  });

  it('writes lower case when no case is named', () => {
    expect(anyLetterCase(z.string()).parse('HJRES')).toBe('hjres');
  });

  it('rewrites before the inner check, so a pattern stating the canonical form takes any case', () => {
    const bioguide = anyLetterCase(z.string().regex(/^[A-Z]\d{6}$/), 'upper');
    expect(bioguide.safeParse('p000197').success).toBe(true);
    expect(bioguide.safeParse('p00019').success).toBe(false);
  });

  it('hands a non-string to the inner schema untouched', () => {
    expect(anyLetterCase(z.union([z.string(), z.number()])).parse(7)).toBe(7);
    expect(anyLetterCase(z.enum(['hr'])).safeParse(7).success).toBe(false);
  });

  it('advertises the inner schema alone', () => {
    const inner = z.enum(['hrpt', 'srpt', 'erpt']);
    expect(z.toJSONSchema(anyLetterCase(inner), { io: 'input' })).toEqual(
      z.toJSONSchema(inner, { io: 'input' }),
    );
  });
});

const BILL_TYPES = ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres'];

/**
 * Every enum input whose value a Congress.gov row supplies, with spellings rows
 * and sibling tools carry (`HRPT` on report rows, `PUB` on CRS related materials,
 * `HR` on bill and summary rows, `house` as roll votes take it). The last four
 * rows pin the per-tool preprocessors the shared helper replaced.
 */
const LETTER_CASE_INPUTS: ReadonlyArray<{
  tool: { name: string; input: z.ZodType };
  field: string;
  base: Record<string, unknown>;
  sent: readonly string[];
  canonical: string;
  advertised: readonly string[];
}> = [
  {
    tool: committeeReportsTool,
    field: 'reportType',
    base: { operation: 'list', congress: 119 },
    sent: ['HRPT', 'Hrpt'],
    canonical: 'hrpt',
    advertised: ['hrpt', 'srpt', 'erpt'],
  },
  {
    tool: enactedLawsTool,
    field: 'lawType',
    base: { operation: 'list', congress: 119 },
    sent: ['PUB', 'Pub'],
    canonical: 'pub',
    advertised: ['pub', 'priv'],
  },
  {
    tool: billSummariesTool,
    field: 'billType',
    base: { congress: 119 },
    sent: ['HR', 'Hr'],
    canonical: 'hr',
    advertised: BILL_TYPES,
  },
  {
    tool: searchBillsTool,
    field: 'billType',
    base: { query: 'semiconductors' },
    sent: ['HJRES', 'HJRes'],
    canonical: 'hjres',
    advertised: BILL_TYPES,
  },
  {
    tool: searchBillsTool,
    field: 'originChamber',
    base: { query: 'semiconductors' },
    sent: ['house', 'HOUSE', 'hOUSE'],
    canonical: 'House',
    advertised: ['House', 'Senate'],
  },
  {
    tool: billLookupTool,
    field: 'billType',
    base: { operation: 'list', congress: 119 },
    sent: ['HR', 'Hr'],
    canonical: 'hr',
    advertised: BILL_TYPES,
  },
  {
    tool: amendmentLookupTool,
    field: 'amendmentType',
    base: { operation: 'list', congress: 119 },
    sent: ['HAMDT', 'Hamdt'],
    canonical: 'hamdt',
    advertised: ['hamdt', 'samdt', 'suamdt'],
  },
  {
    tool: rollVotesTool,
    field: 'chamber',
    base: { operation: 'list', congress: 119, session: 1 },
    sent: ['SENATE', 'Senate'],
    canonical: 'senate',
    advertised: ['house', 'senate'],
  },
  {
    tool: committeeLookupTool,
    field: 'chamber',
    base: { operation: 'list' },
    sent: ['JOINT', 'Joint'],
    canonical: 'joint',
    advertised: ['house', 'senate', 'joint'],
  },
];

describe.each(LETTER_CASE_INPUTS.map((row) => [`${row.tool.name} ${row.field}`, row] as const))(
  '%s in any letter case (#122)',
  (_label, row) => {
    const parse = (value: unknown) => row.tool.input.safeParse({ ...row.base, [row.field]: value });

    it.each([row.canonical, ...row.sent])('reads %j as the canonical code', (value) => {
      const result = parse(value);
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)[row.field]).toBe(row.canonical);
    });

    it.each(['XYZ', 7])('still rejects %j, naming the field', (value) => {
      const result = parse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([[row.field]]);
    });

    it('advertises the canonical enum unchanged', () => {
      const json = z.toJSONSchema(row.tool.input, { io: 'input' }) as {
        properties: Record<string, unknown>;
      };
      expect(json.properties[row.field]).toMatchObject({ type: 'string', enum: row.advertised });
    });
  },
);

describe('a code in any letter case through the tool contract (#122)', () => {
  const report = { operation: 'get', congress: 119, reportNumber: 106 } as const;

  beforeEach(() => {
    mockApi.getCommitteeReport.mockResolvedValue({
      reports: [{ citation: 'H. Rept. 119-106', title: 'Report to accompany H.R. 1' }],
    });
  });

  it('serves reportType HRPT exactly as hrpt on both surfaces', async () => {
    const upper = await runToolContract(committeeReportsTool, {
      ...report,
      reportType: 'HRPT' as 'hrpt',
    });
    const canonical = await runToolContract(committeeReportsTool, {
      ...report,
      reportType: 'hrpt',
    });

    expect(upper.isError).toBeFalsy();
    expect(mockApi.getCommitteeReport).toHaveBeenNthCalledWith(
      1,
      { congress: 119, reportType: 'hrpt', reportNumber: 106 },
      expect.anything(),
    );
    expect(upper.structuredContent).toEqual(canonical.structuredContent);
    expect(upper.content).toEqual(canonical.content);
    expect(upper.structuredContent).toMatchObject({ effectiveQuery: 'HRPT 106 (119th Congress)' });
  });

  it('fails an unknown reportType as invalid arguments naming the field, before any request', async () => {
    const result = await runToolContract(committeeReportsTool, {
      ...report,
      reportType: 'XYZ' as 'hrpt',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    const text = (result.content as Array<{ text?: string }>).map((block) => block.text).join('\n');
    expect(text).toContain('reportType');
    expect(mockApi.getCommitteeReport).not.toHaveBeenCalled();
  });
});
