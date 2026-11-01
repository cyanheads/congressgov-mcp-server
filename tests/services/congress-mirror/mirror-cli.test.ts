/**
 * @fileoverview Integration tests for the mirror lifecycle CLI scripts
 * (`scripts/congress-mirror-{init,refresh,verify}.ts`). Each script runs as a Bun
 * subprocess, the way an operator runs it, so the shared bootstrap's logger
 * initialization is exercised end to end: records on stderr as JSON lines, stdout
 * empty, the level following `MCP_LOG_LEVEL`. Init and refresh page a loopback
 * stand-in for the Congress.gov API.
 * @module tests/services/congress-mirror/mirror-cli
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CongressMirrorService } from '@/services/congress-mirror/congress-mirror-service.js';

const SCRIPT_TIMEOUT_MS = 30_000;

interface ScriptRun {
  code: number | null;
  /** `msg` of every stderr record, in order. */
  messages: string[];
  /** Parsed stderr records. */
  records: Record<string, unknown>[];
  stdout: string;
}

/**
 * Run one mirror script under Bun from the checkout root. `NODE_ENV` is pinned
 * because the framework logger writes nothing to stderr under `testing`, which
 * the test runner would otherwise hand down; `CONGRESS_API_KEY` is pinned so no
 * real key from a local `.env` reaches the loopback upstream.
 */
async function runScript(script: string, env: Record<string, string>): Promise<ScriptRun> {
  const child = spawn('bun', [`scripts/${script}`], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', CONGRESS_API_KEY: 'test-key', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, 'close')) as [number | null];
  const records = stderr
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, stdout, records, messages: records.map((r) => String(r.msg)) };
}

interface Upstream {
  baseUrl: string;
  /** Every request the scripts made, in order. */
  requests: URL[];
  server: Server;
}

const UPSTREAM_BILLS = [
  {
    congress: 119,
    type: 'HR',
    number: '1',
    title: 'Semiconductor Export Control Act',
    originChamber: 'House',
    latestAction: { actionDate: '2026-01-05', text: 'Referred to committee' },
    updateDate: '2026-01-10',
  },
  {
    congress: 119,
    type: 'S',
    number: '2',
    title: 'Clean Water Restoration Act',
    originChamber: 'Senate',
    latestAction: { actionDate: '2026-01-18', text: 'Read twice' },
    updateDate: '2026-02-01',
  },
];

const UPSTREAM_SUMMARIES = [
  {
    bill: { congress: 119, type: 'HR', number: '1' },
    text: '<p>Restricts the export of advanced semiconductor manufacturing equipment.</p>',
    updateDate: '2025-03-01T12:00:00Z',
  },
];

/**
 * Loopback stand-in for the two list endpoints the ingester pages. It honors
 * `fromDateTime` the way Congress.gov does: the summaries list without one holds
 * only the last day's updates (none here), with one it holds every summary
 * updated since; the bill list filters on `updateDate`.
 */
async function startUpstream(): Promise<Upstream> {
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(url);
    const from = url.searchParams.get('fromDateTime');
    let body: Record<string, unknown>;
    if (url.pathname === '/v3/summaries/119') {
      const rows = from ? UPSTREAM_SUMMARIES.filter((s) => s.updateDate >= from) : [];
      body = { summaries: rows, pagination: { count: rows.length } };
    } else if (url.pathname === '/v3/bill/119') {
      const rows = from
        ? UPSTREAM_BILLS.filter((b) => b.updateDate >= from.slice(0, 10))
        : UPSTREAM_BILLS;
      body = { bills: rows, pagination: { count: rows.length } };
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 404, message: 'Not found' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, requests, baseUrl: `http://127.0.0.1:${port}/v3` };
}

describe('mirror lifecycle scripts', () => {
  let dir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'congress-mirror-cli-'));
    env = {
      CONGRESS_MIRROR_ENABLED: 'true',
      CONGRESS_MIRROR_CONGRESSES: '119',
      CONGRESS_MIRROR_PATH: join(dir, 'bills.sqlite3'),
      LOGS_DIR: join(dir, 'logs'),
      MCP_LOG_LEVEL: 'debug',
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('mirror:verify', () => {
    it(
      'reports a never-built store on stderr and exits 1',
      async () => {
        const run = await runScript('congress-mirror-verify.ts', env);

        expect(run.code).toBe(1);
        expect(run.stdout).toBe('');
        expect(run.messages).toContain(
          'Congress bill mirror status: ready=false, status=pending, total=0, completedAt=never',
        );
        // Pino's numeric level for `error`.
        expect(run.records.at(-1)).toMatchObject({
          level: 50,
          msg: 'Mirror is NOT ready — run mirror:init to build the index.',
        });
      },
      SCRIPT_TIMEOUT_MS,
    );

    it(
      'reports a built store and its integrity check, exiting 0',
      async () => {
        const service = new CongressMirrorService({
          mirrorPath: env.CONGRESS_MIRROR_PATH as string,
          congresses: [119],
          getApi: () => ({
            listBills: async ({ offset }) => ({
              data: offset ? [] : [UPSTREAM_BILLS[0] as Record<string, unknown>],
              pagination: { count: 1, nextOffset: null },
            }),
            listSummaries: async () => ({ data: [], pagination: { count: 0, nextOffset: null } }),
          }),
        });
        await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(10_000) });
        await service.mirrorInstance.close();

        const run = await runScript('congress-mirror-verify.ts', env);

        expect(run.code).toBe(0);
        expect(run.stdout).toBe('');
        expect(
          run.messages.some((m) =>
            m.startsWith('Congress bill mirror status: ready=true, status=complete, total=1, '),
          ),
        ).toBe(true);
        expect(run.messages.at(-1)).toBe('Congress bill mirror integrity check passed.');
      },
      SCRIPT_TIMEOUT_MS,
    );

    it(
      'follows MCP_LOG_LEVEL — an error floor drops the info status line, keeps the error',
      async () => {
        const run = await runScript('congress-mirror-verify.ts', {
          ...env,
          MCP_LOG_LEVEL: 'error',
        });

        expect(run.code).toBe(1);
        expect(run.stdout).toBe('');
        expect(run.messages).toEqual(['Mirror is NOT ready — run mirror:init to build the index.']);
      },
      SCRIPT_TIMEOUT_MS,
    );
  });

  describe('mirror:init and mirror:refresh', () => {
    let upstream: Upstream;

    beforeEach(async () => {
      upstream = await startUpstream();
      env.CONGRESS_API_BASE_URL = upstream.baseUrl;
    });

    afterEach(async () => {
      upstream.server.close();
      await once(upstream.server, 'close');
    });

    it(
      'logs the start, per-congress, and completion lines on stderr at the MCP_LOG_LEVEL floor; stdout stays empty',
      async () => {
        const init = await runScript('congress-mirror-init.ts', env);

        expect(init.code).toBe(0);
        expect(init.stdout).toBe('');
        // Pino's numeric level for `debug` — the per-request fetch records.
        expect(init.records.some((r) => r.level === 20)).toBe(true);
        expect(init.messages).toContain('Starting Congress bill mirror init (full build)');
        expect(init.messages).toContain(
          'Congress bill mirror sync starting (mode=init, congresses=119)',
        );
        expect(init.messages).toContain('Congress 119: 1 summaries loaded');
        expect(init.messages).toContain('Congress 119: 2 bills mirrored');
        expect(init.messages.at(-1)).toBe(
          'Congress bill mirror init complete: 2 records applied across 1 pages (total 2).',
        );

        const refresh = await runScript('congress-mirror-refresh.ts', {
          ...env,
          MCP_LOG_LEVEL: 'info',
        });

        expect(refresh.code).toBe(0);
        expect(refresh.stdout).toBe('');
        expect(refresh.records.every((r) => typeof r.level === 'number' && r.level >= 30)).toBe(
          true,
        );
        expect(refresh.messages).toContain('Starting Congress bill mirror refresh');
        expect(refresh.messages).toContain(
          'Congress bill mirror sync starting (mode=refresh, congresses=119, since=2026-02-01T00:00:00Z)',
        );
        expect(refresh.messages).toContain('Congress 119: 1 summaries loaded');
        expect(refresh.messages).toContain('Congress 119: 1 bills mirrored');
        expect(refresh.messages.at(-1)).toBe(
          'Congress bill mirror refresh complete: 1 records applied (total 2).',
        );

        // Both runs request the summaries list from the congress's first day, open-ended.
        const summaryQueries = upstream.requests
          .filter((url) => url.pathname === '/v3/summaries/119')
          .map((url) => [url.searchParams.get('fromDateTime'), url.searchParams.has('toDateTime')]);
        expect(summaryQueries).toEqual([
          ['2025-01-01T00:00:00Z', false],
          ['2025-01-01T00:00:00Z', false],
        ]);
      },
      SCRIPT_TIMEOUT_MS,
    );
  });
});
