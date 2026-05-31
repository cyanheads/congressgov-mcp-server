/**
 * @fileoverview Tool for retrieving House roll call vote data and member voting positions.
 * @module mcp-server/tools/definitions/roll-votes
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatVotes } from '@/mcp-server/tools/format-helpers.js';
import {
  buildEffectiveQuery,
  congressErrorContracts,
  listEnrichment,
  listOrDetail,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const rollVotesTool = tool('congressgov_roll_votes', {
  description: `Retrieve House roll call vote data and individual member voting positions — House-only, as Senate vote data is not yet in the Congress.gov API. Use 'list' to find votes by congress and session (defaults to most-recently-updated first), 'get' for vote details (question, result, associated bill), or 'members' for how each representative voted.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: congressErrorContracts,
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
        "Sort order for 'list', by vote update date. 'recent' (default) returns newest first; 'oldest' returns ascending. With 'recent', offset=0 always returns the strictly newest page. Ignored by 'get' and 'members'.",
      ),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: listOrDetail(
    'vote',
    'Vote record for `get` and `members` (question, result, party totals, member positions); absent for `list`.',
  ),
  enrichment: listEnrichment,
  format: formatVotes,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const effectiveQuery = buildEffectiveQuery('roll call votes', {
        congress: input.congress,
        session: input.session,
      });
      if (input.order === 'recent') {
        const recent = await fetchVotesRecent(
          {
            congress: input.congress,
            session: input.session,
            limit: input.limit,
            offset: input.offset,
          },
          ctx,
        );
        ctx.enrich.echo(effectiveQuery);
        ctx.enrich.total(recent.pagination.count);
        if (recent.data.length === 0)
          ctx.enrich.notice('No votes found. Verify the congress and session numbers.');
        return recent;
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
      ctx.enrich.echo(effectiveQuery);
      ctx.enrich.total(result.pagination.count);
      if (result.data.length === 0)
        ctx.enrich.notice('No votes found. Verify the congress and session numbers.');
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

    if (input.operation === 'members') {
      const membersResult = await api.getVoteMembers(
        { ...voteParams, limit: input.limit, offset: input.offset },
        ctx,
      );
      ctx.log.info('Vote retrieved', { ...voteParams, operation: input.operation });
      ctx.enrich.echo(
        `member votes for roll ${input.voteNumber} in the ${input.congress}th Congress, session ${input.session}`,
      );
      ctx.enrich.total(membersResult.pagination.count);
      if (membersResult.data.length === 0)
        ctx.enrich.notice(`No member vote records found for roll ${input.voteNumber}.`);
      return membersResult;
    }

    const result = await api.getVote(voteParams, ctx);
    ctx.log.info('Vote retrieved', { ...voteParams, operation: input.operation });
    ctx.enrich.echo(
      `roll call ${input.voteNumber} in the ${input.congress}th Congress, session ${input.session}`,
    );
    ctx.enrich.total(1);
    return result;
  },
});

/**
 * Fetch roll call votes in strict newest-first order. The /house-vote/{c}/{s}
 * endpoint returns rows in opaque insertion order (loosely correlated with roll
 * number but not with updateDate — late-edited votes break the sequence), and
 * ignores sort params. Fetch the full session, sort by updateDate desc, then
 * slice the requested page. Typical sessions are 200-750 votes; at PAGE_SIZE=250
 * that's 1-3 upstream requests per call, dispatched in parallel after the first.
 */
async function fetchVotesRecent(
  params: { congress: number; session: number; limit: number; offset: number },
  ctx: Context,
) {
  const api = getCongressApi();
  const PAGE_SIZE = 250;
  const first = await api.listVotes(
    { congress: params.congress, session: params.session, limit: PAGE_SIZE, offset: 0 },
    ctx,
  );
  const total = first.pagination.count;
  if (total === 0 || params.offset >= total) {
    return { data: [], pagination: { count: total, nextOffset: null } };
  }

  const remainingPages = Math.ceil(total / PAGE_SIZE) - 1;
  const pages = await Promise.all(
    Array.from({ length: remainingPages }, (_, i) =>
      api.listVotes(
        {
          congress: params.congress,
          session: params.session,
          limit: PAGE_SIZE,
          offset: (i + 1) * PAGE_SIZE,
        },
        ctx,
      ),
    ),
  );
  const all = [...first.data, ...pages.flatMap((p) => p.data)];

  all.sort((a, b) => {
    const ad = (a as { updateDate?: string }).updateDate ?? '';
    const bd = (b as { updateDate?: string }).updateDate ?? '';
    return bd.localeCompare(ad);
  });

  const slice = all.slice(params.offset, params.offset + params.limit);
  const nextOffset =
    params.offset + slice.length < all.length ? params.offset + slice.length : null;
  ctx.log.info('Votes listed (recent order, strict)', {
    congress: params.congress,
    session: params.session,
    total: all.length,
    returned: slice.length,
    offset: params.offset,
    upstreamRequests: 1 + remainingPages,
  });
  return { ...first, data: slice, pagination: { count: all.length, nextOffset } };
}
