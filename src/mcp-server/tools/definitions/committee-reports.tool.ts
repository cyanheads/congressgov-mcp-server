/**
 * @fileoverview Tool for browsing and retrieving committee reports from Congress.gov.
 * @module mcp-server/tools/definitions/committee-reports
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatCommitteeReports } from '@/mcp-server/tools/format-helpers.js';
import {
  buildEffectiveQuery,
  congressErrorContracts,
  documentErrorContracts,
  documentWindowInput,
  listEnrichment,
  listOrDetail,
  notifyIfNoMatches,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { getCongressDocuments } from '@/services/congress-documents/congress-documents-service.js';
import {
  describeFormat,
  selectDocumentUrl,
} from '@/services/congress-documents/document-formats.js';

/**
 * Committee report text arrives as `[{formats:[…]}, …]` — one format per entry,
 * unlike bill text versions, which carry every format on a single row. Flatten so
 * the format selector sees them all.
 */
function collectReportFormats(text: unknown): unknown[] {
  if (!Array.isArray(text)) return [];
  return text.flatMap((entry) => {
    const formats = (entry as { formats?: unknown } | null | undefined)?.formats;
    return Array.isArray(formats) ? formats : [];
  });
}

export const committeeReportsTool = tool('congressgov_committee_reports', {
  description: `Browse and retrieve committee reports from Congress.gov — reports accompany legislation reported out of committee and explain the bill's purpose, committee amendments, dissenting views, and the committee vote. Report types are 'hrpt' (House), 'srpt' (Senate), and 'erpt' (Executive). 'text' lists the published format URLs; 'content' then reads the report's actual text, a bounded character window at a time.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [...congressErrorContracts, ...documentErrorContracts],
  input: z.object({
    operation: z.enum(['list', 'get', 'text', 'content']).describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number.'),
    reportType: z
      .enum(['hrpt', 'srpt', 'erpt'])
      .optional()
      .describe('Report type. Required for get, text, and content operations.'),
    reportNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Committee report number. Required for get, text, and content operations.'),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
    ...documentWindowInput,
  }),
  output: listOrDetail(
    'report',
    "the committee report (citation, title, committees, associated bill); for `text`, an alternative key 'text' carries an array of {type, url} format links; for `content`, an alternative key 'content' carries {text, format, sourceUrl, documentTitle, totalCharacters, offset, truncated, nextOffset} — one exact character window of the report.",
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
      notifyIfNoMatches(
        ctx,
        result,
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

    if (input.operation === 'content') {
      const citation = `${input.reportType.toUpperCase()} ${input.congress}-${input.reportNumber}`;
      const result = await api.getCommitteeReportText(
        {
          congress: input.congress,
          reportType: input.reportType,
          reportNumber: input.reportNumber,
        },
        ctx,
      );

      const formats = collectReportFormats(result.text);
      if (formats.length === 0) {
        throw ctx.fail(
          'document_unavailable',
          `Committee report ${citation} publishes no document formats.`,
          {
            ...ctx.recoveryFor('document_unavailable'),
            congress: input.congress,
            reportType: input.reportType,
            reportNumber: input.reportNumber,
          },
        );
      }

      const url = selectDocumentUrl(formats, input.format);
      if (!url) {
        throw ctx.fail(
          'format_unavailable',
          `Committee report ${citation} publishes no '${input.format}' document (looked for ${describeFormat(input.format)}).`,
          { ...ctx.recoveryFor('format_unavailable'), format: input.format },
        );
      }

      const document = await getCongressDocuments().fetchDocument(
        {
          url,
          characterOffset: input.characterOffset,
          characterLimit: input.characterLimit,
        },
        ctx,
      );
      ctx.log.info('Committee report content retrieved', {
        congress: input.congress,
        reportType: input.reportType,
        reportNumber: input.reportNumber,
        format: input.format,
        totalCharacters: document.totalCharacters,
      });
      ctx.enrich.echo(
        `${citation}, ${input.format} characters ${document.offset}–${document.offset + document.text.length}`,
      );
      ctx.enrich.total(document.totalCharacters);
      return {
        content: {
          ...document,
          format: input.format,
          sourceUrl: url,
          documentTitle: `Committee Report ${citation}`,
        },
      };
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
