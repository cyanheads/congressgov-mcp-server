/**
 * @fileoverview Tool for browsing recent CRS bill summaries — the "what's happening" feed.
 * @module mcp-server/tools/definitions/bill-summaries
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatSummaries } from '@/mcp-server/tools/format-helpers.js';
import {
  summaryContinuationCall,
  summaryWindowNotice,
  windowSummaryPage,
} from '@/mcp-server/tools/summary-window.js';
import {
  buildEffectiveQuery,
  congressErrorContracts,
  listEnrichment,
  listOutput,
  normalizeOptionalString,
  notifyIfNoMatches,
  validateDateTimeRange,
  validateIsoDateTime,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { BILL_TYPE_CODES } from '@/services/congress-api/types.js';

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export const billSummariesTool = tool('congressgov_bill_summaries', {
  title: 'Congress.gov Bill Summaries',
  description: `Browse recent CRS (Congressional Research Service) bill summaries — plain-language summaries of bills at each legislative stage, useful for answering "what's happening in Congress?". The fromDateTime/toDateTime filters apply to the summary's update time, not the bill's action date, so results include recently rewritten summaries of older bills. Defaults to summaries updated in the last 7 days. Each item shows both the bill's action date and the summary update date. A page stops adding rows once it reaches a fixed response-character budget, and a summary longer than the per-row window arrives as an exact character window carrying textTotalCharacters/textTruncated/textNextOffset; pagination.nextOffset continues the page and a row's textNextOffset continues its text. For summaries of one specific bill — and to read a windowed summary to the end — use congressgov_bill_lookup with operation='summaries' instead.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: congressErrorContracts,
  input: z.object({
    congress: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Congress number. Optional — omit for summaries across all congresses.'),
    billType: z.enum(BILL_TYPE_CODES).optional().describe("Bill type filter. Requires 'congress'."),
    fromDateTime: z
      .string()
      .optional()
      .describe(
        'Start of date range (ISO 8601), filtered on the summary update time. Defaults to 7 days ago if neither date param is set.',
      ),
    toDateTime: z
      .string()
      .optional()
      .describe(
        'End of date range (ISO 8601), filtered on the summary update time. Defaults to now.',
      ),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: listOutput,
  enrichment: listEnrichment,
  format: formatSummaries,

  async handler(input, ctx) {
    const fromDateTimeInput = validateIsoDateTime(
      normalizeOptionalString(input.fromDateTime),
      'fromDateTime',
    );
    const toDateTimeInput = validateIsoDateTime(
      normalizeOptionalString(input.toDateTime),
      'toDateTime',
    );

    // Checked on the caller's own bounds, before the default below is applied —
    // the default only fires when neither bound was supplied, so it can never
    // introduce a reversal of its own.
    validateDateTimeRange(fromDateTimeInput, toDateTimeInput);

    if (input.billType && !input.congress) {
      throw validationError(
        "The 'billType' filter requires 'congress'. Provide both or omit billType to browse across all types.",
        { field: 'congress', billType: input.billType },
      );
    }

    const fromDateTime =
      fromDateTimeInput ??
      (!toDateTimeInput
        ? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')
        : undefined);

    const api = getCongressApi();
    const result = await api.listSummaries(
      {
        congress: input.congress,
        billType: input.billType,
        fromDateTime,
        toDateTime: toDateTimeInput,
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );
    const bounded = windowSummaryPage(result, { offset: input.offset });
    ctx.log.info('Summaries listed', {
      count: bounded.page.data.length,
      droppedRows: bounded.droppedRows,
      windowedRows: bounded.windowed.length,
    });
    ctx.enrich.echo(
      buildEffectiveQuery('bill summaries', {
        congress: input.congress,
        billType: input.billType,
        fromDateTime,
        toDateTime: toDateTimeInput,
      }),
    );
    ctx.enrich.total(result.pagination.count);
    notifyIfNoMatches(
      ctx,
      bounded.page,
      'No summaries found. Try broadening the date range or removing billType/congress filters.',
    );

    /**
     * A windowed row's continuation is a single-bill call, so it names the bill
     * the row itself carries — `bill.type` arrives upper-cased upstream and the
     * builder lower-cases it to the code the input enum takes.
     */
    const notice = summaryWindowNotice(bounded, input.limit, (row) => {
      const bill = row.row.bill;
      if (!bill || typeof bill !== 'object' || Array.isArray(bill)) return;
      const { congress, type, number } = bill as Record<string, unknown>;
      if (congress == null || type == null || number == null) return;
      return summaryContinuationCall({
        congress: Number(congress),
        billType: String(type),
        billNumber: String(number),
        versionCode: typeof row.row.versionCode === 'string' ? row.row.versionCode : undefined,
        characterOffset: row.nextOffset ?? 0,
      });
    });
    if (notice) ctx.enrich.notice(notice);

    return bounded.page;
  },
});
