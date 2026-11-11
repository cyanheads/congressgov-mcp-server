/**
 * @fileoverview Integration tests for the mirror lifecycle CLI
 * (`src/cli/mirror-{init,refresh,verify}.ts`). The server is compiled the way
 * `bun run build` compiles it, into a package laid out as an npm install leaves it
 * and kept outside the checkout. Each compiled entry (`dist/cli/*.js`) runs as a
 * Bun or Node subprocess from an unrelated working directory with no
 * `tsconfig.json`, as an operator runs it from a checkout, the Docker image, or an
 * npm install. That exercises import resolution of the shipped files and the
 * shared bootstrap's logger initialization end to end: records on stderr as JSON
 * lines, stdout empty, the level following `MCP_LOG_LEVEL`. Init and refresh page a
 * loopback stand-in for the Congress.gov API.
 * @module tests/services/congress-mirror/mirror-cli
 */

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CongressMirrorService } from '@/services/congress-mirror/congress-mirror-service.js';
import { type FakeBill, listBillsPage } from './fake-bill-list.js';

const execFileAsync = promisify(execFile);

/** The checkout the test runner starts in. */
const ROOT = process.cwd();
const SCRIPT_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 60_000;

/** tsc's exit status when it reports type errors and still emits (`DiagnosticsPresent_OutputsGenerated`). */
const TSC_EMITTED_WITH_DIAGNOSTICS = 2;

/** The runtimes the compiled CLI runs under. */
const RUNTIMES = ['bun', 'node'] as const;
type Runtime = (typeof RUNTIMES)[number];

/** A compiled build of the server, laid out as an installed npm package. */
interface InstalledPackage {
  /** Working directory for each run: empty, outside the package, no `tsconfig.json`. */
  cwd: string;
  /** Package root: `package.json`, the build in `dist/`, and a `node_modules` link. */
  dir: string;
}

/**
 * Compile `src/` as `bun run build` does — `tsc`, then `tsc-alias` rewriting the
 * `@/` alias to relative imports, over `tsconfig.build.json` — into
 * `<root>/package/dist`, beside a copy of `package.json` and a link to the
 * checkout's `node_modules`. No `tsconfig.json` sits in the package or above it, so
 * the build resolves only through its own relative imports and installed packages,
 * as it does from an npm install. The emit flags keep `.tsbuildinfo`, declarations,
 * and source maps out. Type errors are the typecheck gate's to report: a build that
 * reports them and still emits is used. The `node_modules` link is made last, so a
 * failed build leaves nothing that reaches into the checkout.
 */
async function installBuild(root: string): Promise<InstalledPackage> {
  const dir = join(root, 'package');
  const dist = join(dir, 'dist');
  const bin = (name: string) => join(ROOT, 'node_modules', '.bin', name);
  const emitFlags = [
    '--incremental',
    'false',
    '--sourceMap',
    'false',
    '--declaration',
    'false',
    '--declarationMap',
    'false',
  ];
  await execFileAsync(bin('tsc'), ['-p', 'tsconfig.build.json', '--outDir', dist, ...emitFlags], {
    cwd: ROOT,
  }).catch((error: { code?: unknown }) => {
    if (error.code !== TSC_EMITTED_WITH_DIAGNOSTICS) throw error;
  });
  await execFileAsync(bin('tsc-alias'), ['-p', 'tsconfig.build.json', '--outDir', dist], {
    cwd: ROOT,
  });
  copyFileSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  const cwd = join(root, 'elsewhere');
  mkdirSync(cwd);
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return { cwd, dir };
}

interface ScriptRun {
  code: number | null;
  /** `msg` of every stderr record, in order. */
  messages: string[];
  /** Parsed stderr records. */
  records: Record<string, unknown>[];
  stdout: string;
  /** Stderr lines that are not JSON records — where a module-resolution error lands. */
  unparsed: string[];
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
}

/**
 * Run one compiled entry, `dist/cli/<entry>.js`, of the installed package under
 * `runtime`, from the package's outside working directory. `NODE_ENV` is pinned
 * because the framework logger writes nothing to stderr under `testing`, which
 * the test runner would otherwise hand down; `CONGRESS_API_KEY` is pinned so no
 * real key from a local `.env` reaches the loopback upstream.
 */
async function runCli(
  pkg: InstalledPackage,
  entry: string,
  env: Record<string, string>,
  runtime: Runtime = 'bun',
): Promise<ScriptRun> {
  const child = spawn(runtime, [join(pkg.dir, 'dist', 'cli', `${entry}.js`)], {
    cwd: pkg.cwd,
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
  const records: Record<string, unknown>[] = [];
  const unparsed: string[] = [];
  for (const line of stderr.split('\n').filter((l) => l.trim() !== '')) {
    const record = parseRecord(line);
    if (record) records.push(record);
    else unparsed.push(line);
  }
  return { code, stdout, records, unparsed, messages: records.map((r) => String(r.msg)) };
}

interface Upstream {
  baseUrl: string;
  /** Settles when the first bill-list request arrives. */
  billListRequested: Promise<void>;
  /** Every request the scripts made, in order. */
  requests: URL[];
  server: Server;
}

const UPSTREAM_BILLS: FakeBill[] = [
  {
    congress: 119,
    type: 'HR',
    number: '1',
    title: 'Semiconductor Export Control Act',
    originChamber: 'House',
    latestAction: { actionDate: '2026-01-05', text: 'Referred to committee' },
    updatedAt: '2026-01-10T14:00:00Z',
  },
  {
    congress: 119,
    type: 'S',
    number: '2',
    title: 'Clean Water Restoration Act',
    originChamber: 'Senate',
    latestAction: { actionDate: '2026-01-18', text: 'Read twice' },
    updatedAt: '2026-02-01T09:00:00Z',
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
 * Loopback stand-in for the two list endpoints the ingester pages. The summaries
 * list honors `fromDateTime` the way Congress.gov does: without one it holds only
 * the last day's updates (none here), with one every summary updated since. The
 * bill list is the live-shaped fake (`listBillsPage`): exclusive whole-second
 * bounds on a hidden update time, date-only rows. A bill-list request waits for
 * `billListGate` before it is answered.
 */
async function startUpstream(billListGate?: Promise<void>): Promise<Upstream> {
  const requests: URL[] = [];
  let billListArrived!: () => void;
  const billListRequested = new Promise<void>((resolve) => {
    billListArrived = resolve;
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(url);
    const param = (name: string) => url.searchParams.get(name) ?? undefined;
    let body: Record<string, unknown>;
    if (url.pathname === '/v3/summaries/119') {
      const from = param('fromDateTime');
      const rows = from ? UPSTREAM_SUMMARIES.filter((s) => s.updateDate >= from) : [];
      body = { summaries: rows, pagination: { count: rows.length } };
    } else if (url.pathname === '/v3/bill/119') {
      billListArrived();
      await billListGate;
      const page = listBillsPage(UPSTREAM_BILLS, {
        congress: 119,
        sort: param('sort'),
        limit: Number(param('limit') ?? 20),
        offset: Number(param('offset') ?? 0),
        fromDateTime: param('fromDateTime'),
        toDateTime: param('toDateTime'),
      });
      body = { bills: page.data, pagination: { count: page.pagination.count } };
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
  return { server, requests, billListRequested, baseUrl: `http://127.0.0.1:${port}/v3` };
}

describe('mirror lifecycle CLI', () => {
  let buildRoot: string;
  let pkg: InstalledPackage;
  let dir: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    buildRoot = mkdtempSync(join(tmpdir(), 'congress-mirror-cli-build-'));
    pkg = await installBuild(buildRoot);
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    /**
     * `pkg` is unset only when the build failed, which leaves no link (installBuild
     * links last). The link goes first, so the recursive removal never reaches the
     * checkout's node_modules.
     */
    if (pkg) unlinkSync(join(pkg.dir, 'node_modules'));
    rmSync(buildRoot, { recursive: true, force: true });
  });

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
    it.each(RUNTIMES)(
      'under %s, resolves its imports from the installed build, reports a never-built store on stderr, and exits 1',
      async (runtime) => {
        const run = await runCli(pkg, 'mirror-verify', env, runtime);

        expect(run.unparsed).toEqual([]);
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

    it.each(RUNTIMES)(
      'under %s, reports a built store and its integrity check, exiting 0',
      async (runtime) => {
        const service = new CongressMirrorService({
          mirrorPath: env.CONGRESS_MIRROR_PATH as string,
          congresses: [119],
          getApi: () => ({
            listBills: async (params) => listBillsPage(UPSTREAM_BILLS.slice(0, 1), params),
            listSummaries: async () => ({ data: [], pagination: { count: 0, nextOffset: null } }),
          }),
        });
        await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(10_000) });
        await service.mirrorInstance.close();

        const run = await runCli(pkg, 'mirror-verify', env, runtime);

        expect(run.unparsed).toEqual([]);
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
        const run = await runCli(pkg, 'mirror-verify', { ...env, MCP_LOG_LEVEL: 'error' });

        expect(run.unparsed).toEqual([]);
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

    it.each(RUNTIMES)(
      'under %s, logs the start, per-congress, and completion lines on stderr at the MCP_LOG_LEVEL floor; stdout stays empty',
      async (runtime) => {
        const init = await runCli(pkg, 'mirror-init', env, runtime);

        expect(init.unparsed).toEqual([]);
        expect(init.code).toBe(0);
        expect(init.stdout).toBe('');
        // Pino's numeric level for `debug` — the per-request fetch records.
        expect(init.records.some((r) => r.level === 20)).toBe(true);
        expect(init.messages).toContain('Starting Congress bill mirror init (full build)');
        expect(init.messages).toContain(
          'Congress bill mirror sync starting (mode=init, congresses=119)',
        );
        expect(init.messages).toContain('Congress 119: 1 summaries loaded');
        expect(init.messages).toContain(
          'Congress 119: 2 bills mirrored from 2025-01-01 in 1 bill-list requests',
        );
        expect(init.messages.at(-1)).toBe(
          'Congress bill mirror init complete: 2 records applied across 1 pages (total 2).',
        );

        const refresh = await runCli(
          pkg,
          'mirror-refresh',
          { ...env, MCP_LOG_LEVEL: 'info' },
          runtime,
        );

        expect(refresh.unparsed).toEqual([]);
        expect(refresh.code).toBe(0);
        expect(refresh.stdout).toBe('');
        expect(refresh.records.every((r) => typeof r.level === 'number' && r.level >= 30)).toBe(
          true,
        );
        expect(refresh.messages).toContain('Starting Congress bill mirror refresh');
        expect(refresh.messages).toContain(
          'Congress bill mirror sync starting (mode=refresh, congresses=119, checkpoint=2026-02-01|119)',
        );
        expect(refresh.messages).toContain('Congress 119: 1 summaries loaded');
        expect(refresh.messages).toContain(
          'Congress 119: 1 bills mirrored from 2026-02-01 in 1 bill-list requests',
        );
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
        // Init walks the bill list from the congress's start, refresh from the checkpoint
        // day, each from one second before its day and never by offset.
        const billQueries = upstream.requests
          .filter((url) => url.pathname === '/v3/bill/119')
          .map((url) => [url.searchParams.get('fromDateTime'), url.searchParams.get('offset')]);
        expect(billQueries).toEqual([
          ['2024-12-31T23:59:59Z', null],
          ['2026-01-31T23:59:59Z', null],
        ]);
      },
      SCRIPT_TIMEOUT_MS,
    );

    it.each(RUNTIMES)(
      'under %s, a SIGTERM mid-walk stops the run and releases its lease, so an immediate re-run completes',
      async (runtime) => {
        let openGate!: () => void;
        const gated = await startUpstream(
          new Promise<void>((resolve) => {
            openGate = resolve;
          }),
        );
        const gatedEnv = { ...env, CONGRESS_API_BASE_URL: gated.baseUrl };
        const child = spawn(runtime, [join(pkg.dir, 'dist', 'cli', 'mirror-init.js')], {
          cwd: pkg.cwd,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            CONGRESS_API_KEY: 'test-key',
            ...gatedEnv,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        const acknowledged = new Promise<void>((resolve) => {
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            stderr += chunk;
            if (stderr.includes('SIGTERM received')) resolve();
          });
        });
        const closed = once(child, 'close') as Promise<[number | null]>;

        await gated.billListRequested;
        child.kill('SIGTERM');
        // A run that ignores the signal's settle step dies here; one that honors it waits for the request in flight.
        await Promise.race([acknowledged, closed]);
        openGate();
        const [code] = await closed;
        const messages = stderr
          .split('\n')
          .map(parseRecord)
          .map((record) => record?.msg);

        expect(code).toBe(1);
        expect(messages).toContain('Mirror sync stopped');

        const rerun = await runCli(pkg, 'mirror-init', gatedEnv, runtime);

        expect(rerun.code).toBe(0);
        expect(rerun.messages.at(-1)).toBe(
          'Congress bill mirror init complete: 2 records applied across 1 pages (total 2).',
        );
        gated.server.close();
        await once(gated.server, 'close');
      },
      SCRIPT_TIMEOUT_MS,
    );
  });

  describe('packaging', () => {
    it('points each mirror:* package script at a compiled entry the build emits', () => {
      const { scripts } = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      const mirrorScripts = Object.fromEntries(
        Object.entries(scripts).filter(([name]) => name.startsWith('mirror:')),
      );

      expect(mirrorScripts).toEqual({
        'mirror:init': 'bun dist/cli/mirror-init.js',
        'mirror:refresh': 'bun dist/cli/mirror-refresh.js',
        'mirror:verify': 'bun dist/cli/mirror-verify.js',
      });
      for (const command of Object.values(mirrorScripts)) {
        const entry = command.split(' ')[1] as string;
        expect(existsSync(join(pkg.dir, entry)), entry).toBe(true);
      }
    });

    it(
      "ships the compiled entry each mirror:* script names, and the bootstrap they share, in the build's npm tarball",
      async () => {
        const { scripts } = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>;
        };
        const entries = Object.entries(scripts)
          .filter(([name]) => name.startsWith('mirror:'))
          .map(([, command]) => command.split(' ')[1] as string);
        const { stdout } = await execFileAsync(
          'npm',
          ['pack', '--dry-run', '--json', '--ignore-scripts'],
          { cwd: pkg.dir },
        );
        const [tarball] = JSON.parse(stdout) as { files: { path: string }[] }[];
        const paths = tarball?.files.map((file) => file.path) ?? [];

        expect(entries).toHaveLength(3);
        for (const entry of [...entries, 'dist/cli/mirror-context.js']) {
          expect(paths, entry).toContain(entry);
        }
      },
      SCRIPT_TIMEOUT_MS,
    );

    it(
      'leaves scripts/ out of the npm tarball',
      async () => {
        const { stdout } = await execFileAsync(
          'npm',
          ['pack', '--dry-run', '--json', '--ignore-scripts'],
          { cwd: ROOT },
        );
        const [tarball] = JSON.parse(stdout) as { files: { path: string }[] }[];
        const paths = tarball?.files.map((file) => file.path) ?? [];

        expect(paths).toContain('package.json');
        expect(paths.filter((path) => path.startsWith('scripts/'))).toEqual([]);
      },
      SCRIPT_TIMEOUT_MS,
    );
  });
});
