/**
 * @fileoverview Tool for browsing presidential nominations and the Senate confirmation pipeline.
 * @module mcp-server/tools/definitions/senate-nominations
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { formatNominations } from '@/mcp-server/tools/format-helpers.js';
import {
  buildEffectiveQuery,
  listEnrichment,
  listOrDetail,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const senateNominationsTool = tool('congressgov_senate_nominations', {
  description: `Browse presidential nominations to federal positions and track the Senate confirmation process. Use 'list' to browse, 'get' for nomination detail, 'actions'/'committees'/'hearings' for confirmation pipeline data, or 'nominees' to retrieve individual appointees in a multi-nominee batch. Nominations use 'PN' (Presidential Nomination) numbering. Most nominations carry confirmation activity on the parent (e.g., PN1000); multi-part parents (e.g., PN851) carry no activity of their own — their actions, committees, hearings, and nominees live on partitioned children (PN851-1, PN851-2, …). 'get' on a parent that has no \`nominees\` array signals the partitioned form is needed for everything below it.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    operation: z
      .enum(['list', 'get', 'nominees', 'actions', 'committees', 'hearings'])
      .describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number.'),
    nominationNumber: z
      .string()
      .optional()
      .describe(
        "Nomination number. Use the bare form (e.g. '1000') for nominations whose activity sits on the parent; use the partitioned form (e.g. '851-1') for sub-resources of a multi-part nomination. Required for detail operations.",
      ),
    ordinal: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Batch ordinal within a multi-nominee nomination. Each ordinal addresses a group of nominees; the 'nominees' operation returns every individual in that batch. Use 'get' first to see available ordinals on the nomination's `nominees` array (multi-part parents have no nominees array — use a partitioned form like '851-1' instead).",
      ),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: listOrDetail(
    'nomination',
    'Nomination record for `get` (description, dates, nominees array, sub-resource counts); absent for `list` and sub-resources.',
  ),
  enrichment: listEnrichment,
  format: formatNominations,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listNominations(
        {
          congress: input.congress,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Nominations listed', {
        congress: input.congress,
        count: result.data.length,
      });
      ctx.enrich.echo(buildEffectiveQuery('nominations', { congress: input.congress }));
      ctx.enrich.total(result.pagination.count);
      if (result.data.length === 0)
        ctx.enrich.notice('No nominations found for this congress. Verify the congress number.');
      return result;
    }

    if (!input.nominationNumber) {
      throw validationError(
        `The '${input.operation}' operation requires nominationNumber. Use 'list' to browse nominations.`,
        { field: 'nominationNumber', operation: input.operation },
      );
    }

    if (input.operation === 'get') {
      const result = await api.getNomination(input.congress, input.nominationNumber, ctx);
      ctx.log.info('Nomination retrieved', {
        congress: input.congress,
        nominationNumber: input.nominationNumber,
      });
      ctx.enrich.echo(`nomination PN${input.nominationNumber} in the ${input.congress}th Congress`);
      ctx.enrich.total(1);
      return result;
    }

    if (input.operation === 'nominees') {
      if (!input.ordinal) {
        throw validationError(
          "The 'nominees' operation requires 'ordinal' — the position number within the nomination. Use 'get' first to see available ordinals in the nominees array.",
          { field: 'ordinal' },
        );
      }
      const result = await api.getNominee(
        input.congress,
        input.nominationNumber,
        input.ordinal,
        {
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Nominee retrieved', {
        congress: input.congress,
        nominationNumber: input.nominationNumber,
        ordinal: input.ordinal,
      });
      ctx.enrich.echo(
        `nominees for nomination ${input.nominationNumber}, ordinal ${input.ordinal}`,
      );
      ctx.enrich.total(result.pagination.count);
      applyParentFormNotice(ctx, result, input.nominationNumber);
      return result;
    }

    const result = await api.getNominationSubResource(
      {
        congress: input.congress,
        nominationNumber: input.nominationNumber,
        subResource: input.operation,
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );
    ctx.log.info('Nomination sub-resource retrieved', {
      congress: input.congress,
      nominationNumber: input.nominationNumber,
      subResource: input.operation,
    });
    ctx.enrich.echo(`${input.operation} for nomination ${input.nominationNumber}`);
    ctx.enrich.total(result.pagination.count);
    applyParentFormNotice(ctx, result, input.nominationNumber);
    return result;
  },
});

/**
 * Sub-resource calls (actions/committees/hearings/nominees) against a bare
 * parent number (e.g. '851') silently return 0 results when the nomination is
 * a multi-part parent — those sub-resources live on the partitioned children.
 * Emits an enrichment notice so agents know to try the partitioned form.
 */
function applyParentFormNotice(
  ctx: Context,
  result: { data: unknown[] },
  nominationNumber: string,
): void {
  if (result.data.length > 0 || nominationNumber.includes('-')) return;
  ctx.enrich.notice(
    `If \`${nominationNumber}\` is a multi-part parent, its actions/committees/hearings/nominees live on the partitioned children. Try \`${nominationNumber}-1\` (and -2, -3, …) instead.`,
  );
}
