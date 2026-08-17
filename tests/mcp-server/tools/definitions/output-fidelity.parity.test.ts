/**
 * @fileoverview End-to-end parity coverage for the output-fidelity fixes: a
 * handler's `structuredContent` and its `format()`-rendered `content[]` must
 * carry the same data. Clients split across the two surfaces (Claude Code reads
 * structuredContent, Claude Desktop reads content[]), so a value present in one
 * and absent from the other is invisible to half the fleet.
 *
 * Resolves cyanheads/congressgov-mcp-server#45, #50, #51.
 *
 * @module tests/mcp-server/tools/definitions/output-fidelity.parity.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { billSummariesTool } from '@/mcp-server/tools/definitions/bill-summaries.tool.js';
import { enactedLawsTool } from '@/mcp-server/tools/definitions/enacted-laws.tool.js';
import { memberLookupTool } from '@/mcp-server/tools/definitions/member-lookup.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

const mockApi = {
  listLaws: vi.fn(),
  getLaw: vi.fn(),
  getMember: vi.fn(),
  listSummaries: vi.fn(),
  getBillSubResource: vi.fn(),
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
    expect(reasons).toEqual(['not_found', 'rate_limited', 'invalid_request', 'upstream_error']);
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
