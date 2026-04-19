/**
 * @fileoverview Resource for fetching committee detail by system code.
 * @module mcp-server/resources/definitions/committee
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const committeeResource = resource('congress://committee/{committeeCode}', {
  name: 'committee-detail',
  description: 'Committee detail: name, chamber, subcommittees, history, legislation counts.',
  mimeType: 'application/json',
  params: z.object({
    committeeCode: z.string().describe("Committee system code (e.g., 'hsju00')."),
  }),

  async handler(params, ctx) {
    const api = getCongressApi();
    const chamber = params.committeeCode.startsWith('s')
      ? 'senate'
      : params.committeeCode.startsWith('j')
        ? 'joint'
        : 'house';
    const result = await api.getCommittee(chamber, params.committeeCode, ctx);
    ctx.log.info('Committee resource fetched', { committeeCode: params.committeeCode });
    return result.committee;
  },
});
