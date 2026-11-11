/**
 * @fileoverview Tool for browsing, retrieving, and reading CRS policy analysis reports.
 * @module mcp-server/tools/definitions/crs-reports
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatCrsReports } from '@/mcp-server/tools/format-helpers.js';
import {
  addNotice,
  buildEffectiveQuery,
  congressErrorContracts,
  documentErrorContracts,
  documentWindowInput,
  identityErrorContracts,
  listEnrichment,
  listOrDetail,
  normalizeOptionalString,
  noticeIgnoredInputs,
  notifyIfNoMatches,
  validateDateTimeRange,
  validateIsoDateTime,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { getCongressDocuments } from '@/services/congress-documents/congress-documents-service.js';
import { selectCrsDocumentUrl } from '@/services/congress-documents/document-formats.js';

/**
 * A CRS report ID as callers send it: letters then digits (`R40097`, `IF12218`) or
 * two digit groups joined by a hyphen (`96-548`), in either case, padded with
 * whitespace, or blank. JSON Schema carries no case flag or trim, so the pattern
 * spells out every raw form and `toReportId` normalizes. Adjacent pieces match
 * disjoint characters and the only trailing `\s*` sits inside the optional group,
 * so a match runs in linear time.
 */
const REPORT_ID_PATTERN = /^\s*(?:(?:[A-Za-z]+\d+|\d+-\d+)\s*)?$/;

/** The ID the API path takes: trimmed and upper-cased (Congress.gov 404s `r40097`); blank is unset. */
function toReportId(value: string | undefined): string | undefined {
  return normalizeOptionalString(value)?.toUpperCase();
}

/**
 * One `limit`/`offset` page of a report's related materials. Congress.gov ignores
 * paging on `/crsreport/{id}` and returns the whole list (R46406: 168 rows, 163
 * once the service drops repeated URLs), so the page is a slice of that one
 * response. A list that fits the first page is returned as served; any other page
 * adds the total and the next offset, with a notice naming the rows returned.
 */
function pageRelatedMaterials(
  ctx: Context,
  report: Record<string, unknown>,
  { offset, limit }: { offset: number; limit: number },
): Record<string, unknown> {
  const all = report.relatedMaterials;
  if (!Array.isArray(all) || (offset === 0 && all.length <= limit)) return report;
  const rows = all.slice(offset, offset + limit);
  const end = offset + rows.length;
  const nextOffset = end < all.length ? end : null;
  addNotice(
    ctx,
    rows.length === 0
      ? `offset ${offset} is past the end of this report's ${all.length} related materials; restart at offset 0.`
      : `Related materials ${offset + 1}–${end} of ${all.length} returned; ${nextOffset === null ? 'this is the last page.' : `pass offset ${nextOffset} for the next page.`}`,
  );
  return {
    ...report,
    relatedMaterials: rows,
    relatedMaterialsCount: all.length,
    relatedMaterialsNextOffset: nextOffset,
  };
}

export const crsReportsTool = tool('congressgov_crs_reports', {
  title: 'Congress.gov CRS Reports',
  description: `Browse, retrieve, and read CRS (Congressional Research Service) reports — nonpartisan policy analyses by subject-matter experts at the Library of Congress, covering policy areas, legislative proposals, and legal questions. Report IDs are letters then digits (R40097, RL33612, IF12345) or, for older reports, two digit groups joined by a hyphen (96-548). Use 'list' to browse available reports, newest update first, 'get' for full detail (authors, topics, summary, download formats, and related materials, which limit and offset page: relatedMaterialsCount and relatedMaterialsNextOffset appear when a page leaves rows out), or 'content' to read the report itself — its HTML version as plain text, a bounded character window at a time; feed nextOffset back as characterOffset to read on. The oldest reports publish only a PDF, which 'content' cannot read; the error names its URL. 'list' takes fromDateTime/toDateTime, which filter on the date Congress.gov last updated a report — not its publication date — so a window finds reports added or revised in it.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [...congressErrorContracts, ...documentErrorContracts, ...identityErrorContracts],
  inputAliases: { id: 'reportNumber', reportId: 'reportNumber', report_id: 'reportNumber' },
  input: z.object({
    operation: z.enum(['list', 'get', 'content']).describe('Which data to retrieve.'),
    reportNumber: z
      .string()
      .regex(
        REPORT_ID_PATTERN,
        'Must be a CRS report ID: letters then digits (R40097) or two digit groups joined by a hyphen (96-548).',
      )
      .optional()
      .describe(
        "CRS report ID — letters then digits (e.g. 'R40097', 'IF12345') or two digit groups joined by a hyphen (e.g. '96-548'). Case and surrounding whitespace are ignored. Required for 'get' and 'content'.",
      ),
    fromDateTime: z
      .string()
      .optional()
      .describe(
        "Start of the update-date window for 'list' (ISO 8601, e.g. 2026-10-01T00:00:00Z): the date Congress.gov last updated a report, not its publication date. Ignored by other operations.",
      ),
    toDateTime: z
      .string()
      .optional()
      .describe(
        "End of the update-date window for 'list' (ISO 8601). Same field semantics as fromDateTime. Ignored by other operations.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(250)
      .default(20)
      .describe("Results per page (1-250): reports on 'list', related materials on 'get'."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Pagination offset: into the report list on 'list', into the report's related materials on 'get'.",
      ),
    ...documentWindowInput,
  }),
  output: listOrDetail(
    { report: 'record', content: 'record' },
    "CRS report record for `get` (authors, topics, summary, formats, and one limit/offset page of related materials); absent for `list`. For `content`, an alternative key 'content' carries {text, format, sourceUrl, documentTitle, totalCharacters, offset, truncated, nextOffset} — one exact character window of the report's HTML version read as plain text.",
    {
      report: z
        .object({
          relatedMaterialsCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              "Total related materials the report lists. Present when 'get' returns part of the list: the list runs past limit, or offset is past 0.",
            ),
          relatedMaterialsNextOffset: z
            .number()
            .int()
            .nonnegative()
            .nullable()
            .optional()
            .describe(
              'The offset that returns the next page of related materials, or null on the last page. Present with relatedMaterialsCount.',
            ),
        })
        .passthrough()
        .optional()
        .describe(
          'CRS report record for `get`: authors, topics, summary, formats, and one page of related materials.',
        ),
    },
  ),
  enrichment: listEnrichment,
  format: formatCrsReports,

  async handler(input, ctx) {
    const api = getCongressApi();
    const reportNumber = toReportId(input.reportNumber);
    const fromDateTime = validateIsoDateTime(
      normalizeOptionalString(input.fromDateTime),
      'fromDateTime',
    );
    const toDateTime = validateIsoDateTime(normalizeOptionalString(input.toDateTime), 'toDateTime');
    validateDateTimeRange(fromDateTime, toDateTime);

    if (input.operation === 'list') {
      if (reportNumber) {
        throw ctx.fail(
          'incompatible_identity',
          "'list' does not use reportNumber. Remove reportNumber to browse, or use 'get' or 'content' with reportNumber.",
          { field: 'reportNumber', operation: input.operation },
        );
      }
      const result = await api.listCrsReports(
        { limit: input.limit, offset: input.offset, fromDateTime, toDateTime },
        ctx,
      );
      ctx.log.info('CRS reports listed', { count: result.data.length });
      ctx.enrich.echo(buildEffectiveQuery('CRS reports', { fromDateTime, toDateTime }));
      ctx.enrich.total(result.pagination.count);
      notifyIfNoMatches(
        ctx,
        result,
        fromDateTime || toDateTime
          ? 'No CRS reports found with an update date in that window. Widen or remove fromDateTime/toDateTime.'
          : 'No CRS reports found. The endpoint may be temporarily unavailable.',
      );
      return result;
    }

    if (!reportNumber) {
      throw validationError(
        `The '${input.operation}' operation requires reportNumber. Report IDs are letters then digits (R40097) or two digit groups joined by a hyphen (96-548). Use 'list' to browse available reports.`,
        { field: 'reportNumber' },
      );
    }
    noticeIgnoredInputs(ctx, input.operation, { fromDateTime, toDateTime });

    const result = await api.getCrsReport({ reportNumber }, ctx);

    if (input.operation === 'content') {
      /** The HTML path does not follow the ID, so the URL is the one `formats` publishes. */
      const url = selectCrsDocumentUrl(result.report.formats, reportNumber);
      const document = await getCongressDocuments().fetchDocument(
        {
          url,
          characterOffset: input.characterOffset,
          characterLimit: input.characterLimit,
          reading: 'html',
        },
        ctx,
      );
      ctx.log.info('CRS report content retrieved', {
        reportNumber,
        totalCharacters: document.totalCharacters,
      });
      ctx.enrich.echo(
        `CRS report ${reportNumber}, html characters ${document.offset}–${document.offset + document.text.length}`,
      );
      ctx.enrich.total(document.totalCharacters);
      return {
        content: {
          ...document,
          format: 'html',
          sourceUrl: url,
          documentTitle: `CRS Report ${reportNumber}`,
        },
      };
    }

    ctx.log.info('CRS report retrieved', { reportNumber });
    ctx.enrich.echo(`CRS report ${reportNumber}`);
    ctx.enrich.total(1);
    return { report: pageRelatedMaterials(ctx, result.report, input) };
  },
});
