/**
 * @fileoverview Tool for browsing congressional committees and their activity.
 * @module mcp-server/tools/definitions/committee-lookup
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatCommittees } from '@/mcp-server/tools/format-helpers.js';
import {
  buildEffectiveQuery,
  congressErrorContracts,
  listEnrichment,
  listOrDetail,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import type { Chamber } from '@/services/congress-api/types.js';

/** Committee codes carry chamber in the first letter (h=House, s=Senate, j=Joint). */
function inferChamberFromCode(code: string): Chamber | undefined {
  const first = code[0]?.toLowerCase();
  if (first === 's') return 'senate';
  if (first === 'j') return 'joint';
  if (first === 'h') return 'house';
  return;
}

export const committeeLookupTool = tool('congressgov_committee_lookup', {
  description: `Browse congressional committees and their legislation, reports, and nominations. Committee codes follow the pattern chamber-prefix (h/s/j) + abbreviation + number — use 'list' to discover codes, then 'get' or drill into 'bills', 'reports', or 'nominations' ('nominations' is Senate-only). 'get' and sub-resources only need committeeCode (chamber is inferred from the prefix); pass chamber explicitly to override. The 'bills' sub-resource defaults to 'recent' order (newest update-date first); pass order='oldest' for ascending update-date order. Upstream omits bill titles from the 'bills' sub-resource — rows carry only {congress, billType, billNumber, actionDate, relationshipType, url}; chain 'congressgov_bill_lookup get' per row to retrieve titles and policy area.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: congressErrorContracts,
  input: z.object({
    operation: z
      .enum(['list', 'get', 'bills', 'reports', 'nominations'])
      .describe('Which data to retrieve.'),
    congress: z.number().int().positive().optional().describe('Congress number.'),
    chamber: z
      .enum(['house', 'senate', 'joint'])
      .optional()
      .describe(
        "Chamber filter for 'list', or override for 'get' and sub-resources (otherwise inferred from committeeCode prefix).",
      ),
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
  output: listOrDetail(
    'committee',
    'Committee record for `get` (name, chamber, subcommittees, history, sub-resource counts); absent for `list` and sub-resources.',
  ),
  enrichment: listEnrichment,
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
      ctx.enrich.echo(
        buildEffectiveQuery('committees', { congress: input.congress, chamber: input.chamber }),
      );
      ctx.enrich.total(result.pagination.count);
      if (result.data.length === 0)
        ctx.enrich.notice(
          'No committees found. Try removing the chamber filter or check the congress number.',
        );
      return result;
    }

    if (!input.committeeCode) {
      throw validationError(
        `The '${input.operation}' operation requires committeeCode. Use 'list' to discover available committees.`,
        { operation: input.operation, committeeCode: input.committeeCode },
      );
    }

    const chamber = input.chamber ?? inferChamberFromCode(input.committeeCode);
    if (!chamber) {
      throw validationError(
        `Could not infer chamber from committeeCode '${input.committeeCode}'. Pass chamber explicitly ('house', 'senate', or 'joint').`,
        { field: 'committeeCode', committeeCode: input.committeeCode },
      );
    }

    if (input.operation === 'get') {
      const result = await api.getCommittee(chamber, input.committeeCode, ctx);
      ctx.log.info('Committee retrieved', { committeeCode: input.committeeCode });
      ctx.enrich.echo(`committee ${input.committeeCode}`);
      ctx.enrich.total(1);
      return result;
    }

    if (input.operation === 'nominations' && chamber !== 'senate') {
      throw validationError(
        "Nominations are only referred to Senate committees. Use chamber='senate' or a Senate committee code (s-prefix).",
        { field: 'chamber', chamber },
      );
    }

    if (input.operation === 'bills' && input.order === 'recent') {
      const recentResult = await fetchCommitteeBillsRecent(
        {
          chamber,
          committeeCode: input.committeeCode,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.enrich.echo(`bills for committee ${input.committeeCode} (recent order)`);
      ctx.enrich.total(recentResult.pagination.count);
      if (recentResult.data.length === 0)
        ctx.enrich.notice(`No bills found for committee ${input.committeeCode}.`);
      return recentResult;
    }

    const result = await api.getCommitteeSubResource(
      {
        chamber,
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
    ctx.enrich.echo(`${input.operation} for committee ${input.committeeCode}`);
    ctx.enrich.total(result.pagination.count);
    if (result.data.length === 0)
      ctx.enrich.notice(`No ${input.operation} found for committee ${input.committeeCode}.`);
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
