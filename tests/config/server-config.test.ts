/**
 * @fileoverview Configuration normalization at the environment boundary, and the
 * `./.env` load ahead of the first parse. Each test runs in an empty temporary
 * working directory, so a developer's own `.env` never reaches the assertions.
 * @module tests/config/server-config.test
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

describe('server environment configuration', () => {
  const repoDir = process.cwd();
  let workDir: string;

  beforeEach(() => {
    resetServerConfig();
    for (const key of [
      'CONGRESS_API_KEY',
      'CONGRESS_API_BASE_URL',
      'CONGRESS_MIRROR_ENABLED',
      'CONGRESS_MIRROR_PATH',
      'CONGRESS_MIRROR_REFRESH_CRON',
      'CONGRESS_MIRROR_CONGRESSES',
    ])
      vi.stubEnv(key, undefined);
    workDir = mkdtempSync(join(tmpdir(), 'congress-config-'));
    process.chdir(workDir);
  });
  afterEach(() => {
    process.chdir(repoDir);
    rmSync(workDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it.each(['', `\${CONGRESS_MIRROR_ENABLED}`])(
    'treats unset client substitutions as defaults: %s',
    (value) => {
      vi.stubEnv('CONGRESS_MIRROR_ENABLED', value);
      vi.stubEnv('CONGRESS_MIRROR_REFRESH_CRON', value);
      expect(getServerConfig()).toMatchObject({
        mirrorEnabled: false,
        mirrorRefreshCron: undefined,
      });
    },
  );
  it.each(['false', '0', 'off'])('keeps false strings disabled: %s', (value) => {
    vi.stubEnv('CONGRESS_MIRROR_ENABLED', value);
    expect(getServerConfig().mirrorEnabled).toBe(false);
  });
  it('reads a configured mirror and schedule', () => {
    vi.stubEnv('CONGRESS_MIRROR_ENABLED', 'true');
    vi.stubEnv('CONGRESS_MIRROR_REFRESH_CRON', '0 * * * *');
    vi.stubEnv('CONGRESS_MIRROR_CONGRESSES', '118,119');
    expect(getServerConfig()).toMatchObject({
      mirrorEnabled: true,
      mirrorRefreshCron: '0 * * * *',
      congresses: [118, 119],
    });
  });
  it('rejects a malformed boolean instead of silently disabling the mirror', () => {
    vi.stubEnv('CONGRESS_MIRROR_ENABLED', 'maybe');
    expect(() => getServerConfig()).toThrow(/CONGRESS_MIRROR_ENABLED/);
  });

  describe('./.env', () => {
    it('applies a value present only in ./.env', () => {
      writeFileSync(
        join(workDir, '.env'),
        'CONGRESS_MIRROR_ENABLED=true\nCONGRESS_MIRROR_PATH=/srv/dotenv/bills.sqlite3\n',
      );
      expect(getServerConfig()).toMatchObject({
        mirrorEnabled: true,
        mirrorPath: '/srv/dotenv/bills.sqlite3',
      });
    });

    it('never overrides a variable already set', () => {
      vi.stubEnv('CONGRESS_MIRROR_PATH', '/srv/env/bills.sqlite3');
      writeFileSync(join(workDir, '.env'), 'CONGRESS_MIRROR_PATH=/srv/dotenv/bills.sqlite3\n');
      expect(getServerConfig().mirrorPath).toBe('/srv/env/bills.sqlite3');
    });

    it('reads the defaults when there is no ./.env', () => {
      expect(getServerConfig()).toMatchObject({
        mirrorEnabled: false,
        mirrorPath: '.mirror/bills.sqlite3',
      });
    });

    it("leaves a ./.env it can't read to createApp(), parsing without it", () => {
      mkdirSync(join(workDir, '.env'));
      expect(getServerConfig()).toMatchObject({
        mirrorEnabled: false,
        mirrorPath: '.mirror/bills.sqlite3',
      });
    });
  });
});
