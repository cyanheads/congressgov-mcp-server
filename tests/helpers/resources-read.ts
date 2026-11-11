/**
 * @fileoverview `resources/read` as a client meets it: a JSON-RPC request through
 * the framework's worker handler, where a `params` rejection answers -32007
 * (ValidationError) before the resource handler runs.
 * @module tests/helpers/resources-read
 */

import { createWorkerHandler, type WorkerHandlerOptions } from '@cyanheads/mcp-ts-core/worker';

/** The JSON-RPC body a `resources/read` answers with. */
export interface ResourcesReadBody {
  error?: { code: number; data?: unknown };
  result?: { contents: Array<{ text?: string }> };
}

/** A `resources/read` client over a server that serves `resources` alone. */
export function resourcesReader(resources: NonNullable<WorkerHandlerOptions['resources']>) {
  const app = createWorkerHandler({
    name: 'congressgov-mcp-server',
    title: 'congressgov-mcp-server',
    resources,
  });

  return async function resourcesRead(uri: string): Promise<ResourcesReadBody> {
    const response = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'resources/read',
          'Mcp-Name': uri,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/read',
          params: {
            uri,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
      {},
      { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as never,
    );
    const text = await response.text();
    const json = text.startsWith('{')
      ? text
      : (text
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice('data:'.length) ?? text);
    return JSON.parse(json) as ResourcesReadBody;
  };
}
