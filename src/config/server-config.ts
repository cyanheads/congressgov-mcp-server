/**
 * @fileoverview Server-specific configuration for the Congress.gov MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .default('DEMO_KEY')
    .describe(
      'Congress.gov API key from api.data.gov — optional (DEMO_KEY: 30 req/hr, own key: 1000 req/hr)',
    ),
  baseUrl: z
    .string()
    .url()
    .default('https://api.congress.gov/v3')
    .describe('Congress.gov API base URL'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'CONGRESS_API_KEY',
    baseUrl: 'CONGRESS_API_BASE_URL',
  });
  return _config;
}
