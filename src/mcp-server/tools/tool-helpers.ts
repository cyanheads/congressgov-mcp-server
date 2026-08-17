/**
 * @fileoverview Shared utilities for Congress.gov tool definitions.
 * @module mcp-server/tools/tool-helpers
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import {
  type ErrorContract,
  JsonRpcErrorCode,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { DOCUMENT_FORMATS } from '@/services/congress-documents/document-formats.js';

/**
 * Shared output-schema building blocks. Upstream Congress.gov responses are
 * sparse, variable, and JSON-shaped; describe the top-level envelope only —
 * `data`/`pagination` for lists, an entity key for detail — and let the
 * inner records remain open.
 */
const paginationShape = z
  .object({
    count: z.number().int().nonnegative().describe('Total result count across all pages.'),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Offset to pass for the next page, or null when there are no more pages.'),
  })
  .describe('Pagination metadata: total count and next offset.');

/**
 * `data` element schema. Rows are upstream JSON records — kept as a permissive
 * object so the schema doesn't drift from Congress.gov's variable shapes, but
 * declared as `z.object({}).passthrough()` (not `z.unknown()`) so the type
 * line up with `ApiRecord[]` from the service layer.
 */
const dataRows = z
  .array(
    z
      .object({})
      .passthrough()
      .describe('Upstream JSON record. Per-tool item shape is rendered in the markdown body.'),
  )
  .describe('Result rows. Per-tool item shape is rendered in the markdown body.');

/** Result envelope shared by every `list`-style operation. */
export const listOutput = z
  .object({
    data: dataRows,
    pagination: paginationShape,
  })
  .passthrough();

/**
 * Union of list + detail envelopes — tools with both modes.
 *
 * Detail-mode payloads carry a single nested record under a named key (e.g.
 * `bill`, `law`, `member`); list-mode carries `data` + `pagination`. The
 * detail-mode key stays on `.passthrough()` rather than as a declared field —
 * otherwise the framework's inferred handler return type would conflict with
 * the upstream record's `[k:string]: unknown` index signature.
 */
export function listOrDetail(entityKey: string, description?: string) {
  const detailDesc = description ?? `the ${entityKey} record from Congress.gov.`;
  return z
    .object({
      data: dataRows.optional(),
      pagination: paginationShape.optional(),
    })
    .passthrough()
    .describe(`Detail-mode key '${entityKey}' carries: ${detailDesc}`);
}

/**
 * A positive integer written as digits only, with leading zeros allowed — the
 * `"0009479"` form is accepted, `"0"` is not.
 */
const NUMERIC_IDENTIFIER_PATTERN = /^0*[1-9]\d*$/;

/**
 * Schema for a positive-integer path identifier that Congress.gov list rows may
 * carry as either a JSON number or a numeric string (a bill's `number` and a
 * daily record's `issueNumber` both arrive as strings). Accepting only a number
 * breaks the list → drill-down chain at the MCP input boundary.
 *
 * A plain union rather than a coercion: `z.coerce.number()` advertises "anything
 * coercible" and would swallow `"1e3"`, booleans, and whitespace-padded values,
 * and `.transform()` is not JSON-Schema-serializable. Non-numeric, decimal,
 * signed, blank, scientific-notation, and zero values still fail at parse time —
 * each of these would otherwise be interpolated verbatim into the upstream URL
 * path. Normalize the parsed value with `toIdentifierNumber` before handing it
 * to the service layer, which takes `number`.
 * Resolves cyanheads/congressgov-mcp-server#43.
 */
export function numericIdentifier(description: string) {
  return z
    .union([
      z.number().int().positive().describe('Positive integer form.'),
      z
        .string()
        .regex(
          NUMERIC_IDENTIFIER_PATTERN,
          'Must be digits only and greater than zero (leading zeros allowed).',
        )
        .describe('Digit-string form, as list rows carry it.'),
    ])
    .describe(description);
}

/** Normalize a `numericIdentifier` value to the `number` the service layer takes. */
export function toIdentifierNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * A law number, written either bare (`90`, leading zeros allowed) or as the
 * `{congress}-{lawNumber}` citation Congress.gov publishes (`118-90`).
 */
const LAW_NUMBER_PATTERN = /^(?:\d+-)?0*[1-9]\d*$/;

/**
 * Schema for the law number a `/law/{congress}/{lawType}/{lawNumber}` lookup
 * takes. The bare number never appears in list output: the only law identifier
 * a `list` response carries is the compound citation on `laws[].number`
 * (`"118-90"`, rendered as `**Law:** Public Law 118-90`), while the row's own
 * `number` is the origin bill. Accepting the citation removes the undocumented
 * split-on-the-hyphen step from the list → get chain.
 *
 * Same plain-union-plus-handler-normalization shape as `numericIdentifier` —
 * `.transform()` is not JSON-Schema-serializable. Pass the parsed value through
 * `toLawNumber`, which cross-checks a citation's prefix against `congress`.
 * Resolves cyanheads/congressgov-mcp-server#54.
 */
export function lawNumberIdentifier(description: string) {
  return z
    .union([
      z.number().int().positive().describe('Positive integer form (e.g. 90).'),
      z
        .string()
        .regex(
          LAW_NUMBER_PATTERN,
          'Must be a law number (90) or a full law citation (118-90), digits only and greater than zero.',
        )
        .describe('String form — the law number ("90") or the full citation ("118-90").'),
    ])
    .describe(description);
}

/**
 * Normalize a `lawNumberIdentifier` value to the bare law number the service
 * layer takes, rejecting a citation that names a different congress than the
 * one supplied — the two would otherwise disagree silently and resolve to a law
 * the caller never asked for.
 */
export function toLawNumber(value: number | string, congress: number): number {
  if (typeof value === 'number') return value;
  const hyphen = value.indexOf('-');
  if (hyphen === -1) return Number(value);

  const citedCongress = Number(value.slice(0, hyphen));
  const lawNumber = Number(value.slice(hyphen + 1));
  if (citedCongress !== congress) {
    throw validationError(
      `Law citation '${value}' is from congress ${citedCongress}, but congress=${congress} was supplied. Pass congress=${citedCongress}, or drop the prefix and pass lawNumber=${lawNumber}.`,
      { field: 'lawNumber', lawNumber: value, congress },
    );
  }
  return lawNumber;
}

export function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/**
 * Validate an optional ISO 8601 date-time string. The Congress.gov API accepts
 * `YYYY-MM-DDTHH:MM:SSZ` and rejects anything else with an opaque 400 — catch
 * the mistake here so the caller gets an actionable message.
 *
 * The shape regex alone is insufficient: `2023-02-30T00:00:00Z` (Feb 30) and
 * `2023-13-01T00:00:00Z` (month 13) match the pattern but are not real dates,
 * and Congress.gov 400s on them. A UTC round-trip rejects any component the
 * calendar normalizes away — impossible day, month, hour, minute, or second.
 * Resolves cyanheads/congressgov-mcp-server#35.
 */
const ISO_8601_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

function isRealCalendarDateTime(parts: RegExpExecArray): boolean {
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

export function validateIsoDateTime(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return;
  const parts = ISO_8601_PATTERN.exec(value);
  if (!parts || !isRealCalendarDateTime(parts)) {
    throw validationError(
      `'${field}' must be an ISO 8601 date-time like 2026-05-01T00:00:00Z. Got: ${value}`,
      { field, value },
    );
  }
  return value;
}

/**
 * Reject a reversed `fromDateTime`/`toDateTime` pair. Congress.gov answers a
 * reversed range with an empty 200, which is indistinguishable from a genuinely
 * empty query — catch the contradiction here instead.
 *
 * A zero-width range (`from === to`) is legal, and either bound may be supplied
 * alone. Both values must already have passed `validateIsoDateTime`, which pins
 * them to the fixed-width `YYYY-MM-DDTHH:MM:SSZ` shape — so lexicographic
 * comparison is exact ordering and no `Date` parsing is needed.
 * Resolves cyanheads/congressgov-mcp-server#48.
 */
export function validateDateTimeRange(
  fromDateTime: string | undefined,
  toDateTime: string | undefined,
): void {
  if (fromDateTime === undefined || toDateTime === undefined) return;
  if (fromDateTime > toDateTime) {
    throw validationError(
      `'fromDateTime' must be earlier than or equal to 'toDateTime'. Got fromDateTime=${fromDateTime}, toDateTime=${toDateTime}. Swap the two bounds or widen the range.`,
      { field: 'fromDateTime', fromDateTime, toDateTime },
    );
  }
}

/**
 * Enrichment block shared by all browse/list operations. Declares the three
 * standard agent-facing fields: the effective query echo, the total result
 * count, and an optional notice for empty results or edge cases.
 *
 * Usage in tool definitions:
 * ```ts
 * enrichment: listEnrichment,
 * ```
 * Usage in handlers:
 * ```ts
 * ctx.enrich.echo(buildEffectiveQuery('bills', { congress: 118 }));
 * ctx.enrich.total(result.pagination.count);
 * notifyIfNoMatches(ctx, result, 'No matching results. Try adjusting the filters.');
 * ```
 */
export const listEnrichment = {
  effectiveQuery: z.string().describe('The browse scope and applied filters.'),
  totalCount: z.number().describe('Total results across all pages.'),
  notice: z
    .string()
    .optional()
    .describe('Guidance when results are empty, a page is past the end, or a caveat applies.'),
};

/**
 * A paginated result envelope, narrowed to what the empty-result gate reads.
 * `count` is the upstream total across all pages, not the length of `data`.
 */
type PaginatedResult = {
  data: readonly unknown[];
  pagination: { count: number };
};

/**
 * Emit an empty-result notice only when nothing matched upstream.
 *
 * An empty `data` array has two distinct causes: the query matched nothing, or
 * the caller paged past the end of a non-empty result set. Only the first is a
 * no-match. The second already renders as an accurate "page is empty — offset is
 * past the end of N total items" line in `format()` (`renderList` and the vote
 * roster renderers in `format-helpers.ts`), and pairing that with no-match
 * guidance gives the caller two contradictory explanations while
 * `structuredContent.notice` carries only the wrong one. Gating on
 * `pagination.count` separates the two states.
 *
 * The message stays per-call-site — browse operations carry filter-broadening
 * advice, sub-resources carry their own context-specific text — so only the
 * decision to fire is shared, never the wording.
 * Resolves cyanheads/congressgov-mcp-server#49.
 */
export function notifyIfNoMatches(ctx: Context, result: PaginatedResult, message: string): void {
  if (result.data.length === 0 && result.pagination.count === 0) ctx.enrich.notice(message);
}

/**
 * Build an effective-query string for enrichment echo. Returns the scope plus
 * any non-empty filter values as a compact `(key=val, …)` suffix.
 */
export function buildEffectiveQuery(scope: string, filters?: Record<string, unknown>): string {
  if (!filters) return scope;
  const parts: string[] = [];
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === '') continue;
    parts.push(`${key}=${String(val)}`);
  }
  return parts.length === 0 ? scope : `${scope} (${parts.join(', ')})`;
}

/** Characters one `content` call returns by default. */
export const DEFAULT_CONTENT_CHARACTERS = 25_000;

/** Ceiling on one `content` window. A full bill takes several windows regardless. */
export const MAX_CONTENT_CHARACTERS = 100_000;

/**
 * Input fields shared by every `content` operation: which format to read, and
 * the character window to return.
 *
 * The window is deliberately **not** the tools' existing `offset`/`limit` pair.
 * Those are the Congress.gov pagination params, capped at `limit ≤ 250` because
 * that is the API's own page ceiling — a cap that would make a character window
 * useless, and one that cannot be widened per-operation on a flat input object
 * without breaking every list operation's validation. The idiom is preserved
 * (an offset, a limit, and a `nextOffset` to feed back); only the names differ,
 * so the two ranges can carry the bounds each actually needs.
 */
export const documentWindowInput = {
  format: z
    .enum(DOCUMENT_FORMATS)
    .default('text')
    .describe(
      "Document format for 'content'. 'text' is GPO's Formatted Text — plain, pre-formatted print output, published for every document checked. 'xml' prefers United States Legislative Markup and falls back to Formatted XML; it exists on some bill text versions and on no committee report or Congressional Record article. PDF is not retrieved — read one at the format URLs 'text'/'articles' return.",
    ),
  characterOffset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "First character to return for 'content', 0-based. Offsets are exact and are never snapped to a section or paragraph break, so feeding the response's nextOffset back walks the whole document with every character returned exactly once.",
    ),
  characterLimit: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONTENT_CHARACTERS)
    .default(DEFAULT_CONTENT_CHARACTERS)
    .describe(
      `Maximum characters to return for 'content' (1-${MAX_CONTENT_CHARACTERS}). Legislative documents run past a million characters, so a full bill takes several windows.`,
    ),
};

/**
 * Failure modes of the `content` operation on `congressgov_bill_lookup`,
 * `congressgov_committee_reports`, and `congressgov_daily_record`. Layered on top
 * of `congressErrorContracts` — the document fetch is a second upstream
 * (`www.congress.gov`) with its own ways to fail, and only these three tools
 * reach it.
 *
 * `CongressDocumentsService` raises each with a matching `data.reason` and
 * resolves the `recovery` hint declared here via `ctx.recoveryFor`, so the hint
 * lives in exactly one place.
 * Resolves cyanheads/congressgov-mcp-server#53.
 */
export const documentErrorContracts = [
  {
    code: JsonRpcErrorCode.NotFound,
    reason: 'document_unavailable',
    retryable: false,
    when: "The 'content' selection resolves to no retrievable document — the text version or article index is past the end of the list, the record publishes no formats at all, or Congress.gov does not hold the file its own metadata names.",
    recovery:
      "Run the tool's 'text' or 'articles' operation first to see which documents Congress.gov publishes for this record, then retry with a selection it lists.",
  },
  {
    code: JsonRpcErrorCode.NotFound,
    reason: 'format_unavailable',
    retryable: false,
    when: "The document exists but publishes nothing in the requested 'format' — some text versions and committee reports ship PDF only, and no Congressional Record article publishes XML.",
    recovery:
      "Retry with format 'text', which every document checked publishes; if that fails too the document is PDF-only, so read it at the format URL the text operation returns.",
  },
  {
    code: JsonRpcErrorCode.ServiceUnavailable,
    reason: 'document_fetch_failed',
    retryable: true,
    when: 'www.congress.gov did not return a readable document — a non-2xx status, a network failure, an empty body, or a content type that is not text or XML.',
    recovery:
      'Retry after a short delay; if the failure persists, request a different format or read the document at the sourceUrl the text operation returns.',
  },
  {
    code: JsonRpcErrorCode.InvalidParams,
    reason: 'document_too_large',
    retryable: false,
    when: 'The document is larger than the byte ceiling this server retrieves, so no character window can be served from it.',
    recovery:
      'Read the document at the sourceUrl the text operation returns. A document this size clears the ceiling in every format it publishes, so switching format reaches the same limit.',
  },
  {
    code: JsonRpcErrorCode.InvalidParams,
    reason: 'offset_past_end',
    retryable: false,
    when: 'characterOffset is at or beyond the last character of the document, so the window would be empty.',
    recovery:
      'Restart the walk at characterOffset 0 and follow nextOffset, which goes null once the document has been read to the end.',
  },
] as const satisfies readonly ErrorContract[];

/**
 * Shared `errors[]` contract for every Congress.gov tool. All ten tools reach
 * the same `CongressApiService` fetch path, so they surface the same four
 * upstream failure modes. The service raises each with a matching `data.reason`
 * and `data.recovery.hint` (see `classifyUpstreamError`), making the failures
 * machine-readable; declaring them here advertises the contract in `tools/list`.
 * Resolves cyanheads/congressgov-mcp-server#32 and #34.
 */
export const congressErrorContracts = [
  {
    code: JsonRpcErrorCode.NotFound,
    reason: 'not_found',
    retryable: false,
    when: 'A requested bill, member, committee, report, vote, or nomination does not exist in Congress.gov.',
    recovery:
      "Use the tool's list or browse operation to discover valid identifiers, then retry with one that exists.",
  },
  {
    code: JsonRpcErrorCode.RateLimited,
    reason: 'rate_limited',
    retryable: true,
    when: 'The Congress.gov API rate limit (5,000 requests/hour per key) was exceeded.',
    recovery:
      'Wait for the hourly rate-limit window to reset before retrying, or reduce the request frequency.',
  },
  {
    code: JsonRpcErrorCode.InvalidParams,
    reason: 'invalid_request',
    retryable: false,
    when: 'Congress.gov rejected the request as malformed — a bad date range or an identifier with an unexpected shape.',
    recovery:
      'Check parameter formats: dates must be ISO 8601 like 2026-05-01T00:00:00Z and identifiers must match their documented shape.',
  },
  {
    code: JsonRpcErrorCode.ServiceUnavailable,
    reason: 'upstream_error',
    retryable: true,
    when: 'Congress.gov returned an unexpected error (5xx or another non-2xx status).',
    recovery:
      'Retry after a short delay; if the failure persists the Congress.gov service may be temporarily degraded.',
  },
] as const satisfies readonly ErrorContract[];
