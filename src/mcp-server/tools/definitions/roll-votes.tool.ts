/**
 * @fileoverview Tool for retrieving House roll call vote data and member voting positions.
 * @module mcp-server/tools/definitions/roll-votes
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatVotes } from '@/mcp-server/tools/format-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const rollVotesTool = tool('congressgov_roll_votes', {
  description: `Retrieve House roll call vote data and individual member voting positions — House-only, as Senate vote data is not yet in the Congress.gov API. Use 'list' to find votes by congress and session (defaults to most-recently-updated first), 'get' for vote details (question, result, associated bill), or 'members' for how each representative voted.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    operation: z.enum(['list', 'get', 'members']).describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number.'),
    session: z
      .number()
      .int()
      .min(1)
      .max(2)
      .describe('Session number (1 or 2). Odd years are session 1, even years session 2.'),
    voteNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Roll call vote number. Required for 'get' and 'members'."),
    order: z
      .enum(['recent', 'oldest'])
      .default('recent')
      .describe(
        "Sort order for 'list' (sorts by update date). 'recent' (default) is newest first; 'oldest' is ascending. The upstream API ignores sort params on this endpoint, so 'recent' is implemented client-side by fetching the tail and reversing. Ignored by 'get' and 'members'.",
      ),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: z.object({}).passthrough().describe('Vote data from Congress.gov API.'),
  format: formatVotes,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      if (input.order === 'recent') {
        return fetchVotesRecent(
          {
            congress: input.congress,
            session: input.session,
            limit: input.limit,
            offset: input.offset,
          },
          ctx,
        );
      }
      const result = await api.listVotes(
        {
          congress: input.congress,
          session: input.session,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Votes listed', { congress: input.congress, session: input.session });
      return result;
    }

    if (!input.voteNumber) {
      throw validationError(
        `The '${input.operation}' operation requires voteNumber. Use 'list' to browse available votes.`,
        { field: 'voteNumber', operation: input.operation },
      );
    }

    const voteParams = {
      congress: input.congress,
      session: input.session,
      voteNumber: input.voteNumber,
    };

    const result =
      input.operation === 'members'
        ? await api.getVoteMembers({ ...voteParams, limit: input.limit, offset: input.offset }, ctx)
        : await api.getVote(voteParams, ctx);
    ctx.log.info('Vote retrieved', {
      ...voteParams,
      operation: input.operation,
    });
    return result;
  },
});

/**
 * Fetch roll call votes in newest-first order. The /house-vote/{c}/{s} endpoint
 * returns rows in an opaque order and ignores sort params, so probe the total
 * count, fetch the tail, and reverse client-side. `offset` is interpreted in
 * the reversed (recent) view — offset=0 always returns the most recent page.
 */
async function fetchVotesRecent(
  params: { congress: number; session: number; limit: number; offset: number },
  ctx: Context,
) {
  const api = getCongressApi();
  const probe = await api.listVotes(
    { congress: params.congress, session: params.session, limit: 1, offset: 0 },
    ctx,
  );
  const total = probe.pagination.count;
  if (total === 0 || params.offset >= total) {
    return { data: [], pagination: { count: total, nextOffset: null } };
  }
  const absOffset = Math.max(0, total - params.offset - params.limit);
  const effectiveLimit = Math.min(params.limit, total - params.offset);
  const result = await api.listVotes(
    {
      congress: params.congress,
      session: params.session,
      limit: effectiveLimit,
      offset: absOffset,
    },
    ctx,
  );
  const reversed = [...result.data].reverse();
  const nextOffset = params.offset + effectiveLimit < total ? params.offset + effectiveLimit : null;
  ctx.log.info('Votes listed (recent order)', {
    congress: params.congress,
    session: params.session,
    total,
    returned: reversed.length,
    offset: params.offset,
  });
  return { ...result, data: reversed, pagination: { count: total, nextOffset } };
}
