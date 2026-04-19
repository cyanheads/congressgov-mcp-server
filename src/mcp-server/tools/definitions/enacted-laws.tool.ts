/**
 * @fileoverview Tool for browsing enacted public and private laws from Congress.gov.
 * @module mcp-server/tools/definitions/enacted-laws
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { formatLaws } from '@/mcp-server/tools/format-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const enactedLawsTool = tool('congressgov_enacted_laws', {
  description: `Browse enacted public and private laws from Congress.gov. Use 'list' to browse laws by congress, or 'get' for a specific law's full detail. Each law references its origin bill for the full legislative history. Law types: pub: Public laws (general application, most common); priv: Private laws (specific individuals or entities)`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    operation: z.enum(['list', 'get']).describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number.'),
    lawType: z.enum(['pub', 'priv']).optional().describe("Law type. Required for 'get'."),
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
      throw new Error("The 'get' operation requires lawType ('pub' or 'priv') and lawNumber.");
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
