/**
 * @fileoverview Contract tests for the MCP-advertised tool catalog.
 * @module tests/mcp-server/tools/definitions/tool-catalog.contract
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { committeeLookupTool } from '@/mcp-server/tools/definitions/committee-lookup.tool.js';
import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { crsReportsTool } from '@/mcp-server/tools/definitions/crs-reports.tool.js';
import { dailyRecordTool } from '@/mcp-server/tools/definitions/daily-record.tool.js';
import { enactedLawsTool } from '@/mcp-server/tools/definitions/enacted-laws.tool.js';
import { memberLookupTool } from '@/mcp-server/tools/definitions/member-lookup.tool.js';
import { rollVotesTool } from '@/mcp-server/tools/definitions/roll-votes.tool.js';
import { senateNominationsTool } from '@/mcp-server/tools/definitions/senate-nominations.tool.js';

const LIST_OR_DETAIL_TOOLS = [
  billLookupTool,
  enactedLawsTool,
  memberLookupTool,
  committeeLookupTool,
  rollVotesTool,
  senateNominationsTool,
  crsReportsTool,
  committeeReportsTool,
  dailyRecordTool,
] as const;

const EXPECTED_TITLES = {
  congressgov_bill_lookup: 'Congress.gov Bill Lookup',
  congressgov_enacted_laws: 'Congress.gov Enacted Laws',
  congressgov_member_lookup: 'Congress.gov Member Lookup',
  congressgov_committee_lookup: 'Congress.gov Committee Lookup',
  congressgov_roll_votes: 'Congress.gov Roll Votes',
  congressgov_senate_nominations: 'Congress.gov Senate Nominations',
  congressgov_bill_summaries: 'Congress.gov Bill Summaries',
  congressgov_crs_reports: 'Congress.gov CRS Reports',
  congressgov_committee_reports: 'Congress.gov Committee Reports',
  congressgov_daily_record: 'Congress.gov Daily Record',
  congressgov_search_bills: 'Congress.gov Bill Search',
} as const;

const EXPECTED_DETAIL_ROOTS = {
  congressgov_bill_lookup: ['bill', 'content'],
  congressgov_enacted_laws: ['law'],
  congressgov_member_lookup: ['member'],
  congressgov_committee_lookup: ['committee'],
  congressgov_roll_votes: ['vote'],
  congressgov_senate_nominations: ['nomination'],
  congressgov_crs_reports: ['report'],
  congressgov_committee_reports: ['report', 'text', 'content'],
  congressgov_daily_record: ['content'],
} as const;

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: unknown;
};

type AdvertisedTool = {
  name: string;
  title?: string;
  outputSchema?: JsonSchema;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

function createStdioCatalogClient(mirrorPath: string, logsPath: string) {
  const server: ChildProcessWithoutNullStreams = spawn('bun', ['src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: 'stdio',
      LOGS_DIR: logsPath,
      CONGRESS_MIRROR_ENABLED: 'true',
      CONGRESS_MIRROR_PATH: mirrorPath,
    },
  });
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let stdoutBuffer = '';
  let stderr = '';

  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      const response = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (response.id === undefined) continue;
      const request = pending.get(response.id);
      if (!request) continue;
      clearTimeout(request.timeout);
      pending.delete(response.id);
      if (response.error) {
        request.reject(new Error(`MCP ${response.error.code}: ${response.error.message}`));
      } else {
        request.resolve(response.result);
      }
    }
  });
  server.on('exit', (code) => {
    if (code === 0 || pending.size === 0) return;
    const error = new Error(`Catalog server exited with code ${code}. ${stderr}`.trim());
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  });

  const request = <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for MCP ${method}. ${stderr}`.trim()));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  return {
    async listTools(): Promise<AdvertisedTool[]> {
      await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'tool-catalog-contract-test', version: '1.0.0' },
      });
      server.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      return (await request<{ tools: AdvertisedTool[] }>('tools/list', {})).tools;
    },
    async close(): Promise<void> {
      server.stdin.end();
      if (server.exitCode === null && server.signalCode === null) await once(server, 'exit');
    },
  };
}

describe('tool catalog contract', () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mirrorPath = join(tmpdir(), `congressgov-catalog-${runId}.sqlite3`);
  const logsPath = join(tmpdir(), `congressgov-catalog-logs-${runId}`);
  let closeServer: () => Promise<void>;
  let tools: AdvertisedTool[];

  beforeAll(async () => {
    const client = createStdioCatalogClient(mirrorPath, logsPath);
    closeServer = client.close;
    tools = await client.listTools();
  });

  afterAll(async () => {
    await closeServer();
    for (const suffix of ['', '-wal', '-shm']) {
      const path = mirrorPath + suffix;
      if (existsSync(path)) rmSync(path, { force: true });
    }
    if (existsSync(logsPath)) rmSync(logsPath, { recursive: true, force: true });
  });

  it('retains the shared list, enrichment, and error fields in tools/list', () => {
    for (const definition of LIST_OR_DETAIL_TOOLS) {
      const advertised = tools.find(({ name }) => name === definition.name);
      const properties = advertised?.outputSchema?.properties;
      expect(properties, definition.name).toEqual(
        expect.objectContaining({
          data: expect.any(Object),
          pagination: expect.any(Object),
          effectiveQuery: expect.any(Object),
          totalCount: expect.any(Object),
          notice: expect.any(Object),
          error: expect.any(Object),
        }),
      );
    }
  });

  it('keeps dynamic list rows permissive in the advertised schema', () => {
    const advertised = tools.find(({ name }) => name === billLookupTool.name);
    const data = advertised?.outputSchema?.properties?.data as
      | { items?: { additionalProperties?: unknown } }
      | undefined;
    expect(data?.items?.additionalProperties).toEqual({});
  });

  it('advertises the complete optional non-list root inventory', () => {
    for (const [toolName, roots] of Object.entries(EXPECTED_DETAIL_ROOTS)) {
      const advertised = tools.find(({ name }) => name === toolName);
      const properties = advertised?.outputSchema?.properties ?? {};
      const required = advertised?.outputSchema?.required ?? [];
      for (const root of roots) {
        expect(properties, `${toolName}.${root}`).toHaveProperty(root);
        expect(required, `${toolName}.${root}`).not.toContain(root);
        const schema = properties[root] as {
          type?: string;
          additionalProperties?: unknown;
          items?: { additionalProperties?: unknown };
        };
        if (root === 'text') {
          expect(schema.type, `${toolName}.${root}`).toBe('array');
          expect(schema.items?.additionalProperties, `${toolName}.${root}`).toEqual({});
        } else {
          expect(schema.type, `${toolName}.${root}`).toBe('object');
          expect(schema.additionalProperties, `${toolName}.${root}`).toEqual({});
        }
      }
    }
  });

  it('advertises the exact explicit title inventory', () => {
    expect(Object.fromEntries(tools.map(({ name, title }) => [name, title]))).toEqual(
      EXPECTED_TITLES,
    );
  });

  it('describes committee filter behavior without internal fetch details', () => {
    const description = committeeLookupTool.input.shape.filter.description;
    expect(description).toContain("Only meaningful for 'list'");
    expect(description).toContain('fuzzy-matched rows are labeled approximate');
    expect(description).not.toMatch(/fetch|client-side/i);
  });

  it('accepts nested dynamic records on every existing success root', () => {
    const nested = { outer: { inner: { value: 'kept' } } };
    const samples = [
      [billLookupTool, { bill: nested }, { content: nested }],
      [enactedLawsTool, { law: nested }],
      [memberLookupTool, { member: nested }],
      [committeeLookupTool, { committee: nested }],
      [rollVotesTool, { vote: nested }],
      [senateNominationsTool, { nomination: nested }],
      [crsReportsTool, { report: nested }],
      [committeeReportsTool, { report: nested }, { text: [nested] }, { content: nested }],
      [dailyRecordTool, { content: nested }],
    ] as const;

    for (const [definition, ...outputs] of samples) {
      for (const output of outputs) {
        expect(definition.output.parse(output), definition.name).toEqual(output);
      }
    }
  });
});
