/**
 * @fileoverview Tool for browsing congressional committees and their activity.
 * @module mcp-server/tools/definitions/committee-lookup
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatCommittees } from '@/mcp-server/tools/format-helpers.js';
import {
  addNotice,
  anyLetterCase,
  buildEffectiveQuery,
  congressErrorContracts,
  identityErrorContracts,
  listEnrichment,
  listOrDetail,
  normalizeOptionalString,
  noticeIgnoredInputs,
  notifyIfNoMatches,
  validateDateTimeRange,
  validateIsoDateTime,
} from '@/mcp-server/tools/tool-helpers.js';
import {
  fetchAllCommittees,
  findRosterRow,
  inferChamberFromCode,
  listedChamber,
  readCommittee,
  rosterChamber,
} from '@/services/congress-api/committee-roster.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import type { Chamber } from '@/services/congress-api/types.js';

// ── Client-side committee name filter ────────────────────────────────────────

/** Normalize a string for matching: lowercase, strip punctuation/diacritics, collapse whitespace. */
function normalizeForMatch(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract bigrams from a normalized string. */
function bigrams(str: string): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < str.length - 1; i++) result.add(str.slice(i, i + 2));
  return result;
}

/** Dice coefficient between two bigram sets. */
function diceCoeff(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const bg of a) if (b.has(bg)) intersection++;
  return (2 * intersection) / (a.size + b.size);
}

const FUZZY_THRESHOLD = 0.5;
const FUZZY_MAX_RESULTS = 5;

type ApiRecord = Record<string, unknown>;

/**
 * Filter a committee list by name using a two-pass strategy:
 * 1. Primary: every token in `filter` appears in the normalized committee name.
 * 2. Fuzzy fallback (only when primary is empty): each query token must meet the
 *    bigram-Dice floor against a name token. Rank by mean token similarity, then
 *    normalized name and system code, keeping at most five approximate matches.
 *
 * Never throws — no match returns an empty array.
 */
function filterCommittees(items: ApiRecord[], filter: string): ApiRecord[] {
  const normFilter = normalizeForMatch(filter);
  const tokens = normFilter.split(' ').filter(Boolean);
  if (tokens.length === 0) return items;

  // Primary: all-token match (order-independent, partial-word OK)
  const primary = items.filter((item) => {
    const name = typeof item.name === 'string' ? normalizeForMatch(item.name) : '';
    return tokens.every((tok) => name.includes(tok));
  });
  if (primary.length > 0) return primary;

  const queryBigrams = tokens.map(bigrams);
  const scored = items
    .map((item) => {
      const name = typeof item.name === 'string' ? normalizeForMatch(item.name) : '';
      const nameBigrams = name.split(' ').filter(Boolean).map(bigrams);
      const tokenScores = queryBigrams.map((query) =>
        Math.max(0, ...nameBigrams.map((candidate) => diceCoeff(query, candidate))),
      );
      const qualifies = tokenScores.every((score) => score >= FUZZY_THRESHOLD);
      const score = tokenScores.reduce((sum, value) => sum + value, 0) / tokenScores.length;
      const code = typeof item.systemCode === 'string' ? item.systemCode : '';
      return { item, name, code, score, qualifies };
    })
    .filter(({ qualifies }) => qualifies)
    .sort(
      (a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.code.localeCompare(b.code),
    )
    .slice(0, FUZZY_MAX_RESULTS);

  return scored.map(({ item }) => ({ ...item, approximate: true }));
}

/**
 * The shape most committee system codes take: chamber-prefixed letters + a
 * 2-digit suffix (`hsju00`, `ssbk13`). A value of this shape is read as a code
 * in its prefix's chamber with no roster read. Any other value goes to the
 * roster: it is a code when a row's `systemCode` equals it (`n79043125`,
 * `sp2k00`), and otherwise a committee name for the resolver — testing for the
 * code shape rather than for whitespace is what lets single-token names
 * ('Judiciary') resolve. Resolves cyanheads/congressgov-mcp-server#46 and #114.
 *
 * Matched case-insensitively: upstream `systemCode` values are lowercase, so an
 * uppercased code is normalized rather than mistaken for a name.
 */
const COMMITTEE_CODE_SHAPE = /^[a-z]{2,6}\d{2}$/i;

/** `chamber` in any letter case: committee rows carry 'House', 'Senate', 'Joint', and the advertised enum stays lowercase. */
const ChamberEnum = anyLetterCase(z.enum(['house', 'senate', 'joint']));

export const committeeLookupTool = tool('congressgov_committee_lookup', {
  title: 'Congress.gov Committee Lookup',
  description: `Browse congressional committees and their legislation, reports, and nominations. Use 'list' (with optional 'filter' for name→code resolution) to discover committee codes — the systemCode on each row, such as 'hsju00' or the historical 'n79043125' — then 'get' or drill into 'bills', 'reports', or 'nominations' ('nominations' is Senate-only). 'get' and sub-resources only need committeeCode: the chamber is read from the code's prefix, or from the committee roster when the prefix names no chamber or one that does not hold the code; pass chamber explicitly to override. 'bills' and 'reports' take fromDateTime/toDateTime, a window on the dates Congress.gov updated each row: a row with any update inside the window matches, so a window returns rows added in it plus older rows touched in it. Congress.gov lists a committee's bills roughly from least to most recently updated; 'bills' defaults to order='recent', which reverses that list, and order='oldest' keeps it. Upstream omits bill titles from the 'bills' sub-resource — rows carry only {congress, type, number, actionDate, relationshipType, updateDate, url}; chain 'congressgov_bill_lookup get' per row to retrieve titles and policy area.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [...congressErrorContracts, ...identityErrorContracts],
  input: z.object({
    operation: z
      .enum(['list', 'get', 'bills', 'reports', 'nominations'])
      .describe('Which data to retrieve.'),
    congress: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Congress number, for 'list' only — Congress.gov offers no congress filter on a committee's bills, reports, or nominations.",
      ),
    chamber: ChamberEnum.optional().describe(
      "Chamber filter for 'list'. For 'get' and sub-resources, the committee's chamber, inferred when omitted; set it to resolve a committee name given as committeeCode among that chamber's committees only.",
    ),
    committeeCode: z
      .string()
      .regex(
        /[A-Za-z0-9]/,
        "committeeCode must contain a letter or digit. Pass a code like 'hsju00', or a committee name to resolve.",
      )
      .optional()
      .describe(
        "Committee system code: the systemCode of a 'list' row, e.g. 'hsju00' or 'n79043125', matched case-insensitively. Required for 'get' and sub-resources; 'list' refuses it. Any other value with a letter or digit is treated as a committee name and resolved automatically — single-word names ('Judiciary') included — or use operation:'list' with filter to browse.",
      ),
    // Provisional param name — tracking fleet-wide convention in cyanheads/mcp-ts-core#186.
    filter: z
      .string()
      .optional()
      .describe(
        "Filter committee-list results by name (e.g., 'transportation', 'armed services'), for 'list' only; fuzzy-matched rows are labeled approximate.",
      ),
    fromDateTime: z
      .string()
      .optional()
      .describe(
        "Start of the update-date window for 'bills' and 'reports' (ISO 8601, e.g. 2025-03-01T00:00:00Z): a row matches when Congress.gov updated it at any time inside the window, so older rows touched in the window match too, and each matched row carries an updateDate from inside the window rather than its latest. Ignored by 'list', 'get', and 'nominations'.",
      ),
    toDateTime: z
      .string()
      .optional()
      .describe(
        "End of the update-date window for 'bills' and 'reports' (ISO 8601). Same semantics as fromDateTime. Ignored by 'list', 'get', and 'nominations'.",
      ),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
    order: z
      .enum(['recent', 'oldest'])
      .default('recent')
      .describe(
        "Row order for the 'bills' sub-resource. Congress.gov lists a committee's bills roughly from least to most recently updated: 'recent' (default) reverses that list, so the rows it lists last come first, and 'oldest' keeps it. Ignored by other operations.",
      ),
  }),
  output: listOrDetail(
    { committee: 'record' },
    'Committee record for `get` (name, chamber, subcommittees, history, sub-resource counts); absent for `list` and sub-resources.',
  ),
  enrichment: listEnrichment,
  format: formatCommittees,

  async handler(input, ctx) {
    const api = getCongressApi();
    const fromDateTime = validateIsoDateTime(
      normalizeOptionalString(input.fromDateTime),
      'fromDateTime',
    );
    const toDateTime = validateIsoDateTime(normalizeOptionalString(input.toDateTime), 'toDateTime');
    validateDateTimeRange(fromDateTime, toDateTime);

    if (input.operation === 'list') {
      if (input.committeeCode !== undefined) {
        const value = input.committeeCode.trim();
        throw ctx.fail(
          'incompatible_identity',
          COMMITTEE_CODE_SHAPE.test(value)
            ? "'list' does not use committeeCode. Remove committeeCode to browse, or use 'get', 'bills', 'reports', or 'nominations' with committeeCode."
            : `'list' does not use committeeCode. To find a committee by name, pass it as filter: '${value}'; or use 'get' with committeeCode, which resolves a name to its code.`,
          { field: 'committeeCode', operation: input.operation },
        );
      }
      noticeIgnoredInputs(ctx, input.operation, { fromDateTime, toDateTime });
      const filter = normalizeOptionalString(input.filter);
      // When filtering, page through the complete scoped committee set before
      // matching client-side — the roster (455 House, 818 all chambers) exceeds
      // the 250-row request cap, so a single fetch drops matches past row 250.
      const result = filter
        ? await fetchAllCommittees({ congress: input.congress, chamber: input.chamber }, ctx)
        : await api.listCommittees(
            {
              congress: input.congress,
              chamber: input.chamber,
              limit: input.limit,
              offset: input.offset,
            },
            ctx,
          );

      const matched = filter ? filterCommittees(result.data as ApiRecord[], filter) : result.data;
      // The filtered set is matched against every fetched row, so it is paginated
      // here rather than upstream — `count` stays the full match total while `data`
      // carries only the caller's window. Resolves cyanheads/congressgov-mcp-server#44.
      const windowEnd = input.offset + input.limit;
      const listResult = filter
        ? {
            ...result,
            data: matched.slice(input.offset, windowEnd),
            pagination: {
              count: matched.length,
              nextOffset: windowEnd < matched.length ? windowEnd : null,
            },
          }
        : { ...result, data: matched };
      ctx.log.info('Committees listed', {
        count: matched.length,
        shown: listResult.data.length,
        total: result.pagination.count,
        filter,
      });
      ctx.enrich.echo(
        buildEffectiveQuery('committees', {
          congress: input.congress,
          chamber: input.chamber,
          filter,
        }),
      );
      ctx.enrich.total(listResult.pagination.count);
      notifyIfNoMatches(
        ctx,
        listResult,
        filter
          ? `No committees matched '${filter}'. Call 'list' without filter to browse all committees.`
          : 'No committees found. Try removing the chamber filter or check the congress number.',
      );
      return listResult;
    }

    if (!input.committeeCode) {
      throw validationError(
        `The '${input.operation}' operation requires committeeCode. Use 'list' to discover available committees.`,
        { operation: input.operation, committeeCode: input.committeeCode },
      );
    }

    /** The update-date window reaches only 'bills' and 'reports'; Congress.gov ignores it on 'nominations' (#119). */
    const windowApplies = input.operation === 'bills' || input.operation === 'reports';
    const window = windowApplies ? { fromDateTime, toDateTime } : {};
    noticeIgnoredInputs(
      ctx,
      input.operation,
      {
        congress: input.congress,
        filter: normalizeOptionalString(input.filter),
        ...(windowApplies ? {} : { fromDateTime, toDateTime }),
      },
      input.operation !== 'get' && input.congress !== undefined
        ? 'Results span every congress.'
        : undefined,
    );

    let committeeCode = input.committeeCode.trim();
    let resolvedChamber: Chamber | undefined;
    const direct = COMMITTEE_CODE_SHAPE.test(committeeCode);
    if (direct) {
      committeeCode = committeeCode.toLowerCase();
    } else {
      // Page the complete committee set — the chamber's when one is set, as 'list'
      // with filter does, else every chamber's — so a roster code or a name matches
      // rows past the 250-row request cap. Resolves cyanheads/congressgov-mcp-server#108.
      const all = await fetchAllCommittees({ chamber: input.chamber }, ctx);
      const resolution = resolveCommittee(all.data, committeeCode, input.chamber);
      if (resolution.kind === 'candidates') {
        ctx.enrich.echo(
          buildEffectiveQuery('committee name resolution', {
            name: committeeCode,
            chamber: input.chamber,
          }),
        );
        addNotice(ctx, resolution.notice);
        ctx.enrich.total(resolution.matches.length);
        ctx.log.info('Committee name resolution — candidates returned', {
          name: committeeCode,
          chamber: input.chamber,
          count: resolution.matches.length,
        });
        return {
          data: resolution.matches,
          pagination: { count: resolution.matches.length, nextOffset: null },
        };
      }
      if (resolution.kind === 'name') {
        ctx.log.info('Committee name resolved', {
          name: committeeCode,
          chamber: input.chamber,
          resolvedCode: resolution.code,
          approximate: resolution.approximate,
        });
        addNotice(
          ctx,
          `Resolved '${committeeCode}' → ${resolution.code} (${resolution.name})${resolution.approximate ? ' (approximate match)' : ''}.`,
        );
      }
      committeeCode = resolution.code;
      resolvedChamber = resolution.chamber;
    }

    const inferred = input.chamber ?? resolvedChamber ?? inferChamberFromCode(committeeCode);
    if (!inferred) {
      throw validationError(
        `Could not infer chamber from committeeCode '${committeeCode}'. Pass chamber explicitly ('house', 'senate', or 'joint').`,
        { field: 'committeeCode', committeeCode },
      );
    }
    let chamber: Chamber = inferred;
    /** A code given directly with no `chamber` is read in its prefix's chamber until that chamber proves not to hold it (#111). */
    let fromPrefix = direct && input.chamber === undefined;

    if (input.operation === 'nominations' && chamber !== 'senate') {
      const listed = fromPrefix ? await listedChamber(committeeCode, ctx) : undefined;
      if (listed !== 'senate') {
        throw validationError(
          "Nominations are only referred to Senate committees. Use chamber='senate' or a Senate committee code.",
          { field: 'chamber', chamber },
        );
      }
      noticeListedChamber(ctx, committeeCode, listed, chamber);
      chamber = listed;
      fromPrefix = false;
    }

    /** Run `read` in `chamber`, or, for a direct code with no `chamber`, in whichever chamber holds it. */
    const readIn = async <T>(read: (inChamber: Chamber) => Promise<T>): Promise<T> => {
      if (!fromPrefix) return read(chamber);
      const committee = await readCommittee(committeeCode, read, ctx);
      if (committee.chamber !== chamber) {
        noticeListedChamber(ctx, committeeCode, committee.chamber, chamber);
      }
      return committee.value;
    };
    const windowed = windowApplies && (fromDateTime !== undefined || toDateTime !== undefined);
    const noneFound = (noun: string) =>
      windowed
        ? `No ${noun} found for committee ${committeeCode} with an update inside the fromDateTime/toDateTime window. Widen or remove the window.`
        : `No ${noun} found for committee ${committeeCode}.`;

    if (input.operation === 'get') {
      const result = await readIn((inChamber) => api.getCommittee(inChamber, committeeCode, ctx));
      ctx.log.info('Committee retrieved', { committeeCode });
      ctx.enrich.echo(`committee ${committeeCode}`);
      ctx.enrich.total(1);
      return result;
    }

    if (input.operation === 'bills' && input.order === 'recent') {
      const recentResult = await readIn((inChamber) =>
        fetchCommitteeBillsRecent(
          {
            chamber: inChamber,
            committeeCode,
            limit: input.limit,
            offset: input.offset,
            ...window,
          },
          ctx,
        ),
      );
      ctx.enrich.echo(
        buildEffectiveQuery(`bills for committee ${committeeCode}`, { order: 'recent', ...window }),
      );
      ctx.enrich.total(recentResult.pagination.count);
      notifyIfNoMatches(ctx, recentResult, noneFound('bills'));
      return recentResult;
    }

    const subResource = input.operation;
    const result = await readIn((inChamber) =>
      api.getCommitteeSubResource(
        {
          chamber: inChamber,
          committeeCode,
          subResource,
          limit: input.limit,
          offset: input.offset,
          ...window,
        },
        ctx,
      ),
    );
    ctx.log.info('Committee sub-resource retrieved', { committeeCode, subResource });
    ctx.enrich.echo(buildEffectiveQuery(`${subResource} for committee ${committeeCode}`, window));
    ctx.enrich.total(result.pagination.count);
    notifyIfNoMatches(ctx, result, noneFound(subResource));
    return result;
  },
});

/** What a `committeeCode` value outside the code shape names among the roster rows in scope. */
type CommitteeResolution =
  | { kind: 'code'; code: string; chamber: Chamber | undefined }
  | {
      kind: 'name';
      code: string;
      chamber: Chamber | undefined;
      name: string;
      approximate: boolean;
    }
  | { kind: 'candidates'; matches: ApiRecord[]; notice: string };

/**
 * Resolve a `committeeCode` value outside the code shape against the roster rows
 * in scope. A row whose systemCode equals it makes it a code (`n79043125`,
 * `sp2k00`), read in the chamber that row lists (#114). Anything else is a
 * committee name, matched with the primary (all-token) pass 'list' + filter
 * uses, restricted to parent committees (systemCode ending '00'), and one match
 * resolves to its code and its row's chamber.
 *
 * Zero or several matches, or a lone approximate one within `chamber`, come back
 * as candidates so the caller can choose. Zero covers both a name nothing answers
 * to and a code the roster lacks ('ssbk'); its notice points at a systemCode from
 * 'list' and the name→code route so neither dead-ends, and a chamber-scoped miss
 * points at dropping chamber. A lone approximate match within `chamber` is offered
 * rather than read: a name no committee there carries ('forestry' in the House)
 * can still clear the fuzzy floor against an unrelated one (Oversight, via
 * 'reform') while the committee meant sits in another chamber.
 */
function resolveCommittee(
  rows: ApiRecord[],
  value: string,
  chamber: Chamber | undefined,
): CommitteeResolution {
  const listed = findRosterRow(rows, value);
  if (listed) {
    return {
      kind: 'code',
      code: (listed.systemCode as string).toLowerCase(),
      chamber: rosterChamber(listed),
    };
  }

  const parents = rows.filter(
    (c) => typeof c.systemCode === 'string' && c.systemCode.endsWith('00'),
  );
  const matches = filterCommittees(parents, value);
  const lone = matches.length === 1 ? matches[0] : undefined;
  if (lone && !(chamber && lone.approximate === true)) {
    return {
      kind: 'name',
      code: lone.systemCode as string,
      chamber: rosterChamber(lone),
      name: lone.name as string,
      approximate: lone.approximate === true,
    };
  }

  const scope = chamber ? ` in the ${chamber} chamber` : '';
  const notice =
    matches.length === 0
      ? `No committee code or name matched '${value}'${scope}.${chamber ? ' Remove chamber to search every chamber.' : ''} Pass a systemCode from operation:'list' (e.g. 'hsju00'), or use operation:'list' with filter to find a committee by name.`
      : lone
        ? `No committee name matched '${value}'${scope}; the committee listed is an approximate match. Use its systemCode if it is the one you meant, or remove chamber to search every chamber.`
        : `'${value}' matched ${matches.length} committees${scope}. Use the systemCode from one of these results, or narrow your name.`;
  return { kind: 'candidates', matches, notice };
}

function noticeListedChamber(ctx: Context, code: string, listed: Chamber, prefix: Chamber): void {
  ctx.log.info('Committee read in its roster chamber', {
    committeeCode: code,
    prefixChamber: prefix,
    chamber: listed,
  });
  addNotice(
    ctx,
    `Read ${code} in the ${listed} chamber, where the committee roster lists it; its code prefix names the ${prefix} chamber.`,
  );
}

/**
 * Fetch committee bills in newest-first order.
 *
 * Congress.gov lists a committee's bills roughly from least to most recently
 * updated and ignores sort parameters. To surface the latest activity, probe the
 * total count (limit=1), then fetch the tail of the list and reverse it
 * client-side. `offset` / `limit` on input refer to the reversed (recent) view —
 * offset=0 always returns the page Congress.gov lists last. The update-date
 * window, when given, goes on both requests: filtered rows keep the unfiltered
 * list's order and page stably by offset, so the tail read lands on the
 * filtered total the probe counted.
 */
async function fetchCommitteeBillsRecent(
  params: {
    chamber: Chamber;
    committeeCode: string;
    limit: number;
    offset: number;
    fromDateTime?: string | undefined;
    toDateTime?: string | undefined;
  },
  ctx: Context,
) {
  const api = getCongressApi();
  const window = { fromDateTime: params.fromDateTime, toDateTime: params.toDateTime };
  const probe = await api.getCommitteeSubResource(
    {
      chamber: params.chamber,
      committeeCode: params.committeeCode,
      subResource: 'bills',
      limit: 1,
      offset: 0,
      ...window,
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
      ...window,
    },
    ctx,
  );

  const reversed = result.data.toReversed();
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
