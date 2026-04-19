/**
 * @fileoverview Tool for browsing and retrieving CRS policy analysis reports.
 * @module mcp-server/tools/definitions/crs-reports
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { formatCrsReports } from '@/mcp-server/tools/format-helpers.js';
import { createPaginationSchema } from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

const PaginationSchema = createPaginationSchema('Total number of matching CRS reports.');

const CrsReportSchema = z
  .object({
    reportNumber: z
      .string()
      .optional()
      .describe('CRS report identifier when provided by Congress.gov.'),
    title: z
      .string()
      .optional()
      .describe('CRS report title when provided by Congress.gov. Omitted when unknown.'),
    summary: z
      .string()
      .optional()
      .describe('CRS report summary when provided by Congress.gov. Omitted when unknown.'),
    updateDate: z
      .string()
      .optional()
      .describe('Last update timestamp when provided by Congress.gov.'),
  })
  .passthrough();

export const crsReportsTool = tool('congressgov_crs_reports', {
  description: `Browse and retrieve CRS (Congressional Research Service) reports — nonpartisan policy analyses by subject-matter experts at the Library of Congress, covering policy areas, legislative proposals, and legal questions. Report IDs use letter-number codes (e.g., R40097, RL33612, IF12345). Use 'list' to browse available reports or 'get' for full detail (authors, topics, summary, download formats).`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    operation: z.enum(['list', 'get']).describe('Which data to retrieve.'),
    reportNumber: z
      .string()
      .optional()
      .describe("CRS report ID (e.g., 'R40097'). Required for 'get'."),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: z
    .object({
      data: z
        .array(z.unknown())
        .optional()
        .describe(
          'CRS report list results when operation="list". Preserves upstream item shapes instead of narrowing them.',
        ),
      pagination: PaginationSchema.optional().describe('Pagination metadata for list results.'),
      report: CrsReportSchema.optional().describe('CRS report detail when operation="get".'),
    })
    .passthrough()
    .refine((result) => (Array.isArray(result.data) && !!result.pagination) || !!result.report, {
      message: 'Expected either paginated list data or a CRS report detail object.',
    })
    .describe('CRS report data from Congress.gov API.'),
  format: formatCrsReports,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listCrsReports({ limit: input.limit, offset: input.offset }, ctx);
      ctx.log.info('CRS reports listed', { count: result.data.length });
      return result;
    }

    if (!input.reportNumber) {
      throw new Error(
        "The 'get' operation requires reportNumber. Report IDs use letter-number codes (e.g., R40097). Use 'list' to browse available reports.",
      );
    }

    const result = await api.getCrsReport({ reportNumber: input.reportNumber }, ctx);
    ctx.log.info('CRS report retrieved', { reportNumber: input.reportNumber });
    return result;
  },
});
