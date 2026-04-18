/**
 * @fileoverview Tool for browsing recent CRS bill summaries — the "what's happening" feed.
 * @module mcp-server/tools/definitions/bill-summaries
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { formatSummaries } from '@/mcp-server/tools/format-helpers.js';
import {
  createPaginationSchema,
  normalizeOptionalString,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const PaginationSchema = createPaginationSchema('Total number of matching summaries.');

export const billSummariesTool = tool('congressgov_bill_summaries', {
  description: `Browse recent CRS (Congressional Research Service) bill summaries — plain-language summaries of bills at each legislative stage, and the best tool for answering "what's happening in Congress?". Defaults to the last 7 days; specify fromDateTime/toDateTime for custom ranges. Each summary includes the associated bill reference (congress, type, number) for follow-up with 'congressgov_bill_lookup'.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    congress: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Congress number. Optional — omit for summaries across all congresses.'),
    billType: z
      .enum(['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres'])
      .optional()
      .describe("Bill type filter. Requires 'congress'."),
    fromDateTime: z
      .string()
      .optional()
      .describe(
        'Start of date range (ISO 8601). Defaults to 7 days ago if neither date param is set.',
      ),
    toDateTime: z.string().optional().describe('End of date range (ISO 8601). Defaults to now.'),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: z
    .object({
      data: z
        .array(z.unknown())
        .describe(
          'Bill summaries returned by Congress.gov. Preserves upstream item shapes instead of narrowing them.',
        ),
      pagination: PaginationSchema.describe('Pagination metadata for the returned summaries.'),
      rawResponse: z
        .unknown()
        .optional()
        .describe('Full upstream Congress.gov response envelope before normalization.'),
    })
    .passthrough()
    .describe('Bill summary data from Congress.gov API.'),
  format: formatSummaries,

  async handler(input, ctx) {
    const fromDateTimeInput = normalizeOptionalString(input.fromDateTime);
    const toDateTimeInput = normalizeOptionalString(input.toDateTime);

    if (input.billType && !input.congress) {
      throw new Error(
        "The 'billType' filter requires 'congress'. Provide both or omit billType to browse across all types.",
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
    ctx.log.info('Summaries listed', { count: result.data.length });
    return result;
  },
});
