/**
 * @fileoverview Tool for browsing and retrieving U.S. legislative bill data from Congress.gov.
 * @module mcp-server/tools/definitions/bill-lookup
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import type { BillSubResource } from '@/services/congress-api/types.js';

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
  description: `Browse and retrieve U.S. legislative bill data from Congress.gov.

IMPORTANT: This API has no keyword search. To find bills, filter by congress number, bill type, and/or date range. Use 'congressgov_bill_summaries' to discover recently summarized legislation, or 'congressgov_member_lookup' to find bills via their sponsor.

Operations:
- list: Browse bills. Requires 'congress'. Add 'billType' to narrow by chamber/type.
- get: Full bill detail including sponsor, policy area, CBO estimates, and law info.
- actions/amendments/cosponsors/committees/subjects/summaries/text/titles/related: Sub-resources for a specific bill. Require congress + billType + billNumber.

For enacted laws, use 'congressgov_enacted_laws' instead.`,
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
  output: z.object({}).passthrough().describe('Bill data from Congress.gov API.'),

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listBills({
        congress: input.congress,
        billType: input.billType,
        fromDateTime: input.fromDateTime,
        toDateTime: input.toDateTime,
        limit: input.limit,
        offset: input.offset,
      });
      ctx.log.info('Bills listed', { congress: input.congress, count: result.data.length });
      return result;
    }

    if (!input.billType || !input.billNumber) {
      throw new Error(
        `The '${input.operation}' operation requires congress, billType, and billNumber. Use 'list' first to find the bill, then request its ${input.operation}.`,
      );
    }

    if (input.operation === 'get') {
      const result = await api.getBill({
        congress: input.congress,
        billType: input.billType,
        billNumber: input.billNumber,
      });
      ctx.log.info('Bill retrieved', {
        congress: input.congress,
        billType: input.billType,
        billNumber: input.billNumber,
      });
      return result;
    }

    const subResource = SUB_RESOURCE_MAP[input.operation] ?? input.operation;
    const result = await api.getBillSubResource({
      congress: input.congress,
      billType: input.billType,
      billNumber: input.billNumber,
      subResource: subResource as BillSubResource,
      limit: input.limit,
      offset: input.offset,
    });
    ctx.log.info('Bill sub-resource retrieved', {
      congress: input.congress,
      billType: input.billType,
      billNumber: input.billNumber,
      subResource,
    });
    return result;
  },
});
