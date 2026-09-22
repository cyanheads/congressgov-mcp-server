/**
 * @fileoverview Tool for browsing and retrieving U.S. legislative bill data from Congress.gov.
 * @module mcp-server/tools/definitions/bill-lookup
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatBills } from '@/mcp-server/tools/format-helpers.js';
import {
  summaryContinuationCall,
  summaryWindowNotice,
  windowSummaryPage,
} from '@/mcp-server/tools/summary-window.js';
import {
  buildEffectiveQuery,
  congressErrorContracts,
  documentErrorContracts,
  documentWindowInput,
  listEnrichment,
  listOrDetail,
  MAX_CONTENT_CHARACTERS,
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
  title: 'Congress.gov Bill Lookup',
  description: `Browse and retrieve U.S. legislative bill data from Congress.gov. Discover bills by filtering on congress, bill type, and date range — there is no keyword search. Use 'list' to browse (requires congress, defaults to most-recently-updated first), 'get' for full bill detail (sponsor, policy area, CBO estimates, law info), or drill into a specific bill with 'actions', 'amendments', 'cosponsors', 'committees', 'subjects', 'summaries', 'text', 'titles', or 'related' (each requires congress + billType + billNumber). 'text' lists the published versions and their format URLs; 'content' then reads one version's actual text, a bounded character window at a time. 'summaries' takes an optional versionCode selector and returns each row's text a bounded character window at a time — a row past the window carries textTotalCharacters/textTruncated/textNextOffset, and characterOffset reads on from there.`,
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
    versionCode: z
      .string()
      .optional()
      .describe(
        "Which summary version 'summaries' returns — the versionCode a summary row carries ('00' introduced, '49' public law). Selection runs over the bill's whole summary list, which Congress.gov publishes no filter for, and limit/offset then page the matching rows. Omit to return every version. Ignored by other operations.",
      ),
    ...documentWindowInput,
    characterOffset: documentWindowInput.characterOffset.describe(
      "First character to return, 0-based — of the document on 'content', and of every returned row's summary text on 'summaries'. Offsets are exact and are never snapped to a section or paragraph break, so feeding back the response's nextOffset (or a summary row's textNextOffset) walks the whole text with every character returned exactly once.",
    ),
    characterLimit: documentWindowInput.characterLimit.describe(
      `Maximum characters to return (1-${MAX_CONTENT_CHARACTERS}) — for the document window on 'content', and for each row's summary text on 'summaries'. Legislative documents run past a million characters and an enacted bill's summary past two hundred thousand, so either takes several windows.`,
    ),
  }),
  output: listOrDetail(
    { bill: 'record', content: 'record' },
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

    if (input.operation === 'summaries') {
      /** Narrowed above; a closure below reads it, where the narrowing is lost. */
      const billType = input.billType;
      const versionCode = normalizeOptionalString(input.versionCode);
      /**
       * Congress.gov publishes no version filter on the summaries sub-resource,
       * so a selection reads the bill's whole list — the API's own page ceiling
       * — and matches client-side. Without one the caller's own page is fetched
       * unchanged.
       */
      const result = await api.getBillSubResource(
        {
          congress: input.congress,
          billType: input.billType,
          billNumber,
          subResource: 'summaries',
          limit: versionCode ? 250 : input.limit,
          offset: versionCode ? 0 : input.offset,
        },
        ctx,
      );

      let page = result;
      if (versionCode) {
        const matched = result.data.filter((row) => row.versionCode === versionCode);
        const selected = matched.slice(input.offset, input.offset + input.limit);
        page = {
          ...result,
          data: selected,
          pagination: {
            count: matched.length,
            nextOffset:
              input.offset + selected.length < matched.length
                ? input.offset + selected.length
                : null,
          },
        };
      }

      const bounded = windowSummaryPage(page, {
        offset: input.offset,
        characterOffset: input.characterOffset,
        characterLimit: input.characterLimit,
      });

      if (bounded.offsetPastEnd) {
        throw ctx.fail(
          'offset_past_end',
          `characterOffset ${input.characterOffset} is at or past the end of every summary returned for ${input.billType.toUpperCase()} ${billNumber}.`,
          {
            ...ctx.recoveryFor('offset_past_end'),
            characterOffset: input.characterOffset,
            versionCode,
          },
        );
      }

      ctx.log.info('Bill summaries retrieved', {
        congress: input.congress,
        billType: input.billType,
        billNumber,
        versionCode,
        count: bounded.page.data.length,
        droppedRows: bounded.droppedRows,
        windowedRows: bounded.windowed.length,
      });
      ctx.enrich.echo(
        buildEffectiveQuery(
          `summaries for ${input.billType.toUpperCase()} ${billNumber} in the ${input.congress}th Congress`,
          { versionCode },
        ),
      );
      ctx.enrich.total(bounded.page.pagination.count);

      if (versionCode && bounded.page.data.length === 0) {
        const available = [
          ...new Set(
            result.data
              .map((row) => row.versionCode)
              .filter((code): code is string => typeof code === 'string'),
          ),
        ];
        ctx.enrich.notice(
          `No summary with versionCode '${versionCode}' for ${input.billType.toUpperCase()} ${billNumber}.${
            available.length > 0
              ? ` Versions published: ${available.join(', ')}.`
              : ' Congress.gov publishes no summaries for this bill.'
          }`,
        );
        return bounded.page;
      }

      notifyIfNoMatches(
        ctx,
        bounded.page,
        `No summaries found for ${input.billType.toUpperCase()} ${billNumber}.`,
      );

      const notice = summaryWindowNotice(bounded, input.limit, (row) =>
        summaryContinuationCall({
          congress: input.congress,
          billType,
          billNumber,
          versionCode: typeof row.row.versionCode === 'string' ? row.row.versionCode : versionCode,
          characterOffset: row.nextOffset ?? 0,
        }),
      );
      if (notice) ctx.enrich.notice(notice);

      return bounded.page;
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
