/**
 * @fileoverview Tool for browsing presidential nominations and the Senate confirmation pipeline.
 * @module mcp-server/tools/definitions/senate-nominations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const senateNominationsTool = tool('congressgov_senate_nominations', {
  description: `Browse presidential nominations to federal positions and track the Senate confirmation process.

Nominations use 'PN' (Presidential Nomination) numbering. A single nomination may contain multiple nominees — use 'nominees' to see individual appointees.

Partitioned nominations (e.g., PN230-1, PN230-2) occur when nominees within one nomination follow different confirmation paths.`,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    operation: z
      .enum(['list', 'get', 'nominees', 'actions', 'committees', 'hearings'])
      .describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number.'),
    nominationNumber: z
      .string()
      .optional()
      .describe("Nomination number (e.g., '1064'). Required for detail operations."),
    ordinal: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Position ordinal within a nomination (for multi-nominee nominations).'),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: z.object({}).passthrough().describe('Nomination data from Congress.gov API.'),

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listNominations({
        congress: input.congress,
        limit: input.limit,
        offset: input.offset,
      });
      ctx.log.info('Nominations listed', {
        congress: input.congress,
        count: result.data.length,
      });
      return result;
    }

    if (!input.nominationNumber) {
      throw new Error(
        `The '${input.operation}' operation requires nominationNumber. Use 'list' to browse nominations.`,
      );
    }

    if (input.operation === 'get' || input.operation === 'nominees') {
      const result = await api.getNomination(input.congress, input.nominationNumber);
      ctx.log.info('Nomination retrieved', {
        congress: input.congress,
        nominationNumber: input.nominationNumber,
      });
      return result;
    }

    const result = await api.getNominationSubResource({
      congress: input.congress,
      nominationNumber: input.nominationNumber,
      subResource: input.operation,
      limit: input.limit,
      offset: input.offset,
    });
    ctx.log.info('Nomination sub-resource retrieved', {
      congress: input.congress,
      nominationNumber: input.nominationNumber,
      subResource: input.operation,
    });
    return result;
  },
});
