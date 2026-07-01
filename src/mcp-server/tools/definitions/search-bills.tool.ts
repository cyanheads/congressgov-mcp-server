/**
 * @fileoverview congressgov_search_bills — keyword search over the local bill FTS
 * mirror, the discovery path the Congress.gov API structurally lacks. Queries the
 * embedded SQLite + FTS5 index (title + summary), not the live API, so it has no
 * live fallback: a mirror that has not finished its initial build returns an empty
 * result with an enrichment notice rather than a thrown error. Gated behind
 * CONGRESS_MIRROR_ENABLED via disabledTool() — visible-but-uncallable when the
 * mirror is off (the default).
 * @module mcp-server/tools/definitions/search-bills
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { formatSearchBills } from '@/mcp-server/tools/format-helpers.js';
import {
  buildEffectiveQuery,
  listEnrichment,
  listOutput,
} from '@/mcp-server/tools/tool-helpers.js';
import { BILL_TYPE_CODES } from '@/services/congress-api/types.js';
import { getCongressMirror } from '@/services/congress-mirror/congress-mirror-service.js';

const searchBillsDef = tool('congressgov_search_bills', {
  description: `Keyword-search U.S. bills by title and CRS summary text — the discovery path the Congress.gov API itself lacks (it has no keyword search). Backed by a local full-text index over a bounded congress window; title and summary are indexed, but policy area and full bill text are not. Returns BM25-ranked matches, each with the bill's derived id (congress/billType/billNumber) for follow-up congressgov_bill_lookup calls and a truncated summary preview. Narrow with the optional congress, billType, and originChamber filters. Searches the local mirror, not the live API — if the mirror has not finished its initial build it returns an empty result with a notice, not an error.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Free-text keywords matched against bill titles and summaries (e.g. "semiconductor export controls"). Tokens are AND-combined.',
      ),
    congress: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Restrict to a single congress (e.g. 119). Omit to search the whole mirrored window.',
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
  enrichment: listEnrichment,
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

    /** No live-API fallback — a mirror that never completed an initial sync is an
     * empty result plus a notice pointing at the refresh, never a throw. */
    if (!(await service.ready())) {
      ctx.enrich.total(0);
      ctx.enrich.notice(
        'The bill search mirror has not finished its initial build yet, so no results are available. Build it with the mirror:init script (or wait for the scheduled refresh) and retry.',
      );
      return { data: [], pagination: { count: 0, nextOffset: null } };
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
    if (page.items.length === 0) {
      ctx.enrich.notice(
        `No bills matched "${input.query}". Try broader or fewer keywords, or remove the congress/billType/originChamber filters.`,
      );
    }

    const nextOffset =
      page.offset + page.items.length < page.total ? page.offset + page.items.length : null;
    /** The shared list envelope carries `data` as passthrough records; the typed
     * search results widen cleanly to that shape. */
    return {
      data: page.items as unknown as Record<string, unknown>[],
      pagination: { count: page.total, nextOffset },
    };
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
