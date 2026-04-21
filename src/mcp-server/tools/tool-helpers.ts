/**
 * @fileoverview Shared utilities for Congress.gov tool definitions.
 * @module mcp-server/tools/tool-helpers
 */

export function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
