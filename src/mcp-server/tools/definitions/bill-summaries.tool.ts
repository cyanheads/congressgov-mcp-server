/**
 * @fileoverview Tool for browsing recent CRS bill summaries — the "what's happening" feed.
 * @module mcp-server/tools/definitions/bill-summaries
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatSummaries } from '@/mcp-server/tools/format-helpers.js';
import {
  buildEffectiveQuery,
  congressErrorContracts,
  listEnrichment,
  listOutput,
  normalizeOptionalString,
  validateIsoDateTime,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { BILL_TYPE_CODES } from '@/services/congress-api/types.js';

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export const billSummariesTool = tool('congressgov_bill_summaries', {
  description: `Browse recent CRS (Congressional Research Service) bill summaries — plain-language summaries of bills at each legislative stage, useful for answering "what's happening in Congress?". The fromDateTime/toDateTime filters apply to the summary's update time, not the bill's action date, so results include recently rewritten summaries of older bills. Defaults to summaries updated in the last 7 days. Each item shows both the bill's action date and the summary update date. For summaries of one specific bill, use congressgov_bill_lookup with operation='summaries' instead.`,
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
    ctx.log.info('Summaries listed', { count: result.data.length });
    ctx.enrich.echo(
      buildEffectiveQuery('bill summaries', {
        congress: input.congress,
        billType: input.billType,
        fromDateTime,
        toDateTime: toDateTimeInput,
      }),
    );
    ctx.enrich.total(result.pagination.count);
    if (result.data.length === 0)
      ctx.enrich.notice(
        'No summaries found. Try broadening the date range or removing billType/congress filters.',
      );
    return result;
  },
});
