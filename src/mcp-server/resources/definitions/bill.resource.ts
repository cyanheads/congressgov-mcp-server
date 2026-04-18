/**
 * @fileoverview Resource for fetching bill detail by congress, type, and number.
 * @module mcp-server/resources/definitions/bill
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import type { BillType } from '@/services/congress-api/types.js';

export const billResource = resource('congress://bill/{congress}/{billType}/{billNumber}', {
  name: 'bill-detail',
  description: 'Bill detail: sponsor, status, policy area, committees, latest action.',
  mimeType: 'application/json',
  params: z.object({
    congress: z.string().describe('Congress number (e.g., 118).'),
    billType: z.string().describe('Bill type code (e.g., hr, s, hjres).'),
    billNumber: z.string().describe('Bill number (e.g., 3076).'),
  }),

  async handler(params, ctx) {
    const api = getCongressApi();
    const result = await api.getBill(
      {
        congress: Number(params.congress),
        billType: params.billType as BillType,
        billNumber: Number(params.billNumber),
      },
      ctx,
    );
    ctx.log.info('Bill resource fetched', {
      congress: params.congress,
      billType: params.billType,
      billNumber: params.billNumber,
    });
    return result.bill;
  },
});
