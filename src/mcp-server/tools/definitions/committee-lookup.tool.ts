/**
 * @fileoverview Tool for browsing congressional committees and their activity.
 * @module mcp-server/tools/definitions/committee-lookup
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';

import { formatCommittees } from '@/mcp-server/tools/format-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import type { Chamber } from '@/services/congress-api/types.js';

export const committeeLookupTool = tool('congressgov_committee_lookup', {
  description: `Browse congressional committees and their legislation, reports, and nominations. Committee codes follow the pattern chamber-prefix (h/s/j) + abbreviation + number — use 'list' to discover codes, then 'get' or drill into 'bills', 'reports', or 'nominations' ('nominations' is Senate-only). The 'bills' sub-resource defaults to 'recent' order (newest update-date first); pass order='oldest' for ascending update-date order.`,
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
    order: z
      .enum(['recent', 'oldest'])
      .default('recent')
      .describe(
        "Sort order for the 'bills' sub-resource. 'recent' (default) returns newest update-date first; 'oldest' returns ascending update-date order. Ignored by other operations.",
      ),
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

    if (input.operation === 'bills' && input.order === 'recent') {
      return fetchCommitteeBillsRecent(
        {
          chamber: input.chamber,
          committeeCode: input.committeeCode,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
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

/**
 * Fetch committee bills in newest-first order.
 *
 * The Congress.gov API returns committee bills in ascending update-date order
 * and ignores sort parameters. To surface the most recent activity, we probe
 * the total count (limit=1), then fetch the tail of the list and reverse it
 * client-side. `offset` / `limit` on input refer to the reversed (recent)
 * view — offset=0 always returns the most recent page.
 */
async function fetchCommitteeBillsRecent(
  params: { chamber: Chamber; committeeCode: string; limit: number; offset: number },
  ctx: Context,
) {
  const api = getCongressApi();
  const probe = await api.getCommitteeSubResource(
    {
      chamber: params.chamber,
      committeeCode: params.committeeCode,
      subResource: 'bills',
      limit: 1,
      offset: 0,
    },
    ctx,
  );

  const total = probe.pagination.count;
  if (total === 0 || params.offset >= total) {
    return { data: [], pagination: { count: total, nextOffset: null } };
  }

  const absOffset = Math.max(0, total - params.offset - params.limit);
  const effectiveLimit = Math.min(params.limit, total - params.offset);

  const result = await api.getCommitteeSubResource(
    {
      chamber: params.chamber,
      committeeCode: params.committeeCode,
      subResource: 'bills',
      limit: effectiveLimit,
      offset: absOffset,
    },
    ctx,
  );

  const reversed = [...result.data].reverse();
  const nextOffset = params.offset + effectiveLimit < total ? params.offset + effectiveLimit : null;

  ctx.log.info('Committee bills retrieved (recent order)', {
    committeeCode: params.committeeCode,
    total,
    returned: reversed.length,
    offset: params.offset,
  });

  return {
    ...result,
    data: reversed,
    pagination: { count: total, nextOffset },
  };
}
