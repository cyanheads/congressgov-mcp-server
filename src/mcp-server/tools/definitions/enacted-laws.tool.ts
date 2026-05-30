/**
 * @fileoverview Tool for browsing enacted public and private laws from Congress.gov.
 * @module mcp-server/tools/definitions/enacted-laws
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatLaws } from '@/mcp-server/tools/format-helpers.js';
import {
  buildEffectiveQuery,
  listEnrichment,
  listOrDetail,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const enactedLawsTool = tool('congressgov_enacted_laws', {
  description: `Browse enacted public and private laws from Congress.gov by congress and law type ('pub' for public laws, 'priv' for private). 'list' filters by enactment status and law type — the discovery path 'bill_lookup' does not offer. 'get' returns the origin bill record (sponsor, actions, summaries, text), with the public/private law citation on the bill's 'laws' array (e.g. {"number":"118-2","type":"Public Law"}).`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    operation: z.enum(['list', 'get']).describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number.'),
    lawType: z
      .enum(['pub', 'priv'])
      .optional()
      .describe(
        "Law type — 'pub' (public laws, general application, most common) or 'priv' (private laws, specific individuals or entities). Required for 'get'.",
      ),
    lawNumber: z.number().int().positive().optional().describe("Law number. Required for 'get'."),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: listOrDetail(
    'law',
    "Origin bill record for `get`; absent for `list`. The bill's `laws` array carries the law citation.",
  ),
  enrichment: listEnrichment,
  format: formatLaws,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listLaws(
        {
          congress: input.congress,
          lawType: input.lawType,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Laws listed', { congress: input.congress, count: result.data.length });
      ctx.enrich.echo(
        buildEffectiveQuery('enacted laws', { congress: input.congress, lawType: input.lawType }),
      );
      ctx.enrich.total(result.pagination.count);
      if (result.data.length === 0)
        ctx.enrich.notice(
          'No laws matched the filters. Verify the congress number or try a different lawType.',
        );
      return result;
    }

    if (!input.lawType || !input.lawNumber) {
      throw validationError(
        "The 'get' operation requires lawType ('pub' or 'priv') and lawNumber. Use 'list' to browse laws by congress.",
        { lawType: input.lawType, lawNumber: input.lawNumber },
      );
    }

    const result = await api.getLaw(
      {
        congress: input.congress,
        lawType: input.lawType,
        lawNumber: input.lawNumber,
      },
      ctx,
    );
    ctx.log.info('Law retrieved', {
      congress: input.congress,
      lawType: input.lawType,
      lawNumber: input.lawNumber,
    });
    ctx.enrich.echo(
      `${input.lawType === 'pub' ? 'Public' : 'Private'} Law ${input.congress}-${input.lawNumber}`,
    );
    ctx.enrich.total(1);
    return result;
  },
});
