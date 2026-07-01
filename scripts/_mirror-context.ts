/**
 * @fileoverview Shared bootstrap for the mirror lifecycle CLI scripts
 * (congress-mirror-init / congress-mirror-refresh / congress-mirror-verify).
 * Builds the Congress API client and the mirror service from the environment and
 * hands back the underlying mirror — no MCP transport, no tool registration.
 * Imported by the three named scripts, so it must travel with them in the npm
 * tarball and the Docker image.
 * @module scripts/_mirror-context
 */

import type { Mirror } from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';
import { initCongressApi } from '@/services/congress-api/congress-api-service.js';
import { initCongressMirror } from '@/services/congress-mirror/congress-mirror-service.js';

/**
 * Build the mirror from env config and return its instance. The CLI builds the
 * mirror regardless of `CONGRESS_MIRROR_ENABLED` (that flag gates the tool and the
 * in-process scheduler, not out-of-band index construction); the ingester pages
 * the live Congress.gov API via `CongressApiService`, so init it here.
 */
export function getMirror(): Mirror {
  const config = getServerConfig();
  initCongressApi();
  const service = initCongressMirror({
    mirrorPath: config.mirrorPath,
    congresses: config.congresses,
  });
  return service.mirrorInstance;
}
