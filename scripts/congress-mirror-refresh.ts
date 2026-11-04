#!/usr/bin/env bun
/**
 * @fileoverview mirror:refresh — incremental refresh of the Congress bill FTS
 * mirror. Re-walks each checkpoint-covered congress's bill list from the
 * checkpoint day and any other configured congress from its start, then re-walks
 * the CRS summaries, merging them into the existing index; the index stays
 * transactionally queryable throughout. Run out-of-band for stdio deployments
 * (the HTTP server schedules this on a cron when CONGRESS_MIRROR_REFRESH_CRON is
 * set).
 * @module scripts/congress-mirror-refresh
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { getMirror } from './_mirror-context.js';

const mirror = await getMirror();
logger.info('Starting Congress bill mirror refresh');

const result = await mirror.runSync({ mode: 'refresh', signal: AbortSignal.timeout(3_600_000) });

logger.info(
  `Congress bill mirror refresh complete: ${result.recordsApplied} records applied (total ${result.total}).`,
);
await mirror.close();
process.exit(0);
