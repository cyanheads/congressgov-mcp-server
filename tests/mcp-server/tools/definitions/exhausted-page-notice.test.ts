/**
 * @fileoverview Cross-tool coverage for the exhausted-page vs. genuine-no-match
 * split on every browse/list call site. An empty page whose upstream total is
 * greater than zero is a page past the end, not a no-match result: it must carry
 * no `enrichment.notice`, and `format()` must render the page-past-the-end hint.
 * A genuinely empty result set (total zero) keeps its site-specific notice text.
 * Resolves cyanheads/congressgov-mcp-server#49.
 * @module tests/mcp-server/tools/definitions/exhausted-page-notice.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

vi.mock('@/services/senate-lis/senate-vote-service.js', () => ({
  getSenateVoteService: vi.fn(),
  initSenateVoteService: vi.fn(),
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
import { getSenateVoteService } from '@/services/senate-lis/senate-vote-service.js';

const mockApi = {
  listBills: vi.fn(),
  getBillSubResource: vi.fn(),
  listLaws: vi.fn(),
  listMembers: vi.fn(),
  getMemberLegislation: vi.fn(),
  listCommittees: vi.fn(),
  getCommitteeSubResource: vi.fn(),
  listVotes: vi.fn(),
  getVoteMembers: vi.fn(),
  listNominations: vi.fn(),
  getNominationSubResource: vi.fn(),
  listSummaries: vi.fn(),
  listCrsReports: vi.fn(),
  listCommitteeReports: vi.fn(),
  listDailyRecord: vi.fn(),
  getDailyIssues: vi.fn(),
  getDailyArticles: vi.fn(),
};

const mockSenate = {
  listVotes: vi.fn(),
  getVoteMembers: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCongressApi).mockReturnValue(mockApi as never);
  vi.mocked(getSenateVoteService).mockReturnValue(mockSenate as never);
});

/** An empty page whose upstream total is non-zero — offset ran past the end. */
const EXHAUSTED = { data: [], pagination: { count: 42, nextOffset: null } };
/** A genuinely empty result set — nothing upstream matched the filters. */
const NO_MATCH = { data: [], pagination: { count: 0, nextOffset: null } };

function renderedText(
  format: ((result: never) => Array<{ type: string; text?: string }>) | undefined,
  result: unknown,
): string {
  const blocks = format?.(result as never) ?? [];
  return blocks.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');
}

/** One tool operation's empty-result surface. */
type Site = {
  name: string;
  tool: {
    input: { parse: (raw: unknown) => never };
    handler: (input: never, ctx: never) => Promise<unknown>;
    errors?: unknown;
    format?: (result: never) => Array<{ type: string; text?: string }>;
  };
  input: Record<string, unknown>;
  /** Prime every upstream stub for the given envelope. */
  prime: (envelope: typeof EXHAUSTED) => void;
  /** The site's own no-match guidance — must survive unchanged (#22). */
  noticePattern: RegExp;
  /** The page-past-the-end hint `format()` renders (#28) — unaffected by the gate. */
  exhaustedTextPattern?: RegExp;
};

const sites: Site[] = [
  {
    name: 'bill_lookup list',
    tool: billLookupTool as never,
    input: { operation: 'list', congress: 119, billType: 'hr', limit: 2, offset: 100_000 },
    prime: (envelope) => mockApi.listBills.mockResolvedValue(envelope),
    noticePattern: /No bills matched the filters/,
  },
  {
    name: 'bill_lookup sub-resource',
    tool: billLookupTool as never,
    input: { operation: 'actions', congress: 119, billType: 'hr', billNumber: 1234, offset: 500 },
    prime: (envelope) => mockApi.getBillSubResource.mockResolvedValue(envelope),
    noticePattern: /No actions found for HR 1234/,
  },
  {
    name: 'bill_summaries',
    tool: billSummariesTool as never,
    input: { congress: 119, offset: 500 },
    prime: (envelope) => mockApi.listSummaries.mockResolvedValue(envelope),
    noticePattern: /No summaries found/,
  },
  {
    name: 'crs_reports list',
    tool: crsReportsTool as never,
    input: { operation: 'list', offset: 500 },
    prime: (envelope) => mockApi.listCrsReports.mockResolvedValue(envelope),
    noticePattern: /No CRS reports found/,
  },
  {
    name: 'enacted_laws list',
    tool: enactedLawsTool as never,
    input: { operation: 'list', congress: 118, offset: 500 },
    prime: (envelope) => mockApi.listLaws.mockResolvedValue(envelope),
    noticePattern: /No laws matched the filters/,
  },
  {
    name: 'committee_reports list',
    tool: committeeReportsTool as never,
    input: { operation: 'list', congress: 118, offset: 500 },
    prime: (envelope) => mockApi.listCommitteeReports.mockResolvedValue(envelope),
    noticePattern: /No committee reports found/,
  },
  {
    name: 'daily_record list',
    tool: dailyRecordTool as never,
    input: { operation: 'list', offset: 500 },
    prime: (envelope) => mockApi.listDailyRecord.mockResolvedValue(envelope),
    noticePattern: /No Congressional Record volumes found/,
  },
  {
    name: 'daily_record issues',
    tool: dailyRecordTool as never,
    input: { operation: 'issues', volumeNumber: 171, offset: 500 },
    prime: (envelope) => mockApi.getDailyIssues.mockResolvedValue(envelope),
    noticePattern: /No issues found for volume 171/,
  },
  {
    name: 'daily_record articles',
    tool: dailyRecordTool as never,
    input: { operation: 'articles', volumeNumber: 171, issueNumber: 109, offset: 500 },
    prime: (envelope) => mockApi.getDailyArticles.mockResolvedValue(envelope),
    noticePattern: /No articles found for volume 171, issue 109/,
  },
  {
    name: 'member_lookup list',
    tool: memberLookupTool as never,
    input: { operation: 'list', congress: 118, stateCode: 'CA', offset: 500 },
    prime: (envelope) => mockApi.listMembers.mockResolvedValue(envelope),
    noticePattern: /No members matched the filters/,
  },
  {
    name: 'member_lookup sponsored',
    tool: memberLookupTool as never,
    input: { operation: 'sponsored', bioguideId: 'P000197', offset: 500 },
    prime: (envelope) => mockApi.getMemberLegislation.mockResolvedValue(envelope),
    noticePattern: /No sponsored legislation found for member P000197/,
  },
  {
    name: 'committee_lookup list',
    tool: committeeLookupTool as never,
    input: { operation: 'list', chamber: 'house', offset: 500 },
    prime: (envelope) => mockApi.listCommittees.mockResolvedValue(envelope),
    noticePattern: /No committees found/,
  },
  {
    name: 'committee_lookup sub-resource',
    tool: committeeLookupTool as never,
    input: { operation: 'reports', committeeCode: 'hsju00', offset: 500 },
    prime: (envelope) => mockApi.getCommitteeSubResource.mockResolvedValue(envelope),
    noticePattern: /No reports found for committee hsju00/,
  },
  {
    name: 'roll_votes house list (oldest order)',
    tool: rollVotesTool as never,
    input: { operation: 'list', congress: 119, session: 1, order: 'oldest', offset: 500 },
    prime: (envelope) => mockApi.listVotes.mockResolvedValue(envelope),
    noticePattern: /No votes found/,
  },
  {
    name: 'roll_votes house members',
    tool: rollVotesTool as never,
    input: { operation: 'members', congress: 119, session: 1, voteNumber: 42, offset: 500 },
    prime: (envelope) =>
      mockApi.getVoteMembers.mockResolvedValue({ ...envelope, vote: { rollCallNumber: 42 } }),
    noticePattern: /No member vote records found for roll 42/,
    exhaustedTextPattern: /past the end of 42 member positions/,
  },
  {
    name: 'roll_votes senate list',
    tool: rollVotesTool as never,
    input: {
      operation: 'list',
      chamber: 'senate',
      congress: 119,
      session: 1,
      offset: 500,
    },
    prime: (envelope) => mockSenate.listVotes.mockResolvedValue({ ...envelope, chamber: 'senate' }),
    noticePattern: /No Senate votes found/,
  },
  {
    name: 'roll_votes senate members',
    tool: rollVotesTool as never,
    input: {
      operation: 'members',
      chamber: 'senate',
      congress: 119,
      session: 1,
      voteNumber: 7,
      offset: 500,
    },
    prime: (envelope) =>
      mockSenate.getVoteMembers.mockResolvedValue({
        ...envelope,
        chamber: 'senate',
        vote: { chamber: 'senate', voteNumber: 7 },
      }),
    noticePattern: /No member vote records found for Senate roll 7/,
    exhaustedTextPattern: /past the end of 42 member positions/,
  },
  {
    name: 'senate_nominations list',
    tool: senateNominationsTool as never,
    input: { operation: 'list', congress: 119, offset: 500 },
    prime: (envelope) => mockApi.listNominations.mockResolvedValue(envelope),
    noticePattern: /No nominations found for this congress/,
  },
  {
    name: 'senate_nominations sub-resource (parent-form hint)',
    tool: senateNominationsTool as never,
    input: { operation: 'actions', congress: 119, nominationNumber: '851', offset: 500 },
    prime: (envelope) => mockApi.getNominationSubResource.mockResolvedValue(envelope),
    noticePattern: /partitioned children/,
  },
];

describe('exhausted page vs. genuine no-match — enrichment.notice gate', () => {
  for (const site of sites) {
    describe(site.name, () => {
      it('leaves notice unset when the page is past the end of a non-empty result set', async () => {
        site.prime(EXHAUSTED);
        const ctx = createMockContext({ errors: site.tool.errors as never });
        const input = site.tool.input.parse(site.input);
        const result = await site.tool.handler(input, ctx as never);

        const enrichment = getEnrichment(ctx);
        expect(enrichment.totalCount).toBe(42);
        expect(enrichment.notice).toBeUndefined();

        const text = renderedText(site.tool.format, result);
        expect(text).toMatch(site.exhaustedTextPattern ?? /past the end of 42 total items/);
      });

      it('still emits its own no-match guidance when the upstream total is zero', async () => {
        site.prime(NO_MATCH);
        const ctx = createMockContext({ errors: site.tool.errors as never });
        const input = site.tool.input.parse(site.input);
        const result = await site.tool.handler(input, ctx as never);

        const enrichment = getEnrichment(ctx);
        expect(enrichment.totalCount).toBe(0);
        expect(enrichment.notice).toMatch(site.noticePattern);

        const text = renderedText(site.tool.format, result);
        expect(text).not.toMatch(/past the end/);
      });
    });
  }
});

// ── Paths that synthesize their own pagination envelope ──────────────────────

describe('offset boundaries — bill_lookup list', () => {
  /** Upstream serves the empty page itself; the offset only decides which. */
  const emptyPageOf = (count: number) => ({ data: [], pagination: { count, nextOffset: null } });

  const listAt = async (offset: number, upstream: ReturnType<typeof emptyPageOf>) => {
    mockApi.listBills.mockResolvedValue(upstream);
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 119,
      billType: 'hr',
      limit: 10,
      offset,
    });
    const result = await billLookupTool.handler(input, ctx);
    return { ctx, result };
  };

  it('offset exactly at the end of the result set is an exhausted page', async () => {
    const { ctx, result } = await listAt(10, emptyPageOf(10));
    expect(getEnrichment(ctx).notice).toBeUndefined();
    expect(renderedText(billLookupTool.format, result)).toMatch(/past the end of 10 total items/);
  });

  it('offset far past the end is still an exhausted page', async () => {
    const { ctx, result } = await listAt(100_000, emptyPageOf(10_081));
    expect(getEnrichment(ctx).notice).toBeUndefined();
    expect(renderedText(billLookupTool.format, result)).toMatch(
      /past the end of 10081 total items/,
    );
  });

  it('offset zero against a genuinely empty result set is a no-match', async () => {
    const { ctx, result } = await listAt(0, emptyPageOf(0));
    expect(getEnrichment(ctx).notice).toMatch(/No bills matched the filters/);
    expect(renderedText(billLookupTool.format, result)).toMatch(/No matching results/);
  });

  it('offset past the end of a genuinely empty result set is still a no-match', async () => {
    const { ctx } = await listAt(100_000, emptyPageOf(0));
    expect(getEnrichment(ctx).notice).toMatch(/No bills matched the filters/);
  });
});

describe('roll_votes house list (recent order) — client-side pagination', () => {
  const votes = Array.from({ length: 5 }, (_, i) => ({
    rollCallNumber: i + 1,
    updateDate: `2026-01-0${i + 1}T00:00:00Z`,
  }));

  it('leaves notice unset when the offset runs past the sorted session', async () => {
    mockApi.listVotes.mockResolvedValue({
      data: votes,
      pagination: { count: votes.length, nextOffset: null },
    });
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    const input = rollVotesTool.input.parse({
      operation: 'list',
      congress: 119,
      session: 1,
      order: 'recent',
      offset: 500,
    });
    const result = await rollVotesTool.handler(input, ctx);
    expect(result.data).toEqual([]);
    expect(result.pagination?.count).toBe(votes.length);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('emits the no-match notice when the session holds no votes at all', async () => {
    mockApi.listVotes.mockResolvedValue({ data: [], pagination: { count: 0, nextOffset: null } });
    const ctx = createMockContext({ errors: rollVotesTool.errors });
    const input = rollVotesTool.input.parse({
      operation: 'list',
      congress: 119,
      session: 1,
      order: 'recent',
    });
    await rollVotesTool.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toMatch(/No votes found/);
  });
});

describe('committee_lookup bills (recent order) — probe-then-slice pagination', () => {
  it('leaves notice unset when the offset runs past the committee bill list', async () => {
    mockApi.getCommitteeSubResource.mockResolvedValue({
      data: [{ billNumber: 1 }],
      pagination: { count: 5, nextOffset: null },
    });
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      committeeCode: 'hsju00',
      order: 'recent',
      offset: 500,
    });
    const result = await committeeLookupTool.handler(input, ctx);
    expect(result.data).toEqual([]);
    expect(result.pagination?.count).toBe(5);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('emits the no-match notice when the committee has no bills', async () => {
    mockApi.getCommitteeSubResource.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      committeeCode: 'hsju00',
      order: 'recent',
    });
    await committeeLookupTool.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toMatch(/No bills found for committee hsju00/);
  });
});
