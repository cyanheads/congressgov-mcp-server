/**
 * @fileoverview Resource providing current congress number, session dates, and chamber info.
 * @module mcp-server/resources/definitions/current-congress
 */

import { resource } from '@cyanheads/mcp-ts-core';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const currentCongressResource = resource('congress://current', {
  name: 'current-congress',
  description:
    'Current congress number, session dates, and chamber info. Baseline context for queries.',
  mimeType: 'application/json',

  list: async () => ({
    resources: [
      { uri: 'congress://current', name: 'Current Congress', mimeType: 'application/json' },
    ],
  }),

  async handler(_params, ctx) {
    const api = getCongressApi();
    const congress = await api.getCurrentCongress(ctx);
    ctx.log.info('Current congress fetched', { congress: congress.congress });
    return congress;
  },
});
