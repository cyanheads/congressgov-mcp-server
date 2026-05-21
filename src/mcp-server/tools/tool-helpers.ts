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
    query: z
      .string()
      .optional()
      .describe(
        'Echo of the applied filters for this query. Rendered as the first line of the response so the caller can confirm what was searched.',
      ),
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
      query: z
        .string()
        .optional()
        .describe(
          'Echo of the applied filters for list-mode queries. Rendered as the first line of the response.',
        ),
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
 * Build the `query` echo for a list response. The formatter renders this as
 * the leading "Search:" line regardless of whether results are empty, so the
 * caller can always confirm what filters were applied.
 */
export function buildQueryEcho(scope: string, filters?: Record<string, unknown>): string {
  if (!filters) return scope;
  const parts: string[] = [];
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === '') continue;
    parts.push(`${key}=${String(val)}`);
  }
  return parts.length === 0 ? scope : `${scope} (${parts.join(', ')})`;
}
