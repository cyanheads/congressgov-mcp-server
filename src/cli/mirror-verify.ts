/**
 * @fileoverview mirror:verify — report the Congress bill mirror health: readiness,
 * sync status, last completion, record count, and a SQLite integrity check. Exits
 * non-zero when the mirror is not ready or integrity fails, so it can gate a
 * deployment or a post-build smoke check.
 * @module cli/mirror-verify
 */

import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getMirror } from './mirror-context.js';

const mirror = await getMirror();
const context = requestContextService.createRequestContext({ operation: 'mirror:verify' });
const status = await mirror.status();

logger.info(
  `Congress bill mirror status: ready=${status.ready}, status=${status.status}, total=${status.total ?? 0}, completedAt=${status.completedAt ?? 'never'}`,
);
if (status.error) logger.warning(`Last sync error: ${status.error}`);

if (!status.ready) {
  logger.error('Mirror is NOT ready — run mirror:init to build the index.', context);
  await mirror.close();
  process.exit(1);
}

const integrity = await mirror.store.integrityCheck();
if (!integrity.ok) {
  logger.error(`SQLite integrity check FAILED: ${integrity.results.join('; ')}`, context);
  await mirror.close();
  process.exit(1);
}

logger.info('Congress bill mirror integrity check passed.');
await mirror.close();
process.exit(0);
