/**
 * @fileoverview Cross-tool input validation tests: injection attempts, oversized inputs,
 * missing required params, and Zod schema edge cases.
 * @module tests/mcp-server/tools/definitions/input-validation.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { billSummariesTool } from '@/mcp-server/tools/definitions/bill-summaries.tool.js';
import { committeeLookupTool } from '@/mcp-server/tools/definitions/committee-lookup.tool.js';
import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { crsReportsTool } from '@/mcp-server/tools/definitions/crs-reports.tool.js';
import { dailyRecordTool } from '@/mcp-server/tools/definitions/daily-record.tool.js';
import { enactedLawsTool } from '@/mcp-server/tools/definitions/enacted-laws.tool.js';
import { memberLookupTool } from '@/mcp-server/tools/definitions/member-lookup.tool.js';
import { rollVotesTool } from '@/mcp-server/tools/definitions/roll-votes.tool.js';
import { senateNominationsTool } from '@/mcp-server/tools/definitions/senate-nominations.tool.js';
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
    const ctx = createMockContext();
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      fromDateTime: '2024-01-01',
    });
    await expect(billLookupTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
  });

  it('rejects malformed toDateTime', async () => {
    const ctx = createMockContext();
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      toDateTime: 'January 1 2024',
    });
    await expect(billLookupTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
  });

  it('rejects injection-like dateTime strings', async () => {
    const ctx = createMockContext();
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      fromDateTime: "2024-01-01'; SELECT * FROM bills; --",
    });
    await expect(billLookupTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
  });
});

describe('billSummariesTool — handler validation', () => {
  it('rejects malformed fromDateTime', async () => {
    const ctx = createMockContext();
    const input = billSummariesTool.input.parse({ fromDateTime: '2024/01/01' });
    await expect(billSummariesTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
  });

  it('rejects malformed toDateTime', async () => {
    const ctx = createMockContext();
    const input = billSummariesTool.input.parse({ toDateTime: 'not-a-date' });
    await expect(billSummariesTool.handler(input, ctx)).rejects.toThrow(/ISO 8601/);
  });
});

describe('committeeLookupTool — handler validation', () => {
  it('throws when sub-resource is missing committeeCode', async () => {
    const ctx = createMockContext();
    const input = committeeLookupTool.input.parse({ operation: 'bills' });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });

  it('throws when committeeCode has unknown chamber prefix and chamber is not explicit', async () => {
    const ctx = createMockContext();
    // A committeeCode with prefix that cannot be inferred triggers a validation error
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      committeeCode: 'zzjd00',
    });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow();
  });
});

describe('committeeReportsTool — handler validation', () => {
  it('rejects at parse-time when congress is missing (required field)', () => {
    // congress is required in the schema — parse throws before the handler runs
    expect(() => committeeReportsTool.input.parse({ operation: 'list' })).toThrow();
  });
});

describe('crsReportsTool — handler validation', () => {
  it('defaults to 20-item limit for list', async () => {
    mockApi.listCrsReports.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = dailyRecordTool.input.parse({ operation: 'articles', issueNumber: 5 });
    await expect(dailyRecordTool.handler(input, ctx)).rejects.toThrow(/volumeNumber/);
  });
});

describe('enactedLawsTool — handler validation', () => {
  it('throws when get is missing lawNumber', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = committeeLookupTool.input.parse({ operation: 'list' });
    await committeeLookupTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
  });

  it('sets effectiveQuery on get', async () => {
    mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Judiciary' } });
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = committeeReportsTool.input.parse({ operation: 'list', congress: 118 });
    await committeeReportsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
  });

  it('sets effectiveQuery on get', async () => {
    mockApi.getCommitteeReport.mockResolvedValue({ report: { title: 'Report' } });
    const ctx = createMockContext();
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

// ── Error contract advertisement (#32/#34) ───────────────────────────────────

describe('error contracts', () => {
  const REQUIRED_REASONS = ['not_found', 'rate_limited', 'invalid_request', 'upstream_error'];
  const contractTools = {
    bill_lookup: billLookupTool,
    crs_reports: crsReportsTool,
    daily_record: dailyRecordTool,
    member_lookup: memberLookupTool,
    senate_nominations: senateNominationsTool,
  };

  for (const [name, contractTool] of Object.entries(contractTools)) {
    it(`${name} advertises the shared upstream error contract`, () => {
      const reasons = (contractTool.errors ?? []).map((entry) => entry.reason);
      expect(reasons).toEqual(expect.arrayContaining(REQUIRED_REASONS));
    });
  }
});
