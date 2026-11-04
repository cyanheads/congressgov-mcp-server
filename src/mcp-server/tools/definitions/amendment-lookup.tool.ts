/**
 * @fileoverview Tool for browsing and retrieving U.S. congressional amendments from Congress.gov.
 * @module mcp-server/tools/definitions/amendment-lookup
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatAmendments } from '@/mcp-server/tools/format-helpers.js';
import { recordedRollVote, recordedRollVoteSchema } from '@/mcp-server/tools/roll-vote-pointer.js';
import {
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
  numericIdentifier,
  toIdentifierNumber,
  validateDateTimeRange,
  validateIsoDateTime,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { AMENDMENT_TYPE_CODES } from '@/services/congress-api/types.js';
import { getCongressDocuments } from '@/services/congress-documents/congress-documents-service.js';
import { ordinal } from '@/utils/congress-calendar.js';

/** Rows emit `HAMDT`/`SAMDT`, which the API path refuses; the advertised enum stays lower case. */
const AmendmentTypeEnum = z.preprocess(
  (value) => (typeof value === 'string' ? value.toLowerCase() : value),
  z.enum(AMENDMENT_TYPE_CODES),
);

/** The congresses Congress.gov holds Senate unprinted amendments (`suamdt`) for. */
const SUAMDT_CONGRESSES = [97, 98];

/** A text version's published formats that carry a URL, as `{type, url}`. */
function publishedFormats(formats: unknown): Array<{ type: string; url: string }> {
  if (!Array.isArray(formats)) return [];
  return formats.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { type, url } = entry as { type?: unknown; url?: unknown };
    if (typeof url !== 'string' || url.trim() === '') return [];
    return [{ type: typeof type === 'string' ? type.trim() : '', url: url.trim() }];
  });
}

export const amendmentLookupTool = tool('congressgov_amendment_lookup', {
  title: 'Congress.gov Amendment Lookup',
  description: `Browse and retrieve U.S. congressional amendments from Congress.gov — House (hamdt), Senate (samdt), and Senate unprinted (suamdt, 97th and 98th Congresses only). An amendment is addressed by congress + amendmentType + amendmentNumber, the identifiers other tools return: congressgov_bill_lookup 'amendments' rows (type and number), House votes from congressgov_roll_votes (amendmentType and amendmentNumber), and amendment rows from congressgov_member_lookup 'sponsored'/'cosponsored' (amendmentNumber, with the type in the row's url); either letter case is accepted. Use 'list' to browse one congress, optionally one amendmentType (newest update first; fromDateTime/toDateTime filter on update date), 'get' for the record (sponsor, purpose, description, the bill or amendment it amends, latest action), or drill in with 'actions', 'cosponsors', 'amendments' (amendments to this amendment), or 'text'. 'text' lists the published text versions — the Congressional Record pages that print the amendment, often alongside the surrounding floor proceedings — and 'content' reads one version's HTML as plain text, a bounded character window at a time. On that page a Senate amendment is printed under 'SA {number}' or 'Amendment No. {number}'; a House amendment is not printed under its HAMDT number — find it at the Record page its 'actions' rows cite ('text: CR H3582-3583' is the '[[Page H3582]]' marker) or under 'Amendment No. N Offered by', where N is the number the description from 'get' gives it ('An amendment numbered 64 printed in House Report 118-142'). An 'actions' row that records a roll call vote carries rollVote — the chamber, congress, session, and voteNumber congressgov_roll_votes takes to return that vote and each member's position.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [...congressErrorContracts, ...documentErrorContracts, ...identityErrorContracts],
  inputAliases: { type: 'amendmentType', number: 'amendmentNumber' },
  input: z.object({
    operation: z
      .enum(['list', 'get', 'actions', 'cosponsors', 'amendments', 'text', 'content'])
      .describe('Which data to retrieve.'),
    congress: z.number().int().positive().describe('Congress number (e.g., 118, 119).'),
    amendmentType: AmendmentTypeEnum.optional().describe(
      "Amendment type: 'hamdt' (House), 'samdt' (Senate), or 'suamdt' (Senate unprinted, 97th and 98th Congresses only). Optional on 'list'; required for every other operation.",
    ),
    amendmentNumber: numericIdentifier(
      'Amendment number. Required for every operation but \'list\', which refuses it. Accepts the digit-string form rows carry (e.g. "255") as well as a number.',
    ).optional(),
    fromDateTime: z
      .string()
      .optional()
      .describe(
        "Start of the update-date window for 'list' (ISO 8601, e.g. 2026-10-01T00:00:00Z): when Congress.gov last touched the record, not when the amendment was offered. Other operations ignore it and say so in the notice.",
      ),
    toDateTime: z
      .string()
      .optional()
      .describe(
        "End of the update-date window for 'list' (ISO 8601). Same field semantics as fromDateTime.",
      ),
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
        "Which text version 'content' reads, 0-based against the order 'text' returns. Ignored by other operations.",
      ),
    ...documentWindowInput,
  }),
  output: listOrDetail(
    { amendment: 'record', content: 'record' },
    "Amendment record (sponsors, purpose, description, amended bill or amendment, latest action, sub-resource counts) for `get`; absent for `list` and sub-resources. For `content`, an alternative key 'content' carries {text, format, sourceUrl, documentTitle, totalCharacters, offset, truncated, nextOffset} — one exact character window of the text version's HTML read as plain text.",
    {
      data: z
        .array(
          z
            .object({ rollVote: recordedRollVoteSchema.optional() })
            .passthrough()
            .describe(
              'Upstream JSON record: an amendment (`list`, `amendments`) or a sub-resource row. An `actions` row carries `rollVote` when it records one roll call vote congressgov_roll_votes serves.',
            ),
        )
        .optional()
        .describe('Result rows for `list` and the sub-resource operations.'),
    },
  ),
  enrichment: listEnrichment,
  format: formatAmendments,

  async handler(input, ctx) {
    const api = getCongressApi();
    const fromDateTime = validateIsoDateTime(
      normalizeOptionalString(input.fromDateTime),
      'fromDateTime',
    );
    const toDateTime = validateIsoDateTime(normalizeOptionalString(input.toDateTime), 'toDateTime');
    validateDateTimeRange(fromDateTime, toDateTime);

    if (input.operation === 'list') {
      if (input.amendmentNumber !== undefined) {
        throw ctx.fail(
          'incompatible_identity',
          "'list' does not use amendmentNumber. Remove amendmentNumber to browse, or use 'get' with congress, amendmentType, and amendmentNumber.",
          { field: 'amendmentNumber', operation: input.operation },
        );
      }
      const result = await api.listAmendments(
        {
          congress: input.congress,
          amendmentType: input.amendmentType,
          fromDateTime,
          toDateTime,
          sort: input.order === 'oldest' ? 'updateDate asc' : 'updateDate desc',
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Amendments listed', { congress: input.congress, count: result.data.length });
      ctx.enrich.echo(
        buildEffectiveQuery('amendments', {
          congress: input.congress,
          amendmentType: input.amendmentType,
          fromDateTime,
          toDateTime,
        }),
      );
      ctx.enrich.total(result.pagination.count);
      notifyIfNoMatches(
        ctx,
        result,
        input.amendmentType === 'suamdt' && !SUAMDT_CONGRESSES.includes(input.congress)
          ? 'No amendments matched. Senate unprinted amendments (suamdt) exist only in the 97th and 98th Congresses; later Senate amendments are samdt.'
          : 'No amendments matched the filters. Try broadening the date range or removing amendmentType.',
      );
      return result;
    }

    if (!input.amendmentType || !input.amendmentNumber) {
      throw validationError(
        `The '${input.operation}' operation requires congress, amendmentType, and amendmentNumber. Use 'list' first to find the amendment, then request its ${input.operation}.`,
        {
          operation: input.operation,
          amendmentType: input.amendmentType,
          amendmentNumber: input.amendmentNumber,
        },
      );
    }

    /** Rows carry `number` as a string; the service takes a number. */
    const amendmentNumber = toIdentifierNumber(input.amendmentNumber);
    const label = `${input.amendmentType.toUpperCase()} ${amendmentNumber}`;
    const identity = {
      congress: input.congress,
      amendmentType: input.amendmentType,
      amendmentNumber,
    };

    // The date pair filters 'list' only; every other operation is served and names it ignored.
    noticeIgnoredInputs(ctx, input.operation, { fromDateTime, toDateTime });

    if (input.operation === 'get') {
      const result = await api.getAmendment(identity, ctx);
      ctx.log.info('Amendment retrieved', identity);
      ctx.enrich.echo(`${label} in the ${ordinal(input.congress)} Congress`);
      ctx.enrich.total(1);
      return result;
    }

    if (input.operation === 'content') {
      /** One upstream page of exactly the selected version — not the whole list. */
      const versions = await api.getAmendmentSubResource(
        { ...identity, subResource: 'text', limit: 1, offset: input.textVersionIndex },
        ctx,
      );
      const version =
        input.textVersionIndex < versions.pagination.count ? versions.data[0] : undefined;
      if (!version) {
        throw ctx.fail(
          'document_unavailable',
          `No text version at index ${input.textVersionIndex} for ${label} — Congress.gov publishes ${versions.pagination.count} version(s) for this amendment.`,
          { textVersionIndex: input.textVersionIndex, available: versions.pagination.count },
        );
      }

      const versionType = typeof version.type === 'string' ? version.type : 'Amendment';
      /**
       * Amendment text is the Congressional Record page that prints it, labeled
       * `HTML` and `PDF`; the HTML is GPO `<pre>` print output, so it takes the
       * `gpo` reading that keeps that layout verbatim.
       */
      const formats = publishedFormats(version.formats);
      const html = formats.find((entry) => entry.type.toUpperCase() === 'HTML');
      if (!html) {
        if (formats.length === 0) {
          throw ctx.fail(
            'document_unavailable',
            `The ${versionType} text of ${label} publishes no document formats.`,
            { textVersionIndex: input.textVersionIndex },
          );
        }
        const listed = formats.map((entry) => `${entry.type || 'unlabeled'} at ${entry.url}`);
        throw ctx.fail(
          'format_unavailable',
          `The ${versionType} text of ${label} publishes no HTML version, the one format this server reads as text. It publishes ${listed.join('; ')}.`,
          { textVersionIndex: input.textVersionIndex, formats },
        );
      }

      const document = await getCongressDocuments().fetchDocument(
        {
          url: html.url,
          characterOffset: input.characterOffset,
          characterLimit: input.characterLimit,
          reading: 'gpo',
        },
        ctx,
      );
      ctx.log.info('Amendment text content retrieved', {
        ...identity,
        textVersionIndex: input.textVersionIndex,
        totalCharacters: document.totalCharacters,
      });
      ctx.enrich.echo(
        `${versionType} text of ${label} (${ordinal(input.congress)} Congress), html characters ${document.offset}–${document.offset + document.text.length}`,
      );
      ctx.enrich.total(document.totalCharacters);
      return {
        content: {
          ...document,
          format: 'html',
          sourceUrl: html.url,
          documentTitle: `${label} (${ordinal(input.congress)} Congress) — ${versionType} text`,
        },
      };
    }

    const result = await api.getAmendmentSubResource(
      { ...identity, subResource: input.operation, limit: input.limit, offset: input.offset },
      ctx,
    );
    ctx.log.info('Amendment sub-resource retrieved', {
      ...identity,
      subResource: input.operation,
    });
    ctx.enrich.echo(`${input.operation} for ${label} in the ${ordinal(input.congress)} Congress`);
    ctx.enrich.total(result.pagination.count);
    notifyIfNoMatches(ctx, result, `No ${input.operation} found for ${label}.`);
    if (input.operation !== 'actions') return result;
    return {
      ...result,
      data: result.data.map((action) => {
        const rollVote = recordedRollVote(action.recordedVotes);
        return rollVote ? { ...action, rollVote } : action;
      }),
    };
  },
});
