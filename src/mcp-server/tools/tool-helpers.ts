/**
 * @fileoverview Shared utilities for Congress.gov tool definitions.
 * @module mcp-server/tools/tool-helpers
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  type ErrorContract,
  JsonRpcErrorCode,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';

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
 * if (result.data.length === 0) ctx.enrich.notice('No matching results. Try adjusting the filters.');
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
