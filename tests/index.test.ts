/**
 * @fileoverview Application lifecycle wiring without opening a transport.
 * @module tests/index.test
 */
import type { CoreServices, createApp } from '@cyanheads/mcp-ts-core';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AppOptions = Parameters<typeof createApp>[0];

const state = vi.hoisted(() => ({
  app: undefined as AppOptions | undefined,
  config: {
    mirrorEnabled: false,
    mirrorPath: '/tmp/congress-lifecycle.sqlite3',
    congresses: [119],
    mirrorRefreshCron: undefined as string | undefined,
  },
  close: vi.fn().mockResolvedValue(undefined),
  runSync: vi.fn(),
  init: vi.fn(),
  schedule: vi.fn().mockResolvedValue(undefined),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('@cyanheads/mcp-ts-core', async (original) => ({
  ...(await original<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: vi.fn((options: AppOptions) => {
    state.app = options;
  }),
}));
vi.mock('@cyanheads/mcp-ts-core/utils', async (original) => ({
  ...(await original<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  schedulerService: { schedule: state.schedule, start: state.start, stop: state.stop },
}));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => state.config }));
vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  initCongressApi: vi.fn(),
  getCongressApi: vi.fn(),
}));
vi.mock('@/services/senate-lis/senate-vote-service.js', () => ({
  initSenateVoteService: vi.fn(),
  getSenateVoteService: vi.fn(),
}));
vi.mock('@/services/congress-documents/congress-documents-service.js', () => ({
  initCongressDocuments: vi.fn(),
  getCongressDocuments: vi.fn(),
}));
vi.mock('@/services/congress-mirror/congress-mirror-service.js', () => ({
  initCongressMirror: state.init,
  getCongressMirror: () => ({ mirrorInstance: { close: state.close, runSync: state.runSync } }),
}));

describe('application lifecycle', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.config.mirrorEnabled = false;
    state.config.mirrorRefreshCron = undefined;
    vi.resetModules();
    await import('@/index.js');
  });
  const core = { config: { mcpTransportType: 'http' } } as CoreServices;
  it('leaves the mirror uninitialized when disabled', async () => {
    await state.app?.setup?.(core);
    expect(state.init).not.toHaveBeenCalled();
  });
  it('initializes an enabled mirror and its configured refresh schedule', async () => {
    state.config.mirrorEnabled = true;
    state.config.mirrorRefreshCron = '0 * * * *';
    await state.app?.setup?.(core);
    expect(state.init).toHaveBeenCalledWith({
      mirrorPath: state.config.mirrorPath,
      congresses: [119],
    });
    expect(state.schedule).toHaveBeenCalled();
  });
  it('closes an enabled mirror during shutdown', async () => {
    state.config.mirrorEnabled = true;
    expect(state.app?.teardown).toBeTypeOf('function');
    await state.app?.teardown?.(core);
    expect(state.close).toHaveBeenCalledOnce();
  });
  it('stops scheduling and waits for a cancelled refresh before closing SQLite', async () => {
    state.config.mirrorEnabled = true;
    state.config.mirrorRefreshCron = '0 * * * *';
    await state.app?.setup?.(core);
    let settle: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    state.runSync.mockImplementation((options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((resolve) => {
        settle = () => resolve({ recordsApplied: 0, total: 0 });
      });
    });
    const callback = state.schedule.mock.calls[0]?.[2];
    const refresh = callback(requestContextService.createRequestContext());
    const shutdown = state.app?.teardown?.(core);
    expect(state.stop).toHaveBeenCalledWith('congress-bills-refresh');
    expect(signal?.aborted).toBe(true);
    expect(state.close).not.toHaveBeenCalled();
    settle?.();
    await Promise.all([refresh, shutdown]);
    expect(state.close).toHaveBeenCalledOnce();
  });
  it('leaves the disabled mirror alone during shutdown', async () => {
    await state.app?.teardown?.(core);
    expect(state.close).not.toHaveBeenCalled();
    expect(state.stop).not.toHaveBeenCalled();
  });
  it('declares the stateless HTTP default', () => {
    expect(state.app?.sessionMode).toBe('stateless');
  });
});
