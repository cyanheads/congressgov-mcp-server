/**
 * @fileoverview Shared utilities for Congress.gov tool definitions.
 * @module mcp-server/tools/tool-helpers
 */

import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

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
 */
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function validateIsoDateTime(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return;
  if (!ISO_8601_PATTERN.test(value)) {
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
