/**
 * @fileoverview Tool for retrieving House roll call vote data and member voting positions.
 * @module mcp-server/tools/definitions/roll-votes
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { formatResult } from '@/mcp-server/tools/format-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const rollVotesTool = tool('congressgov_roll_votes', {
  description: `Retrieve House roll call vote data and individual member voting positions.

NOTE: Covers House votes only — Senate vote data is not yet in the Congress.gov API.

Use 'list' to find votes by congress and session, 'get' for vote details (question, result, associated bill), and 'members' for how each representative voted.`,
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
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: z.object({}).passthrough().describe('Vote data from Congress.gov API.'),
  format: formatResult,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listVotes({
        congress: input.congress,
        session: input.session,
        limit: input.limit,
        offset: input.offset,
      });
      ctx.log.info('Votes listed', { congress: input.congress, session: input.session });
      return result;
    }

    if (!input.voteNumber) {
      throw new Error(
        `The '${input.operation}' operation requires voteNumber. Use 'list' to browse available votes.`,
      );
    }

    const voteParams = {
      congress: input.congress,
      session: input.session,
      voteNumber: input.voteNumber,
    };

    const result =
      input.operation === 'members'
        ? await api.getVoteMembers(voteParams)
        : await api.getVote(voteParams);
    ctx.log.info('Vote retrieved', {
      ...voteParams,
      operation: input.operation,
    });
    return result;
  },
});
