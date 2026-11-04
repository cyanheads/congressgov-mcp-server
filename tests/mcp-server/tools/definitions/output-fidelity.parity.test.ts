/**
 * @fileoverview End-to-end parity coverage for the output-fidelity fixes: a
 * handler's `structuredContent` and its `format()`-rendered `content[]` must
 * carry the same data. Clients split across the two surfaces (Claude Code reads
 * structuredContent, Claude Desktop reads content[]), so a value present in one
 * and absent from the other is invisible to half the fleet.
 *
 * Resolves cyanheads/congressgov-mcp-server#45, #50, #51, #55, #58, #67, #73, #95, #100, #101, #102.
 *
 * @module tests/mcp-server/tools/definitions/output-fidelity.parity.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { senateNominationsTool } from '@/mcp-server/tools/definitions/senate-nominations.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { initCongressDocuments } from '@/services/congress-documents/congress-documents-service.js';
import { initSenateVoteService } from '@/services/senate-lis/senate-vote-service.js';

const mockApi = {
  listLaws: vi.fn(),
  getLaw: vi.fn(),
  getMember: vi.fn(),
  listSummaries: vi.fn(),
  getBillSubResource: vi.fn(),
  listCommittees: vi.fn(),
  listCrsReports: vi.fn(),
  listDailyRecord: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCongressApi).mockReturnValue(mockApi as never);
});

/** Join a formatter's blocks into the single string a content-only client sees. */
function joinText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks.map((b) => b.text ?? '').join('\n');
}

describe('#45 — law citation reaches structuredContent and content[]', () => {
  it('carries the public law citation on both surfaces of a list response', async () => {
    const ctx = createMockContext({ errors: enactedLawsTool.errors });
    mockApi.listLaws.mockResolvedValue({
      data: [
        {
          congress: 118,
          type: 'S',
          number: '3764',
          originChamber: 'Senate',
          title: 'United States Commission on International Religious Freedom Reauthorization Act',
          latestAction: { actionDate: '2024-09-30', text: 'Became Public Law No: 118-90.' },
          laws: [{ number: '118-90', type: 'Public Law' }],
        },
      ],
      pagination: { count: 1, nextOffset: null },
    });

    const input = enactedLawsTool.input.parse({
      operation: 'list',
      congress: 118,
      lawType: 'pub',
      limit: 2,
    });
    const result = await enactedLawsTool.handler(input, ctx);

    expect(result.data?.[0]).toMatchObject({ laws: [{ number: '118-90', type: 'Public Law' }] });
    expect(joinText(enactedLawsTool.format!(result))).toContain('**Law:** Public Law 118-90');
    expect(getEnrichment(ctx).totalCount).toBe(1);
  });

  it('reports an empty result set on both surfaces', async () => {
    const ctx = createMockContext({ errors: enactedLawsTool.errors });
    mockApi.listLaws.mockResolvedValue({ data: [], pagination: { count: 0, nextOffset: null } });

    const input = enactedLawsTool.input.parse({ operation: 'list', congress: 999 });
    const result = await enactedLawsTool.handler(input, ctx);

    expect(result.data).toHaveLength(0);
    expect(joinText(enactedLawsTool.format!(result))).toContain('No matching results');
    expect(getEnrichment(ctx).notice).toContain('No laws matched');
  });

  it('distinguishes an offset past the end from an empty result set', async () => {
    const ctx = createMockContext({ errors: enactedLawsTool.errors });
    mockApi.listLaws.mockResolvedValue({ data: [], pagination: { count: 42, nextOffset: null } });

    const input = enactedLawsTool.input.parse({ operation: 'list', congress: 118, offset: 500 });
    const result = await enactedLawsTool.handler(input, ctx);

    const content = joinText(enactedLawsTool.format!(result));
    expect(content).toContain('Page is empty');
    expect(content).toContain('past the end of 42 total items');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('declares the upstream failure modes with machine-readable reasons and recovery', () => {
    const reasons = enactedLawsTool.errors?.map((e) => e.reason);
    expect(reasons).toEqual([
      'not_found',
      'rate_limited',
      'invalid_request',
      'api_key_rejected',
      'upstream_error',
      'upstream_timeout',
      'incompatible_identity',
    ]);
    for (const contract of enactedLawsTool.errors ?? []) {
      expect(contract.recovery).toBeTruthy();
      expect(contract.when).toBeTruthy();
    }
  });

  it('rejects a get without lawType/lawNumber with an actionable message', async () => {
    const ctx = createMockContext({ errors: enactedLawsTool.errors });
    const input = enactedLawsTool.input.parse({ operation: 'get', congress: 118 });
    await expect(enactedLawsTool.handler(input, ctx)).rejects.toThrow(
      /requires lawType.*and lawNumber/,
    );
  });
});

describe('#50 — member detail reaches both surfaces intact', () => {
  const member = {
    bioguideId: 'P000197',
    directOrderName: 'Nancy Pelosi',
    partyName: 'Democratic',
    state: 'California',
    addressInformation: {
      officeAddress: '1236 Longworth House Office Building',
      city: 'Washington',
      district: 'DC',
      zipCode: 20515,
      phoneNumber: '(202) 225-4965',
    },
    previousNames: [
      { directOrderName: 'Nancy P. Pelosi', startDate: '1987-06-02T00:00:00Z' },
      { directOrderName: 'Nancy Patricia Pelosi', startDate: '1991-01-03T00:00:00Z' },
    ],
    terms: Array.from({ length: 20 }, (_, i) => ({
      chamber: 'House of Representatives',
      startYear: String(1987 + i * 2),
      endYear: String(1989 + i * 2),
    })),
  };

  it('renders address, previous names, and all terms in content[]', async () => {
    const ctx = createMockContext({ errors: memberLookupTool.errors });
    mockApi.getMember.mockResolvedValue({ member });

    const input = memberLookupTool.input.parse({ operation: 'get', bioguideId: 'P000197' });
    const result = await memberLookupTool.handler(input, ctx);

    expect(result.member).toMatchObject({
      addressInformation: { phoneNumber: '(202) 225-4965' },
    });
    expect((result.member as typeof member).previousNames).toHaveLength(2);

    const content = joinText(memberLookupTool.format!(result));
    expect(content).toContain('1236 Longworth House Office Building');
    expect(content).toContain('Nancy P. Pelosi');
    expect(content).toContain('Nancy Patricia Pelosi');
    expect(content).toContain('**Terms (20):**');
    expect(content).toContain('1987–1989');
    expect(content).toContain('2025–2027');
    expect(content).not.toContain('earlier_');
  });

  it('renders a sparse member record without inventing fields', async () => {
    const ctx = createMockContext({ errors: memberLookupTool.errors });
    mockApi.getMember.mockResolvedValue({ member: { bioguideId: 'X000001' } });

    const input = memberLookupTool.input.parse({ operation: 'get', bioguideId: 'X000001' });
    const result = await memberLookupTool.handler(input, ctx);

    const content = joinText(memberLookupTool.format!(result));
    expect(content).toContain('# X000001');
    expect(content).not.toContain('**Terms');
    expect(content).not.toContain('undefined');
  });
});

describe('#51 — emphasis normalization reaches content[] while structuredContent keeps the source', () => {
  const rawSummary =
    '<p>The bill provides <em>de minimis </em>treatment and <strong>major </strong>changes.</p>';

  it('normalizes bill_summaries output', async () => {
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    mockApi.listSummaries.mockResolvedValue({
      data: [
        {
          actionDate: '2026-08-04',
          actionDesc: 'Introduced in House',
          text: rawSummary,
          bill: { congress: 119, type: 'HR', number: '322', title: 'Sample Act' },
        },
      ],
      pagination: { count: 1, nextOffset: null },
    });

    const input = billSummariesTool.input.parse({ congress: 119, billType: 'hr', limit: 2 });
    const result = await billSummariesTool.handler(input, ctx);

    expect(result.data[0]).toMatchObject({ text: rawSummary });

    const content = joinText(billSummariesTool.format!(result));
    expect(content).toContain('*de minimis* treatment');
    expect(content).toContain('**major** changes');
    expect(content).not.toContain('*de minimis *');
    expect(content).not.toContain('**major **');
  });

  it('normalizes the bill_lookup summaries sub-resource', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    mockApi.getBillSubResource.mockResolvedValue({
      data: [
        {
          actionDesc: 'Introduced in House',
          actionDate: '2026-08-04',
          updateDate: '2026-08-05T00:00:00Z',
          text: rawSummary,
        },
      ],
      pagination: { count: 1, nextOffset: null },
    });

    const input = billLookupTool.input.parse({
      operation: 'summaries',
      congress: 119,
      billType: 'hr',
      billNumber: 322,
    });
    const result = await billLookupTool.handler(input, ctx);

    expect(result.data?.[0]).toMatchObject({ text: rawSummary });

    const content = joinText(billLookupTool.format!(result));
    expect(content).toContain('*de minimis* treatment');
    expect(content).toContain('**major** changes');
    expect(content).not.toContain('*de minimis *');
  });
});

describe('#58 — list boundaries reach content[] while structuredContent keeps the source', () => {
  const rawSummary =
    '<p>Exceptions include:</p><ul><li>First item;</li><li>Second item;</li></ul><p>Afterward.</p>';

  it('preserves the raw bill_summaries row and separates its rendered text', async () => {
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    mockApi.listSummaries.mockResolvedValue({
      data: [{ text: rawSummary, bill: { congress: 119, type: 'HR', number: '58' } }],
      pagination: { count: 1, nextOffset: null },
    });

    const result = await billSummariesTool.handler(
      billSummariesTool.input.parse({ congress: 119, billType: 'hr' }),
      ctx,
    );

    expect(result.data[0]).toMatchObject({ text: rawSummary });
    expect(joinText(billSummariesTool.format!(result))).toContain(
      'First item;\nSecond item;\n\nAfterward.',
    );
  });

  it('preserves the raw bill_lookup summary row and separates its rendered text', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    mockApi.getBillSubResource.mockResolvedValue({
      data: [{ actionDesc: 'Introduced in House', text: rawSummary }],
      pagination: { count: 1, nextOffset: null },
    });

    const result = await billLookupTool.handler(
      billLookupTool.input.parse({
        operation: 'summaries',
        congress: 119,
        billType: 'hr',
        billNumber: 58,
      }),
      ctx,
    );

    expect(result.data?.[0]).toMatchObject({ text: rawSummary });
    expect(joinText(billLookupTool.format!(result))).toContain(
      'First item;\nSecond item;\n\nAfterward.',
    );
  });
});

describe('#73 — content[] decodes each character reference once; structuredContent keeps the source', () => {
  const rawSummary = '<p>The text literally reads &amp;lt;b&amp;gt; &#8212; not a tag.</p>';
  const rendered = 'The text literally reads &lt;b&gt; — not a tag.';

  it('bill_summaries', async () => {
    mockApi.listSummaries.mockResolvedValue({
      data: [{ text: rawSummary, bill: { congress: 119, type: 'HR', number: '73' } }],
      pagination: { count: 1, nextOffset: null },
    });

    const result = await runToolContract(billSummariesTool, { congress: 119, billType: 'hr' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ data: [{ text: rawSummary }] });
    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    expect(content).toContain(rendered);
    expect(content).not.toContain('<b>');
  });

  it('bill_lookup summaries', async () => {
    mockApi.getBillSubResource.mockResolvedValue({
      data: [{ actionDesc: 'Introduced in House', text: rawSummary }],
      pagination: { count: 1, nextOffset: null },
    });

    const result = await runToolContract(billLookupTool, {
      operation: 'summaries',
      congress: 119,
      billType: 'hr',
      billNumber: 73,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ data: [{ text: rawSummary }] });
    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    expect(content).toContain(rendered);
    expect(content).not.toContain('<b>');
  });
});

describe('#70 — a windowed summary keeps its HTML in structuredContent and renders in content[]', () => {
  /** Two paragraphs, past the default per-row window so both surfaces bound it. */
  const rawSummary = `<p><strong>Widget Act</strong></p><p>${'The bill directs the Secretary to report. '.repeat(700)}</p>`;

  it('bill_summaries', async () => {
    mockApi.listSummaries.mockResolvedValue({
      data: [
        { versionCode: '00', text: rawSummary, bill: { congress: 119, type: 'HR', number: '70' } },
      ],
      pagination: { count: 1, nextOffset: null },
    });

    const result = await runToolContract(billSummariesTool, { congress: 119, billType: 'hr' });
    const structured = billSummariesTool.output.parse(result.structuredContent) as {
      data: Array<Record<string, unknown>>;
    };
    const row = structured.data[0] as Record<string, unknown>;

    /** The window is the upstream HTML, unmodified — only shorter. */
    expect(rawSummary.startsWith(row.text as string)).toBe(true);
    expect(row.textTotalCharacters).toBe(rawSummary.length);

    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    expect(content).toContain('**Widget Act**');
    expect(content).not.toContain('<strong>');
    expect(content).toContain(`of ${rawSummary.length.toLocaleString('en-US')}`);
  });

  it('bill_lookup summaries', async () => {
    mockApi.getBillSubResource.mockResolvedValue({
      data: [{ actionDesc: 'Introduced in House', versionCode: '00', text: rawSummary }],
      pagination: { count: 1, nextOffset: null },
    });

    const result = await runToolContract(billLookupTool, {
      operation: 'summaries',
      congress: 119,
      billType: 'hr',
      billNumber: 70,
      characterLimit: 300,
    });
    const structured = billLookupTool.output.parse(result.structuredContent) as {
      data?: Array<Record<string, unknown>>;
    };
    const row = structured.data?.[0] as Record<string, unknown>;

    expect(row.text).toBe(rawSummary.slice(0, row.textNextOffset as number));
    expect(row.textTruncated).toBe(true);
    expect((row.text as string).length).toBeLessThanOrEqual(300);

    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    expect(content).toContain('**Widget Act**');
    expect(content).not.toContain('<p>');
    expect(content).toContain('next characterOffset:');
  });
});

describe('#67 — Senate list rows carry a resolved vote date on both surfaces', () => {
  const rolloverMenu = readFileSync(
    new URL('../../../services/senate-lis/fixtures/menu-116-2-rollover.xml', import.meta.url),
    'utf8',
  );

  beforeEach(() => {
    initSenateVoteService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => rolloverMenu,
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('survives the declared output schema and renders in content[]', async () => {
    const result = await runToolContract(rollVotesTool, {
      operation: 'list',
      chamber: 'senate',
      congress: 116,
      session: 2,
      limit: 3,
      order: 'recent',
    });

    expect(result.isError).toBeFalsy();
    const structured = rollVotesTool.output.parse(result.structuredContent) as {
      data?: Array<Record<string, unknown>>;
    };
    expect(structured.data?.map((row) => [row.voteNumber, row.voteDate, row.voteDateIso])).toEqual([
      [292, '01-Jan', '2021-01-01'],
      [291, '01-Jan', '2021-01-01'],
      [290, '30-Dec', '2020-12-30'],
    ]);

    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    expect(content).toContain('**Date:** 2021-01-01 (01-Jan)');
    expect(content).toContain('**Date:** 2020-12-30 (30-Dec)');
  });
});

describe('#55 — list rows reach structuredContent and content[] intact', () => {
  it('carries a subcommittee parent on both surfaces', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.listCommittees.mockResolvedValue({
      data: [
        {
          name: 'Task Force on the Declassification of Federal Secrets Subcommittee',
          systemCode: 'hzgo34',
          chamber: 'House',
          committeeTypeCode: 'Task Force',
          updateDate: '2026-01-22T19:34:38Z',
          url: 'https://api.congress.gov/v3/committee/house/hzgo34?format=json',
          parent: {
            name: 'Oversight and Government Reform Committee',
            systemCode: 'hsgo00',
            url: 'https://api.congress.gov/v3/committee/house/hsgo00?format=json',
          },
        },
      ],
      pagination: { count: 1, nextOffset: null },
    });

    const input = committeeLookupTool.input.parse({
      operation: 'list',
      chamber: 'house',
      limit: 3,
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(result.data?.[0]).toMatchObject({ parent: { systemCode: 'hsgo00' } });
    expect(joinText(committeeLookupTool.format!(result))).toContain('hsgo00');
    expect(getEnrichment(ctx).totalCount).toBe(1);
  });

  it('carries a CRS report publish date on both surfaces', async () => {
    const ctx = createMockContext({ errors: crsReportsTool.errors });
    mockApi.listCrsReports.mockResolvedValue({
      data: [
        {
          id: 'R46991',
          title: 'Economic Development Administration: An Overview of Programs',
          updateDate: '2026-04-10',
          publishDate: '2026-04-09',
          status: 'Active',
        },
      ],
      pagination: { count: 1, nextOffset: null },
    });

    const input = crsReportsTool.input.parse({ operation: 'list', limit: 2 });
    const result = await crsReportsTool.handler(input, ctx);

    expect(result.data?.[0]).toMatchObject({ publishDate: '2026-04-09' });
    const content = joinText(crsReportsTool.format!(result));
    expect(content).toContain('**Updated:** 2026-04-10');
    expect(content).toContain('2026-04-09');
  });

  it('carries the full daily record issue timestamp on both surfaces', async () => {
    const ctx = createMockContext({ errors: dailyRecordTool.errors });
    mockApi.listDailyRecord.mockResolvedValue({
      data: [
        {
          congress: 119,
          issueDate: '2026-04-17T04:00:00Z',
          issueNumber: '68',
          sessionNumber: 2,
          volumeNumber: 172,
        },
      ],
      pagination: { count: 1, nextOffset: null },
    });

    const input = dailyRecordTool.input.parse({ operation: 'list', limit: 2 });
    const result = await dailyRecordTool.handler(input, ctx);

    expect(result.data?.[0]).toMatchObject({ issueDate: '2026-04-17T04:00:00Z' });
    const content = joinText(dailyRecordTool.format!(result));
    expect(content).toContain('Volume 172, Issue 68 — 2026-04-17');
    expect(content).toContain('2026-04-17T04:00:00Z');
  });

  it('reports an empty committee list on both surfaces', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    mockApi.listCommittees.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });

    const input = committeeLookupTool.input.parse({ operation: 'list', chamber: 'house' });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(result.data).toHaveLength(0);
    expect(joinText(committeeLookupTool.format!(result))).toContain('No matching results');
    expect(getEnrichment(ctx).notice).toContain('No committees found');
  });

  it('rejects a committee sub-resource call with no committeeCode', async () => {
    const ctx = createMockContext({ errors: committeeLookupTool.errors });
    const input = committeeLookupTool.input.parse({ operation: 'reports' });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(/requires committeeCode/);
  });
});

describe('#62 — a nomination action citing its Senate vote points at it on both surfaces', () => {
  /** Real `latestAction` / `S05310` text from /nomination/119/730-2. */
  const confirmed = {
    actionDate: '2026-08-07',
    text: 'Confirmed by the Senate by Yea-Nay Vote. 51 - 47. Record Vote Number: 225.',
  };
  const rollVote = { chamber: 'senate', congress: 119, session: 2, voteNumber: 225 };
  const line =
    '**Senate Roll Vote:** congressgov_roll_votes chamber=senate, congress=119, session=2, voteNumber=225';

  beforeEach(() => {
    vi.mocked(getCongressApi).mockReturnValue({
      getNomination: vi.fn(async () => ({
        nomination: { citation: 'PN730-2', congress: 119, latestAction: { ...confirmed } },
      })),
      getNominationSubResource: vi.fn(async () => ({
        data: [{ actionCode: 'S05310', ...confirmed, type: 'Floor' }],
        pagination: { count: 15, nextOffset: 1 },
      })),
    } as never);
  });

  it('get carries the pointer on latestAction', async () => {
    const result = await runToolContract(senateNominationsTool, {
      operation: 'get',
      congress: 119,
      nominationNumber: '730-2',
    });
    expect(result.isError).toBeFalsy();
    const structured = senateNominationsTool.output.parse(result.structuredContent) as {
      nomination?: { latestAction?: { rollVote?: unknown } };
    };
    expect(structured.nomination?.latestAction?.rollVote).toEqual(rollVote);
    expect(joinText(result.content as Array<{ type: string; text?: string }>)).toContain(line);
  });

  it('actions carries the pointer on the citing row', async () => {
    const result = await runToolContract(senateNominationsTool, {
      operation: 'actions',
      congress: 119,
      nominationNumber: '730-2',
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    const structured = senateNominationsTool.output.parse(result.structuredContent) as {
      data?: Array<{ rollVote?: unknown }>;
    };
    expect(structured.data?.[0]?.rollVote).toEqual(rollVote);
    expect(joinText(result.content as Array<{ type: string; text?: string }>)).toContain(line);
  });
});

describe('#102 — a bill action recording a roll call points at it on both surfaces', () => {
  /** /bill/117/hr/3684/actions — House passage (Roll no. 369). */
  const passage = {
    actionCode: 'H41610',
    actionDate: '2021-11-05',
    recordedVotes: [
      {
        chamber: 'House',
        congress: 117,
        date: '2021-11-06T03:27:28Z',
        rollNumber: 369,
        sessionNumber: 1,
        url: 'https://clerk.house.gov/evs/2021/roll369.xml',
      },
    ],
    sourceSystem: { code: 2, name: 'House floor actions' },
    text: 'On motion that the House agree to the Senate amendment Agreed to by the Yeas and Nays: 228 - 206 (Roll no. 369). (consideration: CR H6230-6231)',
    type: 'ResolvingDifferences',
  };

  it('declares rollVote on action rows with either chamber', () => {
    const schema = z.toJSONSchema(billLookupTool.output) as unknown as {
      properties: {
        data: {
          items: {
            properties: {
              rollVote: { properties: { chamber: { enum: string[] } }; required: string[] };
            };
          };
        };
      };
    };
    const rollVote = schema.properties.data.items.properties.rollVote;
    expect(rollVote.properties.chamber.enum).toEqual(['house', 'senate']);
    expect(rollVote.required).toEqual(['chamber', 'congress', 'session', 'voteNumber']);
  });

  it('carries the pointer in structuredContent and its call in content[]', async () => {
    mockApi.getBillSubResource.mockResolvedValue({
      data: [passage],
      pagination: { count: 101, nextOffset: 1 },
    });
    const result = await runToolContract(billLookupTool, {
      operation: 'actions',
      congress: 117,
      billType: 'hr',
      billNumber: 3684,
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    const structured = billLookupTool.output.parse(result.structuredContent) as {
      data?: Array<{ rollVote?: unknown }>;
    };
    expect(structured.data?.[0]?.rollVote).toEqual({
      chamber: 'house',
      congress: 117,
      session: 1,
      voteNumber: 369,
    });
    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    expect(content).toContain(
      '**House Roll Vote:** congressgov_roll_votes chamber=house, congress=117, session=1, voteNumber=369',
    );
    expect(content).toContain('https://clerk.house.gov/evs/2021/roll369.xml');
  });
});

/**
 * Every string value of a record, keyed by its path — the values a `content[]`
 * reader must see — whitespace-collapsed into the inline form the renderers
 * print. Numbers are left out: a short count or code is a substring of too much
 * else on the page to prove it was rendered. A `{count, url}` sub-resource
 * reference is the renderer's one documented exception ("N available", the
 * tool's own operation being the path to those rows), so its URL is skipped.
 */
function stringLeaves(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value.replace(/\s+/g, ' ').trim()]];
  if (Array.isArray(value)) return value.flatMap((item, i) => stringLeaves(item, `${path}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  if ('count' in value && Object.keys(value).length <= 2) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    stringLeaves(item, path ? `${path}.${key}` : key),
  );
}

describe('#100 — an amendment record and its roll call actions reach both surfaces', () => {
  /** /amendment/118/hamdt/255 (2026-11-03). */
  const roy = {
    actionDate: '2023-07-14',
    actionTime: '10:44:04',
    text: 'On agreeing to the Roy amendment (A040) Agreed to by recorded vote: 217 - 216 (Roll no. 326).',
  };
  const hamdt255 = {
    actions: {
      count: 7,
      url: 'https://api.congress.gov/v3/amendment/118/hamdt/255/actions?format=json',
    },
    amendedBill: {
      congress: 118,
      number: '2670',
      originChamber: 'House',
      originChamberCode: 'H',
      title: 'National Defense Authorization Act for Fiscal Year 2024',
      type: 'HR',
      updateDateIncludingText: '2026-09-08',
      url: 'https://api.congress.gov/v3/bill/118/hr/2670?format=json',
    },
    chamber: 'House of Representatives',
    congress: 118,
    description:
      "An amendment numbered 64 printed in House Report 118-142 to prohibit the DOD from carrying out the President's Administration climate change executive orders.",
    latestAction: {
      ...roy,
      links: [{ name: 'Roll no. 326', url: 'https://www.congress.gov/votes/house/118-1/326' }],
    },
    number: '255',
    purpose:
      "Amendment prohibits the Department of Defense from carrying out the Administration's climate change executive orders.",
    sponsors: [
      {
        bioguideId: 'R000614',
        district: 21,
        firstName: 'Chip',
        fullName: 'Rep. Roy, Chip [R-TX-21]',
        lastName: 'Roy',
        party: 'R',
        state: 'TX',
        url: 'https://api.congress.gov/v3/member/R000614?format=json',
      },
    ],
    submittedDate: '2023-07-14T04:00:00Z',
    textVersions: {
      count: 1,
      url: 'https://api.congress.gov/v3/amendment/118/hamdt/255/text?format=json',
    },
    type: 'HAMDT',
    updateDate: '2025-05-13T11:06:20Z',
  };

  /** /amendment/118/hamdt/255/actions — the House roll 326 row and the row offering it. */
  const houseRows = [
    {
      actionCode: 'H32111',
      actionDate: '2023-07-14',
      actionTime: '10:44:04',
      recordedVotes: [
        {
          chamber: 'House',
          congress: 118,
          date: '2023-07-14T14:44:04Z',
          rollNumber: 326,
          sessionNumber: 1,
          url: 'https://clerk.house.gov/evs/2023/roll326.xml',
        },
      ],
      sourceSystem: { code: 2, name: 'House floor actions' },
      text: roy.text,
      type: 'Floor',
    },
    {
      actionCode: 'H3A100',
      actionDate: '2023-07-14',
      actionTime: '09:30:06',
      sourceSystem: { code: 2, name: 'House floor actions' },
      text: 'Amendment (A040) offered by Mr. Roy. (consideration: CR H3582-3584, H3598; text: CR H3582-3583)',
      type: 'Floor',
    },
  ];

  /** /amendment/117/samdt/2137/actions — the Senate vote 312 row and a row recording none. */
  const senateRows = [
    {
      actionDate: '2021-08-08',
      recordedVotes: [
        {
          chamber: 'Senate',
          congress: 117,
          date: '2021-08-09T00:45:48Z',
          rollNumber: 312,
          sessionNumber: 1,
          url: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1171/vote_117_1_00312.xml',
        },
      ],
      sourceSystem: { code: 0, name: 'Senate' },
      text: 'Amendment SA 2137 agreed to in Senate by Yea-Nay Vote. 69 - 28. Record Vote Number: 312. ',
      type: 'Floor',
    },
    {
      actionDate: '2021-08-08',
      sourceSystem: { code: 0, name: 'Senate' },
      text: 'Considered by Senate. (consideration: CR S6034, S6056-6057)',
      type: 'Floor',
    },
  ];

  it('declares rollVote on action rows with either chamber', () => {
    const schema = z.toJSONSchema(amendmentLookupTool.output) as unknown as {
      properties: {
        data: {
          items: {
            properties: {
              rollVote: { properties: { chamber: { enum: string[] } }; required: string[] };
            };
          };
        };
      };
    };
    const rollVote = schema.properties.data.items.properties.rollVote;
    expect(rollVote.properties.chamber.enum).toEqual(['house', 'senate']);
    expect(rollVote.required).toEqual(['chamber', 'congress', 'session', 'voteNumber']);
  });

  it("'get' carries every string value of the record on both surfaces", async () => {
    vi.mocked(getCongressApi).mockReturnValue({
      getAmendment: vi.fn(async () => ({ amendment: hamdt255 })),
    } as never);
    const result = await runToolContract(amendmentLookupTool, {
      operation: 'get',
      congress: 118,
      amendmentType: 'HAMDT',
      amendmentNumber: '255',
    });
    expect(result.isError).toBeFalsy();
    const structured = amendmentLookupTool.output.parse(result.structuredContent) as {
      amendment?: unknown;
    };
    expect(structured.amendment).toEqual(hamdt255);

    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    for (const [path, value] of stringLeaves(hamdt255)) expect(content, path).toContain(value);
    expect(content).toContain('**actions:** 7 available');
    expect(content).toContain('**textVersions:** 1 available');
  });

  it.each([
    [
      'House roll 326',
      { congress: 118, amendmentType: 'hamdt', amendmentNumber: 255 },
      houseRows,
      { count: 7, nextOffset: 2 },
      { chamber: 'house', congress: 118, session: 1, voteNumber: 326 },
      '**House Roll Vote:** congressgov_roll_votes chamber=house, congress=118, session=1, voteNumber=326',
    ],
    [
      'Senate vote 312',
      { congress: 117, amendmentType: 'samdt', amendmentNumber: 2137 },
      senateRows,
      { count: 3, nextOffset: 2 },
      { chamber: 'senate', congress: 117, session: 1, voteNumber: 312 },
      '**Senate Roll Vote:** congressgov_roll_votes chamber=senate, congress=117, session=1, voteNumber=312',
    ],
  ])(
    "'actions' carries the %s pointer in structuredContent, its call in content[], and every row value on both",
    async (_vote, identity, rows, pagination, rollVote, line) => {
      vi.mocked(getCongressApi).mockReturnValue({
        getAmendmentSubResource: vi.fn(async () => ({ data: rows, pagination })),
      } as never);
      const result = await runToolContract(amendmentLookupTool, {
        operation: 'actions',
        ...identity,
        limit: 2,
      });
      expect(result.isError).toBeFalsy();
      const structured = amendmentLookupTool.output.parse(result.structuredContent) as {
        data?: Array<Record<string, unknown>>;
        pagination?: unknown;
      };
      expect(structured.data).toEqual([{ ...rows[0], rollVote }, rows[1]]);
      expect(structured.pagination).toEqual(pagination);

      const content = joinText(result.content as Array<{ type: string; text?: string }>);
      expect(content.split(line)).toHaveLength(2);
      expect(content).toContain(`**${pagination.count} results** | next offset: 2`);
      for (const [path, value] of stringLeaves(structured.data)) {
        expect(content, path).toContain(value);
      }
    },
  );
});

describe('#102 — a filtered roster carries its filter and counts on both surfaces', () => {
  /** /house-vote/117/1/369/members (2026-11-03), trimmed: the vote context and three members. */
  const vote = {
    congress: 117,
    rollCallNumber: 369,
    sessionNumber: 1,
    result: 'Passed',
    voteQuestion: 'On Motion to Concur in the Senate Amendment',
  };
  const roster = [
    {
      bioguideId: 'S000168',
      firstName: 'Maria',
      lastName: 'Salazar',
      voteCast: 'Nay',
      voteParty: 'R',
      voteState: 'FL',
    },
    {
      bioguideId: 'S001216',
      firstName: 'Kim',
      lastName: 'Schrier',
      voteCast: 'Yea',
      voteParty: 'D',
      voteState: 'WA',
    },
    {
      bioguideId: 'J000298',
      firstName: 'Pramila',
      lastName: 'Jayapal',
      voteCast: 'Yea',
      voteParty: 'D',
      voteState: 'WA',
    },
  ];

  beforeEach(() => {
    /** Pages the way the service does: the whole roster fetched, sliced by limit/offset. */
    vi.mocked(getCongressApi).mockReturnValue({
      getVoteMembers: vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => {
        const data = roster.slice(offset, offset + limit);
        const next = offset + data.length;
        return {
          data,
          vote,
          pagination: { count: roster.length, nextOffset: next < roster.length ? next : null },
        };
      }),
    } as never);
  });

  it('renders every structured value of a filtered page in content[]', async () => {
    const result = await runToolContract(rollVotesTool, {
      operation: 'members',
      congress: 117,
      session: 1,
      voteNumber: 369,
      stateCode: 'WA',
      limit: 1,
      offset: 1,
    });
    expect(result.isError).toBeFalsy();
    const structured = rollVotesTool.output.parse(result.structuredContent) as {
      data: Array<Record<string, unknown>>;
      pagination: { count: number; nextOffset: number | null };
      memberFilter?: Record<string, unknown>;
    };
    expect(structured.data).toEqual([roster[2]]);
    expect(structured.pagination).toEqual({ count: 2, nextOffset: null });
    expect(structured.memberFilter).toEqual({ stateCode: 'WA', rosterCount: 3 });

    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    expect(content).toContain('**Filter:** stateCode=WA — matches 2 of 3 member positions');
    expect(content).toContain('**Members 2–2 of 2**');
    expect(content).toContain('- Pramila Jayapal (D-WA) → Yea');
    expect(content).toContain('J000298');
  });

  it('reports a filter matching nothing on both surfaces without claiming an empty roster', async () => {
    const result = await runToolContract(rollVotesTool, {
      operation: 'members',
      congress: 117,
      session: 1,
      voteNumber: 369,
      bioguideId: 'Z000017',
    });
    const structured = result.structuredContent as {
      data: unknown[];
      memberFilter?: Record<string, unknown>;
      notice?: string;
    };
    expect(structured.data).toEqual([]);
    expect(structured.memberFilter).toEqual({ bioguideId: 'Z000017', rosterCount: 3 });
    expect(structured.notice).toContain('bioguideId=Z000017');

    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    expect(content).toContain('**Filter:** bioguideId=Z000017 — matches 0 of 3 member positions');
    expect(content).toContain('bioguideId=Z000017');
    expect(content).not.toContain('No member positions recorded');
  });
});

/** Every value of a `content` window, as `content[]` renders it. */
function expectWindowRendered(window: Record<string, unknown>, rendered: string): void {
  const total = window.totalCharacters as number;
  const offset = window.offset as number;
  const text = window.text as string;
  expect(rendered).toContain(`# ${window.documentTitle as string}`);
  expect(rendered).toContain(`**Format:** ${window.format as string}`);
  expect(rendered).toContain(
    `**Characters ${(offset + 1).toLocaleString('en-US')}–${(offset + text.length).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}**`,
  );
  expect(rendered).toContain(`**Truncated:** ${String(window.truncated)}`);
  expect(rendered).toContain(`offset: ${offset}`);
  expect(rendered).toContain(
    window.nextOffset === null
      ? '_end of document_'
      : `next offset: ${window.nextOffset as number}`,
  );
  expect(rendered).toContain(`**Source:** ${window.sourceUrl as string}`);
  expect(rendered).toContain(`\`\`\`\n${text}\n\`\`\``);
}

describe('#95 — a multi-part committee report carries its parts on both surfaces', () => {
  const records = [
    { citation: 'H. Rept. 117-70,Part 2', part: 2, title: 'Part two title' },
    { citation: 'H. Rept. 117-70', part: 1, title: 'Part one title' },
  ];
  const text = [
    {
      formats: [
        {
          isErrata: 'N',
          type: 'PDF',
          url: 'https://www.congress.gov/117/crpt/hrpt70/CRPT-117hrpt70-pt2.pdf',
        },
      ],
    },
    {
      formats: [
        {
          isErrata: 'N',
          type: 'PDF',
          url: 'https://www.congress.gov/117/crpt/hrpt70/CRPT-117hrpt70.pdf',
        },
      ],
    },
  ];

  beforeEach(() => {
    vi.mocked(getCongressApi).mockReturnValue({
      getCommitteeReport: vi.fn(async () => ({ reports: records })),
      getCommitteeReportText: vi.fn(async () => ({ text })),
    } as never);
  });

  it("'get' renders the selected record and every part number", async () => {
    const result = await runToolContract(committeeReportsTool, {
      operation: 'get',
      congress: 117,
      reportType: 'hrpt',
      reportNumber: 70,
      part: 2,
    });
    const structured = committeeReportsTool.output.parse(result.structuredContent) as {
      report: Record<string, unknown>;
      parts: number[];
    };
    expect(structured.report).toEqual(records[0]);
    expect(structured.parts).toEqual([1, 2]);
    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    for (const value of ['H. Rept. 117-70,Part 2', 'Part two title', '**Parts:** 1, 2']) {
      expect(content).toContain(value);
    }
    expect(content).not.toContain('Part one title');
  });

  it("'text' renders the selected part's format URLs and every part number", async () => {
    const result = await runToolContract(committeeReportsTool, {
      operation: 'text',
      congress: 117,
      reportType: 'hrpt',
      reportNumber: 70,
    });
    expect(result.structuredContent).toMatchObject({ text: [text[1]], parts: [1, 2] });
    const content = joinText(result.content as Array<{ type: string; text?: string }>);
    expect(content).toContain('https://www.congress.gov/117/crpt/hrpt70/CRPT-117hrpt70.pdf');
    expect(content).not.toContain('-pt2.pdf');
    expect(content).toContain('**Parts:** 1, 2');
  });
});

describe('#101 — a CRS report window carries every value on both surfaces', () => {
  const HTML_URL = 'https://www.congress.gov/crs_external_products/IN/HTML/IN12753.html';
  const PAGE =
    '<html><body><h1>Insight</h1><p>One &amp; two.</p><script>Highcharts.x()</script></body></html>';

  beforeEach(() => {
    vi.mocked(getCongressApi).mockReturnValue({
      getCrsReport: vi.fn(async () => ({
        report: { id: 'IN12753', formats: [{ format: 'HTML', url: HTML_URL }] },
      })),
    } as never);
    initCongressDocuments();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(PAGE, { headers: { 'content-type': 'text/html' } })),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [0, 25_000],
    [3, 8],
  ])('renders the window at offset %i, limit %i', async (characterOffset, characterLimit) => {
    const result = await runToolContract(crsReportsTool, {
      operation: 'content',
      reportNumber: 'IN12753',
      characterOffset,
      characterLimit,
    });
    expect(result.isError).toBeFalsy();
    const window = (result.structuredContent as { content: Record<string, unknown> }).content;
    expect(window).toMatchObject({
      text: 'Insight\n\nOne & two.'.slice(characterOffset, characterOffset + characterLimit),
      totalCharacters: 'Insight\n\nOne & two.'.length,
      format: 'html',
      documentTitle: 'CRS Report IN12753',
      sourceUrl: HTML_URL,
    });
    expectWindowRendered(
      window,
      joinText(result.content as Array<{ type: string; text?: string }>),
    );
  });
});
