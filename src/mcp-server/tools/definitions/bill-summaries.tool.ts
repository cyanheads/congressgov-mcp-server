/**
 * @fileoverview Tool for browsing recent CRS bill summaries — the "what's happening" feed.
 * @module mcp-server/tools/definitions/bill-summaries
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { formatResult } from '@/mcp-server/tools/format-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const billSummariesTool = tool('congressgov_bill_summaries', {
  description: `Browse recent CRS (Congressional Research Service) bill summaries.

This is the best tool for answering "what's happening in Congress?" — CRS analysts write plain-language summaries of bills at each legislative stage.

By default, returns summaries from the last 7 days. Specify fromDateTime/toDateTime for custom ranges. Each summary includes the associated bill reference (congress, type, number) for follow-up with congressgov_bill_lookup.`,
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
  output: z.object({}).passthrough().describe('Bill summary data from Congress.gov API.'),
  format: formatResult,

  async handler(input, ctx) {
    if (input.billType && !input.congress) {
      throw new Error(
        "The 'billType' filter requires 'congress'. Provide both or omit billType to browse across all types.",
      );
    }

    const fromDateTime =
      input.fromDateTime ??
      (!input.toDateTime
        ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
        : undefined);

    const api = getCongressApi();
    const result = await api.listSummaries({
      congress: input.congress,
      billType: input.billType,
      fromDateTime,
      toDateTime: input.toDateTime,
      limit: input.limit,
      offset: input.offset,
    });
    ctx.log.info('Summaries listed', { count: result.data.length });
    return result;
  },
});
