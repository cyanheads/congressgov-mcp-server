/**
 * @fileoverview Tool for browsing and retrieving committee reports from Congress.gov.
 * @module mcp-server/tools/definitions/committee-reports
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatCommitteeReports } from '@/mcp-server/tools/format-helpers.js';
import {
  anyLetterCase,
  buildEffectiveQuery,
  congressErrorContracts,
  documentErrorContracts,
  documentFormatInput,
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
import {
  describeFormat,
  formatUrlPart,
  selectDocumentUrl,
} from '@/services/congress-documents/document-formats.js';
import { ordinal } from '@/utils/congress-calendar.js';

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

/** The part a format entry belongs to: its URL's `-pt{N}` marker, else 1. */
function formatPart(format: unknown): number {
  const url = (format as { url?: unknown } | null | undefined)?.url;
  return typeof url === 'string' ? formatUrlPart(url) : 1;
}

/** The part a report record describes: upstream `part`, a number or digit string, else 1. */
function recordPart(record: Record<string, unknown>): number {
  const { part } = record;
  if (typeof part === 'number' && Number.isInteger(part) && part > 0) return part;
  if (typeof part === 'string' && /^\s*0*[1-9]\d*\s*$/.test(part)) return Number(part);
  return 1;
}

/** An errata reprint of a part, which files under the part number it corrects. */
function isErrataRecord(record: Record<string, unknown>): boolean {
  return typeof record.citation === 'string' && /errata/i.test(record.citation);
}

/** The sorted distinct parts; a report that names none is Part 1 alone. */
function distinctParts(parts: number[]): number[] {
  const sorted = [...new Set(parts)].sort((a, b) => a - b);
  return sorted.length > 0 ? sorted : [1];
}

/** The `/text` entries of one part: other parts' formats dropped, and entries left with none. */
function partTextEntries(text: unknown[], part: number): unknown[] {
  return text.flatMap((entry) => {
    const formats = (entry as { formats?: unknown } | null | undefined)?.formats;
    if (!Array.isArray(formats)) return [entry];
    const kept = formats.filter((format) => formatPart(format) === part);
    if (kept.length === formats.length) return [entry];
    return kept.length > 0 ? [{ ...(entry as Record<string, unknown>), formats: kept }] : [];
  });
}

const committeeReportsOutput = listOrDetail(
  { report: 'record', text: 'records', content: 'record' },
  "the committee report (citation, title, committees, associated bill) — the selected part's record for a multi-part report; for `text`, an alternative key 'text' carries an array of {type, url} format links for the selected part; for `content`, an alternative key 'content' carries {text, format, sourceUrl, documentTitle, totalCharacters, offset, truncated, nextOffset} — one exact character window of the selected part's text.",
  {
    parts: z
      .array(z.number().int().positive().describe('A part number.'))
      .optional()
      .describe(
        "Every part number the report is filed in, ascending, on 'get', 'text', and 'content' for a report Congress.gov files in more than one part; absent for a single-part report. The response describes the part the part input selected.",
      ),
  },
);

export const committeeReportsTool = tool('congressgov_committee_reports', {
  title: 'Congress.gov Committee Reports',
  description: `Browse and retrieve committee reports from Congress.gov — reports accompany legislation reported out of committee and explain the bill's purpose, committee amendments, dissenting views, and the committee vote. Report types are 'hrpt' (House), 'srpt' (Senate), and 'erpt' (Executive). 'list' is not ordered by date; it takes fromDateTime/toDateTime, which filter on the date Congress.gov last updated a report record, and conference, which selects conference reports — list rows carry no conference field. 'text' lists the published format URLs; 'content' then reads the report's actual text, a bounded character window at a time. A multi-part report (Part 2, Book 3) is filed as one record per part under one report number: 'get', 'text', and 'content' serve Part 1 unless part names another, and list every part number in parts.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [...congressErrorContracts, ...documentErrorContracts, ...identityErrorContracts],
  input: z.object({
    operation: z.enum(['list', 'get', 'text', 'content']).describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number.'),
    reportType: anyLetterCase(z.enum(['hrpt', 'srpt', 'erpt']))
      .optional()
      .describe('Report type. Required for get, text, and content operations.'),
    reportNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Committee report number. Required for get, text, and content operations.'),
    part: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Which part of a multi-part report 'get', 'text', and 'content' serve; Part 1 when omitted. A multi-part response lists the report's part numbers in parts. 'list' does not take it.",
      ),
    fromDateTime: z
      .string()
      .optional()
      .describe(
        "Start of the update-date window for 'list' (ISO 8601, e.g. 2025-06-01T00:00:00Z): the date Congress.gov last updated a report record, not its publication date. Ignored by other operations.",
      ),
    toDateTime: z
      .string()
      .optional()
      .describe(
        "End of the update-date window for 'list' (ISO 8601). Same field semantics as fromDateTime. Ignored by other operations.",
      ),
    conference: z
      .boolean()
      .optional()
      .describe(
        "For 'list': true returns only conference reports, false only the others; omit for both. Ignored by other operations.",
      ),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
    ...documentFormatInput,
    ...documentWindowInput,
  }),
  output: committeeReportsOutput,
  enrichment: listEnrichment,
  format: formatCommitteeReports,

  async handler(input, ctx) {
    const api = getCongressApi();
    const fromDateTime = validateIsoDateTime(
      normalizeOptionalString(input.fromDateTime),
      'fromDateTime',
    );
    const toDateTime = validateIsoDateTime(normalizeOptionalString(input.toDateTime), 'toDateTime');
    validateDateTimeRange(fromDateTime, toDateTime);

    if (input.operation === 'list') {
      if (input.reportNumber !== undefined) {
        throw ctx.fail(
          'incompatible_identity',
          "'list' does not use reportNumber. Remove reportNumber to browse, or use 'get', 'text', or 'content' with congress, reportType, and reportNumber.",
          { field: 'reportNumber', operation: input.operation },
        );
      }
      if (input.part !== undefined) {
        throw ctx.fail(
          'incompatible_identity',
          "'list' does not use part. Remove part to browse, or use 'get', 'text', or 'content' with congress, reportType, reportNumber, and part.",
          { field: 'part', operation: input.operation },
        );
      }
      const result = await api.listCommitteeReports(
        {
          congress: input.congress,
          reportType: input.reportType,
          fromDateTime,
          toDateTime,
          conference: input.conference,
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
          fromDateTime,
          toDateTime,
          conference: input.conference,
        }),
      );
      ctx.enrich.total(result.pagination.count);
      notifyIfNoMatches(
        ctx,
        result,
        'No committee reports found. Try removing the reportType, fromDateTime/toDateTime, or conference filter, or check the congress number.',
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
    noticeIgnoredInputs(ctx, input.operation, {
      fromDateTime,
      toDateTime,
      conference: input.conference,
    });

    const report = {
      congress: input.congress,
      reportType: input.reportType,
      reportNumber: input.reportNumber,
    };
    const citation = `${input.reportType.toUpperCase()} ${input.congress}-${input.reportNumber}`;
    const part = input.part ?? 1;

    /** Fail a part the report is not filed in, naming the ones it is. */
    const missingPart = (parts: number[]) =>
      ctx.fail(
        'not_found',
        `Committee report ${citation} has no part ${part}. Its parts are ${parts.join(', ')}.`,
        {
          ...report,
          part,
          parts,
          recovery: {
            hint: `Retry with part set to one of ${parts.join(', ')}, or omit part to read Part 1.`,
          },
        },
      );

    if (input.operation === 'get') {
      const { reports } = await api.getCommitteeReport(report, ctx);
      const parts = distinctParts(reports.map(recordPart));
      const filed = reports.filter((record) => recordPart(record) === part);
      const selected = filed.find((record) => !isErrataRecord(record)) ?? filed[0];
      if (!selected) throw missingPart(parts);
      ctx.log.info('Committee report retrieved', { ...report, part });
      ctx.enrich.echo(
        `${input.reportType.toUpperCase()} ${input.reportNumber}${parts.length > 1 ? `, Part ${part}` : ''} (${ordinal(input.congress)} Congress)`,
      );
      ctx.enrich.total(1);
      return { report: selected, ...(parts.length > 1 ? { parts } : {}) };
    }

    const result = await api.getCommitteeReportText(report, ctx);
    const formats = collectReportFormats(result.text);

    if (input.operation === 'content') {
      if (formats.length === 0) {
        throw ctx.fail(
          'document_unavailable',
          `Committee report ${citation} publishes no document formats.`,
          report,
        );
      }
      const parts = distinctParts(formats.map(formatPart));
      if (!parts.includes(part)) throw missingPart(parts);
      const label = parts.length > 1 ? `${citation}, Part ${part}` : citation;

      const url = selectDocumentUrl(
        formats.filter((format) => formatPart(format) === part),
        input.format,
      );
      if (!url) {
        throw ctx.fail(
          'format_unavailable',
          `Committee report ${label} publishes no '${input.format}' document (looked for ${describeFormat(input.format)}).`,
          { ...ctx.recoveryFor('format_unavailable'), format: input.format },
        );
      }

      const document = await getCongressDocuments().fetchDocument(
        {
          url,
          characterOffset: input.characterOffset,
          characterLimit: input.characterLimit,
          reading: 'gpo',
        },
        ctx,
      );
      ctx.log.info('Committee report content retrieved', {
        ...report,
        part,
        format: input.format,
        totalCharacters: document.totalCharacters,
      });
      ctx.enrich.echo(
        `${label}, ${input.format} characters ${document.offset}–${document.offset + document.text.length}`,
      );
      ctx.enrich.total(document.totalCharacters);
      return {
        content: {
          ...document,
          format: input.format,
          sourceUrl: url,
          documentTitle: `Committee Report ${label}`,
        },
        ...(parts.length > 1 ? { parts } : {}),
      };
    }

    const parts = distinctParts(formats.map(formatPart));
    if (!parts.includes(part)) throw missingPart(parts);
    const text = Array.isArray(result.text) ? partTextEntries(result.text, part) : result.text;
    ctx.log.info('Committee report text retrieved', { ...report, part });
    ctx.enrich.echo(
      `text formats for ${input.reportType.toUpperCase()} ${input.reportNumber}${parts.length > 1 ? `, Part ${part}` : ''} (${ordinal(input.congress)} Congress)`,
    );
    ctx.enrich.total(Array.isArray(text) ? text.length : 1);
    return { text, ...(parts.length > 1 ? { parts } : {}) };
  },
});
