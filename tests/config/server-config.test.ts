/**
 * @fileoverview Configuration normalization at the environment boundary.
 * @module tests/config/server-config.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

describe('server environment configuration', () => {
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
  });
  afterEach(() => {
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
});
