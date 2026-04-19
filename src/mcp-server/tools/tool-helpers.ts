/**
 * @fileoverview Shared schemas and small utilities for Congress.gov tool definitions.
 * @module mcp-server/tools/tool-helpers
 */

import { z } from '@cyanheads/mcp-ts-core';

export const StringOrNumberSchema = z.union([z.number(), z.string()]);

export const UnknownRecordSchema = z.record(z.string(), z.unknown());

export function createPaginationSchema(countDescription: string) {
  return z.object({
    count: z.number().int().nonnegative().describe(countDescription),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Offset to request the next page, or null when there is no next page.'),
  });
}

export function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
