/**
 * @fileoverview Server-specific configuration for the Congress.gov MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Default on-disk location of the SQLite bill FTS mirror. */
export const DEFAULT_MIRROR_PATH = '.mirror/bills.sqlite3';

/**
 * Congress number covering a given date. The 1st U.S. Congress convened in 1789
 * and each Congress spans two years, so `floor((year - 1789) / 2) + 1` yields the
 * ordinal (2025–2026 → 119). Used to seed the default mirror window when
 * `CONGRESS_MIRROR_CONGRESSES` is unset.
 */
export function currentCongressNumber(date: Date = new Date()): number {
  return Math.floor((date.getUTCFullYear() - 1789) / 2) + 1;
}

/**
 * Parse `CONGRESS_MIRROR_CONGRESSES` — a comma-separated list of congress numbers
 * ("118,119") — into a positive-integer array. Unset/empty falls back to the
 * current congress plus the one prior (the realistic "what's this recent bill
 * about" search window); a fully malformed value resolves to an empty array,
 * which the `.min(1)` guard rejects loudly at startup.
 */
function parseCongresses(value: unknown): number[] {
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  const current = currentCongressNumber();
  return [current, current - 1];
}

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .default('DEMO_KEY')
    .describe(
      'Congress.gov API key from api.data.gov — optional (DEMO_KEY: 30 req/hr, own key: 5000 req/hr)',
    ),
  baseUrl: z
    .string()
    .url()
    .default('https://api.congress.gov/v3')
    .describe('Congress.gov API base URL'),

  /**
   * Master switch for the local bill FTS mirror + `congressgov_search_bills`.
   * Off by default so the standard deploy stays config-free and the live-API
   * tools are unaffected. Unset/empty/malformed resolves to `false`.
   */
  mirrorEnabled: z
    .preprocess((v) => (v === undefined || v === null || v === '' ? 'false' : v), z.stringbool())
    .describe('Enable the local bill search mirror and the congressgov_search_bills tool.'),
  /** Filesystem path to the SQLite mirror index file (matches the Dockerfile `.mirror` dir). */
  mirrorPath: z
    .string()
    .min(1)
    .default(DEFAULT_MIRROR_PATH)
    .describe('Filesystem path to the SQLite bill mirror index.'),
  /**
   * Cron expression for the in-process incremental refresh (HTTP transport only).
   * Unset means no in-process schedule — run `bun run mirror:refresh` out-of-band.
   */
  mirrorRefreshCron: z
    .preprocess((v) => (v === '' || v === null ? undefined : v), z.string().min(1).optional())
    .describe('Cron schedule for the in-process mirror refresh (HTTP only; omit to run manually).'),
  /**
   * Congresses to mirror. Defaults to the current congress plus the one prior.
   * Comma-separated env value (e.g. "118,119"); widening the window is a config
   * change, not a redesign.
   */
  congresses: z
    .preprocess(parseCongresses, z.array(z.number().int().positive()).min(1))
    .describe('Congress numbers included in the mirror (default: current + 1 prior).'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'CONGRESS_API_KEY',
    baseUrl: 'CONGRESS_API_BASE_URL',
    mirrorEnabled: 'CONGRESS_MIRROR_ENABLED',
    mirrorPath: 'CONGRESS_MIRROR_PATH',
    mirrorRefreshCron: 'CONGRESS_MIRROR_REFRESH_CRON',
    congresses: 'CONGRESS_MIRROR_CONGRESSES',
  });
  return _config;
}

/** Reset the cached config — test-only. */
export function resetServerConfig(): void {
  _config = undefined;
}
