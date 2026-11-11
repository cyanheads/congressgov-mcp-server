/**
 * @fileoverview congressgov_search_bills — keyword search over the local bill FTS
 * mirror, the discovery path the Congress.gov API structurally lacks. Queries the
 * embedded SQLite + FTS5 index (title + summary), not the live API, so it has no
 * live fallback: a mirror that has not finished its initial build returns an empty
 * result with an enrichment notice rather than a thrown error. Gated behind
 * CONGRESS_MIRROR_ENABLED via disabledTool() — when the mirror is off (the
 * default) the tool stays on the landing page for operators but
 * is skipped during MCP registration, so clients never see it in tools/list.
 * @module mcp-server/tools/definitions/search-bills
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { formatSearchBills } from '@/mcp-server/tools/format-helpers.js';
import {
  addNotice,
  anyLetterCase,
  buildEffectiveQuery,
  listEnrichment,
  listOutput,
  notifyIfNoMatches,
} from '@/mcp-server/tools/tool-helpers.js';
import { BILL_TYPE_CODES } from '@/services/congress-api/types.js';
import { getCongressMirror } from '@/services/congress-mirror/congress-mirror-service.js';
import type { ExclusionForm, UnmatchedMark } from '@/services/congress-mirror/normalize.js';
import { ordinal } from '@/utils/congress-calendar.js';

/**
 * The congresses a mirror holds, as a notice phrase: "the 119th Congress only",
 * "the 118th and 119th Congresses only", or "no bills".
 */
function heldCongresses(congresses: readonly number[]): string {
  const names = congresses.map(ordinal);
  const last = names.at(-1);
  if (last === undefined) return 'no bills';
  if (names.length === 1) return `the ${last} Congress only`;
  const rest = names.slice(0, -1);
  return `the ${rest.join(', ')}${rest.length > 1 ? ',' : ''} and ${last} Congresses only`;
}

/** Joins marks as `( and "` / `(, ), and "`. */
const MARK_LIST = new Intl.ListFormat('en', { type: 'conjunction' });

/** The notice naming the unmatched marks the query's translation ignored. */
function unmatchedNotice(marks: readonly UnmatchedMark[]): string {
  const advice: string[] = [];
  if (marks.some((mark) => mark !== '"')) advice.push('pair ( with ) to group terms');
  if (marks.includes('"')) advice.push('put " on both sides of an exact phrase');
  return `The query's unmatched ${MARK_LIST.format(marks)} ${marks.length === 1 ? 'was' : 'were'} ignored; ${advice.join(', and ')}.`;
}

/** Each exclusion form as the notice names it, and how to search for the word it took instead. */
const EXCLUSION_READINGS = {
  NOT: { name: 'NOT', advice: 'to search for the word NOT, quote it ("NOT")' },
  '-': {
    name: '- at the start of a word',
    advice: 'to search for a hyphenated term, join the hyphen to the word before it (covid-19)',
  },
} as const satisfies Record<ExclusionForm, { advice: string; name: string }>;

/**
 * The notice naming the exclusions the query used — on every response that has
 * one, since an exclusion can leave out the very bill a caller wanted at any row
 * count (`DO NOT CALL`, `covid -19`).
 */
function exclusionNotice(forms: readonly ExclusionForm[]): string {
  const readings = forms.map((form) => EXCLUSION_READINGS[form]);
  return `The query's ${MARK_LIST.format(readings.map((reading) => reading.name))} ${forms.length === 1 ? 'was read as an exclusion' : 'were read as exclusions'}; ${readings.map((reading) => reading.advice).join(', and ')}.`;
}

const searchBillsDef = tool('congressgov_search_bills', {
  title: 'Congress.gov Bill Search',
  description: `Keyword-search U.S. bills by title and CRS summary text — the discovery path the Congress.gov API itself lacks (it has no keyword search). Backed by a local full-text index over a bounded window of congresses, which every response names in mirroredCongresses; title and summary are indexed, but policy area and full bill text are not. Returns BM25-ranked matches, each with the bill's derived id (congress/billType/billNumber) for follow-up congressgov_bill_lookup calls and a truncated summary preview. Every query word must match unless OR offers alternatives; "quoted words" match as a phrase, word* as a prefix, -word or NOT word excludes, and parentheses group terms (see query). Narrow with the optional congress, billType, and originChamber filters; a congress outside mirroredCongresses returns an empty result with a notice, not a no-match. Searches the local mirror, not the live API — if the mirror has not finished its initial build it returns an empty result with a notice, not an error.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  errors: [
    {
      code: JsonRpcErrorCode.ValidationError,
      reason: 'invalid_query',
      thrownBy: 'service',
      retryable: false,
      severity: 'notice',
      when: 'The query has no term to search for (only exclusions such as -smoke or NOT smoke), has an AND, OR, or NOT with no term beside it, or nests more than 10 levels of groups that hold OR or an exclusion or are themselves excluded.',
      recovery:
        'Keep at least one term to search for beside any -word or NOT word, put a term on each side of AND and OR and after NOT, nest groups that hold OR or an exclusion, or are excluded, at most 10 levels deep, and quote an operator ("OR") to search for the word itself.',
    },
  ],
  input: z.object({
    query: z
      .string()
      .regex(/[\p{L}\p{N}]/u, 'Query must contain at least one letter or number.')
      .describe(
        'Keywords matched against bill titles and summaries (e.g. "semiconductor export controls"). Words are AND-combined; "two words" matches the exact phrase; word* matches a prefix; -word or NOT word excludes bills from its group, and every group needs a term to search for beside any exclusion; A OR B matches either; ( ) groups terms, and groups that hold OR or an exclusion, or are excluded, nest up to 10 levels deep (a group around a single term or group never counts). Only uppercase AND, OR, and NOT are operators: lowercase and, or, and not, and a quoted "OR", are searched as words. An unmatched (, ), or " is ignored with a notice.',
      ),
    congress: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Restrict to a single congress (e.g. 119), one of the mirroredCongresses every response reports. Omit to search the whole mirrored window.',
      ),
    billType: anyLetterCase(z.enum(BILL_TYPE_CODES))
      .optional()
      .describe('Restrict to a bill type (hr, s, hjres, sjres, hconres, sconres, hres, sres).'),
    originChamber: anyLetterCase(z.enum(['House', 'Senate']), 'title')
      .optional()
      .describe('Restrict to the originating chamber.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Results per page (1–100, default 20).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: listOutput,
  enrichment: {
    ...listEnrichment,
    mirroredCongresses: z
      .array(z.number().int().positive())
      .describe(
        'Congress numbers the local mirror holds bills for, ascending — the congresses this tool can search. Empty while the mirror has not finished its initial build.',
      ),
  },
  enrichmentTrailer: {
    mirroredCongresses: {
      render: (congresses) =>
        `**Mirrored congresses:** ${congresses.length > 0 ? congresses.join(', ') : 'none'}`,
    },
  },
  format: formatSearchBills,

  async handler(input, ctx) {
    const service = getCongressMirror();
    ctx.enrich.echo(
      buildEffectiveQuery('bill search', {
        query: input.query,
        congress: input.congress,
        billType: input.billType,
        originChamber: input.originChamber,
      }),
    );
    const empty = { data: [], pagination: { count: 0, nextOffset: null } };

    /** No live-API fallback — a mirror that never completed an initial sync is an
     * empty result plus a notice pointing at the refresh, never a throw. */
    if (!(await service.ready())) {
      ctx.enrich({ mirroredCongresses: [] });
      ctx.enrich.total(0);
      addNotice(
        ctx,
        'The bill search mirror has not finished its initial build yet, so no results are available. Build it with the mirror:init script (or wait for the scheduled refresh) and retry.',
      );
      return empty;
    }

    /** Read from the store, not the configuration — the store is what search reads. */
    const mirroredCongresses = await service.mirroredCongresses();
    ctx.enrich({ mirroredCongresses });
    if (input.congress !== undefined && !mirroredCongresses.includes(input.congress)) {
      ctx.enrich.total(0);
      addNotice(
        ctx,
        `The bill search mirror holds ${heldCongresses(mirroredCongresses)}, so it can't search the ${ordinal(input.congress)} Congress. Browse that congress's bills with congressgov_bill_lookup (operation 'list', congress ${input.congress}), which reads Congress.gov live but has no keyword search.`,
      );
      return empty;
    }

    const page = await service.search(
      {
        query: input.query,
        congress: input.congress,
        billType: input.billType,
        originChamber: input.originChamber,
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );

    ctx.log.info('Bill search complete', { query: input.query, matches: page.total });
    ctx.enrich.total(page.total);
    if (page.unmatched.length > 0) addNotice(ctx, unmatchedNotice(page.unmatched));
    if (page.exclusions.length > 0) addNotice(ctx, exclusionNotice(page.exclusions));

    const nextOffset =
      page.offset + page.items.length < page.total ? page.offset + page.items.length : null;
    /** The shared list envelope carries `data` as passthrough records; the typed
     * search results widen cleanly to that shape. */
    const result = {
      data: page.items as unknown as Record<string, unknown>[],
      pagination: { count: page.total, nextOffset },
    };
    notifyIfNoMatches(
      ctx,
      result,
      `No bills matched "${input.query}". Try broader or fewer keywords, or remove the congress/billType/originChamber filters.`,
    );
    return result;
  },
});

/**
 * Gated behind the mirror master switch. When the mirror is off (the default) the
 * tool renders on the landing page as present-but-uncallable with a hint, and is
 * skipped during MCP registration so clients can't call a guaranteed-empty search.
 */
export const searchBillsTool = getServerConfig().mirrorEnabled
  ? searchBillsDef
  : disabledTool(searchBillsDef, {
      reason: 'The local bill search mirror is turned off in this deployment.',
      hint: 'CONGRESS_MIRROR_ENABLED=true',
    });
