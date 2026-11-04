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
import { getServerConfig } from '@/config/server-config.js';
import { formatSearchBills } from '@/mcp-server/tools/format-helpers.js';
import {
  addNotice,
  buildEffectiveQuery,
  listEnrichment,
  listOutput,
  notifyIfNoMatches,
} from '@/mcp-server/tools/tool-helpers.js';
import { BILL_TYPE_CODES } from '@/services/congress-api/types.js';
import { getCongressMirror } from '@/services/congress-mirror/congress-mirror-service.js';
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

const searchBillsDef = tool('congressgov_search_bills', {
  title: 'Congress.gov Bill Search',
  description: `Keyword-search U.S. bills by title and CRS summary text — the discovery path the Congress.gov API itself lacks (it has no keyword search). Backed by a local full-text index over a bounded window of congresses, which every response names in mirroredCongresses; title and summary are indexed, but policy area and full bill text are not. Returns BM25-ranked matches, each with the bill's derived id (congress/billType/billNumber) for follow-up congressgov_bill_lookup calls and a truncated summary preview. Narrow with the optional congress, billType, and originChamber filters; a congress outside mirroredCongresses returns an empty result with a notice, not a no-match. Searches the local mirror, not the live API — if the mirror has not finished its initial build it returns an empty result with a notice, not an error.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    query: z
      .string()
      .regex(/[\p{L}\p{N}]/u, 'Query must contain at least one letter or number.')
      .describe(
        'Free-text keywords matched against bill titles and summaries (e.g. "semiconductor export controls"). Tokens are AND-combined.',
      ),
    congress: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Restrict to a single congress (e.g. 119), one of the mirroredCongresses every response reports. Omit to search the whole mirrored window.',
      ),
    billType: z
      .enum(BILL_TYPE_CODES)
      .optional()
      .describe('Restrict to a bill type (hr, s, hjres, sjres, hconres, sconres, hres, sres).'),
    originChamber: z
      .enum(['House', 'Senate'])
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
