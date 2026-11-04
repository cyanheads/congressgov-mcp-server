/**
 * @fileoverview Tool for retrieving House and Senate roll call vote data and member
 * voting positions. House votes come from the Congress.gov API; Senate votes from the
 * Senate's official LIS XML feed (the API exposes no Senate vote namespace), or from
 * Voteview's published files when that feed can't be read.
 * @module mcp-server/tools/definitions/roll-votes
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatVotes } from '@/mcp-server/tools/format-helpers.js';
import {
  HOUSE_VOTE_COVERAGE,
  HOUSE_VOTE_FIRST_CONGRESS,
} from '@/mcp-server/tools/roll-vote-pointer.js';
import {
  addNotice,
  buildEffectiveQuery,
  congressErrorContracts,
  identityErrorContracts,
  listEnrichment,
  listOrDetail,
  normalizeOptionalString,
  noticeIgnoredInputs,
  notifyIfNoMatches,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { SENATE_VOTE_COVERAGE } from '@/services/senate-lis/parse.js';
import { getSenateVoteService } from '@/services/senate-lis/senate-vote-service.js';
import type { SenateVoteSource } from '@/services/senate-lis/types.js';
import { currentCongressNumber, ordinal } from '@/utils/congress-calendar.js';

const ChamberEnum = z.preprocess(
  (value) => (typeof value === 'string' ? value.toLowerCase() : value),
  z.enum(['house', 'senate']),
);

/**
 * An optional `members` filter matching `pattern`. A form-based client submits a
 * blank instead of omitting the field, so '' is accepted and read as unset.
 */
function memberFilterField(pattern: RegExp, valueDescription: string, description: string) {
  return z
    .union([z.literal(''), z.string().regex(pattern).describe(valueDescription)])
    .optional()
    .describe(description);
}

const MEMBER_FILTER_FIELDS = ['bioguideId', 'stateCode', 'party'] as const;
type MemberFilterField = (typeof MEMBER_FILTER_FIELDS)[number];

/** The `members` filters a call supplied, uppercased — roster codes are uppercase. */
type MemberFilter = Partial<Record<MemberFilterField, string>>;

/** The roster field each filter reads, per chamber: Senate LIS rows carry no bioguide ID. */
const ROSTER_FIELDS = {
  house: { bioguideId: 'bioguideId', stateCode: 'voteState', party: 'voteParty' },
  senate: { stateCode: 'state', party: 'party' },
} as const satisfies Record<'house' | 'senate', MemberFilter>;

/**
 * Both services fetch a vote's whole roster in one request and page it client-side,
 * so a filtered call asks them for one page holding all of it and pages the matches.
 */
const WHOLE_ROSTER = { limit: Number.MAX_SAFE_INTEGER, offset: 0 };

const HOUSE_NO_VOTES_NOTICE = `No votes found. Verify the congress and session numbers — ${HOUSE_VOTE_COVERAGE}.`;

const HOUSE_CLERK_VOTE_HINT =
  "Find a bill action that records the vote with congressgov_bill_lookup 'actions': its recordedVotes entry carries the House Clerk's vote XML URL (clerk.house.gov/evs/{year}/roll{number}.xml), which holds the question, result, and each member's position.";

/**
 * Where a Senate response came from when Voteview answered for the LIS feed —
 * an enrichment field, so it reaches `structuredContent` and `content[]` alike.
 */
const senateSourceSchema = z
  .object({
    name: z.literal('Voteview').describe('The source that answered: Voteview (UCLA).'),
    url: z.string().describe("Voteview's home page."),
    congress: z.number().int().positive().describe('Congress the latest vote belongs to.'),
    latestVote: z
      .object({
        session: z.number().int().describe('Session of the latest vote.'),
        voteNumber: z.number().int().describe('Roll call number of the latest vote.'),
        date: z.string().describe('Date of the latest vote, YYYY-MM-DD.'),
      })
      .describe(
        "Voteview's newest Senate roll call for this congress. Voteview adds votes after the Senate takes them, so a later vote is not found until it does.",
      ),
    citation: z.string().describe('The citation Voteview asks its users to give.'),
  })
  .optional()
  .describe(
    "Present only on Senate calls the Senate's LIS feed could not answer (senate.gov refusing automated requests, or the feed unavailable), which Voteview's published vote files answered instead. Absent when the LIS feed answered.",
  );

/** Only a congress still sitting can gain votes, so only its line says later ones are missing. */
function renderSenateSource(source: SenateVoteSource | undefined): string {
  if (!source) return '';
  const { latestVote } = source;
  const later = source.congress >= currentCongressNumber() ? '; later votes are not in it yet' : '';
  return `**Source:** Voteview (${source.url}) answered for the Senate's LIS feed, which could not be read. Its latest Senate vote for the ${ordinal(source.congress)} Congress is session ${latestVote.session} vote ${latestVote.voteNumber} (${latestVote.date})${later}. Cite as: ${source.citation}`;
}

const VOTE_RECORD_DESCRIPTION =
  'Vote record for `get` and `members` (question, result, party totals, member positions); absent for `list`.';

const rollVotesOutput = listOrDetail({ vote: 'record' }, VOTE_RECORD_DESCRIPTION, {
  memberFilter: z
    .object({
      bioguideId: z.string().optional().describe('The bioguideId filter, uppercased.'),
      stateCode: z.string().optional().describe('The stateCode filter, uppercased.'),
      party: z.string().optional().describe('The party filter, uppercased.'),
      rosterCount: z
        .number()
        .int()
        .nonnegative()
        .describe(
          'Member positions the vote records before filtering. pagination.count counts the ones the filters match.',
        ),
    })
    .optional()
    .describe(
      "The filters a 'members' call applied to the vote's roster — a position is returned only when it matches every one. Absent when the call supplied none.",
    ),
});

export const rollVotesTool = tool('congressgov_roll_votes', {
  title: 'Congress.gov Roll Votes',
  description: `Retrieve U.S. congressional roll call votes and individual member voting positions for either chamber. Set 'chamber' to 'house' (default, from the Congress.gov API — ${HOUSE_VOTE_COVERAGE}) or 'senate' (from the Senate's official LIS feed — ${SENATE_VOTE_COVERAGE}). When the LIS feed can't be read (senate.gov refuses automated requests), Senate calls are answered from Voteview's published vote files instead, and 'source' names Voteview and its latest vote; a later vote is not found until Voteview adds it. Use 'list' to find votes by congress and session (newest first by default), 'get' for vote details (question, result, tallies, party breakdown, associated bill/nomination/amendment), or 'members' for how each member voted. 'members' narrows the roster by bioguideId (House only), stateCode, and party before paging, so one member's or one delegation's position takes one call. A bill action that records a roll call carries rollVote in congressgov_bill_lookup 'actions' — pass its chamber, congress, session, and voteNumber here. A House vote on an amendment carries amendmentType and amendmentNumber; pass them, with congress, to congressgov_amendment_lookup for the amendment's sponsor, actions, cosponsors, and text.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
    ...congressErrorContracts,
    ...identityErrorContracts,
    {
      code: JsonRpcErrorCode.ValidationError,
      reason: 'unsupported_filter',
      retryable: false,
      when: "A Senate 'members' call filters by bioguideId — the Senate's LIS roll call feed identifies senators by its own member IDs, never by bioguide ID.",
      recovery:
        "Filter the Senate roster by stateCode (a state's two senators), optionally with party, and find the senator by name in the rows returned.",
    },
  ],
  input: z.object({
    operation: z.enum(['list', 'get', 'members']).describe('Which data to retrieve.'),
    /** `prefault`, not `default`: the advertised input schema drops a `default` over a preprocess. */
    chamber: ChamberEnum.prefault('house').describe(
      "Chamber whose votes to query, in any letter case. 'house' (default) draws from the Congress.gov API; 'senate' draws from the Senate's official LIS roll-call feed, or from Voteview's published vote files when that feed can't be read. Roll call numbers reset each session and are specific to one chamber.",
    ),
    congress: z.number().int().positive().describe('Congress number.'),
    session: z
      .number()
      .int()
      .min(1)
      .max(2)
      .describe(
        "Session number (1 or 2). A congress's first year is session 1 and its second year session 2; a second session can run into January 1–3 of the following year (the 116th Congress's second session voted on 2021-01-01).",
      ),
    voteNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Roll call vote number. Required for 'get' and 'members'."),
    bioguideId: memberFilterField(
      /^[A-Za-z]\d{6}$/,
      'A bioguide ID: one letter and six digits.',
      "For 'members' on a House vote: return only the position of the member with this bioguide ID (e.g. 'J000298', as congressgov_member_lookup returns it), in any letter case. The Senate's LIS feed identifies senators by its own IDs, so a Senate 'members' call rejects it — filter by stateCode instead. Ignored by 'list' and 'get'.",
    ),
    stateCode: memberFilterField(
      /^[A-Za-z]{2}$/,
      'A two-letter state or territory code.',
      "For 'members': return only the positions of one state's or territory's members, by two-letter code (e.g. 'WA'), in any letter case. Ignored by 'list' and 'get'.",
    ),
    party: memberFilterField(
      /^[A-Za-z]{1,2}$/,
      'A one- or two-letter party code.',
      "For 'members': return only the positions of one party, by the code the roster carries (e.g. 'D', 'R', 'I'), in any letter case. Combined filters must all match; they apply before limit and offset, and pagination.count counts the matching positions. Ignored by 'list' and 'get'.",
    ),
    order: z
      .enum(['recent', 'oldest'])
      .default('recent')
      .describe(
        "Sort order for 'list'. 'recent' (default) returns newest first; 'oldest' returns ascending. House sorts by vote update date (with 'recent', offset=0 always returns the strictly newest page); Senate sorts by roll call number. Ignored by 'get' and 'members'.",
      ),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: rollVotesOutput,
  enrichment: { ...listEnrichment, source: senateSourceSchema },
  enrichmentTrailer: { source: { render: renderSenateSource } },
  format: formatVotes,

  async handler(input, ctx) {
    if (input.operation === 'list' && input.voteNumber !== undefined) {
      throw ctx.fail(
        'incompatible_identity',
        "'list' does not use voteNumber. Remove voteNumber to browse, or use 'get' or 'members' with congress, session, and voteNumber.",
        { field: 'voteNumber', operation: input.operation },
      );
    }
    const memberFilter = memberFilterOf(input);
    if (input.operation !== 'members') {
      noticeIgnoredInputs(ctx, input.operation, {
        bioguideId: input.bioguideId,
        stateCode: input.stateCode,
        party: input.party,
      });
    } else if (input.chamber === 'senate' && memberFilter?.bioguideId) {
      throw ctx.fail(
        'unsupported_filter',
        "bioguideId cannot filter a Senate roll call roster: the Senate's LIS feed identifies senators by its own member IDs. Filter by stateCode (a state's two senators), optionally with party, instead.",
        { field: 'bioguideId', chamber: input.chamber },
      );
    }
    if (input.chamber === 'senate') {
      return handleSenateVotes(input, memberFilter, ctx);
    }

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
        notifyIfNoMatches(ctx, recent, HOUSE_NO_VOTES_NOTICE);
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
      notifyIfNoMatches(ctx, result, HOUSE_NO_VOTES_NOTICE);
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

    /** Congress.gov holds no earlier House vote; asking would only return its generic 404. */
    if (input.congress < HOUSE_VOTE_FIRST_CONGRESS) {
      throw ctx.fail(
        'not_found',
        `House roll call vote ${input.voteNumber} of the ${ordinal(input.congress)} Congress, session ${input.session} is not on Congress.gov: ${HOUSE_VOTE_COVERAGE}. A bill action that records the vote carries the House Clerk's vote XML in its recordedVotes entry.`,
        { ...voteParams, recovery: { hint: HOUSE_CLERK_VOTE_HINT } },
      );
    }

    if (input.operation === 'members') {
      const membersResult = memberFilter
        ? applyMemberFilter(
            await api.getVoteMembers({ ...voteParams, ...WHOLE_ROSTER }, ctx),
            memberFilter,
            ROSTER_FIELDS.house,
            input,
          )
        : await api.getVoteMembers(
            { ...voteParams, limit: input.limit, offset: input.offset },
            ctx,
          );
      ctx.log.info('Vote retrieved', { ...voteParams, operation: input.operation });
      ctx.enrich.echo(
        buildEffectiveQuery(
          `member votes for roll ${input.voteNumber} in the ${ordinal(input.congress)} Congress, session ${input.session}`,
          memberFilter,
        ),
      );
      ctx.enrich.total(membersResult.pagination.count);
      notifyNoPositions(ctx, membersResult, `roll ${input.voteNumber}`);
      return membersResult;
    }

    const result = await api.getVote(voteParams, ctx);
    ctx.log.info('Vote retrieved', { ...voteParams, operation: input.operation });
    ctx.enrich.echo(
      `roll call ${input.voteNumber} in the ${ordinal(input.congress)} Congress, session ${input.session}`,
    );
    ctx.enrich.total(1);
    return result;
  },
});

type SenateVoteInput = {
  operation: 'list' | 'get' | 'members';
  congress: number;
  session: number;
  voteNumber?: number | undefined;
  order: 'recent' | 'oldest';
  limit: number;
  offset: number;
};

/**
 * Move the `source` a Senate result carries when Voteview answered into the
 * call's enrichment, which renders it on both surfaces. An LIS result has none
 * and passes through unchanged.
 */
function discloseSource<R extends { source?: SenateVoteSource }>(
  ctx: Context,
  { source, ...result }: R,
): Omit<R, 'source'> {
  if (source) ctx.enrich({ source });
  return result;
}

/**
 * Senate branch of `congressgov_roll_votes`. Mirrors the House operation surface
 * (`list` / `get` / `members`) but sources data from the Senate LIS XML feed via
 * `SenateVoteService` — or from Voteview, when the feed can't be read. The feed
 * serves a whole session's menu in one file and each vote's roster inline, so
 * pagination is client-side (handled in the service).
 */
async function handleSenateVotes(
  input: SenateVoteInput,
  memberFilter: MemberFilter | undefined,
  ctx: Context,
) {
  const senate = getSenateVoteService();

  if (input.operation === 'list') {
    const result = discloseSource(
      ctx,
      await senate.listVotes(
        {
          congress: input.congress,
          session: input.session,
          order: input.order,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      ),
    );
    ctx.log.info('Senate votes listed', { congress: input.congress, session: input.session });
    ctx.enrich.echo(
      buildEffectiveQuery('Senate roll call votes', {
        congress: input.congress,
        session: input.session,
      }),
    );
    ctx.enrich.total(result.pagination.count);
    notifyIfNoMatches(
      ctx,
      result,
      `No Senate votes found. Verify the congress and session — ${SENATE_VOTE_COVERAGE}.`,
    );
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
    const result = memberFilter
      ? applyMemberFilter(
          discloseSource(ctx, await senate.getVoteMembers({ ...voteParams, ...WHOLE_ROSTER }, ctx)),
          memberFilter,
          ROSTER_FIELDS.senate,
          input,
        )
      : discloseSource(
          ctx,
          await senate.getVoteMembers(
            { ...voteParams, limit: input.limit, offset: input.offset },
            ctx,
          ),
        );
    ctx.log.info('Senate vote retrieved', { ...voteParams, operation: input.operation });
    ctx.enrich.echo(
      buildEffectiveQuery(
        `member votes for Senate roll ${input.voteNumber} in the ${ordinal(input.congress)} Congress, session ${input.session}`,
        memberFilter,
      ),
    );
    ctx.enrich.total(result.pagination.count);
    notifyNoPositions(ctx, result, `Senate roll ${input.voteNumber}`);
    return result;
  }

  const result = discloseSource(ctx, await senate.getVote(voteParams, ctx));
  ctx.log.info('Senate vote retrieved', { ...voteParams, operation: input.operation });
  ctx.enrich.echo(
    `Senate roll call ${input.voteNumber} in the ${ordinal(input.congress)} Congress, session ${input.session}`,
  );
  ctx.enrich.total(1);
  return result;
}

/** The `members` filters a call supplied, uppercased, or undefined when it supplied none. */
function memberFilterOf(
  input: Partial<Record<MemberFilterField, string | undefined>>,
): MemberFilter | undefined {
  const supplied = MEMBER_FILTER_FIELDS.flatMap((field) => {
    const value = normalizeOptionalString(input[field]);
    return value ? [[field, value.toUpperCase()] as const] : [];
  });
  return supplied.length > 0 ? Object.fromEntries(supplied) : undefined;
}

/**
 * Narrow a whole roster to the positions matching every filter, then page the
 * matches: `pagination.count` counts them, and `memberFilter` carries the filters
 * with the whole roster's size beside them.
 */
function applyMemberFilter<R extends { data: Array<Record<string, unknown>> }>(
  roster: R,
  filter: MemberFilter,
  fields: MemberFilter,
  page: { limit: number; offset: number },
) {
  const terms = Object.entries(filter) as Array<[MemberFilterField, string]>;
  const matched = roster.data.filter((row) =>
    terms.every(([name, value]) => {
      const field = fields[name];
      const cell = field === undefined ? undefined : row[field];
      return typeof cell === 'string' && cell.toUpperCase() === value;
    }),
  );
  const data = matched.slice(page.offset, page.offset + page.limit);
  const end = page.offset + data.length;
  return {
    ...roster,
    data,
    pagination: { count: matched.length, nextOffset: end < matched.length ? end : null },
    memberFilter: { ...filter, rosterCount: roster.data.length },
  };
}

/**
 * The notice for a `members` call with no position to show. A filter matching none
 * of a vote's recorded positions is not a vote with none recorded, so it says which;
 * a page past the end of the positions draws none (`notifyIfNoMatches`).
 */
function notifyNoPositions(
  ctx: Context,
  result: {
    data: readonly unknown[];
    pagination: { count: number };
    memberFilter?: MemberFilter & { rosterCount: number };
  },
  rollLabel: string,
): void {
  const { memberFilter } = result;
  if (!memberFilter || memberFilter.rosterCount === 0) {
    notifyIfNoMatches(ctx, result, `No member vote records found for ${rollLabel}.`);
    return;
  }
  if (result.pagination.count > 0) return;
  const terms = MEMBER_FILTER_FIELDS.flatMap((field) =>
    memberFilter[field] ? [`${field}=${memberFilter[field]}`] : [],
  );
  addNotice(
    ctx,
    `No member position among the ${memberFilter.rosterCount} recorded for ${rollLabel} matches ${terms.join(', ')}. Check the filter values, or drop a filter to widen the match.`,
  );
}

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
