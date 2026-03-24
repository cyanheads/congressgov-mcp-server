/**
 * @fileoverview Tool for browsing and retrieving committee reports from Congress.gov.
 * @module mcp-server/tools/definitions/committee-reports
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

export const committeeReportsTool = tool('congressgov_committee_reports', {
  description: `Browse and retrieve committee reports from Congress.gov.

Committee reports accompany legislation reported out of committee. They explain the bill's purpose, committee amendments, dissenting views, and the committee vote.

Report types:
- hrpt: House reports
- srpt: Senate reports
- erpt: Executive reports`,
  annotations: { readOnlyHint: true, openWorldHint: true },
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
  output: z.object({}).passthrough().describe('Committee report data from Congress.gov API.'),

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listCommitteeReports({
        congress: input.congress,
        reportType: input.reportType,
        limit: input.limit,
        offset: input.offset,
      });
      ctx.log.info('Committee reports listed', {
        congress: input.congress,
        count: result.data.length,
      });
      return result;
    }

    if (!input.reportType || !input.reportNumber) {
      throw new Error(
        `The '${input.operation}' operation requires reportType and reportNumber. Use 'list' to browse available reports.`,
      );
    }

    if (input.operation === 'text') {
      const result = await api.getCommitteeReportText({
        congress: input.congress,
        reportType: input.reportType,
        reportNumber: input.reportNumber,
      });
      ctx.log.info('Committee report text retrieved', {
        congress: input.congress,
        reportType: input.reportType,
        reportNumber: input.reportNumber,
      });
      return result;
    }

    const result = await api.getCommitteeReport({
      congress: input.congress,
      reportType: input.reportType,
      reportNumber: input.reportNumber,
    });
    ctx.log.info('Committee report retrieved', {
      congress: input.congress,
      reportType: input.reportType,
      reportNumber: input.reportNumber,
    });
    return result;
  },
});
