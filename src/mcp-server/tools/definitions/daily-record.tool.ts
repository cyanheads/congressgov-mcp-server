/**
 * @fileoverview Tool for browsing the daily Congressional Record.
 * @module mcp-server/tools/definitions/daily-record
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatDailyRecord } from '@/mcp-server/tools/format-helpers.js';
import {
  congressErrorContracts,
  listEnrichment,
  listOutput,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const dailyRecordTool = tool('congressgov_daily_record', {
  description: `Browse the daily Congressional Record — floor speeches, debates, and legislative text published each day Congress is in session. Navigation is hierarchical: volumes (via 'list') → issues (via 'issues') → articles (via 'articles'). Use 'list' to find recent volumes, 'issues' to see what's in a volume, and 'articles' to access individual speeches and debate sections.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: congressErrorContracts,
  input: z.object({
    operation: z.enum(['list', 'issues', 'articles']).describe('Which data to retrieve.'),
    volumeNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Volume number. Required for 'issues' and 'articles'."),
    issueNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Issue number within a volume. Required for 'articles'."),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: listOutput,
  enrichment: listEnrichment,
  format: formatDailyRecord,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listDailyRecord({ limit: input.limit, offset: input.offset }, ctx);
      ctx.log.info('Daily record listed');
      ctx.enrich.echo('Congressional Record volumes');
      ctx.enrich.total(result.pagination.count);
      if (result.data.length === 0) ctx.enrich.notice('No Congressional Record volumes found.');
      return result;
    }

    if (!input.volumeNumber) {
      throw validationError(
        `The '${input.operation}' operation requires volumeNumber. Use 'list' to browse available Congressional Record volumes.`,
        { field: 'volumeNumber', operation: input.operation },
      );
    }

    if (input.operation === 'issues') {
      const result = await api.getDailyIssues(
        {
          volumeNumber: input.volumeNumber,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Daily record issues retrieved', { volumeNumber: input.volumeNumber });
      ctx.enrich.echo(`issues for volume ${input.volumeNumber}`);
      ctx.enrich.total(result.pagination.count);
      if (result.data.length === 0)
        ctx.enrich.notice(`No issues found for volume ${input.volumeNumber}.`);
      return result;
    }

    if (!input.issueNumber) {
      throw validationError(
        "The 'articles' operation requires both volumeNumber and issueNumber. Use 'issues' to see available issues within a volume.",
        { field: 'issueNumber' },
      );
    }

    const result = await api.getDailyArticles(
      {
        volumeNumber: input.volumeNumber,
        issueNumber: input.issueNumber,
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );
    ctx.log.info('Daily record articles retrieved', {
      volumeNumber: input.volumeNumber,
      issueNumber: input.issueNumber,
    });
    ctx.enrich.echo(`articles for volume ${input.volumeNumber}, issue ${input.issueNumber}`);
    ctx.enrich.total(result.pagination.count);
    if (result.data.length === 0)
      ctx.enrich.notice(
        `No articles found for volume ${input.volumeNumber}, issue ${input.issueNumber}.`,
      );
    return result;
  },
});
