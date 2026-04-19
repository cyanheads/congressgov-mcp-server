/**
 * @fileoverview Tool for browsing and retrieving U.S. legislative bill data from Congress.gov.
 * @module mcp-server/tools/definitions/bill-lookup
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { formatBills } from '@/mcp-server/tools/format-helpers.js';
import {
  createPaginationSchema,
  normalizeOptionalString,
  StringOrNumberSchema,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import type { BillSubResource } from '@/services/congress-api/types.js';

const PaginationSchema = createPaginationSchema('Total number of matching records.');

const BillDetailSchema = z
  .object({
    congress: StringOrNumberSchema.optional().describe(
      'Congress number when Congress.gov includes it.',
    ),
    type: z.string().optional().describe('Bill type code when provided by Congress.gov.'),
    number: StringOrNumberSchema.optional().describe('Bill number when provided by Congress.gov.'),
    title: z
      .string()
      .optional()
      .describe('Bill title when provided by Congress.gov. Omitted when unknown.'),
    updateDate: z
      .string()
      .optional()
      .describe('Last update timestamp when provided by Congress.gov.'),
    latestAction: z
      .object({
        actionDate: z
          .string()
          .optional()
          .describe('Latest action date when provided by Congress.gov.'),
        text: z.string().optional().describe('Latest action text when provided by Congress.gov.'),
      })
      .passthrough()
      .optional()
      .describe('Latest action summary when provided by Congress.gov.'),
  })
  .passthrough();

const BillTypeEnum = z.enum(['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres']);

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
  description: `Browse and retrieve U.S. legislative bill data from Congress.gov. The API has no keyword search — discover bills by filtering on congress, bill type, and date range, or cross-reference via 'congressgov_bill_summaries' (recent CRS summaries) and 'congressgov_member_lookup' (bills by sponsor). Use 'list' to browse (requires congress), 'get' for full bill detail (sponsor, policy area, CBO estimates, law info), or drill into a specific bill with 'actions', 'amendments', 'cosponsors', 'committees', 'subjects', 'summaries', 'text', 'titles', or 'related' (each requires congress + billType + billNumber). For enacted laws, use 'congressgov_enacted_laws'.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
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
      .describe('Start of date range filter (ISO 8601). Filters by latest action date.'),
    toDateTime: z.string().optional().describe('End of date range filter (ISO 8601).'),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: z
    .object({
      data: z
        .array(z.unknown())
        .optional()
        .describe(
          'List or sub-resource records for list and drill-down operations. Preserves upstream item shapes instead of narrowing them.',
        ),
      pagination: PaginationSchema.optional().describe(
        'Pagination metadata for list and sub-resource operations.',
      ),
      bill: BillDetailSchema.optional().describe('Bill detail for operation="get".'),
    })
    .passthrough()
    .refine((result) => (Array.isArray(result.data) && !!result.pagination) || !!result.bill, {
      message: 'Expected either paginated list data or a bill detail object.',
    })
    .describe('Bill data from Congress.gov API.'),
  format: formatBills,

  async handler(input, ctx) {
    const api = getCongressApi();
    const fromDateTime = normalizeOptionalString(input.fromDateTime);
    const toDateTime = normalizeOptionalString(input.toDateTime);

    if (input.operation === 'list') {
      const result = await api.listBills(
        {
          congress: input.congress,
          billType: input.billType,
          fromDateTime,
          toDateTime,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Bills listed', { congress: input.congress, count: result.data.length });
      return result;
    }

    if (!input.billType || !input.billNumber) {
      throw new Error(
        `The '${input.operation}' operation requires congress, billType, and billNumber. Use 'list' first to find the bill, then request its ${input.operation}.`,
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
    return result;
  },
});
