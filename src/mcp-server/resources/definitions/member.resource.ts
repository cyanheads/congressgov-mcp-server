/**
 * @fileoverview Resource for fetching a member profile by bioguide ID.
 * @module mcp-server/resources/definitions/member
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const memberResource = resource('congress://member/{bioguideId}', {
  name: 'member-profile',
  description: 'Member profile: name, state, party, terms, leadership, office, legislation counts.',
  mimeType: 'application/json',
  params: z.object({
    bioguideId: z
      .string()
      .regex(
        /^[A-Z]\d{6}$/,
        'Bioguide ID must be one uppercase letter followed by 6 digits (e.g., P000197).',
      )
      .describe('Bioguide identifier for the member (e.g., P000197).'),
  }),

  async handler(params, ctx) {
    const api = getCongressApi();
    const result = await api.getMember(params.bioguideId, ctx);
    ctx.log.info('Member resource fetched', { bioguideId: params.bioguideId });
    return result.member;
  },
});
