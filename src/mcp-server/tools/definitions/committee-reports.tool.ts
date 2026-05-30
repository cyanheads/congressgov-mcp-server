/**
 * @fileoverview Tool for browsing and retrieving committee reports from Congress.gov.
 * @module mcp-server/tools/definitions/committee-reports
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatCommitteeReports } from '@/mcp-server/tools/format-helpers.js';
import {
  buildEffectiveQuery,
  listEnrichment,
  listOrDetail,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const committeeReportsTool = tool('congressgov_committee_reports', {
  description: `Browse and retrieve committee reports from Congress.gov — reports accompany legislation reported out of committee and explain the bill's purpose, committee amendments, dissenting views, and the committee vote. Report types are 'hrpt' (House), 'srpt' (Senate), and 'erpt' (Executive).`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    operation: z.enum(['list', 'get', 'text']).describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number.'),
    reportType: z
      .enum(['hrpt', 'srpt', 'erpt'])
      .optional()
      .describe('Report type. Required for get and text operations.'),
    reportNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Committee report number. Required for get and text operations.'),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: listOrDetail(
    'report',
    "the committee report (citation, title, committees, associated bill); for `text`, an alternative key 'text' carries an array of {type, url} format links.",
  ),
  enrichment: listEnrichment,
  format: formatCommitteeReports,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listCommitteeReports(
        {
          congress: input.congress,
          reportType: input.reportType,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Committee reports listed', {
        congress: input.congress,
        count: result.data.length,
      });
      ctx.enrich.echo(
        buildEffectiveQuery('committee reports', {
          congress: input.congress,
          reportType: input.reportType,
        }),
      );
      ctx.enrich.total(result.pagination.count);
      if (result.data.length === 0)
        ctx.enrich.notice(
          'No committee reports found. Try removing the reportType filter or check the congress number.',
        );
      return result;
    }

    if (!input.reportType || !input.reportNumber) {
      throw validationError(
        `The '${input.operation}' operation requires reportType and reportNumber. Use 'list' to browse available reports.`,
        {
          operation: input.operation,
          reportType: input.reportType,
          reportNumber: input.reportNumber,
        },
      );
    }

    if (input.operation === 'text') {
      const result = await api.getCommitteeReportText(
        {
          congress: input.congress,
          reportType: input.reportType,
          reportNumber: input.reportNumber,
        },
        ctx,
      );
      ctx.log.info('Committee report text retrieved', {
        congress: input.congress,
        reportType: input.reportType,
        reportNumber: input.reportNumber,
      });
      ctx.enrich.echo(
        `text formats for ${input.reportType.toUpperCase()} ${input.reportNumber} (${input.congress}th Congress)`,
      );
      ctx.enrich.total(Array.isArray(result.text) ? result.text.length : 1);
      return result;
    }

    const result = await api.getCommitteeReport(
      {
        congress: input.congress,
        reportType: input.reportType,
        reportNumber: input.reportNumber,
      },
      ctx,
    );
    ctx.log.info('Committee report retrieved', {
      congress: input.congress,
      reportType: input.reportType,
      reportNumber: input.reportNumber,
    });
    ctx.enrich.echo(
      `${input.reportType.toUpperCase()} ${input.reportNumber} (${input.congress}th Congress)`,
    );
    ctx.enrich.total(1);
    return result;
  },
});
