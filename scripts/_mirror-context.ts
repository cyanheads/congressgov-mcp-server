/**
 * @fileoverview Shared bootstrap for the mirror lifecycle CLI scripts
 * (congress-mirror-init / congress-mirror-refresh / congress-mirror-verify).
 * Initializes the framework logger, builds the Congress API client and the mirror
 * service from the environment, and hands back the underlying mirror — no MCP
 * transport, no tool registration. Imported by the three named scripts, so it
 * must travel with them in the npm tarball and the Docker image.
 * @module scripts/_mirror-context
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
