#!/usr/bin/env bun
/**
 * @fileoverview mirror:init — full out-of-band build of the Congress bill FTS
 * mirror. Pages the bill list and CRS summaries for the configured congress
 * window, merges them into one row per bill, and writes the SQLite index.
 * Idempotent (the framework upserts by primary key) — safe to re-run after an
 * interrupt. Run as a one-shot job or at Docker build, never on server startup.
 * @module scripts/congress-mirror-init
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { getMirror } from './_mirror-context.js';

const mirror = getMirror();
logger.info('Starting Congress bill mirror init (full build)');

const result = await mirror.runSync({ mode: 'init', signal: AbortSignal.timeout(3_600_000) });

logger.info(
  `Congress bill mirror init complete: ${result.recordsApplied} records applied across ${result.pagesFetched} pages (total ${result.total}).`,
);
await mirror.close();
process.exit(0);
