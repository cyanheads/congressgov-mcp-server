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
  congressErrorContracts,
  identityErrorContracts,
  listEnrichment,
  listOrDetail,
  normalizeOptionalString,
  notifyIfNoMatches,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import {
  SENATE_VOTE_COVERAGE,
  SENATE_VOTE_FIRST_CONGRESS,
  senateSessionForDate,
} from '@/services/senate-lis/parse.js';

type UpstreamRecord = Record<string, unknown>;

/**
 * An action's citation of its own Senate record vote: `Record Vote Number: 225.`,
 * `Record Vote No: 20.`, with `EX.` before or after the number (`No: EX. 3.`,
 * `No: 309EX.`, `No: 104 EX.`). The colon is what separates it from a back-reference
 * to another action's vote — `(Record Vote No. 318)`, `(Roll Call Vote No. 318)` —
 * which never carries one. Linear: no nested quantifier and no unanchored `.*`.
 */
const OWN_VOTE_CITATION = /Record Vote (?:Number|No): ?(?:EX\. ?)?(\d+)/;

const rollVoteSchema = z
  .object({
    chamber: z
      .literal('senate')
      .describe(
        "Always 'senate'. Pass it: congressgov_roll_votes defaults to 'house', whose vote with the same number is a different vote.",
      ),
    congress: z.number().int().positive().describe('Congress the vote was cast in.'),
    session: z
      .number()
      .int()
      .min(1)
      .max(2)
      .describe(
        "Session the vote was cast in, from the action date: the congress's first year is session 1; its second year, and January 1–3 of the year after, session 2.",
      ),
    voteNumber: z.number().int().positive().describe('Senate roll call number the action cites.'),
  })
  .describe(
    `Arguments for congressgov_roll_votes that retrieve the Senate roll call vote this action cites as its own. Absent when the action cites no vote of its own (a back-reference such as "(Record Vote No. 318)" names another action's vote), and for votes before the feed starts — ${SENATE_VOTE_COVERAGE}.`,
  );

type RollVote = z.infer<typeof rollVoteSchema>;

const latestActionSchema = z
  .object({ rollVote: rollVoteSchema.optional() })
  .passthrough()
  .nullable()
  .optional()
  .describe(
    'Most recent action (`actionDate`, `text`), with `rollVote` when its text cites its own Senate record vote. Null or absent on a multi-part parent (e.g. PN730).',
  );

const NOMINATION_RECORD_DESCRIPTION =
  'Nomination record for `get` (description, dates, nominees array, sub-resource counts); absent for `list` and sub-resources.';

const nominationListOutput = listOrDetail({ nomination: 'record' }, NOMINATION_RECORD_DESCRIPTION);

/** Zod types a description as optional; `listOrDetail` sets one on every envelope it builds. */
const envelopeDescription = nominationListOutput.description;
if (envelopeDescription === undefined) {
  throw new Error('listOrDetail built an envelope with no root description.');
}

/**
 * The shared list/detail envelope with the two roots that can carry a `rollVote`
 * declared. Zod keeps a description per schema instance, so the extended root
 * re-applies the envelope's.
 */
const nominationOutput = nominationListOutput
  .extend({
    data: z
      .array(
        z
          .object({
            latestAction: latestActionSchema,
            rollVote: rollVoteSchema.optional(),
          })
          .passthrough()
          .describe(
            "Upstream JSON record: a nomination (`list`), an action (`actions`), a committee, a hearing, or a nominee. A `list` row's `latestAction` and an `actions` row carry `rollVote` when they cite their own Senate record vote.",
          ),
      )
      .optional()
      .describe('Result rows for `list` and the sub-resource operations.'),
    nomination: z
      .object({ latestAction: latestActionSchema })
      .passthrough()
      .optional()
      .describe(NOMINATION_RECORD_DESCRIPTION),
  })
  .describe(envelopeDescription);

/**
 * The `congressgov_roll_votes` arguments for the Senate vote an action cites as its
 * own, or `undefined` when it cites none, its date falls outside `congress`, or the
 * vote predates the Senate feed.
 */
export function citedRollVote(action: unknown, congress: number): RollVote | undefined {
  if (congress < SENATE_VOTE_FIRST_CONGRESS || !action || typeof action !== 'object') return;
  const { actionDate, text } = action as UpstreamRecord;
  if (typeof actionDate !== 'string' || typeof text !== 'string') return;
  const voteNumber = Number(OWN_VOTE_CITATION.exec(text)?.[1]);
  if (!Number.isSafeInteger(voteNumber) || voteNumber < 1) return;
  const session = senateSessionForDate(congress, actionDate);
  if (session === undefined) return;
  return { chamber: 'senate', congress, session, voteNumber };
}

/** `record`, with `rollVote` on its `latestAction` when that action cites its own Senate vote. */
function withLatestActionRollVote(record: UpstreamRecord, congress: number): UpstreamRecord {
  const rollVote = citedRollVote(record.latestAction, congress);
  if (!rollVote) return record;
  return { ...record, latestAction: { ...(record.latestAction as UpstreamRecord), rollVote } };
}

/** An `actions` row, with `rollVote` when it cites its own Senate vote. */
function withRollVote(action: UpstreamRecord, congress: number): UpstreamRecord {
  const rollVote = citedRollVote(action, congress);
  return rollVote ? { ...action, rollVote } : action;
}

export const senateNominationsTool = tool('congressgov_senate_nominations', {
  title: 'Congress.gov Senate Nominations',
  description: `Browse presidential nominations to federal positions and track the Senate confirmation process. Use 'list' to browse, 'get' for nomination detail, 'actions'/'committees'/'hearings' for confirmation pipeline data, or 'nominees' to retrieve individual appointees in a multi-nominee batch. Nominations use 'PN' (Presidential Nomination) numbering. Most nominations carry confirmation activity on the parent (e.g., PN1000); multi-part parents (e.g., PN851) carry no activity of their own — their actions, committees, hearings, and nominees live on partitioned children (PN851-1, PN851-2, …). 'get' on a parent that has no \`nominees\` array signals the partitioned form is needed for everything below it. An action that cites its own Senate record vote — an \`actions\` row, or \`latestAction\` on \`list\` and \`get\` — carries \`rollVote\`, the congressgov_roll_votes arguments for that vote.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [...congressErrorContracts, ...identityErrorContracts],
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
  output: nominationOutput,
  enrichment: listEnrichment,
  format: formatNominations,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      if (normalizeOptionalString(input.nominationNumber)) {
        throw ctx.fail(
          'incompatible_identity',
          "'list' does not use nominationNumber. Remove nominationNumber to browse, or use 'get' with congress and nominationNumber.",
          { field: 'nominationNumber', operation: input.operation },
        );
      }
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
      notifyIfNoMatches(
        ctx,
        result,
        'No nominations found for this congress. Verify the congress number.',
      );
      return {
        ...result,
        data: result.data.map((row) => withLatestActionRollVote(row, input.congress)),
      };
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
      return { ...result, nomination: withLatestActionRollVote(result.nomination, input.congress) };
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
    if (input.operation !== 'actions') return result;
    return { ...result, data: result.data.map((row) => withRollVote(row, input.congress)) };
  },
});

/**
 * Sub-resource calls (actions/committees/hearings/nominees) against a bare
 * parent number (e.g. '851') silently return 0 results when the nomination is
 * a multi-part parent — those sub-resources live on the partitioned children.
 * Emits an enrichment notice so agents know to try the partitioned form.
 *
 * Only when the sub-resource is genuinely empty: an empty page of a non-empty
 * sub-resource means the offset ran past the end, and the partitioned form would
 * not help there.
 */
function applyParentFormNotice(
  ctx: Context,
  result: { data: unknown[]; pagination: { count: number } },
  nominationNumber: string,
): void {
  if (nominationNumber.includes('-')) return;
  notifyIfNoMatches(
    ctx,
    result,
    `If \`${nominationNumber}\` is a multi-part parent, its actions/committees/hearings/nominees live on the partitioned children. Try \`${nominationNumber}-1\` (and -2, -3, …) instead.`,
  );
}
