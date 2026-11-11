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

const detailRecord = z.object({}).passthrough().describe('Dynamic upstream JSON record.');

const detailRecords = z.array(detailRecord).describe('Dynamic upstream JSON records.');

const detailRootSchemas = {
  record: detailRecord,
  records: detailRecords,
} as const;

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
 * Detail-mode payloads carry one or more explicitly advertised roots; list-mode
 * carries `data` + `pagination`. Each root stays permissive below its declared
 * boundary so Congress.gov's sparse, variable records remain type-compatible.
 *
 * `extra` adds or overrides envelope keys (a typed `data` row, a `parts` field);
 * `.extend()` drops the root description, so it is applied after.
 */
export function listOrDetail<
  const TRoots extends Record<string, keyof typeof detailRootSchemas>,
  TExtra extends z.ZodRawShape = Record<never, never>,
>(roots: TRoots, description?: string, extra?: TExtra) {
  const detailShape = Object.fromEntries(
    Object.entries(roots).map(([key, kind]) => [key, detailRootSchemas[kind].optional()]),
  ) as unknown as {
    /**
     * Runtime schemas remain precise while handler-facing root values stay compatible
     * with Congress.gov records whose nested fields are intentionally unknown.
     */
    [K in keyof TRoots]: z.ZodOptional<z.ZodType<unknown>>;
  };
  const rootNames = Object.keys(roots).map((key) => `'${key}'`);
  const detailDesc = description ?? 'Dynamic records from Congress.gov.';
  return z
    .object({
      data: dataRows.optional(),
      pagination: paginationShape.optional(),
      ...detailShape,
    })
    .passthrough()
    .extend((extra ?? {}) as TExtra)
    .describe(`Non-list roots ${rootNames.join(', ')} carry: ${detailDesc}`);
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

/** The letter case an input's canonical spelling is written in. */
type LetterCase = 'lower' | 'upper' | 'title';

const TO_LETTER_CASE = {
  lower: (value) => value.toLowerCase(),
  upper: (value) => value.toUpperCase(),
  title: (value) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase(),
} as const satisfies Record<LetterCase, (value: string) => string>;

/**
 * Accept a code in any letter case: a string is rewritten in `canonical` case
 * before `schema` checks it. Congress.gov rows and sibling tools spell one code
 * several ways (`HR` beside `hr`, `HRPT`, `House` beside `house`) while each
 * input names a single spelling, so a value copied from a row into the next
 * call reads like the canonical one.
 *
 * The rewrite runs inside the schema, ahead of its enum or pattern, and
 * `toJSONSchema` emits only `schema`, so the advertised check is unchanged and
 * names the canonical spelling; an unknown value still fails it under the
 * field's name, and a non-string reaches `schema` untouched to be rejected.
 * Over a preprocess an advertised default needs `.prefault()`, not `.default()`.
 * `title` capitalizes the first letter and lower-cases the rest — one-word
 * values only.
 */
export function anyLetterCase<T extends z.ZodType>(schema: T, canonical: LetterCase = 'lower') {
  const toCase = TO_LETTER_CASE[canonical];
  return z.preprocess((value) => (typeof value === 'string' ? toCase(value) : value), schema);
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
  if (result.data.length === 0 && result.pagination.count === 0) addNotice(ctx, message);
}

/** Notice sentences written so far in each call, keyed by its context. */
const noticesByCall = new WeakMap<Context, string[]>();

/**
 * Add a sentence to the call's `notice`. `ctx.enrich.notice` is last-wins, so
 * every notice in a handler goes through here: each write re-emits all of the
 * call's sentences, in the order they were added, as one string.
 */
export function addNotice(ctx: Context, text: string): void {
  const notices = noticesByCall.get(ctx) ?? [];
  notices.push(text);
  noticesByCall.set(ctx, notices);
  ctx.enrich.notice(notices.join(' '));
}

/** Joins ignored input names as "a or b" / "a, b, or c". */
const IGNORED_NAMES = new Intl.ListFormat('en', { type: 'disjunction' });

/**
 * Disclose the supplied inputs an operation doesn't use. The call is still
 * served — these are filters another operation reads — but a dropped filter
 * otherwise reads as applied. `candidates` maps input names to their values for
 * this call; undefined, null, and blank values are unset and draw nothing.
 * `detail` adds a sentence (e.g. that results span every congress).
 */
export function noticeIgnoredInputs(
  ctx: Context,
  operation: string,
  candidates: Record<string, unknown>,
  detail?: string,
): void {
  const ignored = Object.entries(candidates)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name]) => name);
  if (ignored.length === 0) return;
  const names = IGNORED_NAMES.format(ignored);
  const verb = ignored.length === 1 ? 'was' : 'were';
  addNotice(
    ctx,
    `'${operation}' does not use ${names}, so ${ignored.length === 1 ? 'it' : 'they'} ${verb} ignored.${detail ? ` ${detail}` : ''}`,
  );
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
 * Characters of one summary row's `text` a response returns when the caller
 * names no window. Matches `DEFAULT_CONTENT_CHARACTERS` deliberately — a row
 * carries about this much body text whichever surface produced it — and sits
 * just under the largest row measured on a 250-row browse page (25,210), so the
 * browse feed windows outliers only. A single bill's summaries are the reason
 * it exists: one enacted omnibus summary runs past 200,000 characters. The
 * window bounds a row, never the page: `limit` alone sets how many rows return.
 */
export const DEFAULT_SUMMARY_TEXT_CHARACTERS = 25_000;

/**
 * The format input of a `content` operation over GPO publications — bill text,
 * committee reports, and Congressional Record articles. A CRS report publishes
 * one readable format, so `congressgov_crs_reports` takes the window alone.
 */
export const documentFormatInput = {
  format: z
    .enum(DOCUMENT_FORMATS)
    .default('text')
    .describe(
      "Document format for 'content'. 'text' is GPO's Formatted Text — plain, pre-formatted print output, published for every document checked. 'xml' prefers United States Legislative Markup and falls back to Formatted XML; it exists on some bill text versions and on no committee report or Congressional Record article. PDF is not retrieved — read one at the format URLs 'text'/'articles' return.",
    ),
};

/**
 * The character window every `content` operation returns.
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
 * Failure modes of the `content` operation on `congressgov_amendment_lookup`,
 * `congressgov_bill_lookup`, `congressgov_committee_reports`,
 * `congressgov_crs_reports`, and `congressgov_daily_record`. Layered on top of
 * `congressErrorContracts` — the document fetch is a second upstream
 * (`www.congress.gov`) with its own ways to fail, and only these five tools reach it.
 *
 * `CongressDocumentsService` and the format selectors in `document-formats.ts`
 * raise each with a matching `data.reason`, and the framework fills the
 * `recovery` hint declared here, so the hint lives in exactly one place.
 * Direct-handler tests retain explicit forwards where needed.
 * Resolves cyanheads/congressgov-mcp-server#53.
 */
export const documentErrorContracts = [
  {
    code: JsonRpcErrorCode.NotFound,
    reason: 'document_unavailable',
    thrownBy: 'service',
    retryable: false,
    when: "The 'content' selection resolves to no retrievable document — the text version or article index is past the end of the list, the record publishes no formats at all, or Congress.gov does not hold the file its own metadata names.",
    recovery:
      "See which documents Congress.gov publishes for this record — the tool's 'text' or 'articles' operation lists them, and for a CRS report 'get' lists its formats — then retry with a selection listed there or read the document at a URL listed there.",
  },
  {
    code: JsonRpcErrorCode.NotFound,
    reason: 'format_unavailable',
    thrownBy: 'service',
    retryable: false,
    when: 'The document exists but publishes nothing in a format this server reads — some text versions and committee reports ship PDF only, no Congressional Record article publishes XML, and the oldest CRS reports publish a PDF but no HTML.',
    recovery:
      "Where the tool takes a format, retry with format 'text', which every GPO document checked publishes. A PDF-only document is not read as text: read it at its PDF URL, which this error names for a CRS report and the 'text' or 'articles' operation lists for the others.",
  },
  {
    code: JsonRpcErrorCode.ServiceUnavailable,
    reason: 'document_fetch_failed',
    thrownBy: 'service',
    retryable: true,
    when: 'www.congress.gov did not return a readable document — a non-2xx status, a network failure, an empty body, or a content type that is not text or XML.',
    recovery:
      'Retry after a short delay; if the failure persists, request a different format or read the document at the sourceUrl the text operation returns.',
  },
  {
    code: JsonRpcErrorCode.ValidationError,
    reason: 'document_too_large',
    thrownBy: 'service',
    retryable: false,
    when: 'The document is larger than the byte ceiling this server retrieves, so no character window can be served from it.',
    recovery:
      'Read the document at the sourceUrl the text operation returns. A document this size clears the ceiling in every format it publishes, so switching format reaches the same limit.',
  },
  {
    code: JsonRpcErrorCode.ValidationError,
    reason: 'offset_past_end',
    thrownBy: 'service',
    retryable: false,
    when: "characterOffset is at or beyond the last character of every text the call would window — the document on 'content', or every returned row's summary text on 'summaries' — so the window would be empty.",
    recovery:
      "Restart the walk at characterOffset 0 and follow the response's nextOffset (or a summary row's textNextOffset), which goes null once the text has been read to the end.",
  },
] as const satisfies readonly ErrorContract[];

/**
 * Shared `errors[]` contract for every Congress.gov API tool. Every tool except
 * the mirror-backed `congressgov_search_bills` reaches the same `CongressApiService` fetch path, so they surface the same six
 * upstream failure modes. The service raises each with a matching `data.reason`
 * and `data.recovery.hint` (see `classifyUpstreamError`), making the failures
 * machine-readable; declaring them here advertises the contract in `tools/list`.
 * Resolves cyanheads/congressgov-mcp-server#32, #34, and #84.
 */
export const congressErrorContracts = [
  {
    code: JsonRpcErrorCode.NotFound,
    reason: 'not_found',
    thrownBy: 'service',
    retryable: false,
    when: 'A requested bill, member, committee, report, vote, or nomination does not exist in Congress.gov.',
    recovery:
      "Use the tool's list or browse operation to discover valid identifiers, then retry with one that exists.",
  },
  {
    code: JsonRpcErrorCode.RateLimited,
    reason: 'rate_limited',
    thrownBy: 'service',
    retryable: true,
    when: 'A process-local attempt budget or the shared upstream credential/IP quota was reached; upstream hourly limits vary and DEMO_KEY also has a daily quota. On a Senate vote the LIS feed could not answer, Voteview answering HTTP 429 is reported the same way.',
    recovery:
      'Follow Retry-After when supplied; otherwise wait and reduce request frequency. This process cannot account for other clients sharing the key or demo IP.',
  },
  {
    code: JsonRpcErrorCode.InvalidParams,
    reason: 'invalid_request',
    thrownBy: 'service',
    retryable: false,
    when: 'Congress.gov rejected the request as malformed — a bad date range or an identifier with an unexpected shape.',
    recovery:
      'Check parameter formats: dates must be ISO 8601 like 2026-05-01T00:00:00Z and identifiers must match their documented shape.',
  },
  {
    code: JsonRpcErrorCode.ConfigurationError,
    reason: 'api_key_rejected',
    thrownBy: 'service',
    retryable: false,
    when: "The api.data.gov gateway rejected the server's configured CONGRESS_API_KEY (missing, invalid, disabled, unauthorized, or unverified); the gateway code is in data.upstreamCode. No change to the call's arguments can fix it.",
    recovery:
      'This is a server configuration problem, not a request problem: the operator must replace CONGRESS_API_KEY with a valid api.data.gov key (https://api.data.gov/signup/) or unset it to fall back to the rate-limited DEMO_KEY, then restart the server.',
  },
  {
    code: JsonRpcErrorCode.ServiceUnavailable,
    reason: 'upstream_error',
    thrownBy: 'service',
    retryable: true,
    when: 'Congress.gov returned an unexpected error (5xx or another non-2xx status) or could not be reached, or a Senate vote could be read from neither the Senate LIS feed nor its Voteview fallback (before the 101st Congress there is no fallback, and there a senate.gov HTTP 403 refusal carries retryable: false).',
    recovery:
      'Retry after a short delay; if the failure persists the Congress.gov service may be temporarily degraded.',
  },
  {
    code: JsonRpcErrorCode.Timeout,
    reason: 'upstream_timeout',
    thrownBy: 'service',
    retryable: true,
    when: "A Congress.gov request or a congress.gov document fetch timed out or returned an HTTP timeout response, or the call's upstream requests could not finish inside its 50-second budget.",
    recovery:
      'Retry after a short delay; if the failure persists the Congress.gov service may be temporarily degraded.',
  },
] as const satisfies readonly ErrorContract[];

/** Domain refusal when a list operation would discard an entity identifier. */
export const identityErrorContracts = [
  {
    code: JsonRpcErrorCode.ValidationError,
    reason: 'incompatible_identity',
    retryable: false,
    when: 'A list operation carries an entity identifier that only a detail operation uses.',
    recovery:
      'Remove the named identity field to browse, or select the compatible operation named in the error and supply its required identifiers.',
  },
] as const satisfies readonly ErrorContract[];
