/**
 * @fileoverview Tool for browsing enacted public and private laws from Congress.gov.
 * @module mcp-server/tools/definitions/enacted-laws
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatLaws } from '@/mcp-server/tools/format-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const enactedLawsTool = tool('congressgov_enacted_laws', {
  description: `Browse enacted public and private laws from Congress.gov. 'list' is the primary value — it filters bills by enactment status and law type ('pub' or 'priv'), which 'bill_lookup' cannot. 'get' is provided for symmetry but returns the same payload as 'bill_lookup' with operation='get' on the origin bill (the upstream /law endpoint mirrors /bill); prefer 'bill_lookup' as canonical for detail. The 'laws' array on the origin bill carries the public/private law citation (e.g. {"number":"118-2","type":"Public Law"}).`,
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
  output: z.object({}).passthrough().describe('Law data from Congress.gov API.'),
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
    return result;
  },
});
