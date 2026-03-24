/**
 * @fileoverview Tests for congressgov_daily_record tool.
 * @module tests/mcp-server/tools/definitions/daily-record.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { dailyRecordTool } from '@/mcp-server/tools/definitions/daily-record.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('dailyRecordTool', () => {
  const mockApi = {
    listDailyRecord: vi.fn(),
    getDailyIssues: vi.fn(),
    getDailyArticles: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists daily record volumes', async () => {
    const ctx = createMockContext();
    mockApi.listDailyRecord.mockResolvedValue({
      data: [{ volumeNumber: 170 }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = dailyRecordTool.input.parse({ operation: 'list' });
    const result = await dailyRecordTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('gets issues for a volume', async () => {
    const ctx = createMockContext();
    mockApi.getDailyIssues.mockResolvedValue({ issues: [{ issueNumber: 1 }] });
    const input = dailyRecordTool.input.parse({
      operation: 'issues',
      volumeNumber: 170,
    });
    const result = await dailyRecordTool.handler(input, ctx);
    expect(result.issues).toHaveLength(1);
  });

  it('throws when issues is missing volumeNumber', async () => {
    const ctx = createMockContext();
    const input = dailyRecordTool.input.parse({ operation: 'issues' });
    await expect(dailyRecordTool.handler(input, ctx)).rejects.toThrow(/volumeNumber/);
  });

  it('gets articles for a specific issue', async () => {
    const ctx = createMockContext();
    mockApi.getDailyArticles.mockResolvedValue({
      data: [{ title: 'Speech' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = dailyRecordTool.input.parse({
      operation: 'articles',
      volumeNumber: 170,
      issueNumber: 5,
    });
    const result = await dailyRecordTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('throws when articles is missing issueNumber', async () => {
    const ctx = createMockContext();
    const input = dailyRecordTool.input.parse({
      operation: 'articles',
      volumeNumber: 170,
    });
    await expect(dailyRecordTool.handler(input, ctx)).rejects.toThrow(/issueNumber/);
  });
});
