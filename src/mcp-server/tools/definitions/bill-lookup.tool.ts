/**
 * @fileoverview Tool for browsing and retrieving U.S. legislative bill data from Congress.gov.
 * @module mcp-server/tools/definitions/bill-lookup
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatBills } from '@/mcp-server/tools/format-helpers.js';
import {
  buildEffectiveQuery,
  congressErrorContracts,
  listEnrichment,
  listOrDetail,
  normalizeOptionalString,
  validateIsoDateTime,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { BILL_TYPE_CODES, type BillSubResource } from '@/services/congress-api/types.js';

const BillTypeEnum = z.enum(BILL_TYPE_CODES);

const OperationEnum = z.enum([
  'list',
  'get',
  'actions',
  'amendments',
  'cosponsors',
  'committees',
  'subjects',
  'summaries',
  'text',
  'titles',
  'related',
]);

const SUB_RESOURCE_MAP: Record<string, string> = {
  related: 'relatedbills',
};

export const billLookupTool = tool('congressgov_bill_lookup', {
  description: `Browse and retrieve U.S. legislative bill data from Congress.gov. Discover bills by filtering on congress, bill type, and date range — there is no keyword search. Use 'list' to browse (requires congress, defaults to most-recently-updated first), 'get' for full bill detail (sponsor, policy area, CBO estimates, law info), or drill into a specific bill with 'actions', 'amendments', 'cosponsors', 'committees', 'subjects', 'summaries', 'text', 'titles', or 'related' (each requires congress + billType + billNumber).`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: congressErrorContracts,
  input: z.object({
    operation: OperationEnum.describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number (e.g., 118, 119).'),
    billType: BillTypeEnum.optional().describe(
      'Bill type code. Required for get and sub-resource operations.',
    ),
    billNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Bill number. Required for get and sub-resource operations.'),
    fromDateTime: z
      .string()
      .optional()
      .describe(
        "Start of date range filter (ISO 8601). Filters by the bill's update date — when Congress.gov last touched the record — not by the bill's latest legislative action.",
      ),
    toDateTime: z
      .string()
      .optional()
      .describe('End of date range filter (ISO 8601). Same field semantics as fromDateTime.'),
    order: z
      .enum(['recent', 'oldest'])
      .default('recent')
      .describe(
        "Sort order for 'list' (sorts by update date). 'recent' (default) is newest first; 'oldest' is ascending. Ignored by other operations.",
      ),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: listOrDetail(
    'bill',
    'Bill record (sponsor, policy area, latest action, CBO estimates, law citation) for `get`; absent for `list` and sub-resources.',
  ),
  enrichment: listEnrichment,
  format: formatBills,

  async handler(input, ctx) {
    const api = getCongressApi();
    const fromDateTime = validateIsoDateTime(
      normalizeOptionalString(input.fromDateTime),
      'fromDateTime',
    );
    const toDateTime = validateIsoDateTime(normalizeOptionalString(input.toDateTime), 'toDateTime');

    if (input.operation === 'list') {
      const result = await api.listBills(
        {
          congress: input.congress,
          billType: input.billType,
          fromDateTime,
          toDateTime,
          sort: input.order === 'oldest' ? 'updateDate asc' : 'updateDate desc',
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Bills listed', { congress: input.congress, count: result.data.length });
      ctx.enrich.echo(
        buildEffectiveQuery('bills', {
          congress: input.congress,
          billType: input.billType,
          fromDateTime,
          toDateTime,
        }),
      );
      ctx.enrich.total(result.pagination.count);
      if (result.data.length === 0)
        ctx.enrich.notice(
          'No bills matched the filters. Try broadening the date range or removing billType.',
        );
      return result;
    }

    if (!input.billType || !input.billNumber) {
      throw validationError(
        `The '${input.operation}' operation requires congress, billType, and billNumber. Use 'list' first to find the bill, then request its ${input.operation}.`,
        { operation: input.operation, billType: input.billType, billNumber: input.billNumber },
      );
    }

    if (input.operation === 'get') {
      const result = await api.getBill(
        {
          congress: input.congress,
          billType: input.billType,
          billNumber: input.billNumber,
        },
        ctx,
      );
      ctx.log.info('Bill retrieved', {
        congress: input.congress,
        billType: input.billType,
        billNumber: input.billNumber,
      });
      ctx.enrich.echo(
        `${input.billType.toUpperCase()} ${input.billNumber} in the ${input.congress}th Congress`,
      );
      ctx.enrich.total(1);
      return result;
    }

    const subResource = SUB_RESOURCE_MAP[input.operation] ?? input.operation;
    const result = await api.getBillSubResource(
      {
        congress: input.congress,
        billType: input.billType,
        billNumber: input.billNumber,
        subResource: subResource as BillSubResource,
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );
    ctx.log.info('Bill sub-resource retrieved', {
      congress: input.congress,
      billType: input.billType,
      billNumber: input.billNumber,
      subResource,
    });
    ctx.enrich.echo(
      `${input.operation} for ${input.billType.toUpperCase()} ${input.billNumber} in the ${input.congress}th Congress`,
    );
    ctx.enrich.total(result.pagination.count);
    if (result.data.length === 0)
      ctx.enrich.notice(
        `No ${input.operation} found for ${input.billType.toUpperCase()} ${input.billNumber}.`,
      );
    return result;
  },
});
