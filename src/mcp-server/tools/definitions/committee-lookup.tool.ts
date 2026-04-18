/**
 * @fileoverview Tool for browsing congressional committees and their activity.
 * @module mcp-server/tools/definitions/committee-lookup
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { formatCommittees } from '@/mcp-server/tools/format-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const committeeLookupTool = tool('congressgov_committee_lookup', {
  description: `Browse congressional committees and their legislation, reports, and nominations. Committee codes follow the pattern chamber-prefix (h/s/j) + abbreviation + number — use 'list' to discover codes, then 'get' or drill into 'bills', 'reports', or 'nominations' ('nominations' is Senate-only). The committeeCode also works with the congress://committee/{committeeCode} resource.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    operation: z
      .enum(['list', 'get', 'bills', 'reports', 'nominations'])
      .describe('Which data to retrieve.'),
    congress: z.number().int().positive().optional().describe('Congress number.'),
    chamber: z
      .enum(['house', 'senate', 'joint'])
      .optional()
      .describe("Chamber filter. Required for 'get' and sub-resources."),
    committeeCode: z
      .string()
      .optional()
      .describe("Committee system code (e.g., 'hsju00'). Required for get and sub-resources."),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: z.object({}).passthrough().describe('Committee data from Congress.gov API.'),
  format: formatCommittees,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listCommittees(
        {
          congress: input.congress,
          chamber: input.chamber,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Committees listed', { count: result.data.length });
      return result;
    }

    if (!input.chamber || !input.committeeCode) {
      throw new Error(
        `The '${input.operation}' operation requires chamber and committeeCode. Use 'list' to discover available committees.`,
      );
    }

    if (input.operation === 'get') {
      const result = await api.getCommittee(input.chamber, input.committeeCode, ctx);
      ctx.log.info('Committee retrieved', { committeeCode: input.committeeCode });
      return result;
    }

    if (input.operation === 'nominations' && input.chamber !== 'senate') {
      throw new Error(
        "Nominations are only referred to Senate committees. Use chamber='senate' or a Senate committee code (s-prefix).",
      );
    }

    const result = await api.getCommitteeSubResource(
      {
        chamber: input.chamber,
        committeeCode: input.committeeCode,
        subResource: input.operation,
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );
    ctx.log.info('Committee sub-resource retrieved', {
      committeeCode: input.committeeCode,
      subResource: input.operation,
    });
    return result;
  },
});
