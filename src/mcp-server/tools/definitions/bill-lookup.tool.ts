/**
 * @fileoverview Tool for browsing and retrieving U.S. legislative bill data from Congress.gov.
 * @module mcp-server/tools/definitions/bill-lookup
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatBills } from '@/mcp-server/tools/format-helpers.js';
import {
  buildEffectiveQuery,
  congressErrorContracts,
  documentErrorContracts,
  documentWindowInput,
  listEnrichment,
  listOrDetail,
  normalizeOptionalString,
  notifyIfNoMatches,
  numericIdentifier,
  toIdentifierNumber,
  validateDateTimeRange,
  validateIsoDateTime,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { BILL_TYPE_CODES, type BillSubResource } from '@/services/congress-api/types.js';
import { getCongressDocuments } from '@/services/congress-documents/congress-documents-service.js';
import {
  describeFormat,
  selectDocumentUrl,
} from '@/services/congress-documents/document-formats.js';

const BillTypeEnum = z.enum(BILL_TYPE_CODES);

const OperationEnum = z.enum([
  'list',
  'get',
  'actions',
  'amendments',
  'cosponsors',
  'committees',
  'subjects',
  'summaries',
  'text',
  'titles',
  'related',
  'content',
]);

const SUB_RESOURCE_MAP: Record<string, string> = {
  related: 'relatedbills',
};

export const billLookupTool = tool('congressgov_bill_lookup', {
  description: `Browse and retrieve U.S. legislative bill data from Congress.gov. Discover bills by filtering on congress, bill type, and date range — there is no keyword search. Use 'list' to browse (requires congress, defaults to most-recently-updated first), 'get' for full bill detail (sponsor, policy area, CBO estimates, law info), or drill into a specific bill with 'actions', 'amendments', 'cosponsors', 'committees', 'subjects', 'summaries', 'text', 'titles', or 'related' (each requires congress + billType + billNumber). 'text' lists the published versions and their format URLs; 'content' then reads one version's actual text, a bounded character window at a time.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [...congressErrorContracts, ...documentErrorContracts],
  input: z.object({
    operation: OperationEnum.describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number (e.g., 118, 119).'),
    billType: BillTypeEnum.optional().describe(
      'Bill type code. Required for get and sub-resource operations.',
    ),
    billNumber: numericIdentifier(
      'Bill number. Required for get and sub-resource operations. Accepts the digit-string form list rows carry (e.g. "9479") as well as a number.',
    ).optional(),
    fromDateTime: z
      .string()
      .optional()
      .describe(
        "Start of date range filter (ISO 8601). Filters by the bill's update date — when Congress.gov last touched the record — not by the bill's latest legislative action.",
      ),
    toDateTime: z
      .string()
      .optional()
      .describe('End of date range filter (ISO 8601). Same field semantics as fromDateTime.'),
    order: z
      .enum(['recent', 'oldest'])
      .default('recent')
      .describe(
        "Sort order for 'list' (sorts by update date). 'recent' (default) is newest first; 'oldest' is ascending. Ignored by other operations.",
      ),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
    textVersionIndex: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Which text version 'content' reads, 0-based against the same order 'text' returns — 0 is the most recent version. Ignored by other operations.",
      ),
    ...documentWindowInput,
  }),
  output: listOrDetail(
    'bill',
    "Bill record (sponsor, policy area, latest action, CBO estimates, law citation) for `get`; absent for `list` and sub-resources. For `content`, an alternative key 'content' carries {text, format, sourceUrl, documentTitle, totalCharacters, offset, truncated, nextOffset} — one exact character window of the document.",
  ),
  enrichment: listEnrichment,
  format: formatBills,

  async handler(input, ctx) {
    const api = getCongressApi();
    const fromDateTime = validateIsoDateTime(
      normalizeOptionalString(input.fromDateTime),
      'fromDateTime',
    );
    const toDateTime = validateIsoDateTime(normalizeOptionalString(input.toDateTime), 'toDateTime');
    validateDateTimeRange(fromDateTime, toDateTime);

    if (input.operation === 'list') {
      const result = await api.listBills(
        {
          congress: input.congress,
          billType: input.billType,
          fromDateTime,
          toDateTime,
          sort: input.order === 'oldest' ? 'updateDate asc' : 'updateDate desc',
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Bills listed', { congress: input.congress, count: result.data.length });
      ctx.enrich.echo(
        buildEffectiveQuery('bills', {
          congress: input.congress,
          billType: input.billType,
          fromDateTime,
          toDateTime,
        }),
      );
      ctx.enrich.total(result.pagination.count);
      notifyIfNoMatches(
        ctx,
        result,
        'No bills matched the filters. Try broadening the date range or removing billType.',
      );
      return result;
    }

    if (!input.billType || !input.billNumber) {
      throw validationError(
        `The '${input.operation}' operation requires congress, billType, and billNumber. Use 'list' first to find the bill, then request its ${input.operation}.`,
        { operation: input.operation, billType: input.billType, billNumber: input.billNumber },
      );
    }

    /** List rows carry `number` as a string; the service takes a number. */
    const billNumber = toIdentifierNumber(input.billNumber);

    if (input.operation === 'get') {
      const result = await api.getBill(
        {
          congress: input.congress,
          billType: input.billType,
          billNumber,
        },
        ctx,
      );
      ctx.log.info('Bill retrieved', {
        congress: input.congress,
        billType: input.billType,
        billNumber,
      });
      ctx.enrich.echo(
        `${input.billType.toUpperCase()} ${billNumber} in the ${input.congress}th Congress`,
      );
      ctx.enrich.total(1);
      return result;
    }

    if (input.operation === 'content') {
      /** One upstream page of exactly the selected version — not the whole list. */
      const versions = await api.getBillSubResource(
        {
          congress: input.congress,
          billType: input.billType,
          billNumber,
          subResource: 'text',
          limit: 1,
          offset: input.textVersionIndex,
        },
        ctx,
      );
      /**
       * `pagination.count` decides the range, not the presence of a row: for an
       * enacted bill the endpoint appends the "Public Law" version to every page,
       * so an out-of-range offset comes back holding that row instead of empty.
       * Selecting `data[0]` alone would serve the Public Law text for any index
       * past the end — a different document than the caller asked for.
       */
      const version =
        input.textVersionIndex < versions.pagination.count ? versions.data[0] : undefined;
      if (!version) {
        throw ctx.fail(
          'document_unavailable',
          `No text version at index ${input.textVersionIndex} for ${input.billType.toUpperCase()} ${billNumber} — Congress.gov publishes ${versions.pagination.count} version(s) for this bill.`,
          {
            ...ctx.recoveryFor('document_unavailable'),
            textVersionIndex: input.textVersionIndex,
            available: versions.pagination.count,
          },
        );
      }

      const url = selectDocumentUrl(version.formats, input.format);
      if (!url) {
        throw ctx.fail(
          'format_unavailable',
          `This text version publishes no '${input.format}' document (looked for ${describeFormat(input.format)}).`,
          {
            ...ctx.recoveryFor('format_unavailable'),
            format: input.format,
            textVersionIndex: input.textVersionIndex,
          },
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
      const versionType = typeof version.type === 'string' ? version.type : 'Bill Text';
      ctx.log.info('Bill text content retrieved', {
        congress: input.congress,
        billType: input.billType,
        billNumber,
        textVersionIndex: input.textVersionIndex,
        format: input.format,
        totalCharacters: document.totalCharacters,
      });
      ctx.enrich.echo(
        `${versionType} of ${input.billType.toUpperCase()} ${billNumber} (${input.congress}th Congress), ${input.format} characters ${document.offset}–${document.offset + document.text.length}`,
      );
      ctx.enrich.total(document.totalCharacters);
      return {
        content: {
          ...document,
          format: input.format,
          sourceUrl: url,
          documentTitle: `${input.billType.toUpperCase()} ${billNumber} — ${versionType}`,
        },
      };
    }

    const subResource = SUB_RESOURCE_MAP[input.operation] ?? input.operation;
    const result = await api.getBillSubResource(
      {
        congress: input.congress,
        billType: input.billType,
        billNumber,
        subResource: subResource as BillSubResource,
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );
    ctx.log.info('Bill sub-resource retrieved', {
      congress: input.congress,
      billType: input.billType,
      billNumber,
      subResource,
    });
    ctx.enrich.echo(
      `${input.operation} for ${input.billType.toUpperCase()} ${billNumber} in the ${input.congress}th Congress`,
    );
    ctx.enrich.total(result.pagination.count);
    notifyIfNoMatches(
      ctx,
      result,
      `No ${input.operation} found for ${input.billType.toUpperCase()} ${billNumber}.`,
    );
    return result;
  },
});
