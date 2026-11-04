/**
 * @fileoverview Tool for browsing congressional committees and their activity.
 * @module mcp-server/tools/definitions/committee-lookup
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatCommittees } from '@/mcp-server/tools/format-helpers.js';
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
 * Shape of a committee system code: chamber-prefixed letters + a 2-digit suffix
 * (`hsju00`, `ssbk13`). Anything else in `committeeCode` is treated as a committee
 * name and routed to the resolver — testing for the code shape rather than for
 * whitespace is what lets single-token names ('Judiciary') resolve.
 * Resolves cyanheads/congressgov-mcp-server#46.
 *
 * Matched case-insensitively: upstream `systemCode` values are lowercase, so an
 * uppercased code is normalized rather than mistaken for a name.
 */
const COMMITTEE_CODE_SHAPE = /^[a-z]{2,6}\d{2}$/i;

/** `chamber` in any letter case: committee rows carry 'House', 'Senate', 'Joint', and the advertised enum stays lowercase. */
const ChamberEnum = z.preprocess(
  (value) => (typeof value === 'string' ? value.toLowerCase() : value),
  z.enum(['house', 'senate', 'joint']),
);

/** Committee codes carry chamber in the first letter (h=House, s=Senate, j=Joint). */
function inferChamberFromCode(code: string): Chamber | undefined {
  const first = code[0]?.toLowerCase();
  if (first === 's') return 'senate';
  if (first === 'j') return 'joint';
  if (first === 'h') return 'house';
  return;
}

/**
 * A roster row's own chamber ('House', 'Senate', 'Joint'). A few historical
 * codes disagree with their prefix — `jsat00`, `jtdr00`, and `jsec03` are Senate
 * committees, `no2010049600` a House one — so a resolved name is read in the
 * chamber its row names, and so is a code its prefix's chamber does not hold.
 */
function rosterChamber(record: ApiRecord): Chamber | undefined {
  switch (typeof record.chamber === 'string' ? record.chamber.toLowerCase() : undefined) {
    case 'house':
      return 'house';
    case 'senate':
      return 'senate';
    case 'joint':
      return 'joint';
    default:
      return;
  }
}

export const committeeLookupTool = tool('congressgov_committee_lookup', {
  title: 'Congress.gov Committee Lookup',
  description: `Browse congressional committees and their legislation, reports, and nominations. Committee codes follow the pattern chamber-prefix (h/s/j) + abbreviation + 2-digit number — use 'list' (with optional 'filter' for name→code resolution) to discover codes, then 'get' or drill into 'bills', 'reports', or 'nominations' ('nominations' is Senate-only). 'get' and sub-resources only need committeeCode (chamber is inferred from the prefix, or read from the committee roster when the prefix's chamber does not hold the code); pass chamber explicitly to override. The 'bills' sub-resource defaults to 'recent' order (newest update-date first); pass order='oldest' for ascending update-date order. Upstream omits bill titles from the 'bills' sub-resource — rows carry only {congress, billType, billNumber, actionDate, relationshipType, url}; chain 'congressgov_bill_lookup get' per row to retrieve titles and policy area.`,
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
        "Committee system code, e.g. 'hsju00'. Required for 'get' and sub-resources; 'list' refuses it. Codes are letters + a 2-digit suffix and are matched case-insensitively. Any other value with a letter or digit is treated as a committee name and resolved automatically — single-word names ('Judiciary') included — or use operation:'list' with filter to browse.",
      ),
    // Provisional param name — tracking fleet-wide convention in cyanheads/mcp-ts-core#186.
    filter: z
      .string()
      .optional()
      .describe(
        "Filter committee-list results by name (e.g., 'transportation', 'armed services'), for 'list' only; fuzzy-matched rows are labeled approximate.",
      ),
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
    { committee: 'record' },
    'Committee record for `get` (name, chamber, subcommittees, history, sub-resource counts); absent for `list` and sub-resources.',
  ),
  enrichment: listEnrichment,
  format: formatCommittees,

  async handler(input, ctx) {
    const api = getCongressApi();

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

    noticeIgnoredInputs(
      ctx,
      input.operation,
      { congress: input.congress, filter: normalizeOptionalString(input.filter) },
      input.operation !== 'get' && input.congress !== undefined
        ? 'Results span every congress.'
        : undefined,
    );

    // Anything that isn't a committee-code shape is treated as a committee name and
    // auto-resolved via the same primary (all-token) match the 'list' + filter path
    // uses, restricted to parent committees (systemCode ending '00').
    let committeeCode = input.committeeCode.trim();
    let resolvedChamber: Chamber | undefined;
    const direct = COMMITTEE_CODE_SHAPE.test(committeeCode);
    if (direct) {
      committeeCode = committeeCode.toLowerCase();
    } else {
      // Page the complete committee set — the chamber's when one is set, as 'list'
      // with filter does, else every chamber's — so name resolution matches rows
      // past the 250-row request cap. Resolves cyanheads/congressgov-mcp-server#108.
      const all = await fetchAllCommittees({ chamber: input.chamber }, ctx);
      const parents = (all.data as ApiRecord[]).filter(
        (c) => typeof c.systemCode === 'string' && c.systemCode.endsWith('00'),
      );
      const matches = filterCommittees(parents, committeeCode);
      const lone = matches.length === 1 ? matches[0] : undefined;

      /**
       * Zero or several matches, or a lone approximate one within `chamber`, come
       * back as candidates so the caller can choose. Zero covers both a name nothing
       * answers to and a malformed code-like token ('ssbk'); one message names the
       * code shape and the name→code route so neither dead-ends, and a chamber-scoped
       * miss points at dropping chamber. A lone approximate match within `chamber` is
       * offered rather than read: a name no committee there carries ('forestry' in
       * the House) can still clear the fuzzy floor against an unrelated one
       * (Oversight, via 'reform') while the committee meant sits in another chamber.
       */
      if (!lone || (input.chamber && lone.approximate === true)) {
        const scope = input.chamber ? ` in the ${input.chamber} chamber` : '';
        const notice =
          matches.length === 0
            ? `No committee code or name matched '${committeeCode}'${scope}.${input.chamber ? ' Remove chamber to search every chamber.' : ''} Committee codes are letters + a 2-digit suffix (e.g. 'hsju00'); to find one by name use operation:'list' with filter.`
            : lone
              ? `No committee name matched '${committeeCode}'${scope}; the committee listed is an approximate match. Use its systemCode if it is the one you meant, or remove chamber to search every chamber.`
              : `'${committeeCode}' matched ${matches.length} committees${scope}. Use the systemCode from one of these results, or narrow your name.`;
        ctx.enrich.echo(
          buildEffectiveQuery('committee name resolution', {
            name: committeeCode,
            chamber: input.chamber,
          }),
        );
        addNotice(ctx, notice);
        ctx.enrich.total(matches.length);
        ctx.log.info('Committee name resolution — candidates returned', {
          name: committeeCode,
          chamber: input.chamber,
          count: matches.length,
        });
        return { data: matches, pagination: { count: matches.length, nextOffset: null } };
      }

      // Exactly one match — proceed with the resolved code.
      const resolvedCode = lone.systemCode as string;
      const approximate = lone.approximate === true;
      resolvedChamber = rosterChamber(lone);
      ctx.log.info('Committee name resolved', {
        name: committeeCode,
        chamber: input.chamber,
        resolvedCode,
        approximate,
      });
      addNotice(
        ctx,
        `Resolved '${committeeCode}' → ${resolvedCode} (${lone.name as string})${approximate ? ' (approximate match)' : ''}.`,
      );
      committeeCode = resolvedCode;
    }

    let chamber = input.chamber ?? resolvedChamber ?? inferChamberFromCode(committeeCode);
    if (!chamber) {
      throw validationError(
        `Could not infer chamber from committeeCode '${committeeCode}'. Pass chamber explicitly ('house', 'senate', or 'joint').`,
        { field: 'committeeCode', committeeCode },
      );
    }
    /** A code given directly with no `chamber` is read in its prefix's chamber until that chamber proves not to hold it (#111). */
    let fromPrefix = direct && input.chamber === undefined;

    if (input.operation === 'nominations' && chamber !== 'senate') {
      const listed = fromPrefix ? await listedChamber(committeeCode, ctx) : undefined;
      if (listed !== 'senate') {
        throw validationError(
          "Nominations are only referred to Senate committees. Use chamber='senate' or a Senate committee code (s-prefix).",
          { field: 'chamber', chamber },
        );
      }
      noticeListedChamber(ctx, committeeCode, listed, chamber);
      chamber = listed;
      fromPrefix = false;
    }
    const target = { committeeCode, chamber, fromPrefix };

    if (input.operation === 'get') {
      const result = await readCommittee(
        target,
        (inChamber) => api.getCommittee(inChamber, committeeCode, ctx),
        ctx,
      );
      ctx.log.info('Committee retrieved', { committeeCode });
      ctx.enrich.echo(`committee ${committeeCode}`);
      ctx.enrich.total(1);
      return result;
    }

    if (input.operation === 'bills' && input.order === 'recent') {
      const recentResult = await readCommittee(
        target,
        (inChamber) =>
          fetchCommitteeBillsRecent(
            {
              chamber: inChamber,
              committeeCode,
              limit: input.limit,
              offset: input.offset,
            },
            ctx,
          ),
        ctx,
      );
      ctx.enrich.echo(`bills for committee ${committeeCode} (recent order)`);
      ctx.enrich.total(recentResult.pagination.count);
      notifyIfNoMatches(ctx, recentResult, `No bills found for committee ${committeeCode}.`);
      return recentResult;
    }

    const subResource = input.operation;
    const result = await readCommittee(
      target,
      (inChamber) =>
        api.getCommitteeSubResource(
          {
            chamber: inChamber,
            committeeCode,
            subResource,
            limit: input.limit,
            offset: input.offset,
          },
          ctx,
        ),
      ctx,
    );
    ctx.log.info('Committee sub-resource retrieved', { committeeCode, subResource });
    ctx.enrich.echo(`${input.operation} for committee ${committeeCode}`);
    ctx.enrich.total(result.pagination.count);
    notifyIfNoMatches(ctx, result, `No ${input.operation} found for committee ${committeeCode}.`);
    return result;
  },
});

/**
 * Fetch the COMPLETE committee set for a scope, paging past the 250-row request
 * cap. `/committee/{chamber}` returns the full historical roster — 455 for the
 * House, 818 across all chambers — but one request returns at most 250 rows, so
 * client-side name filtering (`list` + `filter`) and name→code resolution must
 * page until the upstream `pagination.nextOffset` is exhausted and aggregate
 * every row. Mirrors `fetchCommitteeBillsRecent`: multi-request orchestration
 * lives in the tool layer, not the service. Worst case ≈4 requests (818 ÷ 250).
 * Resolves cyanheads/congressgov-mcp-server#41.
 */
async function fetchAllCommittees(
  params: { congress?: number | undefined; chamber?: Chamber | undefined },
  ctx: Context,
) {
  const api = getCongressApi();
  const PAGE_SIZE = 250;
  const data: ApiRecord[] = [];
  let offset = 0;
  let count = 0;

  for (;;) {
    const page = await api.listCommittees(
      { congress: params.congress, chamber: params.chamber, limit: PAGE_SIZE, offset },
      ctx,
    );
    data.push(...(page.data as ApiRecord[]));
    count = page.pagination.count;
    if (page.pagination.nextOffset == null) break;
    offset = page.pagination.nextOffset;
  }

  return { data, pagination: { count, nextOffset: null } };
}

/** The chamber the cross-chamber committee roster lists `code` under; undefined when no row carries it. */
async function listedChamber(code: string, ctx: Context): Promise<Chamber | undefined> {
  const roster = await fetchAllCommittees({}, ctx);
  const row = (roster.data as ApiRecord[]).find(
    (c) => typeof c.systemCode === 'string' && c.systemCode.toLowerCase() === code,
  );
  return row && rosterChamber(row);
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
 * Run a committee read in `target.chamber`. For a code given directly with no
 * `chamber`, that is its prefix's chamber, and a few codes sit elsewhere —
 * `jsat00`, `jtdr00`, and `jsec03` are Senate committees, and `/committee/joint`
 * answers not_found for them. Only that not_found reads the roster (≈4 requests)
 * and repeats the read in the chamber it lists, so a code its prefix's chamber
 * holds costs nothing extra. A code the roster lacks, or lists under the chamber
 * already tried, keeps the original not_found. The catch is recovery — the
 * not_found picks the next chamber — not error handling, so the handler stays catch-free.
 * Resolves cyanheads/congressgov-mcp-server#111.
 */
async function readCommittee<T>(
  target: { committeeCode: string; chamber: Chamber; fromPrefix: boolean },
  read: (chamber: Chamber) => Promise<T>,
  ctx: Context,
): Promise<T> {
  if (!target.fromPrefix) return read(target.chamber);
  try {
    return await read(target.chamber);
  } catch (error) {
    if (!(error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)) throw error;
    const listed = await listedChamber(target.committeeCode, ctx);
    if (listed === undefined || listed === target.chamber) throw error;
    noticeListedChamber(ctx, target.committeeCode, listed, target.chamber);
    return read(listed);
  }
}

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
