/**
 * @fileoverview Shared bootstrap for the mirror lifecycle CLI
 * (mirror-init / mirror-refresh / mirror-verify). Initializes the framework logger,
 * builds the Congress API client and the mirror service from the environment, and
 * hands back the underlying mirror — no MCP transport, no tool registration. The CLI
 * compiles with the server into `dist/cli/`, so a checkout (after a build), the
 * Docker image, and an npm install run the same files under Bun or Node.
 * @module cli/mirror-context
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import type { Mirror } from '@cyanheads/mcp-ts-core/mirror';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { initCongressApi } from '@/services/congress-api/congress-api-service.js';
import { initCongressMirror } from '@/services/congress-mirror/congress-mirror-service.js';

/**
 * Initialize the logger, then build the mirror from env config and return its
 * instance. The logger buffers records until `initialize()` and discards them at
 * exit, so it starts first; `'stdio'` writes JSON lines to stderr and leaves
 * stdout empty, at the `MCP_LOG_LEVEL` floor the server uses. The CLI builds the
 * mirror regardless of `CONGRESS_MIRROR_ENABLED` (that flag gates the tool and the
 * in-process scheduler, not out-of-band index construction); the ingester pages
 * the live Congress.gov API via `CongressApiService`, so init it here.
 */
export async function getMirror(): Promise<Mirror> {
  await logger.initialize(config.logLevel, 'stdio');
  const serverConfig = getServerConfig();
  initCongressApi();
  const service = initCongressMirror({
    mirrorPath: serverConfig.mirrorPath,
    congresses: serverConfig.congresses,
  });
  return service.mirrorInstance;
}

/**
 * The signal a sync run takes: it aborts after an hour, or on the first SIGINT or
 * SIGTERM. Ending the process mid-page would skip the run's settle step, leaving
 * its sync lease held for up to two minutes, so an immediate re-run would be
 * refused `sync_locked`; aborting lets the run store its position and release the
 * lease first. A second signal ends the process at once.
 */
export function syncSignal(): AbortSignal {
  const stop = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.once(name, () => {
      logger.info(
        `${name} received: stopping the sync after the request in flight. Send it again to end at once.`,
      );
      stop.abort(new Error(`Stopped by ${name}.`));
    });
  }
  return AbortSignal.any([stop.signal, AbortSignal.timeout(3_600_000)]);
}
