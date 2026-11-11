/**
 * @fileoverview mirror:init — full out-of-band build of the Congress bill FTS
 * mirror. Walks the bill list and CRS summaries for the configured congress
 * window, merges them into one row per bill, and writes the SQLite index. Each
 * committed page stores a resume cursor, so re-running after an interrupt resumes
 * from it instead of starting over (the framework upserts by primary key). Run as
 * a one-shot job or at Docker build, never on server startup.
 * @module cli/mirror-init
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { getMirror, syncSignal } from './mirror-context.js';

const mirror = await getMirror();
logger.info('Starting Congress bill mirror init (full build)');

const result = await mirror.runSync({ mode: 'init', signal: syncSignal() });

logger.info(
  `Congress bill mirror init complete: ${result.recordsApplied} records applied across ${result.pagesFetched} pages (total ${result.total}).`,
);
await mirror.close();
process.exit(0);
